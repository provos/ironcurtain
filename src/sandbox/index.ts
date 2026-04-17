/**
 * Sandbox -- Sets up UTCP Code Mode with the MCP proxy server.
 *
 * Code Mode creates a sandboxed TypeScript execution environment where
 * LLM-generated code runs with no direct access to the network, filesystem,
 * or credentials. Instead of connecting to real MCP servers, it connects
 * to our MCP proxy server which evaluates policy on every tool call.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import '@utcp/mcp'; // Register MCP call template type with UTCP SDK
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { Protocol } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { IronCurtainConfig, MCPServerConfig } from '../config/types.js';
import { CONTAINER_WORKSPACE_DIR } from '../docker/agent-adapter.js';
import { createLanguageModel } from '../config/model-provider.js';
import { resolveNodeModulesBin } from '../trusted-process/sandbox-integration.js';
import { ToolCallCoordinator, type CoordinatorTool } from '../trusted-process/tool-call-coordinator.js';
import { loadGeneratedPolicy, extractServerDomainAllowlists, getPackageGeneratedDir } from '../config/index.js';
import { buildTrustedServerSet } from '../memory/memory-annotations.js';
import { proxyAnnotations, proxyPolicyRules, createControlApiClient } from '../docker/proxy-tools.js';
import { extractPolicyRoots, toMcpRoots } from '../trusted-process/policy-roots.js';
import type { McpRoot } from '../trusted-process/mcp-client-manager.js';
import {
  registerIronCurtainProtocol,
  bindCoordinatorToManual,
  unbindCoordinatorFromManual,
  IRONCURTAIN_CALL_TEMPLATE_TYPE,
} from './ironcurtain-protocol.js';
import * as logger from '../logger.js';
import { wrapLanguageModel } from 'ai';
import { createLlmLoggingMiddleware } from '../pipeline/llm-logger.js';
import type { LanguageModelV3 } from '@ai-sdk/provider';

// Workaround: UTCP creates MCP SDK Client instances without setting a per-request
// timeout, so they inherit the SDK's DEFAULT_REQUEST_TIMEOUT_MSEC (60s). This is
// too short when human escalation approval is pending (up to 300s). The SDK doesn't
// expose a way to set a client-level default timeout, so we patch Protocol.request()
// to use our escalation timeout as the default instead of 60s.
//
// This must run before any Client instances are created (i.e. before Sandbox.initialize()).
// The timeout is mutable so Sandbox.initialize() can update it from the config.
let escalationTimeoutMs = 300 * 1000; // default fallback

/** Updates the Protocol.request timeout used by UTCP's MCP SDK clients. */
function setEscalationTimeout(seconds: number): void {
  escalationTimeoutMs = seconds * 1000;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type, @typescript-eslint/unbound-method -- monkey-patch requires untyped apply() and unbound method reference
const originalRequest: Function = Protocol.prototype.request;
Protocol.prototype.request = function (
  this: unknown,
  ...args: [request: unknown, schema: unknown, options?: { timeout?: number }]
) {
  const options = args[2] ?? {};
  if (!options.timeout) {
    args[2] = { ...options, timeout: escalationTimeoutMs };
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- monkey-patch returns the original method's untyped result
  return originalRequest.apply(this, args);
} as typeof Protocol.prototype.request;

// Detect compiled (.js in dist/) vs source (.ts in src/) mode.
// In compiled mode, spawn with `node`; in source mode, spawn with `tsx` directly.
// We resolve the tsx binary from node_modules/.bin instead of going through `npx`
// because npx spawns an intermediate `sh -c` process that doesn't forward SIGTERM,
// leaving orphaned child processes when the MCP SDK tries to shut down the transport.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isCompiled = __filename.endsWith('.js');
const proxyServerPath = resolve(__dirname, `../trusted-process/mcp-proxy-server.${isCompiled ? 'js' : 'ts'}`);
const tsxBin = resolveNodeModulesBin('tsx', resolve(__dirname, '..', '..'));
const PROXY_COMMAND = isCompiled ? 'node' : tsxBin;
const PROXY_ARGS = [proxyServerPath];

/** Sanitize a string to a valid JS identifier segment. */
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');

/** Shared: first segment + remaining joined with underscores. */
function flattenDotted(segments: string[]): string {
  const [manual, ...parts] = segments;
  return `${sanitize(manual)}.${parts.map(sanitize).join('_')}`;
}

/**
 * Mirrors UTCP Code Mode's sanitizeIdentifier() behavior — the property name
 * that UTCP actually creates on `global.tools` in the V8 isolate.
 *
 * Example: "tools.filesystem.read_file" → "tools.filesystem_read_file"
 */
export function toUtcpCallable(toolName: string): string {
  if (!toolName.includes('.')) return sanitize(toolName);
  return flattenDotted(toolName.split('.'));
}

/**
 * Transforms a UTCP tool name (dotted) into the user-facing callable name
 * with server-namespace prefix stripping.
 *
 * For 3+ segment names (tools.<server>.<tool>):
 * - Extract server and tool segments
 * - If tool starts with `serverName_`, strip that prefix
 * - Return `server.strippedTool`
 *
 * Examples:
 *   "tools.filesystem.read_file"    → "filesystem.read_file"
 *   "tools.git.git_add"             → "git.add"
 *   "tools.memory.memory_context"   → "memory.context"
 *   "tools.a.b.c"                   → "a.b_c"
 */
export function toCallableName(toolName: string): string {
  if (!toolName.includes('.')) return sanitize(toolName);
  const segments = toolName.split('.');

  // 2-segment names: unchanged (e.g., "tools.read_file")
  if (segments.length <= 2) return flattenDotted(segments);

  // 3+ segments: server-namespace with prefix stripping
  const server = sanitize(segments[1]);
  const toolParts = segments.slice(2).map(sanitize);
  const tool = toolParts.join('_');

  // Strip redundant server prefix from tool name (e.g., git_add → add)
  const prefix = server + '_';
  const strippedTool = tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;

  return `${server}.${strippedTool}`;
}

/**
 * Extracts required parameter names from a tool's JSON Schema inputs
 * to show inline in the catalog, e.g. "{ path }" or "{ path, content }".
 */
export function extractRequiredParams(inputs?: { properties?: Record<string, unknown>; required?: string[] }): string {
  if (!inputs?.required?.length) return '';
  return `{ ${inputs.required.join(', ')} }`;
}

export interface CodeExecutionResult {
  result: unknown;
  logs: string[];
}

/** A single tool entry for help discovery. */
export interface HelpToolEntry {
  callableName: string;
  params: string;
}

/** Structured help data for progressive tool disclosure. */
export interface HelpData {
  serverDescriptions: Record<string, string>;
  toolsByServer: Record<string, HelpToolEntry[]>;
}

/** Fixed reserved namespaces that aliases must never shadow. */
const FIXED_RESERVED_NAMESPACES = ['help', 'console', 'global', 'undefined', 'NaN', 'Infinity'];

/**
 * Builds a JavaScript snippet that creates server-namespace aliases in the
 * V8 sandbox isolate: `global.<server> = { <tool>: global.<utcpGlobal>.<utcpProp> }`.
 *
 * This enables `filesystem.read_file(...)` alongside the UTCP-created
 * `<utcpGlobal>.filesystem_read_file(...)`.
 *
 * `utcpGlobalName` is the sanitized UTCP manual name, which is the property
 * UTCP actually creates on `global` in the V8 isolate (e.g., `tools_abc123`
 * for manual name `tools-abc123`). Each Sandbox instance uses a unique
 * manual name so multiple sandboxes can coexist without global collisions.
 */
function buildNamespaceAliasSnippet(
  aliases: Array<{ newCallable: string; utcpProp: string }>,
  utcpGlobalName: string,
): string {
  // Group by namespace. Reserve both the fixed reserved names and the
  // UTCP global itself so no alias can overwrite the tool root.
  const reserved = new Set<string>([...FIXED_RESERVED_NAMESPACES, utcpGlobalName]);
  const byNs: Record<string, Array<{ tool: string; utcpProp: string }>> = {};
  for (const { newCallable, utcpProp } of aliases) {
    const dotIdx = newCallable.indexOf('.');
    if (dotIdx === -1) continue;
    const ns = newCallable.slice(0, dotIdx);
    if (reserved.has(ns)) continue;
    const tool = newCallable.slice(dotIdx + 1);
    if (!(ns in byNs)) byNs[ns] = [];
    byNs[ns].push({ tool, utcpProp });
  }

  if (Object.keys(byNs).length === 0) return '';

  const lines: string[] = ['(function() {'];
  for (const [ns, tools] of Object.entries(byNs)) {
    lines.push(`  global["${ns}"] = {};`);
    for (const { tool, utcpProp } of tools) {
      lines.push(`  global["${ns}"]["${tool}"] = global["${utcpGlobalName}"]["${utcpProp}"];`);
    }
  }
  lines.push('})();');
  return lines.join('\n');
}

/**
 * Builds a JavaScript snippet that patches __getToolInterface inside the
 * sandbox isolate so that both new callable names (e.g., "filesystem.read_file")
 * and old UTCP callable names (e.g., "<utcpGlobalName>.filesystem_read_file")
 * resolve to the same interface as the raw UTCP tool names (with dots).
 *
 * UTCP Code Mode keys its interface map by raw tool name (e.g.,
 * "<manualName>.git.git_add") but the callable function name the agent sees
 * uses the new namespace format (e.g., "git.add"). Without this patch,
 * __getToolInterface(callableName) returns null.
 *
 * `manualName` is the UTCP manual name (unsanitized, may contain hyphens).
 * `utcpGlobalName` is the sanitized form UTCP uses as a V8 global.
 */
function buildInterfacePatchSnippet(
  callableToRawMap: Record<string, string>,
  manualName: string,
  utcpGlobalName: string,
): string {
  const mapJson = JSON.stringify(callableToRawMap);
  // The manual prefix the raw UTCP tool names carry (e.g., "tools-abc.").
  const manualPrefixJson = JSON.stringify(`${manualName}.`);
  // The sanitized name used in the old UTCP callable form
  // (e.g., "tools_abc.filesystem_read_file").
  const utcpGlobalPrefixJson = JSON.stringify(`${utcpGlobalName}.`);
  // The snippet runs inside the V8 isolate before user code.
  // It wraps the existing __getToolInterface to also accept callable names.
  // When the name is wrong, it tries auto-correction and falls back to
  // a helpful error message with suggestions.
  return `
    (function() {
      var _callableToRaw = ${mapJson};
      var _manualPrefix = ${manualPrefixJson};
      var _utcpGlobalPrefix = ${utcpGlobalPrefixJson};
      var _origGetToolInterface = global.__getToolInterface;
      if (_origGetToolInterface) {
        global.__getToolInterface = function(toolName) {
          var result = _origGetToolInterface(toolName);
          if (result) return result;
          var rawName = _callableToRaw[toolName];
          if (rawName) return _origGetToolInterface(rawName);

          // Auto-correct: try prepending the manual prefix for raw name lookup
          if (toolName && !toolName.startsWith(_manualPrefix)) {
            var prefixed = _manualPrefix + toolName;
            result = _origGetToolInterface(prefixed);
            if (result) return result;
            rawName = _callableToRaw[prefixed];
            if (rawName) return _origGetToolInterface(rawName);
            // Try converting dots to underscores (e.g. "git.add" -> "<utcpGlobal>.git_add")
            var asOldCallable = _utcpGlobalPrefix + toolName.replace(/\\./g, '_');
            rawName = _callableToRaw[asOldCallable];
            if (rawName) return _origGetToolInterface(rawName);
          }

          // Build helpful error with suggestions
          var allNames = Object.keys(_callableToRaw);
          var suggestions = [];
          var needle = toolName.toLowerCase();
          if (needle.indexOf(_manualPrefix.toLowerCase()) === 0) {
            needle = needle.slice(_manualPrefix.length);
          }
          for (var i = 0; i < allNames.length && suggestions.length < 3; i++) {
            var candidate = allNames[i].toLowerCase();
            if (candidate.indexOf(_manualPrefix.toLowerCase()) === 0) {
              candidate = candidate.slice(_manualPrefix.length);
            }
            if (allNames[i].toLowerCase().indexOf(needle) !== -1 ||
                needle.indexOf(candidate) !== -1) {
              suggestions.push(allNames[i]);
            }
          }
          var msg = "Unknown tool '" + toolName + "'.";
          if (suggestions.length > 0) {
            msg += " Did you mean: " + suggestions.join(', ') + "?";
          } else {
            msg += " Use the callable name format shown in the tool catalog, e.g. git.push";
          }
          return msg;
        };
      }
    })();
  `;
}

/**
 * Builds a JavaScript snippet that injects `global.help = { help: fn }` into the
 * V8 sandbox isolate. This is a pure in-isolate function — no MCP request is
 * created, so the policy engine and audit log never see help calls.
 *
 * - `help.help()` with no args lists all servers with descriptions.
 * - `help.help('filesystem')` lists that server's tools as `callableName(params)`.
 * - Unknown server returns an error message suggesting `help.help()`.
 */
export function buildHelpSnippet(helpData: HelpData): string {
  const descriptionsJson = JSON.stringify(helpData.serverDescriptions);
  const toolsJson = JSON.stringify(helpData.toolsByServer);

  return `
    (function() {
      var _serverDescs = ${descriptionsJson};
      var _toolsByServer = ${toolsJson};
      global.help = {
        help: function(serverName) {
          if (!serverName) {
            var lines = ['Available tool servers:'];
            var names = Object.keys(_serverDescs);
            for (var i = 0; i < names.length; i++) {
              lines.push('  ' + names[i] + ' - ' + _serverDescs[names[i]]);
            }
            lines.push('');
            lines.push("Call help.help('serverName') to list tools in a server.");
            return lines.join('\\n');
          }
          var tools = _toolsByServer[serverName];
          if (!tools) {
            var known = Object.keys(_serverDescs).join(', ');
            return 'Unknown server: ' + serverName + '. Available servers: ' + known + ". Call help.help() to list all.";
          }
          var lines = ['Tools in ' + serverName + ':'];
          for (var i = 0; i < tools.length; i++) {
            var t = tools[i];
            lines.push('  ' + t.callableName + '(' + t.params + ')');
          }
          return lines.join('\\n');
        }
      };
    })();
  `;
}

/**
 * Prefix for per-sandbox virtual UTCP manual names. A random suffix is
 * appended per Sandbox instance so two sandboxes running in the same
 * Node process (e.g., the daemon hosting multiple sessions) can coexist
 * without their `coordinatorByManual` bindings colliding.
 *
 * The prefix + suffix are already valid identifier characters
 * (underscores, letters, digits) so UTCP's own name sanitization
 * (`[^\w]` → `_`) is a no-op on the chosen name -- the name we bind
 * in the coordinator map is byte-identical to what UTCP passes to
 * `registerManual` on the protocol.
 */
const VIRTUAL_MANUAL_PREFIX = 'tools_';

export class Sandbox {
  private client: CodeModeUtcpClient | null = null;
  private toolCatalog: string = '';
  private preamble: string = '';
  private helpData: HelpData = { serverDescriptions: {}, toolsByServer: {} };
  private coordinator: ToolCallCoordinator | null = null;
  /**
   * Per-sandbox UTCP manual name (e.g., `tools_abc123_...`). Unique
   * per instance so concurrent sandboxes don't overwrite each other's
   * coordinator binding. The same name is used as the V8 global UTCP
   * creates in the isolate; snippets reference it directly.
   */
  private readonly manualName = `${VIRTUAL_MANUAL_PREFIX}${randomUUID().replace(/-/g, '_')}`;

  /**
   * Exposes the policy coordinator once the sandbox is initialized.
   * Returns `null` before `initialize()` completes.
   */
  getCoordinator(): ToolCallCoordinator | null {
    return this.coordinator;
  }

  async initialize(config: IronCurtainConfig): Promise<void> {
    // Update the Protocol.request timeout before any Client instances are created.
    setEscalationTimeout(config.escalationTimeoutSeconds);

    this.client = await CodeModeUtcpClient.create();

    // Install the custom in-process UTCP protocol that routes tool calls
    // to the coordinator. Idempotent: safe to call multiple times.
    registerIronCurtainProtocol();

    // Build the coordinator. It owns policy evaluation, audit logging,
    // the circuit breaker, the approval whitelist, and the server-context
    // map. All of these used to be duplicated per subprocess.
    const { coordinator, initialRoots } = await buildCoordinator(config);
    this.coordinator = coordinator;
    bindCoordinatorToManual(this.manualName, coordinator);

    // Spawn one router-mode mcp-proxy-server subprocess per backend
    // server. Each subprocess handles OAuth credential injection,
    // sandbox-runtime wrapping, and the stdio MCP connection to the
    // real backend, but forwards CallTool requests verbatim -- the
    // coordinator owns the policy gate.
    await connectBackendSubprocesses(coordinator, config, initialRoots);

    // Register a single virtual UTCP manual. The UTCP variable
    // substitutor deep-clones `config` into a plain object, so class
    // instances cannot survive the round trip -- the IronCurtain
    // protocol resolves the live coordinator via `coordinatorByManual`
    // (bound above) instead of reading it from the template.
    const registration = await this.client.registerManual({
      name: this.manualName,
      call_template_type: IRONCURTAIN_CALL_TEMPLATE_TYPE,
    });

    if (!registration.success) {
      const errors = registration.errors.join(', ') || 'unknown error';
      throw new Error(`Failed to register IronCurtain manual: ${errors}`);
    }

    const { catalog, patchSnippet, aliasSnippet, helpData } = await this.buildToolCatalogAndPatch(config);
    this.toolCatalog = catalog;
    this.helpData = helpData;

    // Pre-build the preamble once — each executeCode() call creates a fresh
    // V8 isolate, so the preamble must be prepended every time, but the
    // string itself never changes after initialization.
    let preamble = '';
    if (patchSnippet) preamble += patchSnippet + '\n';
    if (aliasSnippet) preamble += aliasSnippet + '\n';
    const helpSnippet = buildHelpSnippet(helpData);
    if (helpSnippet) preamble += helpSnippet + '\n';
    this.preamble = preamble;
  }

  /**
   * Builds the tool catalog, the __getToolInterface patch, namespace alias
   * snippet, and help data in one pass.
   *
   * The catalog is a compact one-line-per-tool listing using new callable names.
   * The patch snippet maps both new and old callable names back to raw UTCP
   * names so that __getToolInterface works with any naming convention.
   * The alias snippet creates server-namespace globals so the new names work.
   * The help data groups tools by server for progressive disclosure.
   */
  private async buildToolCatalogAndPatch(
    config: IronCurtainConfig,
  ): Promise<{ catalog: string; patchSnippet: string; aliasSnippet: string; helpData: HelpData }> {
    if (!this.client) throw new Error('Sandbox not initialized');
    const emptyHelp: HelpData = { serverDescriptions: {}, toolsByServer: {} };

    const tools = await this.client.getTools();
    if (tools.length === 0) {
      return { catalog: 'No tools available', patchSnippet: '', aliasSnippet: '', helpData: emptyHelp };
    }

    const callableToRaw: Record<string, string> = {};
    const catalogLines: string[] = [];
    const toolsByServer: Record<string, HelpToolEntry[]> = {};
    const serverDescriptions: Record<string, string> = {};
    const namespaceAliases: Array<{ newCallable: string; utcpProp: string }> = [];

    for (const t of tools) {
      // Split once; derive all name variants from the same segments.
      const segments = t.name.split('.');
      const callableName = toCallableName(t.name);
      const utcpCallable = segments.length > 1 ? flattenDotted(segments) : sanitize(t.name);
      const params = extractRequiredParams(t.inputs);
      catalogLines.push(`- \`${callableName}(${params})\` — ${t.description}`);

      // Map new callable name → raw UTCP name
      if (callableName !== t.name) {
        callableToRaw[callableName] = t.name;
      }
      // Map old UTCP callable name → raw UTCP name (backward compat)
      if (utcpCallable !== t.name && utcpCallable !== callableName) {
        callableToRaw[utcpCallable] = t.name;
      }

      // Build namespace alias: new callable → UTCP property on global.tools
      // The utcpCallable is "tools.<prop>", extract the property part after the dot
      if (segments.length > 1) {
        const utcpProp = utcpCallable.slice(utcpCallable.indexOf('.') + 1);
        namespaceAliases.push({ newCallable: callableName, utcpProp });
      }

      // Extract server name from the UTCP name: tools.<server>.<tool>
      const serverName = segments.length >= 2 ? segments[1] : segments[0];
      if (!(serverName in toolsByServer)) {
        toolsByServer[serverName] = [];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: Record index may be undefined at runtime
        serverDescriptions[serverName] = config.mcpServers[serverName]?.description ?? serverName;
      }
      toolsByServer[serverName].push({ callableName, params });
    }

    // UTCP creates `global.<sanitizedManualName>` in the V8 isolate.
    // The snippets must target the same property UTCP sets.
    const utcpGlobalName = sanitize(this.manualName);
    const patchSnippet =
      Object.keys(callableToRaw).length > 0
        ? buildInterfacePatchSnippet(callableToRaw, this.manualName, utcpGlobalName)
        : '';
    const aliasSnippet =
      namespaceAliases.length > 0 ? buildNamespaceAliasSnippet(namespaceAliases, utcpGlobalName) : '';
    const helpData: HelpData = { serverDescriptions, toolsByServer };

    return { catalog: catalogLines.join('\n'), patchSnippet, aliasSnippet, helpData };
  }

  getToolInterfaces(): string {
    return this.toolCatalog;
  }

  getHelpData(): HelpData {
    return this.helpData;
  }

  async executeCode(code: string, timeoutMs = 300000): Promise<CodeExecutionResult> {
    if (!this.client) throw new Error('Sandbox not initialized');

    // Prepend the pre-built preamble (interface patch + namespace aliases +
    // help snippet). Each callToolChain creates a fresh V8 isolate.
    const patchedCode = this.preamble ? `${this.preamble}${code}` : code;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- callToolChain returns { result: any }
    const { result, logs } = await this.client.callToolChain(patchedCode, timeoutMs);
    return { result, logs };
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    if (this.coordinator) {
      unbindCoordinatorFromManual(this.manualName);
      await this.coordinator.close();
      this.coordinator = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Coordinator construction + subprocess wiring helpers
// ---------------------------------------------------------------------------

/**
 * Wraps a language model with LLM logging middleware when a log path is
 * set. Mirrors the logging the proxy previously did in-subprocess.
 */
function wrapAutoApproveModel(model: LanguageModelV3, llmLogPath?: string): LanguageModelV3 {
  if (!llmLogPath) return model;
  return wrapLanguageModel({
    model,
    middleware: createLlmLoggingMiddleware(llmLogPath, { stepName: 'auto-approve' }),
  });
}

/**
 * Bundle returned by `buildCoordinator`: the coordinator plus the
 * initial MCP roots derived from the compiled policy. The roots are
 * passed to `MCPClientManager.connect()` when the coordinator talks
 * to relay subprocesses so that escalation-time root expansion has
 * the correct base set on which to extend.
 */
interface CoordinatorBundle {
  coordinator: ToolCallCoordinator;
  initialRoots: McpRoot[];
}

/**
 * Builds the `ToolCallCoordinator` from the loaded policy artifacts.
 * Merges proxy-tool annotations/rules so the coordinator can evaluate
 * virtual proxy tools the same way the subprocess used to.
 */
async function buildCoordinator(config: IronCurtainConfig): Promise<CoordinatorBundle> {
  const { compiledPolicy, toolAnnotations, dynamicLists } = loadGeneratedPolicy({
    policyDir: config.generatedDir,
    toolAnnotationsDir: config.toolAnnotationsDir ?? config.generatedDir,
    fallbackDir: getPackageGeneratedDir(),
  });

  // Inject the virtual proxy tools/rules so the coordinator treats
  // add_proxy_domain / remove_proxy_domain / list_proxy_domains as
  // policy-evaluated tools like any other.
  toolAnnotations.servers.proxy = {
    inputHash: 'hardcoded',
    tools: proxyAnnotations,
  };
  compiledPolicy.rules = [...proxyPolicyRules, ...compiledPolicy.rules];

  const serverDomainAllowlists = extractServerDomainAllowlists(config.mcpServers);
  const trustedServers = buildTrustedServerSet(config.mcpServers);

  // Auto-approve model: build in-process now that the subprocess no
  // longer owns it.
  let autoApproveModel: LanguageModelV3 | null = null;
  const autoApprove = config.userConfig.autoApprove;
  if (autoApprove.enabled) {
    try {
      const base = await createLanguageModel(autoApprove.modelId, config.userConfig);
      autoApproveModel = wrapAutoApproveModel(base, config.autoApproveLlmLogPath);
    } catch (err) {
      // Model construction failure is non-fatal: auto-approve becomes
      // unavailable but the session still runs with manual escalation.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[auto-approve] Model construction failed (${autoApprove.modelId}): ${message}`);
    }
  }

  // Virtual proxy control client (Docker Agent Mode only). Matches the
  // subprocess's previous behavior where SERVER_FILTER=proxy entered
  // virtual-only mode with MITM_CONTROL_ADDR set.
  const controlApiClient = config.mitmControlAddr ? createControlApiClient(config.mitmControlAddr) : null;

  const coordinator = new ToolCallCoordinator({
    compiledPolicy,
    toolAnnotations,
    protectedPaths: config.protectedPaths,
    allowedDirectory: config.allowedDirectory,
    serverDomainAllowlists,
    dynamicLists,
    trustedServers,
    auditLogPath: config.auditLogPath,
    auditRedact: config.userConfig.auditRedaction.enabled,
    autoApproveModel,
    escalationDir: config.escalationDir,
    controlApiClient,
  });

  // Derive initial MCP roots from the compiled policy using the same
  // rule the relay subprocess applied in the legacy single-process
  // path. Passing these to `manager.connect()` makes the coordinator's
  // client advertise `roots.listChanged` and seeds the mutable roots
  // array that `addRootToClient` extends on escalation approval.
  const policyRoots = extractPolicyRoots(compiledPolicy, config.allowedDirectory);
  const initialRoots: McpRoot[] = toMcpRoots(policyRoots);

  return { coordinator, initialRoots };
}

/**
 * Spawns one `mcp-proxy-server.ts` subprocess per backend server in
 * router mode (coordinator-owned policy gate). Also spawns a
 * virtual-only proxy subprocess when `mitmControlAddr` is configured.
 *
 * The subprocesses are driven through the coordinator's
 * `MCPClientManager`. After each connects, its tool list is registered
 * with the coordinator so UTCP sees every tool.
 *
 * `initialRoots` seeds the mutable roots array each relay connection
 * advertises. Passing the same set to every subprocess ensures the
 * policy-derived roots are visible through the relay before any
 * escalation-time expansion.
 */
async function connectBackendSubprocesses(
  coordinator: ToolCallCoordinator,
  config: IronCurtainConfig,
  initialRoots: McpRoot[],
): Promise<void> {
  const manager = coordinator.getMcpManager();
  const proxyEnv = buildProxySubprocessEnv(config);

  for (const serverName of Object.keys(config.mcpServers)) {
    const serverCreds = config.userConfig.serverCredentials[serverName] as Record<string, string> | undefined;
    const subprocessConfig: MCPServerConfig = {
      command: PROXY_COMMAND,
      args: [...PROXY_ARGS],
      env: {
        ...proxyEnv,
        SERVER_FILTER: serverName,
        ...(serverCreds ? { SERVER_CREDENTIALS: JSON.stringify(serverCreds) } : {}),
      },
      sandbox: false,
    };
    try {
      await manager.connect(serverName, subprocessConfig, initialRoots);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to connect MCP server "${serverName}": ${message} -- skipping`);
      continue;
    }
    await registerServerToolsWithCoordinator(coordinator, serverName);
  }

  // Virtual-only proxy subprocess (domain management tools). Only
  // exists when MITM is active (Docker Agent Mode). MITM_CONTROL_ADDR
  // is set exclusively here; no backend credentials, no SERVER_FILTER
  // mapping to a real server.
  if (config.mitmControlAddr) {
    const virtualProxyConfig: MCPServerConfig = {
      command: PROXY_COMMAND,
      args: [...PROXY_ARGS],
      env: {
        ...proxyEnv,
        SERVER_FILTER: 'proxy',
        MITM_CONTROL_ADDR: config.mitmControlAddr,
      },
      sandbox: false,
    };
    try {
      await manager.connect('proxy', virtualProxyConfig, initialRoots);
      await registerServerToolsWithCoordinator(coordinator, 'proxy');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to connect virtual proxy subprocess: ${message}`);
    }
  }
}

/**
 * Asks the subprocess for its tool list and registers each tool with
 * the coordinator. The coordinator shares the manager's live
 * `ClientState` so `addRootToClient` mutates the same array the
 * manager returns from its `roots/list` handler.
 */
async function registerServerToolsWithCoordinator(coordinator: ToolCallCoordinator, serverName: string): Promise<void> {
  const manager = coordinator.getMcpManager();
  const clientState = manager.getClientState(serverName);
  if (!clientState) {
    logger.warn(`[sandbox] No live client for server "${serverName}" after connect -- skipping`);
    return;
  }
  const tools = await manager.listTools(serverName);
  const coordinatorTools: CoordinatorTool[] = tools.map((t) => ({
    serverName,
    name: t.name,
    description: t.description,
    inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
  }));
  coordinator.registerTools(serverName, coordinatorTools, clientState);
}

/**
 * Builds the environment block passed to router-mode subprocesses.
 *
 * Router subprocesses are pure MCP relays: they load the compiled
 * policy only to derive MCP roots advertised at connection time, and
 * forward CallTool requests verbatim. They do NOT construct the
 * security kernel (PolicyEngine/AuditLog/CircuitBreaker/
 * ApprovalWhitelist/auto-approve model) -- the coordinator in the
 * parent process owns all of that.
 *
 * As a result, the following env vars are deliberately omitted:
 *   - AUDIT_LOG_PATH, AUDIT_REDACTION   -- coordinator owns audit
 *   - CONSTITUTION_PATH                 -- never read by the proxy
 *   - PROTECTED_PATHS                   -- only used by PolicyEngine
 *   - ESCALATION_DIR                    -- only used by escalation path
 *   - AUTO_APPROVE_*                    -- coordinator owns auto-approve
 */
function buildProxySubprocessEnv(config: IronCurtainConfig): Record<string, string> {
  const env: Record<string, string> = {
    MCP_SERVERS_CONFIG: JSON.stringify(config.mcpServers),
    // Needed for policy-root derivation (advertised to backend MCP
    // servers as MCP Roots at connection time).
    GENERATED_DIR: config.generatedDir,
    TOOL_ANNOTATIONS_DIR: config.toolAnnotationsDir ?? config.generatedDir,
    ALLOWED_DIRECTORY: config.allowedDirectory,
    CONTAINER_WORKSPACE_DIR,
    ESCALATION_TIMEOUT_SECONDS: String(config.escalationTimeoutSeconds),
    SANDBOX_POLICY: config.sandboxPolicy ?? 'warn',
    ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
  };

  if (config.sessionLogPath) env.SESSION_LOG_PATH = config.sessionLogPath;
  if (config.isPtySession) env.IRONCURTAIN_PTY_SESSION = '1';

  return env;
}
