import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IronCurtainConfig, MCPServerConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadConfig(): IronCurtainConfig {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  const auditLogPath = process.env.AUDIT_LOG_PATH ?? './audit.jsonl';
  const allowedDirectory = process.env.ALLOWED_DIRECTORY ?? '/tmp/ironcurtain-sandbox';

  const mcpServersPath = resolve(__dirname, 'mcp-servers.json');
  const mcpServers: Record<string, MCPServerConfig> = JSON.parse(
    readFileSync(mcpServersPath, 'utf-8'),
  );

  // Sync the filesystem server's allowed directory with the configured value.
  // The mcp-servers.json ships with a default path that may differ from
  // the ALLOWED_DIRECTORY environment variable.
  const fsServer = mcpServers['filesystem'];
  if (fsServer) {
    const defaultDir = '/tmp/ironcurtain-sandbox';
    const dirIndex = fsServer.args.indexOf(defaultDir);
    if (dirIndex !== -1) {
      fsServer.args[dirIndex] = allowedDirectory;
    }
  }

  return {
    anthropicApiKey,
    auditLogPath,
    allowedDirectory,
    mcpServers,
  };
}
