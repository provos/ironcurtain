/**
 * Session registry -- reads and validates PTY session registration files.
 *
 * PTY sessions write registration files to ~/.ironcurtain/pty-registry/
 * when they start, and delete them on shutdown. The escalation listener
 * polls this directory to discover active sessions.
 *
 * Stale session detection: if a registration file exists but the PID
 * is no longer alive, the session crashed without cleanup. The registry
 * removes stale registrations.
 */

import { readdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PtySessionRegistration } from '../docker/pty-types.js';

/**
 * Reads all valid, non-stale session registrations from the registry directory.
 * Removes stale registrations (PID no longer alive) as a side effect.
 */
export function readActiveRegistrations(registryDir: string): PtySessionRegistration[] {
  if (!existsSync(registryDir)) return [];

  const registrations: PtySessionRegistration[] = [];

  let files: string[];
  try {
    files = readdirSync(registryDir).filter((f) => f.startsWith('session-') && f.endsWith('.json'));
  } catch {
    return [];
  }

  for (const file of files) {
    const filePath = resolve(registryDir, file);
    const registration = readRegistration(filePath);
    if (!registration) continue;

    if (isPidAlive(registration.pid)) {
      registrations.push(registration);
    } else {
      // Stale registration: PID is dead, remove the file
      removeStaleRegistration(filePath);
    }
  }

  return registrations;
}

/**
 * Reads and parses a single registration file.
 * Returns undefined if the file is missing or malformed.
 */
function readRegistration(filePath: string): PtySessionRegistration | undefined {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    if (!isValidRegistration(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Type guard for PtySessionRegistration.
 */
function isValidRegistration(value: unknown): value is PtySessionRegistration {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.sessionId === 'string' &&
    typeof obj.escalationDir === 'string' &&
    typeof obj.label === 'string' &&
    typeof obj.startedAt === 'string' &&
    typeof obj.pid === 'number'
  );
}

/**
 * Checks if a PID is alive. Uses process.kill(pid, 0) which
 * returns true if the process exists and the caller has permission
 * to signal it (same user).
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
 * Removes a stale registration file. Best-effort -- ignores errors.
 */
function removeStaleRegistration(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Ignore -- file may have been removed by another process
  }
}
