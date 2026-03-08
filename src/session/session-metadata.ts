/**
 * Persistence for session metadata (persona, workspace, policyDir).
 *
 * Written once when a session is created; read back on --resume so
 * the session continues with the same settings.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getSessionMetadataPath } from '../config/paths.js';
import type { SessionMetadata } from './types.js';

/**
 * Writes session metadata to disk. No-ops if the file already exists
 * (idempotent for edge cases like retried session creation).
 */
export function saveSessionMetadata(sessionId: string, metadata: SessionMetadata): void {
  const path = getSessionMetadataPath(sessionId);
  if (existsSync(path)) return;
  writeFileSync(path, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
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
