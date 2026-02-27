/**
 * Shared MCP server discovery helper for developer scripts.
 *
 * Connects to configured MCP servers, lists their tools, and returns
 * structured tool entries. Used by show-system-prompt.ts to avoid
 * duplicating the connection/discovery logic.
 */

import { mkdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { ServerListing } from '../src/session/prompts.js';

export interface ToolEntry {
  serverName: string;
  name: string;
  description?: string;
  inputSchema: unknown;
}

/**
 * Connects to all configured MCP servers, lists their tools, and
 * returns the collected tool entries. Ensures the sandbox directory
 * exists so filesystem servers can start. Cleans up client connections
 * before returning.
 */
export async function discoverTools(config: IronCurtainConfig, clientName: string): Promise<ToolEntry[]> {
  mkdirSync(config.allowedDirectory, { recursive: true });

  const allTools: ToolEntry[] = [];
  const clients: { client: Client; transport: StdioClientTransport }[] = [];

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    try {
      const transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env ? { ...(process.env as Record<string, string>), ...serverConfig.env } : undefined,
        stderr: 'pipe',
      });
      // Drain piped stderr to prevent backpressure
      transport.stderr?.on('data', () => {});

      const client = new Client({ name: clientName, version: '0.0.0' });
      await client.connect(transport);
      clients.push({ client, transport });

      const result = await client.listTools();
      for (const tool of result.tools) {
        allTools.push({
          serverName,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    } catch (err) {
      process.stderr.write(`Warning: failed to connect to "${serverName}": ${String(err)}\n`);
    }
  }

  for (const { client } of clients) {
    try {
      await client.close();
    } catch {
      // ignore shutdown errors
    }
  }

  return allTools;
}

/**
 * Builds ServerListing entries from discovered tools and the config.
 * Uses the `description` field from mcp-servers.json when available,
 * falling back to the server name.
 */
export function buildServerListings(tools: ToolEntry[], config: IronCurtainConfig): ServerListing[] {
  const serverNames = [...new Set(tools.map((t) => t.serverName))];
  return serverNames.map((name) => ({
    name,
    description: config.mcpServers[name]?.description ?? name,
  }));
}
