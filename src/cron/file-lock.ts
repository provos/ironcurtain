/**
 * Advisory file locking for the job store.
 *
 * Uses mkdir (atomic on POSIX) to create a lock directory next to the
 * target file. The lock directory contains a metadata file with the
 * owning PID and timestamp, enabling stale lock detection when a
 * process crashes without releasing.
 *
 * This is designed for short-lived critical sections (read-modify-write),
 * not long-held process-level locks. For process singleton enforcement,
 * see src/escalation/listener-lock.ts.
 */

import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Default stale timeout: 30 seconds. */
const DEFAULT_STALE_MS = 30_000;

/** Retry interval when waiting for a lock. */
const RETRY_INTERVAL_MS = 50;

/** Maximum time to wait for a lock before giving up. */
const MAX_WAIT_MS = 10_000;

interface LockMetadata {
  pid: number;
  timestamp: number;
}

/**
 * Attempts to acquire an advisory lock for the given path.
 * Returns true if the lock was acquired, false otherwise.
 *
 * The lock is a directory at `{path}.lock/` containing a `meta.json`
 * with the owning PID and creation timestamp.
 */
function tryAcquire(lockDir: string, staleMs: number): boolean {
  // Check for stale lock before attempting
  if (existsSync(lockDir)) {
    if (isLockStale(lockDir, staleMs)) {
      forceRelease(lockDir);
    } else {
      return false;
    }
  }

  try {
    mkdirSync(lockDir);
  } catch (err: unknown) {
    // EEXIST means another process acquired between our check and mkdir
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw err;
  }

  // Write metadata for stale detection
  const meta: LockMetadata = { pid: process.pid, timestamp: Date.now() };
  try {
    writeFileSync(resolve(lockDir, 'meta.json'), JSON.stringify(meta));
  } catch {
    // If we can't write metadata, release and fail
    forceRelease(lockDir);
    return false;
  }

  return true;
}

/**
 * Checks whether an existing lock is stale (owner dead or timed out).
 */
function isLockStale(lockDir: string, staleMs: number): boolean {
  const metaPath = resolve(lockDir, 'meta.json');
  try {
    const raw = readFileSync(metaPath, 'utf-8');
    const meta = JSON.parse(raw) as LockMetadata;

    // Check if the owning process is still alive
    if (!isPidAlive(meta.pid)) {
      return true;
    }

    // Check if the lock has exceeded the stale timeout
    if (Date.now() - meta.timestamp > staleMs) {
      return true;
    }

    return false;
  } catch {
    // No metadata or unreadable -- treat as stale
    return true;
  }
}

/**
 * Checks if a PID is alive using signal 0.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Force-removes a lock directory. Best-effort.
 */
function forceRelease(lockDir: string): void {
  try {
    const metaPath = resolve(lockDir, 'meta.json');
    if (existsSync(metaPath)) {
      unlinkSync(metaPath);
    }
    rmdirSync(lockDir);
  } catch {
    /* best effort */
  }
}

/**
 * Releases an advisory lock. Safe to call even if the lock is not held.
 */
export function releaseLock(lockDir: string): void {
  forceRelease(lockDir);
}

/**
 * Acquires an advisory lock, retrying until timeout.
 *
 * @param lockDir Path to the lock directory (typically `{target}.lock`)
 * @param staleMs Time in ms after which an unreleased lock is considered stale
 * @returns true if acquired, false if timed out
 */
export async function acquireLock(
  lockDir: string,
  staleMs: number = DEFAULT_STALE_MS,
): Promise<boolean> {
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    if (tryAcquire(lockDir, staleMs)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }

  return false;
}

/**
 * Executes a function while holding an advisory file lock.
 *
 * Acquires the lock, runs the function, and releases the lock in a
 * finally block. Throws if the lock cannot be acquired within the
 * timeout period.
 *
 * @param lockDir Path to the lock directory
 * @param fn The function to execute under lock
 * @param staleMs Stale lock timeout (default 30s)
 */
export async function withFileLock<T>(
  lockDir: string,
  fn: () => T | Promise<T>,
  staleMs: number = DEFAULT_STALE_MS,
): Promise<T> {
  const acquired = await acquireLock(lockDir, staleMs);
  if (!acquired) {
    throw new Error(`Failed to acquire file lock: ${lockDir} (timed out after ${MAX_WAIT_MS}ms)`);
  }

  try {
    return await fn();
  } finally {
    releaseLock(lockDir);
  }
}

/**
 * Returns the conventional lock directory path for a job directory.
 * The lock is placed at `{jobDir}/job.json.lock/`.
 */
export function getJobLockDir(jobDir: string): string {
  return resolve(jobDir, 'job.json.lock');
}
