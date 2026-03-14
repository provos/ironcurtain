/**
 * Memory MCP server annotations, policy rules, and server configuration.
 *
 * Provides hardcoded tool annotations and a blanket-allow policy rule for
 * the memory server, plus a builder for the MCP server config entry.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolAnnotation, CompiledRule, CompiledPolicyFile, ToolAnnotationsFile } from '../pipeline/types.js';
import type { MCPServerConfig } from '../config/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MEMORY_SERVER_NAME = 'memory';

/**
 * Hardcoded tool annotations for all 5 memory tools (shared constant).
 * Args must match the schemas registered in packages/memory-mcp-server/src/server.ts.
 */
const MEMORY_TOOL_ANNOTATIONS: ToolAnnotation[] = [
  {
    toolName: 'memory_store',
    serverName: MEMORY_SERVER_NAME,
    comment: 'Stores a memory for later retrieval.',
    sideEffects: true,
    args: { content: ['none'], tags: ['none'], importance: ['none'] },
  },
  {
    toolName: 'memory_recall',
    serverName: MEMORY_SERVER_NAME,
    comment: 'Recalls memories relevant to a query.',
    sideEffects: false,
    args: { query: ['none'], token_budget: ['none'], tags: ['none'], format: ['none'] },
  },
  {
    toolName: 'memory_context',
    serverName: MEMORY_SERVER_NAME,
    comment: 'Gets a session briefing of relevant memories.',
    sideEffects: false,
    args: { task: ['none'], token_budget: ['none'] },
  },
  {
    toolName: 'memory_forget',
    serverName: MEMORY_SERVER_NAME,
    comment: 'Forgets specific memories by ID, tag, or query match.',
    sideEffects: true,
    args: { ids: ['none'], tags: ['none'], query: ['none'], before: ['none'], confirm: ['none'], dry_run: ['none'] },
  },
  {
    toolName: 'memory_inspect',
    serverName: MEMORY_SERVER_NAME,
    comment: 'View memory statistics, recent or important memories.',
    sideEffects: false,
    args: { view: ['none'], ids: ['none'], limit: ['none'] },
  },
];

/** Returns the shared memory tool annotations array. */
export function getMemoryToolAnnotations(): ToolAnnotation[] {
  return MEMORY_TOOL_ANNOTATIONS;
}

/** Blanket-allow rule for all memory server tools. */
export const MEMORY_BLANKET_ALLOW_RULE: CompiledRule = {
  name: 'allow-all-memory-tools',
  description: 'Blanket-allow all memory server tools.',
  principle: 'Memory operations are internal and always safe.',
  if: { server: [MEMORY_SERVER_NAME] },
  then: 'allow',
  reason: 'Memory tools operate on an internal database with no external side effects.',
};

/**
 * Injects memory server tool annotations and blanket-allow policy rule
 * into the loaded policy artifacts. Called from both the TrustedProcess
 * constructor and the MCP proxy server main().
 */
export function injectMemoryAnnotations(
  toolAnnotations: ToolAnnotationsFile,
  compiledPolicy: CompiledPolicyFile,
): void {
  toolAnnotations.servers[MEMORY_SERVER_NAME] = {
    inputHash: 'builtin',
    tools: getMemoryToolAnnotations(),
  };
  compiledPolicy.rules.unshift(MEMORY_BLANKET_ALLOW_RULE);
}

/** Resolved path to the memory-mcp-server entry point (computed once). */
const SERVER_ENTRY = resolve(__dirname, '..', '..', 'packages', 'memory-mcp-server', 'dist', 'index.js');

/**
 * Builds the MCP server config for the memory server.
 *
 * The server runs as a Node.js subprocess using the compiled
 * memory-mcp-server package entry point. Configuration is passed
 * via environment variables.
 */
export function buildMemoryServerConfig(opts: {
  dbPath: string;
  namespace?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
}): MCPServerConfig {
  const env: Record<string, string> = {
    MEMORY_DB_PATH: opts.dbPath,
  };

  if (opts.namespace) {
    env.MEMORY_NAMESPACE = opts.namespace;
  }

  // LLM config: only set when explicitly configured. The memory server uses
  // an OpenAI-compatible client, so Anthropic API keys don't work as a fallback.
  // Without LLM vars the server degrades gracefully (no summarization/compaction).
  if (opts.llmBaseUrl) {
    env.MEMORY_LLM_BASE_URL = opts.llmBaseUrl;
  }
  if (opts.llmApiKey) {
    env.MEMORY_LLM_API_KEY = opts.llmApiKey;
  }

  return {
    command: 'node',
    args: [SERVER_ENTRY],
    env,
    description: 'Persistent memory with semantic search',
    sandbox: false,
  };
}
