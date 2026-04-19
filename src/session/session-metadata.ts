/**
 * Persistence for session metadata (persona, workspace, policyDir).
 *
 * Written once when a session is created; read back on --resume so
 * the session continues with the same settings.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { getSessionMetadataPath } from '../config/paths.js';
import type { SessionMetadata } from './types.js';

/**
 * Writes session metadata to an explicit path. Primary API used by
 * borrow-mode callers (e.g., workflow per-state dirs) that don't live
 * under `{home}/sessions/{sessionId}/`.
 *
 * No-ops if the file already exists (idempotent for retried session
 * creation). Uses `wx` flag to atomically fail on existence rather than
 * stat-then-write (TOCTOU-safe).
 */
export function saveSessionMetadataTo(path: string, metadata: SessionMetadata): void {
  try {
    writeFileSync(path, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', encoding: 'utf-8' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

/**
 * Writes session metadata for a session ID. Thin wrapper around
 * `saveSessionMetadataTo` that derives the path from the session ID.
 */
export function saveSessionMetadata(sessionId: string, metadata: SessionMetadata): void {
  saveSessionMetadataTo(getSessionMetadataPath(sessionId), metadata);
}

/**
 * Reads session metadata from disk. Returns undefined if the file
 * is missing or contains invalid JSON (graceful for old sessions
 * created before metadata persistence was added).
 */
export function loadSessionMetadata(sessionId: string): SessionMetadata | undefined {
  const path = getSessionMetadataPath(sessionId);
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as SessionMetadata;
  } catch {
    return undefined;
  }
}
