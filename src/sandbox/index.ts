/**
 * Sandbox -- Sets up UTCP Code Mode with the MCP proxy server.
 *
 * Code Mode creates a sandboxed TypeScript execution environment where
 * LLM-generated code runs with no direct access to the network, filesystem,
 * or credentials. Instead of connecting to real MCP servers, it connects
 * to our MCP proxy server which evaluates policy on every tool call.
 */

import '@utcp/mcp'; // Register MCP call template type with UTCP SDK
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IronCurtainConfig } from '../config/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_SERVER_PATH = resolve(__dirname, '../trusted-process/mcp-proxy-server.ts');

/**
 * Transforms a UTCP tool name (dotted) into the actual callable function name
 * in the sandbox. Mirrors UTCP Code Mode's sanitizeIdentifier() behavior:
 * split on first dot (manual name), join remaining parts with underscores.
 *
 * Example: "filesystem.filesystem.list_directory" → "filesystem.filesystem_list_directory"
 */
function toCallableName(toolName: string): string {
  const sanitize = (s: string) =>
    s.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');
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

export class Sandbox {
  private client: CodeModeUtcpClient | null = null;
  private toolCatalog: string = '';

  async initialize(config: IronCurtainConfig): Promise<void> {
    this.client = await CodeModeUtcpClient.create();

    // Register the MCP proxy server instead of real MCP servers.
    // The proxy is the trusted process boundary -- it evaluates policy
    // on every tool call before forwarding to the real MCP server.
    const proxyEnv: Record<string, string> = {
      AUDIT_LOG_PATH: config.auditLogPath,
      MCP_SERVERS_CONFIG: JSON.stringify(config.mcpServers),
      GENERATED_DIR: config.generatedDir,
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
    const timeoutMs = config.escalationTimeoutSeconds * 1000;

    // Pass sandbox availability policy to the proxy process
    proxyEnv.SANDBOX_POLICY = config.sandboxPolicy ?? 'warn';

    await this.client.registerManual({
      name: 'filesystem',
      call_template_type: 'mcp',
      config: {
        mcpServers: {
          filesystem: {
            transport: 'stdio',
            command: 'npx',
            args: ['tsx', PROXY_SERVER_PATH],
            env: proxyEnv,
            timeout: timeoutMs,
          },
        },
      },
    });

    this.toolCatalog = await this.buildToolCatalog();
  }

  /**
   * Builds a compact one-line-per-tool catalog from registered tools.
   * Each entry shows the correct callable function name (with underscores)
   * and required parameters so the LLM can invoke tools without introspection.
   */
  private async buildToolCatalog(): Promise<string> {
    if (!this.client) throw new Error('Sandbox not initialized');

    try {
      const tools = await this.client.getTools();
      if (tools.length === 0) return 'No tools available';
      return tools
        .map((t) => {
          const callableName = toCallableName(t.name);
          const params = extractRequiredParams(t.inputs);
          return `- \`${callableName}(${params})\` — ${t.description}`;
        })
        .join('\n');
    } catch {
      return 'Tool catalog not available — use filesystem.* tools';
    }
  }

  getToolInterfaces(): string {
    return this.toolCatalog;
  }

  async executeCode(code: string, timeoutMs = 300000): Promise<CodeExecutionResult> {
    if (!this.client) throw new Error('Sandbox not initialized');

    const { result, logs } = await this.client.callToolChain(code, timeoutMs);
    return { result, logs: logs ?? [] };
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
