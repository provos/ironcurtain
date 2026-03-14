/**
 * Resolves the SQLite database path for the memory MCP server
 * based on the session context (persona or cron job).
 *
 * Memory is only available for persona and cron job sessions,
 * not for ad-hoc default sessions.
 */

import { resolve } from 'node:path';
import { getJobDir } from '../config/paths.js';
import { getPersonaDir } from '../persona/resolve.js';
import { createPersonaName } from '../persona/types.js';

/**
 * Returns the absolute path to the memory SQLite database.
 *
 * - Persona sessions: ~/.ironcurtain/personas/{name}/memory.db
 * - Cron jobs (no persona): ~/.ironcurtain/jobs/{jobId}/memory.db
 *
 * Uses the established path helpers and validators (createPersonaName,
 * getJobDir) to ensure consistent validation and path construction.
 */
export function resolveMemoryDbPath(opts: { persona?: string; jobId?: string }): string {
  if (opts.persona) {
    return resolve(getPersonaDir(createPersonaName(opts.persona)), 'memory.db');
  }

  if (opts.jobId) {
    return resolve(getJobDir(opts.jobId), 'memory.db');
  }

  throw new Error('resolveMemoryDbPath requires either persona or jobId');
}
