import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IronCurtainConfig, MCPServerConfig } from './types.js';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../pipeline/types.js';
import { getIronCurtainHome, getUserGeneratedDir } from './paths.js';
import { resolveRealPath } from '../types/argument-roles.js';
import { loadUserConfig } from './user-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Returns the user-local generated dir if it contains compiled-policy.json,
 * otherwise falls back to the package-bundled generated dir.
 */
function resolveGeneratedDir(packageGeneratedDir: string): string {
  const userDir = getUserGeneratedDir();
  if (existsSync(resolve(userDir, 'compiled-policy.json'))) {
    return userDir;
  }
  return packageGeneratedDir;
}

/**
 * Computes the list of protected paths that the policy engine should
 * prevent agents from modifying. When the active generated dir differs
 * from the package-bundled dir, both are protected.
 */
export function computeProtectedPaths(opts: {
  constitutionPath: string;
  generatedDir: string;
  packageGeneratedDir: string;
  mcpServersPath: string;
  auditLogPath: string;
}): string[] {
  const paths = [
    resolveRealPath(opts.constitutionPath),
    resolveRealPath(opts.generatedDir),
    resolveRealPath(opts.mcpServersPath),
    resolveRealPath(opts.auditLogPath),
  ];
  if (opts.generatedDir !== opts.packageGeneratedDir) {
    paths.push(resolveRealPath(opts.packageGeneratedDir));
  }
  return paths;
}

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

  // Resolve node_modules/ relative paths to absolute paths.
  // Bundled MCP servers reference binaries via node_modules/ which only works
  // from the dev checkout root. After npm install, deps may be hoisted to a
  // parent node_modules/, so we walk up from the package root to find them.
  const packageRoot = resolve(__dirname, '..', '..');
  for (const config of Object.values(mcpServers)) {
    if (config.command.startsWith('node_modules/')) {
      config.command = resolveNodeModulesPath(config.command, packageRoot);
    }
    for (let i = 0; i < config.args.length; i++) {
      if (config.args[i].startsWith('node_modules/')) {
        config.args[i] = resolveNodeModulesPath(config.args[i], packageRoot);
      }
    }
  }

  const constitutionPath = resolve(__dirname, 'constitution.md');
  const packageGeneratedDir = resolve(__dirname, 'generated');
  const generatedDir = resolveGeneratedDir(packageGeneratedDir);

  const protectedPaths = computeProtectedPaths({
    constitutionPath,
    generatedDir,
    packageGeneratedDir,
    mcpServersPath,
    auditLogPath,
  });

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

export function loadGeneratedPolicy(generatedDir: string, fallbackDir?: string): {
  compiledPolicy: CompiledPolicyFile;
  toolAnnotations: ToolAnnotationsFile;
} {
  const compiledPolicy: CompiledPolicyFile = JSON.parse(
    readGeneratedFile(generatedDir, 'compiled-policy.json', fallbackDir),
  );
  const toolAnnotations: ToolAnnotationsFile = JSON.parse(
    readGeneratedFile(generatedDir, 'tool-annotations.json', fallbackDir),
  );
  return { compiledPolicy, toolAnnotations };
}

/**
 * Reads a generated artifact file, trying the primary dir first then the fallback.
 */
function readGeneratedFile(generatedDir: string, filename: string, fallbackDir?: string): string {
  const primaryPath = resolve(generatedDir, filename);
  if (existsSync(primaryPath)) {
    return readFileSync(primaryPath, 'utf-8');
  }
  if (fallbackDir) {
    const fallbackPath = resolve(fallbackDir, filename);
    if (existsSync(fallbackPath)) {
      return readFileSync(fallbackPath, 'utf-8');
    }
  }
  // Neither primary nor fallback exist -- read primary to throw with a clear path
  return readFileSync(primaryPath, 'utf-8');
}

/**
 * Resolves a node_modules/ relative path by walking up from startDir.
 * Handles npm's dependency hoisting where packages may live in a parent node_modules/.
 */
function resolveNodeModulesPath(relativePath: string, startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = resolve(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume it's directly under the package root
  return resolve(startDir, relativePath);
}
