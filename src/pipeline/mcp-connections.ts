/**
 * MCP server connection helpers for dynamic list resolution.
 *
 * Connects to MCP servers needed by list definitions that require
 * tool-use-based resolution (requiresMcp: true).
 */

import chalk from 'chalk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { permissiveJsonSchemaValidator } from '../trusted-process/permissive-output-validator.js';
import { VERSION } from '../version.js';
import type { MCPServerConfig } from '../config/types.js';
import type { ListDefinition } from './types.js';
import type { McpServerConnection } from './list-resolver.js';

/**
 * Connects to MCP servers needed for data-backed list resolution.
 * Only connects to servers hinted by list definitions with requiresMcp: true.
 * Returns a map keyed by server name for the resolver.
 */
export async function connectMcpServersForLists(
  definitions: ListDefinition[],
  mcpServers: Record<string, MCPServerConfig>,
): Promise<Map<string, McpServerConnection>> {
  const mcpDefs = definitions.filter((d) => d.requiresMcp);
  const hasUnhintedLists = mcpDefs.some((d) => !d.mcpServerHint);

  // Connect all configured servers if any list lacks a hint,
  // otherwise connect only the hinted servers.
  const neededServers = hasUnhintedLists
    ? new Set(Object.keys(mcpServers))
    : new Set(
        mcpDefs
          .filter((d): d is typeof d & { mcpServerHint: string } => d.mcpServerHint != null)
          .map((d) => d.mcpServerHint),
      );

  const entries = await Promise.all(
    [...neededServers].map(async (serverName): Promise<[string, McpServerConnection] | null> => {
      const serverConfig = mcpServers[serverName];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- serverName may not exist in mcpServers at runtime (from mcpServerHint)
      if (!serverConfig) {
        console.error(`  ${chalk.yellow('Warning:')} MCP server "${serverName}" not configured — skipping`);
        return null;
      }

      const transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env ? { ...(process.env as Record<string, string>), ...serverConfig.env } : undefined,
        stderr: 'pipe',
      });
      // Drain piped stderr to prevent backpressure
      if (transport.stderr) {
        transport.stderr.on('data', () => {});
      }

      const client = new Client(
        { name: 'ironcurtain-list-resolver', version: VERSION },
        { jsonSchemaValidator: permissiveJsonSchemaValidator },
      );
      await client.connect(transport);
      const toolsResult = await client.listTools();

      return [serverName, { client, tools: toolsResult.tools }];
    }),
  );

  return new Map(entries.filter((e): e is [string, McpServerConnection] => e !== null));
}

export async function disconnectMcpServers(connections: Map<string, McpServerConnection>): Promise<void> {
  for (const conn of connections.values()) {
    try {
      await conn.client.close();
    } catch {
      // Ignore cleanup errors
    }
  }
}
