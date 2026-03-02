/**
 * Lock management for single-instance enforcement.
 *
 * Shared between `ironcurtain escalation-listener` and `ironcurtain mux`.
 * Uses O_EXCL for atomic lock file creation with PID liveness checks
 * to handle stale locks from crashed processes.
 */

import { existsSync, readFileSync, unlinkSync, openSync, writeSync, closeSync, constants } from 'node:fs';

/**
 * Acquires the listener lock file using O_EXCL for atomicity.
 * Returns true if the lock was acquired, false if another instance holds it.
 */
export function acquireLock(lockPath: string): boolean {
  if (existsSync(lockPath)) {
    // Check if the PID in the lock file is still alive
    try {
      const content = readFileSync(lockPath, 'utf-8');
      const pid = parseInt(content.trim(), 10);
      if (!isNaN(pid) && isPidAlive(pid)) {
        return false; // Another instance is running
      }
      // Stale lock -- remove and try again
      unlinkSync(lockPath);
    } catch {
      // If we can't read the lock, try to recreate it
      try {
        unlinkSync(lockPath);
      } catch {
        return false;
      }
    }
  }

  try {
    const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const content = Buffer.from(String(process.pid));
    writeSync(fd, content);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Releases the listener lock file. Best-effort -- ignores errors.
 */
export function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* best effort */
  }
}

/**
 * Checks if a PID is alive using signal 0.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
