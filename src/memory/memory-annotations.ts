/**
 * Memory MCP server name constant and server configuration builder.
 *
 * The memory server is registered as a "trusted server" in the PolicyEngine,
 * bypassing annotation lookup and policy evaluation entirely. No annotations
 * or policy rules are needed here.
 */

import { createRequire } from 'node:module';
import type { MCPServerConfig } from '../config/types.js';

export const MEMORY_SERVER_NAME = 'memory';

/**
 * Resolved path to the memory-mcp-server entry point (computed once).
 *
 * Uses Node module resolution so the path works both in development
 * (workspace symlink) and production (installed from npm).
 */
export const MEMORY_SERVER_ENTRY = createRequire(import.meta.url).resolve('@provos/memory-mcp-server');

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
    args: [MEMORY_SERVER_ENTRY],
    env,
    description: 'Persistent memory with semantic search',
    sandbox: false,
  };
}
