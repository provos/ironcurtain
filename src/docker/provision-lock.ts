/**
 * Host-side advisory lock for the shared, content-keyed workflow dependency
 * cache.
 *
 * The cache directory is keyed solely by `computeWorkflowDependencyHash` and
 * is shared across concurrent workflow runs. Without serialization, two
 * concurrent runs with identical dependencies both observe the absent
 * provisioned-sentinel and race on `rm -rf` + venv/`node_modules` creation,
 * corrupting the cache for both.
 *
 * In-container `flock` on the bind-mounted cache dir does NOT serialize across
 * containers on Docker Desktop / macOS (VirtioFS does not propagate file locks
 * across the host bind mount — verified empirically). Concurrent runs do,
 * however, share the same host process tree, so a HOST-side lock on the cache
 * directory serializes them regardless of container/VirtioFS semantics.
 *
 * Uses `mkdir` (atomic on POSIX) to create a sibling lock directory containing
 * a metadata file with the owning PID and timestamp, enabling stale-lock
 * detection when a holder crashes without releasing. Self-contained (no
 * dependency on other domain modules) so the `docker/` layer stays decoupled.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Polling interval while waiting for a contended lock. */
const RETRY_INTERVAL_MS = 200;

/**
 * Grace window for a lock directory that exists but has no readable `meta.json`
 * yet: the holder created the dir (atomic `mkdir`) and is about to write its
 * metadata. Within this window the lock is treated as freshly held and is never
 * stolen; past it, a meta-less dir is an orphaned mid-acquisition (the holder
 * crashed between `mkdir` and the metadata write) and is reclaimable.
 */
const ACQUIRE_GRACE_MS = 5_000;

interface LockMetadata {
  readonly pid: number;
  readonly timestamp: number;
}

/** Returns true if a process with the given PID is alive (signal 0 probe). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // ESRCH → no such process (dead). EPERM → process exists but is owned by
    // another user (still alive). Any other unexpected error → treat as alive
    // so a transient probe failure never lets a waiter steal a live holder.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Best-effort recursive removal of a lock directory. */
function forceRelease(lockDir: string): void {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Returns true when an existing lock is stale and may be reclaimed: the owning
 * process is dead, or the lock has been held past `staleMs`. When `meta.json`
 * is not yet readable, the lock is reclaimed only if its directory is older than
 * `ACQUIRE_GRACE_MS` — otherwise the holder is mid-acquisition (it created the
 * dir but has not written metadata yet) and must not be stolen.
 */
function isLockStale(lockDir: string, staleMs: number): boolean {
  let meta: LockMetadata;
  try {
    meta = JSON.parse(readFileSync(resolve(lockDir, 'meta.json'), 'utf-8')) as LockMetadata;
  } catch {
    // meta.json missing or unparseable. Do NOT treat that as stale outright, or
    // a waiter could steal a lock during the holder's mkdir→write window. Fall
    // back to the lock dir's own age: reclaim only an orphaned dir whose holder
    // crashed before writing metadata.
    try {
      return Date.now() - statSync(lockDir).mtimeMs > ACQUIRE_GRACE_MS;
    } catch {
      // Lock dir vanished entirely → not held.
      return true;
    }
  }
  if (!isPidAlive(meta.pid)) return true;
  return Date.now() - meta.timestamp > staleMs;
}

/**
 * Single non-blocking attempt to acquire the lock. Atomic `mkdir` is the
 * authoritative acquisition; stale detection only runs after EEXIST. The window
 * between a holder's `mkdir` and its `meta.json` write is covered by
 * `isLockStale`'s grace fallback, so a just-acquired lock is never stolen.
 */
function tryAcquire(lockDir: string, staleMs: number): boolean {
  try {
    mkdirSync(lockDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (!isLockStale(lockDir, staleMs)) return false;
    forceRelease(lockDir);
    try {
      mkdirSync(lockDir);
    } catch (retryErr: unknown) {
      if ((retryErr as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw retryErr;
    }
  }

  const meta: LockMetadata = { pid: process.pid, timestamp: Date.now() };
  try {
    writeFileSync(resolve(lockDir, 'meta.json'), JSON.stringify(meta));
  } catch {
    forceRelease(lockDir);
    return false;
  }
  return true;
}

/** Options for {@link withProvisionLock}. */
export interface ProvisionLockOptions {
  /**
   * Max time to wait to acquire a contended lock before giving up. Must exceed
   * the worst-case provisioning time so a waiter does not abandon while the
   * holder is mid-install. Defaults to 25 minutes.
   */
  readonly maxWaitMs?: number;
  /**
   * Time after which an unreleased lock is considered stale (crashed holder).
   * Must also exceed the worst-case provisioning time so a slow-but-alive
   * holder is never stolen from. Defaults to 25 minutes; PID-liveness reclaims
   * crashed holders well before this.
   */
  readonly staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 25 * 60_000;

/**
 * Runs `fn` while holding a host-side advisory lock at `{cacheDir}.lock/`.
 *
 * Serializes concurrent provisioning of the same content-keyed cache so the
 * second run blocks until the first finishes, then observes the populated
 * cache (sentinel present) and short-circuits. Releases the lock in a finally
 * block. Throws if the lock cannot be acquired within `maxWaitMs`.
 */
export async function withProvisionLock<T>(
  cacheDir: string,
  fn: () => Promise<T>,
  options: ProvisionLockOptions = {},
): Promise<T> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_TIMEOUT_MS;
  const lockDir = `${cacheDir}.lock`;
  const deadline = Date.now() + maxWaitMs;

  let acquired = false;
  while (Date.now() < deadline) {
    if (tryAcquire(lockDir, staleMs)) {
      acquired = true;
      break;
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, RETRY_INTERVAL_MS));
  }
  if (!acquired) {
    throw new Error(`Failed to acquire workflow provisioning lock: ${lockDir} (timed out after ${maxWaitMs}ms)`);
  }

  try {
    return await fn();
  } finally {
    forceRelease(lockDir);
  }
}
