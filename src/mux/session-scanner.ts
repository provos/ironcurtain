/**
 * Session scanner -- discovers resumable sessions from disk.
 *
 * Reads `session-state.json` files from the sessions directory,
 * filters for resumable sessions, and returns them sorted by
 * last activity (most recent first).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { getSessionsDir, getSessionSandboxDir } from '../config/paths.js';
import { SESSION_STATE_FILENAME } from '../docker/pty-types.js';
import type { SessionSnapshot } from '../docker/pty-types.js';

export type { SessionSnapshot } from '../docker/pty-types.js';

/**
 * Scans the sessions directory for resumable sessions.
 * Returns snapshots sorted by lastActivity descending (most recent first).
 */
export function scanResumableSessions(): SessionSnapshot[] {
  const sessionsDir = getSessionsDir();

  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return [];
  }

  const snapshots: SessionSnapshot[] = [];

  for (const entry of entries) {
    const statePath = resolve(sessionsDir, entry, SESSION_STATE_FILENAME);
    try {
      const raw = readFileSync(statePath, 'utf-8');
      const snapshot = JSON.parse(raw) as SessionSnapshot;
      if (snapshot.resumable && snapshot.sessionId) {
        snapshots.push(snapshot);
      }
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

/**
 * Formats a relative time description for display (e.g., "2h ago", "3d ago").
 */
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
