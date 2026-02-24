#!/usr/bin/env npx tsx
/**
 * Developer script: connects to configured MCP servers, lists their tools,
 * and prints the system prompts for both session types (agent / Docker agent).
 *
 * Usage: npx tsx scripts/show-system-prompt.ts
 */

import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config/index.js';
import { toCallableName, extractRequiredParams } from '../src/sandbox/index.js';
import { buildSystemPrompt } from '../src/session/prompts.js';
import { claudeCodeAdapter } from '../src/docker/adapters/claude-code.js';
import { extractAllowedDomains } from '../src/docker/orientation.js';
import type { ToolInfo, OrientationContext } from '../src/docker/agent-adapter.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Ensure the sandbox directory exists so the filesystem server can start.
  mkdirSync(config.allowedDirectory, { recursive: true });

  // Connect to each MCP server and list tools.
  // Uses Client/StdioClientTransport directly (instead of MCPClientManager)
  // so we can pipe stderr to suppress server log output.
  const allTools: { serverName: string; name: string; description?: string; inputSchema: unknown }[] = [];
  const clients: { client: Client; transport: StdioClientTransport }[] = [];

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    try {
      const transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env
          ? { ...(process.env as Record<string, string>), ...serverConfig.env }
          : undefined,
        stderr: 'pipe',
      });
      // Drain piped stderr to prevent backpressure
      transport.stderr?.on('data', () => {});

      const client = new Client({ name: 'show-system-prompt', version: '0.0.0' });
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

  // Shut down all clients
  for (const { client } of clients) {
    try {
      await client.close();
    } catch {
      // ignore shutdown errors
    }
  }

  // --- Agent session prompt (Code Mode / sandbox) ---
  const catalogLines: string[] = [];
  for (const t of allTools) {
    // Code Mode names tools as: <serverName>.<serverName>_<toolName>
    const utcpName = `${t.serverName}.${t.serverName}_${t.name}`;
    const callableName = toCallableName(utcpName);
    const params = extractRequiredParams(
      t.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined,
    );
    catalogLines.push(`- \`${callableName}(${params})\` — ${t.description ?? 'no description'}`);
  }
  const toolCatalog = catalogLines.length > 0 ? catalogLines.join('\n') : 'No tools available';
  const agentPrompt = buildSystemPrompt(toolCatalog, config.allowedDirectory);

  // --- Docker agent session prompt (Claude Code adapter) ---
  const dockerTools: ToolInfo[] = allTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
  }));

  const orientationContext: OrientationContext = {
    workspaceDir: '/workspace',
    hostSandboxDir: config.allowedDirectory,
    tools: dockerTools,
    allowedDomains: extractAllowedDomains(config),
  };
  const dockerPrompt = claudeCodeAdapter.buildSystemPrompt(orientationContext);

  // --- Print both ---
  const separator = '='.repeat(72);

  console.log(separator);
  console.log('  AGENT SESSION SYSTEM PROMPT (Code Mode / Sandbox)');
  console.log(separator);
  console.log();
  console.log(agentPrompt);

  console.log();
  console.log(separator);
  console.log('  DOCKER AGENT SESSION SYSTEM PROMPT (Claude Code adapter)');
  console.log(separator);
  console.log();
  console.log(dockerPrompt);
}

main().catch((err) => {
  process.stderr.write(`Error: ${String(err)}\n`);
  process.exit(1);
});
