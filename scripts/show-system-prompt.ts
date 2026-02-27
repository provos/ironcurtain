#!/usr/bin/env npx tsx
/**
 * Developer script: connects to configured MCP servers, lists their tools,
 * and prints the system prompts for both session types (agent / Docker agent).
 *
 * Usage: npx tsx scripts/show-system-prompt.ts
 */

import 'dotenv/config';
import { loadConfig } from '../src/config/index.js';
import { toCallableName, extractRequiredParams } from '../src/sandbox/index.js';
import { buildSystemPrompt } from '../src/session/prompts.js';
import { claudeCodeAdapter } from '../src/docker/adapters/claude-code.js';
import { extractAllowedDomains } from '../src/docker/orientation.js';
import type { OrientationContext } from '../src/docker/agent-adapter.js';
import { discoverTools, buildServerListings } from './mcp-discovery.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const allTools = await discoverTools(config, 'show-system-prompt');

  // --- Agent session prompt (Code Mode / sandbox) ---
  const serverListings = buildServerListings(allTools, config);
  const agentPrompt = buildSystemPrompt(serverListings, config.allowedDirectory);

  // Also build the old-style full catalog for comparison
  const catalogLines: string[] = [];
  for (const t of allTools) {
    const utcpName = `${t.serverName}.${t.serverName}_${t.name}`;
    const callableName = toCallableName(utcpName);
    const params = extractRequiredParams(
      t.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined,
    );
    catalogLines.push(`- \`${callableName}(${params})\` --- ${t.description ?? 'no description'}`);
  }
  const toolCatalog = catalogLines.length > 0 ? catalogLines.join('\n') : 'No tools available';

  // --- Docker agent session prompt (Claude Code adapter) ---
  const orientationContext: OrientationContext = {
    workspaceDir: '/workspace',
    hostSandboxDir: config.allowedDirectory,
    serverListings,
    allowedDomains: extractAllowedDomains(config),
    networkMode: 'none',
  };
  const dockerPrompt = claudeCodeAdapter.buildSystemPrompt(orientationContext);

  // --- Print all ---
  const separator = '='.repeat(72);

  console.log(separator);
  console.log('  AGENT SESSION SYSTEM PROMPT (Code Mode / Sandbox)');
  console.log(separator);
  console.log();
  console.log(agentPrompt);

  console.log();
  console.log(separator);
  console.log('  FULL TOOL CATALOG (for reference)');
  console.log(separator);
  console.log();
  console.log(toolCatalog);

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
