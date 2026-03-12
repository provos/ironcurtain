#!/usr/bin/env node

/**
 * Entry point for the memory MCP server.
 * Parses config from environment, initializes the engine,
 * starts the MCP server on stdio, and handles graceful shutdown.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createMemoryEngineFromConfig } from './engine-impl.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const engine = createMemoryEngineFromConfig(config);

  const server = createServer(engine);
  const transport = new StdioServerTransport();

  // Graceful shutdown
  const shutdown = (): void => {
    engine.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error('[memory-server] Fatal error:', err);
  process.exit(1);
});
