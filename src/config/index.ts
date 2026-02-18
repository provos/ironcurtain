import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IronCurtainConfig, MCPServerConfig } from './types.js';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../pipeline/types.js';
import { getIronCurtainHome } from './paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadConfig(): IronCurtainConfig {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  const auditLogPath = process.env.AUDIT_LOG_PATH ?? './audit.jsonl';
  // Default to a path under the IronCurtain home directory.
  // In practice, the session factory overrides this per-session,
  // so this default is a fallback for non-session usage (e.g., pipeline).
  const defaultAllowedDir = resolve(getIronCurtainHome(), 'sandbox');
  const allowedDirectory = process.env.ALLOWED_DIRECTORY ?? defaultAllowedDir;

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

  const constitutionPath = resolve(__dirname, 'constitution.md');
  const generatedDir = resolve(__dirname, 'generated');

  const protectedPaths = [
    constitutionPath,
    generatedDir,
    mcpServersPath,
    resolve(auditLogPath),
  ];

  return {
    anthropicApiKey,
    auditLogPath,
    allowedDirectory,
    mcpServers,
    protectedPaths,
    generatedDir,
    constitutionPath,
  };
}

export function loadGeneratedPolicy(generatedDir: string): {
  compiledPolicy: CompiledPolicyFile;
  toolAnnotations: ToolAnnotationsFile;
} {
  const compiledPolicy: CompiledPolicyFile = JSON.parse(
    readFileSync(resolve(generatedDir, 'compiled-policy.json'), 'utf-8'),
  );
  const toolAnnotations: ToolAnnotationsFile = JSON.parse(
    readFileSync(resolve(generatedDir, 'tool-annotations.json'), 'utf-8'),
  );
  return { compiledPolicy, toolAnnotations };
}
