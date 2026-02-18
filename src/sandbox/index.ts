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

export interface CodeExecutionResult {
  result: unknown;
  logs: string[];
}

export class Sandbox {
  private client: CodeModeUtcpClient | null = null;
  private toolInterfaces: string = '';

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
    };

    // Pass the escalation directory to the proxy when configured.
    // When set, the proxy uses file-based IPC for escalation instead of auto-deny.
    if (config.escalationDir) {
      proxyEnv.ESCALATION_DIR = config.escalationDir;
    }

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
            timeout: 30000,
          },
        },
      },
    });

    this.toolInterfaces = await this.discoverToolInterfaces();
  }

  /**
   * Retrieves the generated TypeScript interface declarations for all
   * registered tools. These are injected into the agent's system prompt
   * so the LLM knows what functions are available in the sandbox.
   */
  private async discoverToolInterfaces(): Promise<string> {
    if (!this.client) throw new Error('Sandbox not initialized');

    try {
      // __interfaces is a Code Mode built-in that returns the
      // generated TypeScript declarations for all registered tools.
      const { result } = await this.client.callToolChain(
        'return __interfaces ?? "No interfaces available"',
        15000,
      );
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    } catch {
      return 'Tool interfaces not available — use filesystem.* tools';
    }
  }

  getToolInterfaces(): string {
    return this.toolInterfaces;
  }

  async executeCode(code: string, timeoutMs = 30000): Promise<CodeExecutionResult> {
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
