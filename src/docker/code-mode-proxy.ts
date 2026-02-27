/**
 * CodeModeProxy -- MCP server that exposes a single `execute_code` tool
 * backed by the UTCP Code Mode sandbox.
 *
 * Replaces the old ManagedProxy (which spawned mcp-proxy-server.ts as a
 * child process). Docker agents now send TypeScript via `execute_code`,
 * sharing the same execution engine as builtin Code Mode sessions.
 *
 * Architecture:
 *   Container (Claude Code) → socat → UDS/TCP socket
 *     → CodeModeProxy (MCP Server with execute_code)
 *     → Sandbox.executeCode(code)
 *     → V8 isolate → UTCP → per-server mcp-proxy-server.ts (stdio)
 *     → PolicyEngine → real MCP servers
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UdsServerTransport } from '../trusted-process/uds-server-transport.js';
import { TcpServerTransport } from '../trusted-process/tcp-server-transport.js';
import { Sandbox, type HelpData } from '../sandbox/index.js';
import type { IronCurtainConfig } from '../config/types.js';
import { VERSION } from '../version.js';

/** Public interface for the Docker session's proxy. */
export interface DockerProxy {
  start(): Promise<void>;
  getHelpData(): HelpData;
  stop(): Promise<void>;
  readonly socketPath: string;
  readonly port: number | undefined;
}

export interface CodeModeProxyOptions {
  /** Absolute path for the UDS socket (used in UDS mode, also stored for reference in TCP mode). */
  readonly socketPath: string;
  /** Session configuration passed to the Sandbox. */
  readonly config: IronCurtainConfig;
  /** Listen mode: 'uds' (default) or 'tcp'. TCP mode uses OS-assigned port. */
  readonly listenMode?: 'uds' | 'tcp';
}

export function createCodeModeProxy(options: CodeModeProxyOptions): DockerProxy {
  const sandbox = new Sandbox();
  const useTcp = options.listenMode === 'tcp';

  let mcpServer: Server | null = null; // eslint-disable-line @typescript-eslint/no-deprecated
  let transport: UdsServerTransport | TcpServerTransport | null = null;

  return {
    socketPath: options.socketPath,

    get port(): number | undefined {
      if (transport instanceof TcpServerTransport) {
        try {
          return transport.port;
        } catch {
          return undefined;
        }
      }
      return undefined;
    },

    async start(): Promise<void> {
      // 1. Initialize the sandbox (registers MCP proxy servers per backend)
      await sandbox.initialize(options.config);

      // 2. Create the MCP server exposing a single execute_code tool
      mcpServer = new Server( // eslint-disable-line @typescript-eslint/no-deprecated
        { name: 'ironcurtain-code-mode', version: VERSION },
        { capabilities: { tools: {} } },
      );

      // eslint-disable-next-line @typescript-eslint/require-await -- MCP SDK handler must return Promise
      mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'execute_code',
            description:
              'Execute TypeScript code in a secure sandbox. ' +
              'Tool calls are synchronous (no await). ' +
              'Use `return` to send a value back. ' +
              'Call help.help() to discover available tools.',
            inputSchema: {
              type: 'object' as const,
              properties: {
                code: {
                  type: 'string',
                  description: 'TypeScript code to execute',
                },
              },
              required: ['code'],
            },
          },
        ],
      }));

      mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name !== 'execute_code') {
          return {
            content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
            isError: true,
          };
        }

        const args = request.params.arguments as { code?: string } | undefined;
        const code = args?.code;
        if (!code || typeof code !== 'string') {
          return {
            content: [{ type: 'text', text: 'Missing required parameter: code' }],
            isError: true,
          };
        }

        try {
          const { result, logs } = await sandbox.executeCode(code);
          const parts: string[] = [];

          if (logs.length > 0) {
            parts.push(`[logs]\n${logs.join('\n')}`);
          }

          if (result === undefined) {
            parts.push('(no return value)');
          } else if (typeof result === 'string') {
            parts.push(result);
          } else {
            parts.push(JSON.stringify(result, null, 2));
          }

          return {
            content: [{ type: 'text', text: parts.join('\n\n') }],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text',
                text: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      });

      // 3. Start the transport
      if (useTcp) {
        transport = new TcpServerTransport('127.0.0.1', 0);
      } else {
        transport = new UdsServerTransport(options.socketPath);
      }

      await mcpServer.connect(transport);
    },

    getHelpData(): HelpData {
      return sandbox.getHelpData();
    },

    async stop(): Promise<void> {
      if (mcpServer) {
        await mcpServer.close();
        mcpServer = null;
      }
      // mcpServer.close() closes the transport, but shutdown sandbox separately
      transport = null;
      await sandbox.shutdown();
    },
  };
}
