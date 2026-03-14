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
import '@utcp/mcp'; // Register MCP call template type with UTCP SDK
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { Protocol } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { IronCurtainConfig } from '../config/types.js';
import { CONTAINER_WORKSPACE_DIR } from '../docker/agent-adapter.js';
import { parseModelId, resolveApiKeyForProvider } from '../config/model-provider.js';
import { resolveNodeModulesBin } from '../trusted-process/sandbox-integration.js';

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

/** Namespaces that must not be shadowed by alias globals. */
const RESERVED_NAMESPACES = new Set(['tools', 'help', 'console', 'global', 'undefined', 'NaN', 'Infinity']);

/**
 * Builds a JavaScript snippet that creates server-namespace aliases in the
 * V8 sandbox isolate: `global.<server> = { <tool>: global.tools.<utcpProp> }`.
 *
 * This enables `filesystem.read_file(...)` alongside the UTCP-created
 * `tools.filesystem_read_file(...)`.
 */
function buildNamespaceAliasSnippet(aliases: Array<{ newCallable: string; utcpProp: string }>): string {
  // Group by namespace
  const byNs: Record<string, Array<{ tool: string; utcpProp: string }>> = {};
  for (const { newCallable, utcpProp } of aliases) {
    const dotIdx = newCallable.indexOf('.');
    if (dotIdx === -1) continue;
    const ns = newCallable.slice(0, dotIdx);
    if (RESERVED_NAMESPACES.has(ns)) continue;
    const tool = newCallable.slice(dotIdx + 1);
    if (!(ns in byNs)) byNs[ns] = [];
    byNs[ns].push({ tool, utcpProp });
  }

  if (Object.keys(byNs).length === 0) return '';

  const lines: string[] = ['(function() {'];
  for (const [ns, tools] of Object.entries(byNs)) {
    lines.push(`  global["${ns}"] = {};`);
    for (const { tool, utcpProp } of tools) {
      lines.push(`  global["${ns}"]["${tool}"] = global["tools"]["${utcpProp}"];`);
    }
  }
  lines.push('})();');
  return lines.join('\n');
}

/**
 * Builds a JavaScript snippet that patches __getToolInterface inside the
 * sandbox isolate so that both new callable names (e.g., "filesystem.read_file")
 * and old UTCP callable names (e.g., "tools.filesystem_read_file") resolve to
 * the same interface as the raw UTCP tool names (with dots).
 *
 * UTCP Code Mode keys its interface map by raw tool name (e.g.,
 * "tools.git.git_add") but the callable function name the agent sees
 * uses the new namespace format (e.g., "git.add"). Without this patch,
 * __getToolInterface(callableName) returns null.
 */
function buildInterfacePatchSnippet(callableToRawMap: Record<string, string>): string {
  const mapJson = JSON.stringify(callableToRawMap);
  // The snippet runs inside the V8 isolate before user code.
  // It wraps the existing __getToolInterface to also accept callable names.
  // When the name is wrong, it tries auto-correction and falls back to
  // a helpful error message with suggestions.
  return `
    (function() {
      var _callableToRaw = ${mapJson};
      var _origGetToolInterface = global.__getToolInterface;
      if (_origGetToolInterface) {
        global.__getToolInterface = function(toolName) {
          var result = _origGetToolInterface(toolName);
          if (result) return result;
          var rawName = _callableToRaw[toolName];
          if (rawName) return _origGetToolInterface(rawName);

          // Auto-correct: try prepending "tools." for raw name lookup
          if (toolName && !toolName.startsWith('tools.')) {
            var prefixed = 'tools.' + toolName;
            result = _origGetToolInterface(prefixed);
            if (result) return result;
            rawName = _callableToRaw[prefixed];
            if (rawName) return _origGetToolInterface(rawName);
            // Try converting dots to underscores (e.g. "git.add" -> "tools.git_add")
            var asOldCallable = 'tools.' + toolName.replace(/\\./g, '_');
            rawName = _callableToRaw[asOldCallable];
            if (rawName) return _origGetToolInterface(rawName);
          }

          // Build helpful error with suggestions
          var allNames = Object.keys(_callableToRaw);
          var suggestions = [];
          var needle = toolName.toLowerCase().replace(/^tools\\./, '');
          for (var i = 0; i < allNames.length && suggestions.length < 3; i++) {
            if (allNames[i].toLowerCase().indexOf(needle) !== -1 ||
                needle.indexOf(allNames[i].toLowerCase().replace(/^tools\\./, '')) !== -1) {
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

export class Sandbox {
  private client: CodeModeUtcpClient | null = null;
  private toolCatalog: string = '';
  private preamble: string = '';
  private helpData: HelpData = { serverDescriptions: {}, toolsByServer: {} };

  async initialize(config: IronCurtainConfig): Promise<void> {
    // Update the Protocol.request timeout before any Client instances are created.
    setEscalationTimeout(config.escalationTimeoutSeconds);

    this.client = await CodeModeUtcpClient.create();

    // Register the MCP proxy server instead of real MCP servers.
    // The proxy is the trusted process boundary -- it evaluates policy
    // on every tool call before forwarding to the real MCP server.
    const proxyEnv: Record<string, string> = {
      AUDIT_LOG_PATH: config.auditLogPath,
      MCP_SERVERS_CONFIG: JSON.stringify(config.mcpServers),
      GENERATED_DIR: config.generatedDir,
      TOOL_ANNOTATIONS_DIR: config.toolAnnotationsDir ?? config.generatedDir,
      // Base constitution path — the proxy uses it for freshness checking
      // against the combined (base + user) constitution.
      CONSTITUTION_PATH: config.constitutionPath,
      PROTECTED_PATHS: JSON.stringify(config.protectedPaths),
      ALLOWED_DIRECTORY: config.allowedDirectory,
      CONTAINER_WORKSPACE_DIR,
    };

    // Pass the escalation directory to the proxy when configured.
    // When set, the proxy uses file-based IPC for escalation instead of auto-deny.
    if (config.escalationDir) {
      proxyEnv.ESCALATION_DIR = config.escalationDir;
    }

    // Pass the session log path so the proxy can capture child process stderr.
    if (config.sessionLogPath) {
      proxyEnv.SESSION_LOG_PATH = config.sessionLogPath;
    }

    // Pass escalation timeout to the proxy process and use it for the sandbox timeout.
    // The sandbox timeout must accommodate human escalation approval time.
    proxyEnv.ESCALATION_TIMEOUT_SECONDS = String(config.escalationTimeoutSeconds);
    const timeoutSeconds = config.escalationTimeoutSeconds;

    // Pass sandbox availability policy to the proxy process
    proxyEnv.SANDBOX_POLICY = config.sandboxPolicy ?? 'warn';

    // Pass audit redaction config to the proxy process
    if (config.userConfig.auditRedaction.enabled) {
      proxyEnv.AUDIT_REDACTION = 'true';
    }

    // Pass auto-approve config to the proxy when enabled.
    // The proxy creates its own model instance from these env vars.
    const autoApprove = config.userConfig.autoApprove;
    if (autoApprove.enabled) {
      proxyEnv.AUTO_APPROVE_ENABLED = 'true';
      proxyEnv.AUTO_APPROVE_MODEL_ID = autoApprove.modelId;
      const { provider } = parseModelId(autoApprove.modelId);
      proxyEnv.AUTO_APPROVE_API_KEY = resolveApiKeyForProvider(provider, config.userConfig);
      if (config.autoApproveLlmLogPath) {
        proxyEnv.AUTO_APPROVE_LLM_LOG_PATH = config.autoApproveLlmLogPath;
      }
    }

    // Mark PTY sessions so the proxy requires trusted input source for auto-approval
    if (config.isPtySession) {
      proxyEnv.IRONCURTAIN_PTY_SESSION = '1';
    }

    // Register one proxy per backend server so UTCP names them cleanly:
    //   tools.<serverName>_<toolName>(...)
    // Each proxy gets a SERVER_FILTER env var to connect only to its server.
    const mcpServers: Record<
      string,
      {
        transport: 'stdio';
        command: string;
        args: string[];
        env: Record<string, string>;
        timeout: number;
      }
    > = {};
    for (const serverName of Object.keys(config.mcpServers)) {
      // Per-server isolation: each proxy only receives its own credentials
      const serverCreds = config.userConfig.serverCredentials[serverName] as Record<string, string> | undefined;
      mcpServers[serverName] = {
        transport: 'stdio',
        command: PROXY_COMMAND,
        args: [...PROXY_ARGS],
        env: {
          ...proxyEnv,
          SERVER_FILTER: serverName,
          ...(serverCreds ? { SERVER_CREDENTIALS: JSON.stringify(serverCreds) } : {}),
        },
        timeout: timeoutSeconds,
      };
    }

    const registration = await this.client.registerManual({
      name: 'tools',
      call_template_type: 'mcp',
      config: { mcpServers },
    });

    if (!registration.success) {
      const errors = registration.errors.join(', ') || 'unknown error';
      throw new Error(`Failed to register MCP servers: ${errors}`);
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

    const patchSnippet = Object.keys(callableToRaw).length > 0 ? buildInterfacePatchSnippet(callableToRaw) : '';
    const aliasSnippet = namespaceAliases.length > 0 ? buildNamespaceAliasSnippet(namespaceAliases) : '';
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
  }
}
