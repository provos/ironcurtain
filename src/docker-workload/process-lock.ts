/**
 * Crash-recoverable host-process lock used by Docker-workload lifecycle state.
 *
 * A complete owner record is written and fsynced under a unique candidate name,
 * then published with an atomic hard link. Contenders therefore never observe
 * the old `O_EXCL create -> empty file -> owner JSON` publication window.
 *
 * Ownership is a tuple of PID, OS-reported process-start identity, and a random
 * token. PID alone is insufficient because it can be reused after a crash or a
 * reboot. Reclaiming a dead owner's lock captures the exact observed inode with
 * a rename and deletes only when the captured instance still matches, so a
 * racer's freshly published lock is restored instead of removed. Release is the
 * mirror image: it unlinks only while the published path is still the exact
 * inode this process installed.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

const PROCESS_LOCK_SCHEMA_VERSION = 1;
const MAX_OWNER_BYTES = 4096;
const DEFAULT_ATTEMPTS = 8;
const DEFAULT_MALFORMED_GRACE_MS = 5000;
let cachedSelfProcessIdentity: string | undefined;
let cachedLinuxBootId: string | undefined;

export interface ProcessLockOwner {
  readonly schemaVersion: typeof PROCESS_LOCK_SCHEMA_VERSION;
  readonly pid: number;
  readonly processIdentity: string;
  readonly token: string;
  readonly createdAtMs: number;
}

export type ProcessIdentityResolver = (pid: number) => string | undefined;

export interface AcquireProcessLockOptions {
  readonly attempts?: number;
  readonly malformedGraceMs?: number;
  readonly now?: () => number;
  /** Test seam; production queries the OS process table. */
  readonly processIdentityForPid?: ProcessIdentityResolver;
}

export interface ProcessLockHandle {
  readonly path: string;
  readonly owner: ProcessLockOwner;
  release(): void;
}

export class ProcessLockBusyError extends Error {
  readonly ownerPid: number | undefined;

  constructor(path: string, ownerPid?: number) {
    super(
      ownerPid === undefined
        ? `process lock is busy: ${path}`
        : `process lock is busy (owner pid ${ownerPid}): ${path}`,
    );
    this.name = 'ProcessLockBusyError';
    this.ownerPid = ownerPid;
  }
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface LockObservation extends FileIdentity {
  readonly mtimeMs: number;
  readonly owner: ProcessLockOwner | undefined;
}

/** Acquire a nonblocking process lock or throw {@link ProcessLockBusyError}. */
export function acquireProcessLock(path: string, options: AcquireProcessLockOptions = {}): ProcessLockHandle {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 128) {
    throw new Error('process-lock attempts must be an integer between 1 and 128');
  }
  const malformedGraceMs = options.malformedGraceMs ?? DEFAULT_MALFORMED_GRACE_MS;
  if (!Number.isFinite(malformedGraceMs) || malformedGraceMs < 0) {
    throw new Error('process-lock malformed grace must be nonnegative');
  }
  const now = options.now ?? Date.now;
  const identityForPid = options.processIdentityForPid ?? defaultProcessIdentityForPid;
  const processIdentity =
    options.processIdentityForPid === undefined
      ? (cachedSelfProcessIdentity ??= defaultProcessIdentityForPid(process.pid))
      : identityForPid(process.pid);
  if (processIdentity === undefined) {
    throw new Error('could not determine current process start identity for lock ownership');
  }

  const owner: ProcessLockOwner = {
    schemaVersion: PROCESS_LOCK_SCHEMA_VERSION,
    pid: process.pid,
    processIdentity,
    token: randomUUID(),
    createdAtMs: now(),
  };

  let lastOwnerPid: number | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const descriptor = tryPublishOwner(path, owner);
    if (descriptor !== undefined) return makeHandle(path, owner, descriptor);

    const observed = observeLock(path);
    if (observed === undefined) continue;
    lastOwnerPid = observed.owner?.pid;

    if (observed.owner !== undefined) {
      let currentIdentity: string | undefined;
      try {
        currentIdentity = identityForPid(observed.owner.pid);
      } catch {
        // An inability to adjudicate ownership must not steal a possibly-live lock.
        throw new ProcessLockBusyError(path, observed.owner.pid);
      }
      if (currentIdentity === observed.owner.processIdentity) {
        throw new ProcessLockBusyError(path, observed.owner.pid);
      }
      // Undefined means the PID is gone; a different identity means PID reuse.
    } else if (now() - observed.mtimeMs <= malformedGraceMs) {
      // Compatibility with a crashed/older writer: an incomplete fresh entry is
      // treated as mid-publication, never stale.
      throw new ProcessLockBusyError(path);
    }

    reclaimObservedLock(path, observed);
  }
  throw new ProcessLockBusyError(path, lastOwnerPid);
}

function tryPublishOwner(path: string, owner: ProcessLockOwner): number | undefined {
  const candidate = `${path}.candidate-${process.pid}-${randomUUID()}`;
  const descriptor = writeCandidateRecord(candidate, owner);
  try {
    // Same-directory hard-link publication is atomic and fails when `path`
    // already exists. The linked inode already holds the complete record.
    linkSync(candidate, path);
  } catch (error) {
    closeSync(descriptor);
    unlinkIfPresent(candidate);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }

  const identity = identityFromStat(fstatSync(descriptor));
  try {
    unlinkSync(candidate);
  } catch (error) {
    // Publication already succeeded, so roll back the exact inode we installed:
    // a candidate-cleanup failure must not strand a lock whose caller never
    // received a handle. The candidate is a private alias, never the lock.
    try {
      releaseOwnedLock(path, identity);
    } finally {
      closeSync(descriptor);
    }
    throw error;
  }
  return descriptor;
}

function writeCandidateRecord(candidate: string, owner: ProcessLockOwner): number {
  const descriptor = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
    fsyncSync(descriptor);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    unlinkIfPresent(candidate);
    throw error;
  }
}

function makeHandle(path: string, owner: ProcessLockOwner, descriptor: number): ProcessLockHandle {
  const identity = identityFromStat(fstatSync(descriptor));
  let released = false;
  return {
    path,
    owner,
    release() {
      if (released) return;
      released = true;
      try {
        releaseOwnedLock(path, identity);
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

/**
 * Unlink the lock only while it is still the exact inode we published. Peers
 * never reclaim a live owner's lock, so inode identity is sufficient proof.
 */
function releaseOwnedLock(path: string, identity: FileIdentity): void {
  let current: FileIdentity | undefined;
  try {
    current = identityFromStat(lstatSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (current === undefined || !sameInstance(current, identity)) {
    throw new Error(`process lock ownership was lost before release: ${path}`);
  }
  unlinkSync(path);
}

function reclaimObservedLock(path: string, observed: LockObservation): void {
  // Re-read immediately before capture. This prevents an observation of stale
  // instance A from authorizing removal after another process installed B.
  const current = observeLock(path);
  if (current === undefined || !sameObservedInstance(current, observed)) return;

  const captured = capturePath(path);
  try {
    renameSync(path, captured);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const capturedObservation = observeCapturedLock(captured);
  if (capturedObservation === undefined || !sameObservedInstance(capturedObservation, observed)) {
    restoreCapturedLock(captured, path);
    return;
  }
  unlinkSync(captured);
}

function restoreCapturedLock(captured: string, path: string): void {
  try {
    // Hard-link restoration never overwrites a racer's newly published lock.
    linkSync(captured, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A racer published while we held the capture, so its lock is the live one.
    // The captured instance is discarded; if it still has an owner, that
    // owner's release fails loudly instead of deleting the racer's lock.
  }
  unlinkIfPresent(captured);
}

function observeLock(path: string): LockObservation | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const base = { ...identityFromStat(stat), mtimeMs: stat.mtimeMs };
  if (stat.size > MAX_OWNER_BYTES) return { ...base, owner: undefined };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // An unreadable entry may still belong to a live owner; never reclaim it.
    throw new ProcessLockBusyError(path);
  }
  return { ...base, owner: parseOwner(raw) };
}

/** Any failure to re-read a capture means it is not the instance we captured. */
function observeCapturedLock(captured: string): LockObservation | undefined {
  try {
    return observeLock(captured);
  } catch {
    return undefined;
  }
}

function parseOwner(raw: string): ProcessLockOwner | undefined {
  try {
    const value = JSON.parse(raw) as Partial<ProcessLockOwner>;
    if (
      value.schemaVersion !== PROCESS_LOCK_SCHEMA_VERSION ||
      typeof value.pid !== 'number' ||
      !Number.isInteger(value.pid) ||
      value.pid < 1 ||
      typeof value.processIdentity !== 'string' ||
      value.processIdentity === '' ||
      typeof value.token !== 'string' ||
      value.token === '' ||
      typeof value.createdAtMs !== 'number' ||
      !Number.isFinite(value.createdAtMs)
    ) {
      return undefined;
    }
    return value as ProcessLockOwner;
  } catch {
    return undefined;
  }
}

function sameObservedInstance(left: LockObservation, right: LockObservation): boolean {
  return (
    sameInstance(left, right) &&
    left.owner?.token === right.owner?.token &&
    left.owner?.processIdentity === right.owner?.processIdentity
  );
}

function sameInstance(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identityFromStat(stat: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function capturePath(path: string): string {
  return `${path}.stale-${process.pid}-${randomUUID()}`;
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Stable process-start identity from the host process table. Linux binds the
 * kernel boot ID to `/proc/<pid>/stat` start ticks; macOS uses `/bin/ps` under a
 * fixed locale. A different identity for the same PID means PID reuse.
 */
function defaultProcessIdentityForPid(pid: number): string | undefined {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(') ');
      if (closeParen < 0) throw new Error(`malformed /proc/${pid}/stat`);
      // Fields after comm begin at field 3 (state); starttime is field 22.
      const fields = stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/u);
      const startTicks = fields[19];
      if (!/^\d+$/u.test(startTicks)) {
        throw new Error(`missing process start ticks in /proc/${pid}/stat`);
      }
      const bootId = (cachedLinuxBootId ??= readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
      if (!/^[0-9a-f-]{36}$/iu.test(bootId)) throw new Error('invalid Linux boot identity');
      return `${bootId}:${startTicks}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  try {
    const output = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
    const normalized = output.trim().replace(/\s+/gu, ' ');
    return normalized === '' ? undefined : normalized;
  } catch (error) {
    const status = (error as { readonly status?: unknown }).status;
    if (status === 1) return undefined;
    throw error;
  }
}
