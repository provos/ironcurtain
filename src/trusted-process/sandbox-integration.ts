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
import { writeFileSync, rmSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { quote } from 'shell-quote';
import type {
  MCPServerConfig,
  SandboxAvailabilityPolicy,
  SandboxNetworkConfig,
} from '../config/types.js';

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
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  readonly network: false | {
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

/** Resolve the absolute path to the `srt` binary in node_modules. */
const SRT_BIN = resolve('node_modules/.bin/srt');

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
        '[sandbox] Server requires sandboxing but platform is unavailable ' +
        'and sandboxPolicy is "enforce".',
      );
    }
    return { sandboxed: false, reason: 'platform-unavailable' };
  }

  const sandboxConfig = serverConfig.sandbox ?? {};
  const fsConfig = sandboxConfig.filesystem ?? {};
  const networkConfig = sandboxConfig.network;

  const allowWrite = buildAllowWrite(
    sessionSandboxDir,
    fsConfig.allowWrite ?? [],
  );

  const denyRead = fsConfig.denyRead ?? DEFAULT_DENY_READ;
  const denyWrite = fsConfig.denyWrite ?? [];

  const network = resolveNetworkConfig(networkConfig);

  return {
    sandboxed: true,
    config: { allowWrite, denyRead, denyWrite, network },
  };
}

/**
 * Writes a per-server srt settings JSON file.
 *
 * Each sandboxed server gets its own settings file at
 * `{settingsDir}/{serverName}.srt-settings.json`.
 *
 * Returns the absolute path to the written file.
 */
export function writeServerSettings(
  serverName: string,
  config: ResolvedSandboxParams,
  settingsDir: string,
): string {
  const settingsPath = join(settingsDir, `${serverName}.srt-settings.json`);

  const network = config.network === false
    ? { allowedDomains: [], deniedDomains: [] }
    : { allowedDomains: config.network.allowedDomains, deniedDomains: config.network.deniedDomains };

  const settings = {
    network,
    filesystem: {
      denyRead: config.denyRead,
      allowWrite: config.allowWrite,
      denyWrite: config.denyWrite,
    },
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
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
  const cmdString = quote([command, ...args]);

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
export function annotateSandboxViolation(
  errorMessage: string,
  serverSandboxed: boolean,
): string {
  if (!serverSandboxed) return errorMessage;
  if (!SANDBOX_BLOCK_PATTERN.test(errorMessage)) return errorMessage;

  return `[SANDBOX BLOCKED] ${errorMessage}`;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Builds the allowWrite list with the session sandbox dir always included.
 * Relative paths are resolved against the session sandbox directory.
 */
function buildAllowWrite(
  sessionSandboxDir: string,
  additionalPaths: readonly string[],
): string[] {
  const resolved = additionalPaths.map(p =>
    isAbsolute(p) ? p : resolve(sessionSandboxDir, p),
  );
  return [sessionSandboxDir, ...resolved];
}

/**
 * Resolves network config to the canonical form.
 * `undefined` and `false` both mean no network access.
 */
function resolveNetworkConfig(
  config: false | SandboxNetworkConfig | undefined,
): ResolvedSandboxParams['network'] {
  if (!config) return false;

  return {
    allowedDomains: config.allowedDomains,
    deniedDomains: config.deniedDomains ?? [],
  };
}
