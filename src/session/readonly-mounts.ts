/**
 * Read-only extra mounts for Docker agent sessions.
 *
 * The single module that validates user-selected host directories for
 * mounting read-only under `/mnt/ro/<name>` in the agent container (the bind
 * mounts themselves are built by `buildReadonlyMounts` in
 * `docker/container-workspace.ts`). The mounted content is NOT mediated by the
 * policy engine -- the agent reads it natively inside the container -- so the
 * user who selects a directory accepts that the agent can read everything
 * beneath it. Validation therefore only guards IronCurtain's own invariants,
 * using pure path-prefix comparisons (the mounted tree is never traversed):
 *
 *  - IronCurtain secrets (home dir with CA key / OAuth state / config, `.env`,
 *    agent credential stores) must not become visible inside the container.
 *  - Directories that hold host runtime sockets (`/run`, `/tmp`, Docker
 *    Desktop's `/mnt/wsl`, ...) are refused: a read-only bind does NOT stop
 *    `connect()` on a Unix socket, so mounting one would hand the agent e.g.
 *    the host Docker socket.
 *
 * See docs/designs/readonly-extra-mounts.md.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { expandTilde, resolveRealPath } from '../types/argument-roles.js';
import { getIronCurtainHome, getUserConfigPath } from '../config/paths.js';
import { getAnthropicCredentialsFilePath, getCodexAuthFilePath } from '../docker/oauth-credentials.js';
import { isWsl2Host } from '../docker-workload/environment.js';
import { isEqualOrInside } from './workspace-validation.js';

/** A validated read-only mount: canonical host directory and its container path. */
export interface ReadonlyMountSpec {
  /** Canonical (realpath) absolute host directory. */
  readonly hostPath: string;
  /** Container path, always `${READONLY_MOUNT_ROOT}/<slug>`. */
  readonly containerPath: string;
}

/** Result of resolving or restoring mounts: specs plus user-facing warnings. */
export interface ReadonlyMountResolution {
  readonly mounts: ReadonlyMountSpec[];
  readonly warnings: string[];
}

export const MAX_READONLY_MOUNTS = 8;
export const READONLY_MOUNT_ROOT = '/mnt/ro';

/** `/mnt/ro/<slug>`; `.` and `..` would escape the mount root. */
const CONTAINER_PATH_PATTERN = /^\/mnt\/ro\/(?!\.\.?$)[A-Za-z0-9._-]+$/;

/**
 * Host directories whose subtrees hold live runtime sockets or kernel
 * interfaces. A mount may be neither inside nor a parent of these.
 */
const SYSTEM_ROOTS = [
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/var/run',
  '/var/lib/docker',
  '/var/lib/lxd',
  '/var/lib/incus',
  '/var/snap',
  '/mnt/wsl',
  '/mnt/wslg',
];

/**
 * Shared temp directories that commonly hold sockets. A mount may live inside
 * them (e.g. `/tmp/dataset`) but must not contain them, nor sit inside one of
 * their well-known socket entries ({@link TMP_SOCKET_ENTRY}).
 */
const SOCKET_PARENT_ROOTS = ['/tmp', '/var/tmp'];

/** Top-level temp entries that hold host sockets (X11, ICE, tmux, ssh-agent, systemd). */
const TMP_SOCKET_ENTRY = /^(\.[A-Za-z0-9]+-unix|tmux-\d+|ssh-.+|systemd-private-.+)$/;

// ---------------------------------------------------------------------------
// Host path input normalization (WSL)
// ---------------------------------------------------------------------------

/** Reads the WSL drive automount root from `/etc/wsl.conf` (default `/mnt/`). */
export function readWslAutomountRoot(wslConf?: string): string {
  let content = wslConf;
  if (content === undefined) {
    try {
      content = readFileSync('/etc/wsl.conf', 'utf-8');
    } catch {
      return '/mnt/';
    }
  }
  let inAutomount = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      inAutomount = section[1].trim().toLowerCase() === 'automount';
      continue;
    }
    const root = inAutomount ? /^root\s*=\s*(.+)$/i.exec(line) : null;
    if (root) {
      const value = root[1].trim().replace(/^["']|["']$/g, '');
      if (value.startsWith('/')) return value.endsWith('/') ? value : `${value}/`;
    }
  }
  return '/mnt/';
}

/** True when running under WSL2 (the only WSL that runs Docker). */
export function isWslHost(): boolean {
  return isWsl2Host(process.platform, release());
}

/**
 * Translates a Windows drive path (`D:\Training`, `d:/Training`) to its WSL
 * mount path (`/mnt/d/Training`) when running under WSL. Other input is
 * returned trimmed but otherwise unchanged.
 */
export function normalizeHostPathInput(raw: string, env?: { wsl: boolean; automountRoot: string }): string {
  const input = raw.trim();
  const drive = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(input);
  if (!drive || !(env?.wsl ?? isWslHost())) return input;
  const root = env?.automountRoot ?? readWslAutomountRoot();
  const rest = (drive.at(2) ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return `${root}${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** True when either path is equal to or inside the other. */
function overlaps(a: string, b: string): boolean {
  return isEqualOrInside(a, b) || isEqualOrInside(b, a);
}

/** Device + inode of an existing path (following symlinks), else undefined. */
function identityOf(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

/** Identities of `path` and each existing ancestor (walks up, never into the tree). */
function ancestorIdentities(path: string): Set<string> {
  const ids = new Set<string>();
  for (let current = path; ; current = dirname(current)) {
    const id = identityOf(current);
    if (id !== undefined) ids.add(id);
    if (dirname(current) === current) return ids;
  }
}

/**
 * A path plus its filesystem identity chain. Comparing identities as well as
 * strings catches aliases that string checks miss: case variants on
 * case-insensitive filesystems that keep the typed case (WSL DrvFS `/mnt/d`),
 * and bind-mounted views of the same directory.
 */
interface IdentifiedPath {
  readonly path: string;
  /** Identity of the path itself; undefined when it does not exist. */
  readonly id: string | undefined;
  /** Identities of the path and all its existing ancestors. */
  readonly chain: ReadonlySet<string>;
}

function identify(path: string): IdentifiedPath {
  return { path, id: identityOf(path), chain: ancestorIdentities(path) };
}

/** True when `inner` is equal to or inside `outer`, by path or by identity. */
function isWithin(inner: IdentifiedPath, outer: IdentifiedPath): boolean {
  return isEqualOrInside(inner.path, outer.path) || (outer.id !== undefined && inner.chain.has(outer.id));
}

/** True when either path is equal to or inside the other, by path or by identity. */
function overlapsIdentified(a: IdentifiedPath, b: IdentifiedPath): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

/**
 * Canonical path using the OS realpath, which also normalizes letter case on
 * case-insensitive filesystems (macOS) -- the JS realpath keeps the typed case,
 * which would let `/Users/Me` slip past a `/Users/me` guard. Non-existent
 * paths fall back to {@link resolveRealPath}.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync.native(resolve(expandTilde(path)));
  } catch {
    return resolveRealPath(path);
  }
}

/** Canonical guard paths with identities, computed once per validation batch. */
interface MountGuards {
  readonly home: IdentifiedPath;
  /** IronCurtain-held secrets that must never be visible inside the container. */
  readonly secretRoots: readonly IdentifiedPath[];
  readonly systemRoots: readonly IdentifiedPath[];
  readonly socketParentRoots: readonly IdentifiedPath[];
}

function identifyGuard(path: string): IdentifiedPath {
  return identify(canonicalPath(path));
}

function buildMountGuards(): MountGuards {
  // dotenv loads `.env` from the cwd; guard it only when it exists so an
  // absent file does not block mounting the directory the user is in.
  const envFile = resolve('.env');
  return {
    home: identifyGuard(homedir()),
    secretRoots: [
      getIronCurtainHome(),
      getUserConfigPath(),
      ...(existsSync(envFile) ? [envFile] : []),
      resolve(homedir(), '.claude'),
      dirname(dirname(getAnthropicCredentialsFilePath())),
      dirname(getCodexAuthFilePath()),
    ].map(identifyGuard),
    systemRoots: SYSTEM_ROOTS.map(identifyGuard),
    socketParentRoots: SOCKET_PARENT_ROOTS.map(identifyGuard),
  };
}

/**
 * Validates one raw path and returns its canonical form. Throws an Error with
 * a user-facing message when the path is unusable or unsafe to mount.
 */
function validateHostDirectory(raw: string, guards: MountGuards): string {
  if (raw.trim() === '') throw new Error('Read-only mount path is empty');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) throw new Error('Read-only mount path contains control characters');

  const absolute = resolve(expandTilde(normalizeHostPathInput(raw)));
  let canonical: string;
  try {
    // Must exist (no fallback for missing paths); native for on-disk case.
    canonical = realpathSync.native(absolute);
  } catch {
    throw new Error(`Read-only mount path does not exist: ${absolute}`);
  }
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`Read-only mount path is not a directory: ${canonical}`);
  }
  // Docker's `-v src:dst:ro` format has no escaping for ':'.
  if (canonical.includes(':')) throw new Error(`Read-only mount path must not contain ':': ${canonical}`);
  if (canonical === '/') throw new Error('Cannot mount the root directory');
  const candidate = identify(canonical);
  if (candidate.path === guards.home.path || (candidate.id !== undefined && candidate.id === guards.home.id)) {
    throw new Error('Cannot mount the home directory (it contains IronCurtain and agent credentials)');
  }

  const secret = guards.secretRoots.find((root) => overlapsIdentified(candidate, root));
  if (secret) {
    throw new Error(`Read-only mount ${canonical} would expose IronCurtain credentials or state (${secret.path})`);
  }
  const system = guards.systemRoots.find((root) => overlapsIdentified(candidate, root));
  if (system) throw new Error(`Read-only mount ${canonical} overlaps system directory ${system.path}`);
  for (const root of guards.socketParentRoots) {
    if (isWithin(root, candidate)) {
      throw new Error(`Read-only mount ${canonical} contains ${root.path}, which may hold host sockets`);
    }
    const entry = isEqualOrInside(canonical, root.path) ? canonical.slice(root.path.length + 1).split('/')[0] : '';
    if (TMP_SOCKET_ENTRY.test(entry)) {
      throw new Error(`Read-only mount ${canonical} is inside ${root.path}/${entry}, which holds host sockets`);
    }
  }
  return canonical;
}

/** Warning text for whole-drive mounts (e.g. `/mnt/d`). */
function driveRootWarning(canonical: string): string | undefined {
  if (!/^\/mnt\/[a-z]$/i.test(canonical)) return undefined;
  return `Mounting the whole drive ${canonical}: the agent can read every file on it.`;
}

function slugFor(hostPath: string): string {
  const slug = basename(hostPath).replace(/[^A-Za-z0-9._-]/g, '_');
  return slug === '' || slug === '.' || slug === '..' ? 'mount' : slug;
}

function assignContainerPath(hostPath: string, used: Set<string>): string {
  const slug = slugFor(hostPath);
  let candidate = `${READONLY_MOUNT_ROOT}/${slug}`;
  for (let n = 2; used.has(candidate); n++) {
    candidate = `${READONLY_MOUNT_ROOT}/${slug}-${n}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Validates user-provided host directories and assigns container targets
 * under {@link READONLY_MOUNT_ROOT}. Throws on the first invalid path.
 * Duplicate paths (after canonicalization) are collapsed.
 */
export function resolveReadonlyMounts(rawPaths: readonly string[]): ReadonlyMountResolution {
  const guards = buildMountGuards();
  const canonicalPaths = [...new Set(rawPaths.map((raw) => validateHostDirectory(raw, guards)))];
  if (canonicalPaths.length > MAX_READONLY_MOUNTS) {
    throw new Error(`At most ${MAX_READONLY_MOUNTS} read-only mounts are allowed (got ${canonicalPaths.length})`);
  }
  const used = new Set<string>();
  const mounts = canonicalPaths.map((hostPath) => ({ hostPath, containerPath: assignContainerPath(hostPath, used) }));
  const warnings = canonicalPaths.map(driveRootWarning).filter((w): w is string => w !== undefined);
  return { mounts, warnings };
}

/** Result of restoring mounts on resume, possibly with folders added. */
export interface ReadonlyMountRestore extends ReadonlyMountResolution {
  /**
   * Updated list to persist when folders were added: every saved entry
   * (including ones currently unavailable, so they return on a later resume)
   * followed by the additions. Undefined when nothing was added.
   */
  readonly persist?: ReadonlyMountSpec[];
}

/**
 * Shape-checks mounts persisted in session metadata (untrusted on-disk JSON).
 * Throws on a malformed record; `undefined` means none were saved.
 */
function parsePersistedMounts(persisted: unknown): ReadonlyMountSpec[] {
  if (persisted === undefined) return [];
  if (!Array.isArray(persisted) || persisted.length > MAX_READONLY_MOUNTS) {
    throw new Error('Persisted read-only mounts are malformed');
  }
  const specs: ReadonlyMountSpec[] = [];
  const used = new Set<string>();
  for (const entry of persisted as unknown[]) {
    const spec = entry as Partial<ReadonlyMountSpec> | null;
    if (
      typeof spec?.hostPath !== 'string' ||
      !isAbsolute(spec.hostPath) ||
      typeof spec.containerPath !== 'string' ||
      !CONTAINER_PATH_PATTERN.test(spec.containerPath) ||
      used.has(spec.containerPath)
    ) {
      throw new Error('Persisted read-only mounts are malformed');
    }
    used.add(spec.containerPath);
    specs.push({ hostPath: spec.hostPath, containerPath: spec.containerPath });
  }
  return specs;
}

/**
 * Host paths of the mounts saved with a session, for display (e.g. the web
 * UI's resume list). Malformed metadata yields an empty list here; resume
 * itself rejects it via {@link restoreReadonlyMounts}.
 */
export function savedReadonlyMountHostPaths(persisted: unknown): string[] {
  try {
    return parsePersistedMounts(persisted).map((spec) => spec.hostPath);
  } catch {
    return [];
  }
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Re-validates mounts persisted with a session before resume, optionally
 * adding new folders. A saved directory that no longer exists is skipped with
 * a warning (the session continues); any other validation failure throws, as
 * does a malformed record. Saved mounts keep their container paths so the
 * agent's earlier references stay valid; additions get paths that avoid every
 * saved one. The saved and added folders together are capped at
 * {@link MAX_READONLY_MOUNTS}.
 */
export function restoreReadonlyMounts(
  persisted: unknown,
  additionalRawPaths: readonly string[] = [],
): ReadonlyMountRestore {
  const saved = parsePersistedMounts(persisted);
  const guards = buildMountGuards();
  const mounts: ReadonlyMountSpec[] = [];
  const warnings: string[] = [];
  for (const spec of saved) {
    if (!isExistingDirectory(spec.hostPath)) {
      warnings.push(`Read-only mount ${spec.hostPath} is no longer available; continuing without it.`);
      continue;
    }
    mounts.push({ hostPath: validateHostDirectory(spec.hostPath, guards), containerPath: spec.containerPath });
  }
  if (additionalRawPaths.length === 0) return { mounts, warnings };

  const known = new Set([...saved.map((spec) => spec.hostPath), ...mounts.map((spec) => spec.hostPath)]);
  const used = new Set(saved.map((spec) => spec.containerPath));
  const added: ReadonlyMountSpec[] = [];
  for (const hostPath of new Set(additionalRawPaths.map((raw) => validateHostDirectory(raw, guards)))) {
    if (known.has(hostPath)) continue;
    added.push({ hostPath, containerPath: assignContainerPath(hostPath, used) });
  }
  if (saved.length + added.length > MAX_READONLY_MOUNTS) {
    throw new Error(
      `At most ${MAX_READONLY_MOUNTS} read-only mounts are allowed (session has ${saved.length}, adding ${added.length})`,
    );
  }
  for (const spec of added) {
    const warning = driveRootWarning(spec.hostPath);
    if (warning) warnings.push(warning);
  }
  return {
    mounts: [...mounts, ...added],
    warnings,
    ...(added.length > 0 ? { persist: [...saved, ...added] } : {}),
  };
}

/**
 * True when any mount overlaps the workspace directory. Apple `container`
 * virtiofs can silently drop a directory share when a path inside it is also
 * mounted, so that runtime refuses such nesting.
 */
export function readonlyMountsOverlapWorkspace(specs: readonly ReadonlyMountSpec[], workspaceDir: string): boolean {
  return specs.some((spec) => overlaps(spec.hostPath, workspaceDir));
}

/** System-prompt section telling the agent where the read-only mounts are. */
export function formatReadonlyMountsPrompt(
  specs: readonly ReadonlyMountSpec[],
  notes: readonly string[],
): string | undefined {
  if (specs.length === 0 && notes.length === 0) return undefined;
  const lines = ['## Read-only reference directories', ''];
  if (specs.length > 0) {
    lines.push(
      'The user mounted these host directories into the container READ-ONLY. Read from them freely;',
      'they cannot be modified. Write any outputs to /workspace instead.',
      '',
      ...specs.map((spec) => `- \`${spec.containerPath}\` (host: \`${spec.hostPath}\`)`),
    );
  }
  if (notes.length > 0) {
    if (specs.length > 0) lines.push('');
    lines.push(...notes.map((note) => `Note: ${note}`));
  }
  return lines.join('\n');
}
