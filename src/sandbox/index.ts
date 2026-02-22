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
import { parseModelId, resolveApiKeyForProvider } from '../config/model-provider.js';

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

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- monkey-patch requires untyped apply()
const originalRequest: Function = Protocol.prototype.request;
Protocol.prototype.request = function (
  this: unknown,
  ...args: [request: unknown, schema: unknown, options?: { timeout?: number }]
) {
  const options = args[2] ?? {};
  if (!options.timeout) {
    args[2] = { ...options, timeout: escalationTimeoutMs };
  }
  return originalRequest.apply(this, args);
} as typeof Protocol.prototype.request;

// Detect compiled (.js in dist/) vs source (.ts in src/) mode.
// In compiled mode, spawn with `node`; in source mode, spawn with `npx tsx`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isCompiled = __filename.endsWith('.js');
const proxyServerPath = resolve(__dirname, `../trusted-process/mcp-proxy-server.${isCompiled ? 'js' : 'ts'}`);
const PROXY_COMMAND = isCompiled ? 'node' : 'npx';
const PROXY_ARGS = isCompiled ? [proxyServerPath] : ['tsx', proxyServerPath];

/**
 * Transforms a UTCP tool name (dotted) into the actual callable function name
 * in the sandbox. Mirrors UTCP Code Mode's sanitizeIdentifier() behavior:
 * split on first dot (manual name), join remaining parts with underscores.
 *
 * Example: "filesystem.filesystem.list_directory" → "filesystem.filesystem_list_directory"
 */
export function toCallableName(toolName: string): string {
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');
  if (!toolName.includes('.')) return sanitize(toolName);
  const [manual, ...parts] = toolName.split('.');
  return `${sanitize(manual)}.${parts.map(sanitize).join('_')}`;
}

/**
 * Extracts required parameter names from a tool's JSON Schema inputs
 * to show inline in the catalog, e.g. "{ path }" or "{ path, content }".
 */
function extractRequiredParams(inputs?: { properties?: Record<string, unknown>; required?: string[] }): string {
  if (!inputs?.required?.length) return '';
  return `{ ${inputs.required.join(', ')} }`;
}

export interface CodeExecutionResult {
  result: unknown;
  logs: string[];
}

/**
 * Builds a JavaScript snippet that patches __getToolInterface inside the
 * sandbox isolate so that callable names (with underscores) resolve to
 * the same interface as the raw UTCP tool names (with dots).
 *
 * UTCP Code Mode keys its interface map by raw tool name (e.g.,
 * "tools.git.git_add") but the callable function name the agent sees
 * uses underscores (e.g., "tools.git_git_add"). Without this patch,
 * __getToolInterface(callableName) returns null.
 */
function buildInterfacePatchSnippet(callableToRawMap: Record<string, string>): string {
  const mapJson = JSON.stringify(callableToRawMap);
  // The snippet runs inside the V8 isolate before user code.
  // It wraps the existing __getToolInterface to also accept callable names.
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
          return null;
        };
      }
    })();
  `;
}

export class Sandbox {
  private client: CodeModeUtcpClient | null = null;
  private toolCatalog: string = '';
  private interfacePatchSnippet: string = '';

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
      CONSTITUTION_PATH: config.constitutionPath,
      PROTECTED_PATHS: JSON.stringify(config.protectedPaths),
      ALLOWED_DIRECTORY: config.allowedDirectory,
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
      const serverCreds = config.userConfig.serverCredentials[serverName];
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
      const errors = registration.errors?.join(', ') ?? 'unknown error';
      throw new Error(`Failed to register MCP servers: ${errors}`);
    }

    const { catalog, patchSnippet } = await this.buildToolCatalogAndPatch();
    this.toolCatalog = catalog;
    this.interfacePatchSnippet = patchSnippet;
  }

  /**
   * Builds the tool catalog and the __getToolInterface patch in one pass.
   *
   * The catalog is a compact one-line-per-tool listing using callable names.
   * The patch snippet maps callable names back to raw UTCP names so that
   * __getToolInterface works with either naming convention.
   */
  private async buildToolCatalogAndPatch(): Promise<{ catalog: string; patchSnippet: string }> {
    if (!this.client) throw new Error('Sandbox not initialized');

    const tools = await this.client.getTools();
    if (tools.length === 0) return { catalog: 'No tools available', patchSnippet: '' };

    const callableToRaw: Record<string, string> = {};
    const catalogLines: string[] = [];

    for (const t of tools) {
      const callableName = toCallableName(t.name);
      const params = extractRequiredParams(t.inputs);
      catalogLines.push(`- \`${callableName}(${params})\` — ${t.description}`);

      // Only add mapping when the names actually differ
      if (callableName !== t.name) {
        callableToRaw[callableName] = t.name;
      }
    }

    const patchSnippet = Object.keys(callableToRaw).length > 0 ? buildInterfacePatchSnippet(callableToRaw) : '';

    return { catalog: catalogLines.join('\n'), patchSnippet };
  }

  getToolInterfaces(): string {
    return this.toolCatalog;
  }

  async executeCode(code: string, timeoutMs = 300000): Promise<CodeExecutionResult> {
    if (!this.client) throw new Error('Sandbox not initialized');

    // Prepend the interface patch so __getToolInterface accepts callable names.
    // Each callToolChain invocation creates a fresh V8 isolate, so the patch
    // must be re-applied every time.
    const patchedCode = this.interfacePatchSnippet ? `${this.interfacePatchSnippet}\n${code}` : code;

    const { result, logs } = await this.client.callToolChain(patchedCode, timeoutMs);
    return { result, logs: logs ?? [] };
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
