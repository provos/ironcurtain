import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPServerConfig } from '../config/types.js';
import * as logger from '../logger.js';

interface ManagedServer {
  client: Client;
  transport: StdioClientTransport;
}

export class MCPClientManager {
  private servers = new Map<string, ManagedServer>();

  async connect(name: string, config: MCPServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env ? { ...process.env as Record<string, string>, ...config.env } : undefined,
    });

    const client = new Client(
      { name: 'ironcurtain', version: '0.1.0' },
    );

    await client.connect(transport);
    this.servers.set(name, { client, transport });
  }

  async listTools(serverName: string): Promise<{ name: string; description?: string; inputSchema: unknown }[]> {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`MCP server "${serverName}" not connected`);
    }

    const result = await server.client.listTools();
    return result.tools.map(tool => ({
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

    return server.client.callTool({ name: toolName, arguments: args });
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
