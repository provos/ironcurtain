/**
 * Session scanner -- discovers resumable PTY sessions from disk.
 *
 * This module is shared by the mux and Web UI layers, so neither interactive
 * frontend needs to import the other.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { getSessionDir, getSessionsDir, getSessionSandboxDir, SESSION_STATE_FILENAME } from '../config/paths.js';
import { isSessionSnapshot, type SessionSnapshot } from '../docker/pty-types.js';
import { validateWorkspacePath } from '../session/workspace-validation.js';

export type { SessionSnapshot } from '../docker/pty-types.js';

function validateParsedResumeSession(
  parsed: unknown,
  resumeSessionId: string,
  protectedPaths: string[],
): SessionSnapshot {
  const parsedSessionId =
    typeof parsed === 'object' && parsed !== null ? (parsed as { sessionId?: unknown }).sessionId : undefined;
  if (parsedSessionId !== resumeSessionId) {
    throw new Error(`Cannot resume session "${resumeSessionId}": snapshot sessionId mismatch`);
  }
  if (!isSessionSnapshot(parsed)) {
    throw new Error(`Cannot resume session "${resumeSessionId}": session state snapshot is corrupted or invalid`);
  }
  if (!parsed.resumable) {
    throw new Error(`Cannot resume session "${resumeSessionId}": session is not resumable (status: ${parsed.status})`);
  }

  try {
    validateWorkspacePath(parsed.workspacePath, protectedPaths);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot resume session "${resumeSessionId}": workspace path is unsafe: ${detail}`, {
      cause: error,
    });
  }

  return parsed;
}

/**
 * Loads and authoritatively validates one persisted session for resume.
 * Direct launch callers must use this again even if the session was previously
 * listed, because the mutable snapshot or workspace may have changed.
 */
export function validateResumeSession(resumeSessionId: string, protectedPaths: string[] = []): SessionSnapshot {
  const sessionDir = getSessionDir(resumeSessionId);
  if (!existsSync(sessionDir)) {
    throw new Error(`Cannot resume session "${resumeSessionId}": session directory not found`);
  }
  const snapshotPath = resolve(sessionDir, SESSION_STATE_FILENAME);
  if (!existsSync(snapshotPath)) {
    throw new Error(`Cannot resume session "${resumeSessionId}": no session state snapshot found`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as unknown;
  } catch {
    throw new Error(`Cannot resume session "${resumeSessionId}": session state snapshot is corrupted or invalid`);
  }
  return validateParsedResumeSession(parsed, resumeSessionId, protectedPaths);
}

/**
 * Scans the sessions directory for resumable sessions.
 * Applies the same snapshot and workspace checks as direct resume validation.
 * Returns snapshots sorted by lastActivity descending (most recent first).
 */
export function scanResumableSessions(protectedPaths: string[]): SessionSnapshot[] {
  const sessionsDir = getSessionsDir();

  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return [];
  }

  const snapshots: SessionSnapshot[] = [];

  for (const entry of entries) {
    try {
      const statePath = resolve(getSessionDir(entry), SESSION_STATE_FILENAME);
      const raw = readFileSync(statePath, 'utf-8');
      const snapshot: unknown = JSON.parse(raw);
      snapshots.push(validateParsedResumeSession(snapshot, entry, protectedPaths));
    } catch {
      // Skip sessions without a valid state file
    }
  }

  snapshots.sort((a, b) => {
    const ta = new Date(a.lastActivity).getTime() || 0;
    const tb = new Date(b.lastActivity).getTime() || 0;
    return tb - ta;
  });

  return snapshots;
}

/** Shortens an absolute path by replacing $HOME with ~. */
export function shortenHomePath(p: string): string {
  const home = homedir();
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

/**
 * Returns a display-friendly workspace label for a session, or undefined
 * if the session uses the default sandbox (not an explicit --workspace).
 */
export function getWorkspaceLabel(s: SessionSnapshot): string | undefined {
  if (s.workspacePath === getSessionSandboxDir(s.sessionId)) {
    return undefined;
  }
  return shortenHomePath(s.workspacePath);
}

/** Formats a relative time description for display (e.g., "2h ago", "3d ago"). */
export function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  if (isNaN(diff)) return 'unknown';
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
