import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IronCurtainConfig, MCPServerConfig } from './types.js';
import type { CompiledPolicyFile, DynamicListsFile, ToolAnnotationsFile } from '../pipeline/types.js';
import {
  computeConstitutionHash,
  getIronCurtainHome,
  getUserConstitutionBasePath,
  getUserConstitutionPath,
  getUserGeneratedDir,
} from './paths.js';
import { resolveRealPath } from '../types/argument-roles.js';
import { loadUserConfig } from './user-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isCompiled = __filename.endsWith('.js');

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
  // Protect user-local constitution files when they exist
  const userConstitutionBase = getUserConstitutionBasePath();
  if (existsSync(userConstitutionBase)) {
    paths.push(resolveRealPath(userConstitutionBase));
  }
  const userConstitutionExt = getUserConstitutionPath();
  if (existsSync(userConstitutionExt)) {
    paths.push(resolveRealPath(userConstitutionExt));
  }
  return paths;
}

/**
 * Resolves internal source file paths (./src/*.ts) in MCP server configs
 * to absolute paths. In compiled mode, rewrites to dist/*.js with node.
 */
/**
 * Resolves all relative paths in MCP server configs to absolute paths.
 *
 * Handles two kinds of relative paths:
 * - `node_modules/...` — walks up from packageRoot to find hoisted packages
 * - `./src/...ts` — resolves to absolute; in compiled mode, rewrites to dist/*.js
 *
 * Must be called before spawning any MCP server process. Both `loadConfig()`
 * (runtime) and `loadPipelineConfig()` (pipeline) use this.
 */
export function resolveMcpServerPaths(mcpServers: Record<string, MCPServerConfig>): void {
  // packageRoot is two levels up from this file (src/config/ → project root)
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
    resolveInternalServerPaths(config, packageRoot, isCompiled);
  }
}

function resolveInternalServerPaths(config: MCPServerConfig, packageRoot: string, compiled: boolean): void {
  for (let i = 0; i < config.args.length; i++) {
    const arg = config.args[i];
    if (!arg.startsWith('./src/') || !arg.endsWith('.ts')) continue;

    if (compiled) {
      // Rewrite ./src/X.ts → <abs>/dist/X.js and use node
      const distRelative = arg.replace(/^\.\/src\//, 'dist/').replace(/\.ts$/, '.js');
      config.args[i] = resolve(packageRoot, distRelative);
      if (config.command === 'npx') {
        config.command = 'node';
        const tsxIdx = config.args.indexOf('tsx');
        if (tsxIdx !== -1) config.args.splice(tsxIdx, 1);
      } else if (config.command === 'tsx') {
        config.command = 'node';
      }
    } else {
      // Source mode — resolve to absolute path
      config.args[i] = resolve(packageRoot, arg);
    }
  }
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
  const mcpServers = JSON.parse(readFileSync(mcpServersPath, 'utf-8')) as Record<string, MCPServerConfig>;

  // Sync the filesystem server's allowed directory with the configured value.
  // The mcp-servers.json ships with a default path that may differ from
  // the ALLOWED_DIRECTORY environment variable.
  const fsServer = mcpServers['filesystem'];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: key may not exist in external JSON
  if (fsServer) {
    const defaultDir = '/tmp/ironcurtain-sandbox';
    const dirIndex = fsServer.args.indexOf(defaultDir);
    if (dirIndex !== -1) {
      fsServer.args[dirIndex] = allowedDirectory;
    }
  }

  // Resolve all relative paths (node_modules/ and ./src/) to absolute paths.
  resolveMcpServerPaths(mcpServers);

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

  // Warn if serverCredentials keys don't match any server in mcp-servers.json.
  // This check requires both configs, so it must happen here rather than in loadUserConfig().
  const serverNames = new Set(Object.keys(mcpServers));
  for (const credKey of Object.keys(userConfig.serverCredentials)) {
    if (!serverNames.has(credKey)) {
      process.stderr.write(
        `Warning: serverCredentials["${credKey}"] does not match any server in mcp-servers.json. ` +
          `Available servers: ${[...serverNames].join(', ')}\n`,
      );
    }
  }

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
 * Returns a map from server name to its list of allowed domains.
 *
 * The `*` wildcard is preserved (not filtered) so that the untrusted domain gate fires
 * for servers with `["*"]`. The SSRF structural invariant in
 * `domainMatchesAllowlist()` prevents `*` from matching IP addresses.
 */
export function extractServerDomainAllowlists(mcpServers: Record<string, MCPServerConfig>): Map<string, string[]> {
  const allowlists = new Map<string, string[]>();
  for (const [serverName, config] of Object.entries(mcpServers)) {
    const sandbox = config.sandbox;
    if (!sandbox || typeof sandbox !== 'object') continue;
    const network = sandbox.network;
    if (!network || typeof network !== 'object') continue;
    if (network.allowedDomains.length > 0) {
      allowlists.set(serverName, [...network.allowedDomains]);
    }
  }
  return allowlists;
}

/**
 * Checks whether the compiled policy matches the current constitution.
 * Emits a warning to stderr when the constitution has changed since the
 * last `ironcurtain compile-policy` run.
 */
export function checkConstitutionFreshness(compiledPolicy: CompiledPolicyFile, constitutionPath: string): void {
  try {
    const currentHash = computeConstitutionHash(constitutionPath);
    if (currentHash !== compiledPolicy.constitutionHash) {
      process.stderr.write(
        'Warning: constitution has changed since the last policy compilation. ' +
          'Run `ironcurtain compile-policy` to update the compiled policy.\n',
      );
    }
  } catch (err: unknown) {
    // Missing constitution file is expected in test environments — skip silently.
    // Let other errors (permission denied, etc.) propagate.
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

export function loadGeneratedPolicy(
  generatedDir: string,
  fallbackDir?: string,
): {
  compiledPolicy: CompiledPolicyFile;
  toolAnnotations: ToolAnnotationsFile;
  dynamicLists: DynamicListsFile | undefined;
} {
  const compiledPolicy = JSON.parse(
    readGeneratedFile(generatedDir, 'compiled-policy.json', fallbackDir),
  ) as CompiledPolicyFile;
  const toolAnnotations = JSON.parse(
    readGeneratedFile(generatedDir, 'tool-annotations.json', fallbackDir),
  ) as ToolAnnotationsFile;
  const dynamicLists = loadOptionalGeneratedFile(generatedDir, 'dynamic-lists.json', fallbackDir);

  return { compiledPolicy, toolAnnotations, dynamicLists };
}

/**
 * Loads an optional generated artifact file. Returns undefined if not found.
 */
function loadOptionalGeneratedFile(
  generatedDir: string,
  filename: string,
  fallbackDir?: string,
): DynamicListsFile | undefined {
  const primaryPath = resolve(generatedDir, filename);
  if (existsSync(primaryPath)) {
    return JSON.parse(readFileSync(primaryPath, 'utf-8')) as DynamicListsFile;
  }
  if (fallbackDir) {
    const fallbackPath = resolve(fallbackDir, filename);
    if (existsSync(fallbackPath)) {
      return JSON.parse(readFileSync(fallbackPath, 'utf-8')) as DynamicListsFile;
    }
  }
  return undefined;
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
