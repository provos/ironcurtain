import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CompatibilityCallToolResultSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '../config/types.js';
import * as logger from '../logger.js';
import { VERSION } from '../version.js';
import { permissiveJsonSchemaValidator } from './permissive-output-validator.js';

export const ROOTS_REFRESH_TIMEOUT_MS = 5_000;

export interface McpRoot {
  uri: string;
  name: string;
}

/**
 * Per-server connection state exposed to callers that need to interact
 * with the live MCP client (e.g. the coordinator's roots-expansion
 * path). Owned and mutated by `MCPClientManager`; callers receive the
 * live reference so their mutations (e.g. pushing new roots) and the
 * manager's `roots/list` responses share a single array.
 *
 * `rootsRefreshed` is a one-shot callback set by `addRootToClient` in
 * `tool-call-pipeline.ts`. The manager fires and clears it when the
 * connected MCP server issues a `roots/list` request after receiving
 * our `notifications/roots/list_changed` notification.
 */
export interface ClientState {
  client: Client;
  roots: McpRoot[];
  rootsRefreshed?: () => void;
}

interface ManagedServer extends ClientState {
  transport: StdioClientTransport;
}

export class MCPClientManager {
  private servers = new Map<string, ManagedServer>();

  async connect(name: string, config: MCPServerConfig, roots?: McpRoot[]): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...(process.env as Record<string, string>), ...config.env },
    });

    // Permissive validator bypasses client-side outputSchema validation that
    // breaks on MCP servers returning non-conforming structuredContent on errors.
    // See permissive-output-validator.ts for full context and SDK issue link.
    // Always advertise `roots.listChanged` so backend servers know to
    // subscribe to updates. Escalation-time root expansion relies on
    // this capability being present even when we connected with an
    // empty initial roots list.
    const client = new Client(
      { name: 'ironcurtain', version: VERSION },
      {
        capabilities: { roots: { listChanged: true } },
        jsonSchemaValidator: permissiveJsonSchemaValidator,
      },
    );

    // Always initialize a mutable roots array so `addRootToClient` can
    // extend it at escalation time even when we started with none.
    const mutableRoots: McpRoot[] = roots ? [...roots] : [];
    const managed: ManagedServer = { client, transport, roots: mutableRoots };

    // When the server asks for roots, return the current set. The
    // handler is always registered so escalation-time root additions
    // are observable even if we connected with an empty initial list.
    client.setRequestHandler(ListRootsRequestSchema, () => {
      if (managed.rootsRefreshed) {
        managed.rootsRefreshed();
        managed.rootsRefreshed = undefined;
      }
      return { roots: managed.roots };
    });

    try {
      await client.connect(transport);
    } catch (err) {
      // Clean up the spawned subprocess so it doesn't leak.
      try {
        await client.close();
      } catch {
        // best-effort
      }
      throw err;
    }
    this.servers.set(name, managed);
  }

  /**
   * Returns the live MCP `Client` for a connected server, or undefined
   * when the server is not connected. Exposed so the coordinator can
   * wire an existing client through `ClientState` for
   * `handleCallTool`'s escalation/roots-expansion paths.
   *
   * Callers must not mutate client internals; use the manager's public
   * methods (`callTool`) for state-changing operations.
   */
  getClient(serverName: string): Client | undefined {
    return this.servers.get(serverName)?.client;
  }

  /** Returns the root list tracked for a connected server, if any. */
  getRoots(serverName: string): McpRoot[] | undefined {
    return this.servers.get(serverName)?.roots;
  }

  /**
   * Returns the live `ClientState` for a connected server. Callers use
   * this to share the manager's mutable `roots` array and one-shot
   * `rootsRefreshed` slot with the tool-call pipeline's
   * `addRootToClient`, so a single mutation is both visible to the
   * `roots/list` handler and observable as a refresh event.
   */
  getClientState(serverName: string): ClientState | undefined {
    return this.servers.get(serverName);
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

    // CompatibilityCallToolResultSchema accepts the legacy `toolResult` response format.
    // Output schema validation is intentionally bypassed by the permissiveJsonSchemaValidator
    // on the Client (always returns { valid: true }) so schema issues don't hide real MCP tool errors.
    return server.client.callTool({ name: toolName, arguments: args }, CompatibilityCallToolResultSchema);
  }

  async closeAll(): Promise<void> {
    for (const [name, server] of this.servers) {
      try {
        await server.client.close();
      } catch (err) {
        logger.error(`Error closing MCP server "${name}": ${String(err)}`);
      }
    }
    this.servers.clear();
  }
}
