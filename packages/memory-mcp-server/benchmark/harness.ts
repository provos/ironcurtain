/**
 * Benchmark harness — spawns a memory MCP server, connects via stdio,
 * and provides helpers to store/recall/forget/inspect memories.
 *
 * Generic: works with any MCP memory server that exposes the standard
 * memory_store / memory_recall / memory_context / memory_forget / memory_inspect tools.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ServerConfig, TestMemory } from './types.js';

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export async function spawnServer(config: ServerConfig): Promise<Client> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: { ...process.env, ...config.env },
  });

  const client = new Client({ name: 'benchmark-harness', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

export async function closeServer(client: Client): Promise<void> {
  await client.close();
}

// ---------------------------------------------------------------------------
// Tool call helpers
// ---------------------------------------------------------------------------

export async function callTool(client: Client, toolName: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name: toolName, arguments: args });
  // MCP tool results are an array of content blocks; concatenate text blocks.
  const textBlocks = (result.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!);
  return textBlocks.join('\n');
}

export async function storeMemory(client: Client, memory: TestMemory): Promise<string> {
  const args: Record<string, unknown> = { content: memory.content };
  if (memory.tags) args.tags = memory.tags;
  if (memory.importance !== undefined) args.importance = memory.importance;
  return callTool(client, 'memory_store', args);
}

export async function recallMemories(
  client: Client,
  query: string,
  opts?: { tags?: string[]; tokenBudget?: number; format?: string },
): Promise<string> {
  const args: Record<string, unknown> = { query };
  if (opts?.tags) args.tags = opts.tags;
  if (opts?.tokenBudget) args.token_budget = opts.tokenBudget;
  if (opts?.format) args.format = opts.format;
  return callTool(client, 'memory_recall', args);
}

export async function getContext(client: Client, task?: string, tokenBudget?: number): Promise<string> {
  const args: Record<string, unknown> = {};
  if (task) args.task = task;
  if (tokenBudget) args.token_budget = tokenBudget;
  return callTool(client, 'memory_context', args);
}

export async function forgetMemories(
  client: Client,
  opts: {
    ids?: string[];
    tags?: string[];
    query?: string;
    before?: string;
    confirm?: boolean;
    dryRun?: boolean;
  },
): Promise<string> {
  const args: Record<string, unknown> = {};
  if (opts.ids) args.ids = opts.ids;
  if (opts.tags) args.tags = opts.tags;
  if (opts.query) args.query = opts.query;
  if (opts.before) args.before = opts.before;
  if (opts.confirm !== undefined) args.confirm = opts.confirm;
  if (opts.dryRun !== undefined) args.dry_run = opts.dryRun;
  return callTool(client, 'memory_forget', args);
}

export async function inspectMemories(
  client: Client,
  view: 'stats' | 'recent' | 'important' | 'tags',
  limit?: number,
): Promise<string> {
  const args: Record<string, unknown> = { view };
  if (limit !== undefined) args.limit = limit;
  return callTool(client, 'memory_inspect', args);
}

// ---------------------------------------------------------------------------
// Bulk store with optional delays (for temporal ordering)
// ---------------------------------------------------------------------------

export async function storeAll(client: Client, memories: TestMemory[]): Promise<void> {
  for (const mem of memories) {
    if (mem.delayAfterMs && mem.delayAfterMs > 0) {
      await delay(mem.delayAfterMs);
    }
    await storeMemory(client, mem);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
