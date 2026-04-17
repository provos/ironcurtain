/**
 * Sandbox Integration -- Wraps MCP server processes in OS-level sandboxes.
 *
 * Each sandboxed server is spawned via a separate `srt` CLI process with
 * its own settings file, giving each server independent sandbox infrastructure
 * (filesystem restrictions, network proxy, and process isolation).
 *
 * The proxy process itself never calls SandboxManager.initialize() -- it
 * only uses the stateless isSupportedPlatform() and checkDependencies()
 * for the availability check.
 */

import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { quote } from 'shell-quote';
import type { MCPServerConfig, SandboxAvailabilityPolicy, SandboxNetworkConfig } from '../config/types.js';
import { expandTilde } from '../types/argument-roles.js';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Result of resolving a server's sandbox configuration.
 * Discriminated union: sandboxed servers carry the resolved config,
 * unsandboxed servers carry the reason they were exempted.
 */
export type ResolvedSandboxConfig =
  | { readonly sandboxed: true; readonly config: ResolvedSandboxParams }
  | { readonly sandboxed: false; readonly reason: 'opt-out' | 'platform-unavailable' };

/**
 * Fully resolved sandbox parameters ready for srt settings.
 * All relative paths have been resolved to absolute paths.
 * The session sandbox directory has been injected into allowWrite.
 */
export interface ResolvedSandboxParams {
  readonly allowWrite: readonly string[];
  readonly allowRead: readonly string[];
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  readonly network:
    | false
    | {
        readonly allowedDomains: readonly string[];
        readonly deniedDomains: readonly string[];
      };
}

/** Result of checking sandbox-runtime availability. */
export interface SandboxAvailabilityResult {
  readonly platformSupported: boolean;
  readonly errors: string[];
  readonly warnings: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Sensitive directories blocked from reads by default. */
const DEFAULT_DENY_READ = ['~/.ssh', '~/.gnupg', '~/.aws'];

/**
 * Resolve the absolute path to the `srt` binary in node_modules.
 * Walks up from the package root to handle npm's dependency hoisting,
 * where bins may be in a parent node_modules/.bin/ directory.
 */
const __sandboxDirname = dirname(fileURLToPath(import.meta.url));
const SRT_BIN = resolveNodeModulesBin('srt', resolve(__sandboxDirname, '..', '..'));

/** Pattern matching common OS-level permission errors from sandbox containment. */
const SANDBOX_BLOCK_PATTERN = /EACCES|EPERM|Operation not permitted|Permission denied|read-only file system/i;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Checks sandbox dependencies and returns a structured result.
 *
 * Wraps SandboxManager.isSupportedPlatform() and checkDependencies()
 * into a single call. Does NOT throw -- callers inspect the result and
 * decide based on sandboxPolicy.
 */
export function checkSandboxAvailability(): SandboxAvailabilityResult {
  const platformSupported = SandboxManager.isSupportedPlatform();

  if (!platformSupported) {
    return { platformSupported, errors: [], warnings: [] };
  }

  const { errors, warnings } = SandboxManager.checkDependencies();
  return { platformSupported, errors, warnings };
}

/**
 * Resolves the effective sandbox configuration for a single MCP server.
 *
 * Applies defaults when `sandbox` is omitted, injects the session
 * sandbox directory into allowWrite, and resolves relative paths.
 */
export function resolveSandboxConfig(
  serverConfig: MCPServerConfig,
  sessionSandboxDir: string,
  platformAvailable: boolean,
  policy: SandboxAvailabilityPolicy,
): ResolvedSandboxConfig {
  if (serverConfig.sandbox === false) {
    return { sandboxed: false, reason: 'opt-out' };
  }

  if (!platformAvailable) {
    if (policy === 'enforce') {
      throw new Error(
        '[sandbox] Server requires sandboxing but platform is unavailable ' + 'and sandboxPolicy is "enforce".',
      );
    }
    return { sandboxed: false, reason: 'platform-unavailable' };
  }

  const sandboxConfig = serverConfig.sandbox ?? {};
  const fsConfig = sandboxConfig.filesystem ?? {};
  const networkConfig = sandboxConfig.network;

  const allowWrite = buildAllowWrite(sessionSandboxDir, fsConfig.allowWrite ?? []);
  const allowRead = (fsConfig.allowRead ?? []).map((p) => expandTilde(p));

  const denyRead = fsConfig.denyRead ?? DEFAULT_DENY_READ;
  const denyWrite = fsConfig.denyWrite ?? [];

  const network = resolveNetworkConfig(networkConfig);

  return {
    sandboxed: true,
    config: { allowWrite, allowRead, denyRead, denyWrite, network },
  };
}

/**
 * Resolves sandbox configs for every server in the given map without
 * writing any settings files to disk.
 *
 * Used by the parent process (coordinator construction) to know which
 * servers are sandboxed so audit entries can be stamped with
 * `sandboxed=true` and `annotateSandboxViolation` can prefix EPERM/EACCES
 * errors. The subprocess path still calls `resolveSandboxConfig` +
 * `writeServerSettings` separately because it needs the on-disk files
 * to invoke `srt`.
 */
export function resolveSandboxConfigsForAudit(
  serversConfig: Record<string, MCPServerConfig>,
  allowedDirectory: string | undefined,
  sandboxAvailable: boolean,
  policy: SandboxAvailabilityPolicy,
): Map<string, ResolvedSandboxConfig> {
  const result = new Map<string, ResolvedSandboxConfig>();
  for (const [serverName, config] of Object.entries(serversConfig)) {
    result.set(serverName, resolveSandboxConfig(config, allowedDirectory ?? '/tmp', sandboxAvailable, policy));
  }
  return result;
}

/**
 * Writes a per-server srt settings JSON file and creates a per-server
 * CWD directory for bwrap ghost dotfiles.
 *
 * Each sandboxed server gets its own settings file at
 * `{settingsDir}/{serverName}.srt-settings.json` and a CWD directory at
 * `{settingsDir}/{serverName}.cwd/`. The CWD directory is added to
 * `allowWrite` so the sandboxed process can write logs there. This keeps
 * bwrap ghost dotfiles out of the user-visible sandbox directory.
 *
 * Returns `{ settingsPath, cwdPath }`.
 */
export function writeServerSettings(
  serverName: string,
  config: ResolvedSandboxParams,
  settingsDir: string,
): { settingsPath: string; cwdPath: string } {
  const settingsPath = join(settingsDir, `${serverName}.srt-settings.json`);
  const cwdPath = join(settingsDir, `${serverName}.cwd`);
  mkdirSync(cwdPath, { recursive: true });

  const network =
    config.network === false
      ? { allowedDomains: [], deniedDomains: [] }
      : { allowedDomains: config.network.allowedDomains, deniedDomains: config.network.deniedDomains };

  // Allow the SSH agent Unix socket so sandboxed servers (e.g., git) can
  // authenticate via ssh-agent without falling back to passphrase prompts.
  // SSH_AUTH_SOCK points to a Unix domain socket that the macOS Seatbelt
  // sandbox blocks by default when network restrictions are active.
  const sshAuthSock = process.env.SSH_AUTH_SOCK;
  if (sshAuthSock && config.network !== false) {
    (network as Record<string, unknown>).allowUnixSockets = [dirname(sshAuthSock)];
  }

  const settings = {
    network,
    filesystem: {
      denyRead: config.denyRead,
      allowRead: config.allowRead,
      allowWrite: [...config.allowWrite, cwdPath],
      denyWrite: config.denyWrite,
    },
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { settingsPath, cwdPath };
}

/**
 * Transforms a server's spawn parameters (command + args) into a
 * sandbox-wrapped command suitable for StdioClientTransport.
 *
 * For sandboxed servers: returns `{ command: 'srt', args: ['-s', settingsPath, '-c', escapedCmd] }`.
 * For unsandboxed servers: returns the original command/args unchanged.
 */
export function wrapServerCommand(
  serverName: string,
  command: string,
  args: readonly string[],
  sandboxConfig: ResolvedSandboxConfig,
  settingsDir: string,
): { command: string; args: string[] } {
  if (!sandboxConfig.sandboxed) {
    return { command, args: [...args] };
  }

  const settingsPath = join(settingsDir, `${serverName}.srt-settings.json`);
  // Resolve relative paths in args to absolute so the command works when
  // the proxy sets cwd to the per-server temp directory.
  // Skip flags (-y, --foo) and npm package specifiers (contain @, e.g.
  // @org/pkg, @org/pkg@1.0.0, or unscoped pkg@1.0.0).
  const resolvedArgs = args.map((a) => {
    if (isAbsolute(a) || a.startsWith('-') || a.includes('@')) return a;
    // Only resolve args that look like filesystem paths (contain / or .)
    if (a.includes('/') || a.includes('.')) return resolve(a);
    return a;
  });
  const cmdString = quote([command, ...resolvedArgs]);

  return {
    command: SRT_BIN,
    args: ['-s', settingsPath, '-c', cmdString],
  };
}

/**
 * Cleans up per-server settings files created by writeServerSettings().
 * Called during proxy shutdown. Safe to call even if no files were written.
 */
export function cleanupSettingsFiles(settingsDir: string): void {
  try {
    rmSync(settingsDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; OS temp rotation handles leftovers
  }
}

/**
 * Annotates an MCP error response when it looks like a sandbox block.
 *
 * When a sandboxed server returns an error matching common sandbox-blocked
 * patterns (EPERM, EACCES, etc.) and the policy engine had allowed the call,
 * this prefixes the error with [SANDBOX BLOCKED] to signal OS containment.
 */
export function annotateSandboxViolation(errorMessage: string, serverSandboxed: boolean): string {
  if (!serverSandboxed) return errorMessage;
  if (!SANDBOX_BLOCK_PATTERN.test(errorMessage)) return errorMessage;

  return `[SANDBOX BLOCKED] ${errorMessage}`;
}

/**
 * Discovers filesystem paths required by the current Node.js installation.
 *
 * When a sandbox uses `denyRead: ["~"]`, node/npm installations under the
 * home directory (nvm, volta, fnm, asdf) become unreadable. This function
 * inspects the running process to find the actual installation paths and
 * returns them for inclusion in `allowRead`.
 *
 * Returns deduplicated absolute real paths. Safe to call on any platform.
 */
export function discoverNodePaths(): string[] {
  const paths = new Set<string>();
  // Resolve home through realpath so prefix comparisons work when
  // homedir() involves symlinks (e.g., macOS /var → /private/var)
  const home = safeRealPath(homedir()) ?? homedir();

  // 1. Node.js binary -- follow symlinks to the real location
  const execPath = safeRealPath(process.execPath);
  if (execPath) {
    // The binary is typically at <prefix>/bin/node; we want <prefix>
    const binDir = dirname(execPath);
    const prefix = dirname(binDir);
    addIfUnderHome(paths, prefix, home);
  }

  // 2. Version manager root directories -- these contain node versions,
  //    global packages, and shims that the server process needs to read
  const versionManagerRoots: Array<{ envVar: string; fallback: string }> = [
    { envVar: 'NVM_DIR', fallback: '.nvm' },
    { envVar: 'VOLTA_HOME', fallback: '.volta' },
    { envVar: 'ASDF_DATA_DIR', fallback: '.asdf' },
  ];

  for (const { envVar, fallback } of versionManagerRoots) {
    const dir = process.env[envVar] ?? (home ? join(home, fallback) : '');
    if (dir && existsSync(dir)) {
      const realDir = safeRealPath(dir);
      if (realDir) addIfUnderHome(paths, realDir, home);
    }
  }

  // 3. fnm uses a platform-specific default location
  const fnmDir =
    process.env.FNM_DIR ??
    (process.platform === 'darwin' && home
      ? join(home, 'Library', 'Application Support', 'fnm')
      : home
        ? join(home, '.local', 'share', 'fnm')
        : '');
  if (fnmDir && existsSync(fnmDir)) {
    const realDir = safeRealPath(fnmDir);
    if (realDir) addIfUnderHome(paths, realDir, home);
  }

  return [...paths];
}

/**
 * Rewrites an existing srt settings file to add additional allowRead
 * and/or allowWrite paths. Used after OAuth setup discovers credential
 * directories that weren't known when the settings were first written.
 *
 * Merges new paths with existing ones (deduplicating).
 */
export function rewriteServerSettings(
  settingsPath: string,
  additions: { allowRead?: string[]; allowWrite?: string[] },
): void {
  const content = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
    filesystem?: { allowRead?: string[]; allowWrite?: string[] };
  };
  const fs = content.filesystem ?? {};

  if (additions.allowRead?.length) {
    const existing = new Set<string>(fs.allowRead ?? []);
    for (const p of additions.allowRead) existing.add(p);
    fs.allowRead = [...existing];
  }

  if (additions.allowWrite?.length) {
    const existing = new Set<string>(fs.allowWrite ?? []);
    for (const p of additions.allowWrite) existing.add(p);
    fs.allowWrite = [...existing];
  }

  content.filesystem = fs;
  writeFileSync(settingsPath, JSON.stringify(content, null, 2));
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Resolves a path to its real (canonical) path, returning null on failure.
 * Silently handles paths that don't exist or can't be resolved.
 */
function safeRealPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Adds a path to the set only if it's under the home directory.
 * Paths outside home don't need to be in allowRead since they
 * aren't blocked by `denyRead: ["~"]`.
 */
function addIfUnderHome(paths: Set<string>, dir: string, home: string): void {
  if (home && dir.startsWith(home + '/')) {
    paths.add(dir);
  }
}

/**
 * Builds the allowWrite list with the session sandbox dir always included.
 * Relative paths are resolved against the session sandbox directory.
 */
function buildAllowWrite(sessionSandboxDir: string, additionalPaths: readonly string[]): string[] {
  const resolved = additionalPaths.map((p) => (isAbsolute(p) ? p : resolve(sessionSandboxDir, p)));
  return [sessionSandboxDir, ...resolved];
}

/**
 * Resolves network config to the canonical form.
 * `undefined` and `false` both mean no network access.
 */
function resolveNetworkConfig(config: false | SandboxNetworkConfig | undefined): ResolvedSandboxParams['network'] {
  if (!config) return false;

  return {
    allowedDomains: config.allowedDomains,
    deniedDomains: config.deniedDomains ?? [],
  };
}

/**
 * Resolves a binary name in node_modules/.bin/ by walking up from startDir.
 * Handles npm's dependency hoisting where bins may live in a parent node_modules/.bin/.
 */
export function resolveNodeModulesBin(binName: string, startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', binName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume it's directly under the package root
  return join(startDir, 'node_modules', '.bin', binName);
}
