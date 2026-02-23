import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CompatibilityCallToolResultSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '../config/types.js';
import * as logger from '../logger.js';
import { VERSION } from '../version.js';

export const ROOTS_REFRESH_TIMEOUT_MS = 5_000;

export interface McpRoot {
  uri: string;
  name: string;
}

interface ManagedServer {
  client: Client;
  transport: StdioClientTransport;
  roots?: McpRoot[];
  rootsRefreshed?: () => void;
}

export class MCPClientManager {
  private servers = new Map<string, ManagedServer>();

  async connect(name: string, config: MCPServerConfig, roots?: McpRoot[]): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env ? { ...(process.env as Record<string, string>), ...config.env } : undefined,
    });

    const client = new Client(
      { name: 'ironcurtain', version: VERSION },
      roots ? { capabilities: { roots: { listChanged: true } } } : {},
    );

    // Mutable copy -- addRoot() pushes to this array.
    const mutableRoots = roots ? [...roots] : undefined;
    const managed: ManagedServer = { client, transport, roots: mutableRoots };

    // When the server asks for roots, return the current set.
    // If a rootsRefreshed callback is registered (from addRoot),
    // resolve it so the caller knows the server has the latest roots.
    if (mutableRoots) {
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        if (managed.rootsRefreshed) {
          managed.rootsRefreshed();
          managed.rootsRefreshed = undefined;
        }
        return { roots: mutableRoots };
      });
    }

    await client.connect(transport);
    this.servers.set(name, managed);
  }

  /**
   * Adds a root directory to a connected server and waits for the
   * server to fetch the updated root list. This ensures the server's
   * allowed directories include the new root before any tool call
   * that depends on it is forwarded.
   *
   * No-op if the root URI is already present.
   */
  async addRoot(serverName: string, root: McpRoot): Promise<void> {
    const server = this.servers.get(serverName);
    if (!server?.roots) return;

    // Deduplicate
    if (server.roots.some((r) => r.uri === root.uri)) return;
    server.roots.push(root);

    // Wait for the server to call roots/list after we notify it.
    let timer: ReturnType<typeof setTimeout>;
    const refreshed = new Promise<void>((resolve) => {
      server.rootsRefreshed = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        server.rootsRefreshed = undefined;
        resolve();
      }, ROOTS_REFRESH_TIMEOUT_MS);
      timer.unref();
    });
    await server.client.sendRootsListChanged();
    await Promise.race([refreshed, timeout]);
  }

  async listTools(serverName: string): Promise<{ name: string; description?: string; inputSchema: unknown }[]> {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`MCP server "${serverName}" not connected`);
    }

    const result = await server.client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`MCP server "${serverName}" not connected`);
    }

    // TODO(workaround): Remove once @cyanheads/git-mcp-server fixes outputSchema declarations.
    // See the detailed comment in mcp-proxy-server.ts for full context.
    // CompatibilityCallToolResultSchema bypasses client-side output schema validation that
    // fails when servers declare outputSchema but return non-conforming structuredContent.
    return server.client.callTool({ name: toolName, arguments: args }, CompatibilityCallToolResultSchema);
  }

  async closeAll(): Promise<void> {
    for (const [name, server] of this.servers) {
      try {
        await server.client.close();
      } catch (err) {
        logger.error(`Error closing MCP server "${name}": ${err}`);
      }
    }
    this.servers.clear();
  }
}
