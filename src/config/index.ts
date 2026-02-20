import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IronCurtainConfig, MCPServerConfig } from './types.js';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../pipeline/types.js';
import { getIronCurtainHome } from './paths.js';
import { resolveRealPath } from '../types/argument-roles.js';
import { loadUserConfig } from './user-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadConfig(): IronCurtainConfig {
  const userConfig = loadUserConfig();

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
    resolveRealPath(constitutionPath),
    resolveRealPath(generatedDir),
    resolveRealPath(mcpServersPath),
    resolveRealPath(auditLogPath),
  ];

  return {
    auditLogPath,
    allowedDirectory,
    mcpServers,
    protectedPaths,
    generatedDir,
    constitutionPath,
    agentModelId: userConfig.agentModelId,
    escalationTimeoutSeconds: userConfig.escalationTimeoutSeconds,
    userConfig,
  };
}

/**
 * Extracts domain allowlists from MCP server sandbox network configurations.
 * Filters out the `*` wildcard since it means "no domain restriction".
 * Returns a map from server name to its list of restricted domains.
 */
export function extractServerDomainAllowlists(
  mcpServers: Record<string, MCPServerConfig>,
): Map<string, string[]> {
  const allowlists = new Map<string, string[]>();
  for (const [serverName, config] of Object.entries(mcpServers)) {
    if (config.sandbox && typeof config.sandbox === 'object' && config.sandbox.network && typeof config.sandbox.network === 'object') {
      const domains = config.sandbox.network.allowedDomains.filter(d => d !== '*');
      if (domains.length > 0) {
        allowlists.set(serverName, domains);
      }
    }
  }
  return allowlists;
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
