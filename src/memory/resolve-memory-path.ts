/**
 * Resolves the SQLite database path for the memory MCP server
 * based on the session context (persona, cron job, or default).
 */

import { resolve } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';

/**
 * Returns the absolute path to the memory SQLite database.
 *
 * - Persona sessions: ~/.ironcurtain/personas/{name}/memory.db
 * - Cron jobs (no persona): ~/.ironcurtain/jobs/{jobId}/memory.db
 * - Default sessions: ~/.ironcurtain/memory/default.db
 */
export function resolveMemoryDbPath(opts?: { persona?: string; jobId?: string }): string {
  const home = getIronCurtainHome();

  if (opts?.persona) {
    return resolve(home, 'personas', opts.persona, 'memory.db');
  }

  if (opts?.jobId) {
    return resolve(home, 'jobs', opts.jobId, 'memory.db');
  }

  return resolve(home, 'memory', 'default.db');
}
