/**
 * Workflow definition discovery.
 *
 * Scans bundled and user directories for workflow definition JSON files,
 * and resolves workflow references (by name or file path) to absolute paths.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUserWorkflowsDir } from '../config/paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkflowSource = 'bundled' | 'user' | 'custom';

export interface WorkflowEntry {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: WorkflowSource;
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Returns the path to the bundled workflows directory.
 * Works in both dev (src/workflow/workflows/) and production (dist/workflow/workflows/).
 */
export function getBundledWorkflowsDir(): string {
  return resolve(__dirname, 'workflows');
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scans a directory for .json workflow definitions.
 * Returns entries with the given source tag.
 */
function scanDirectory(dir: string, source: WorkflowSource): WorkflowEntry[] {
  if (!existsSync(dir)) return [];

  const entries: WorkflowEntry[] = [];

  for (const fileName of readdirSync(dir)) {
    if (extname(fileName) !== '.json') continue;

    const filePath = resolve(dir, fileName);
    const name = basename(fileName, '.json');

    try {
      const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
      const obj = raw as Record<string, unknown>;
      const description = typeof obj.description === 'string' ? obj.description : '';
      entries.push({ name, description, path: filePath, source });
    } catch {
      // Skip files that are not valid JSON
    }
  }

  return entries;
}

/**
 * Discovers all available workflow definitions from bundled and user directories.
 * User workflows override bundled ones on name collision.
 * Returns entries sorted alphabetically by name.
 */
export function discoverWorkflows(): WorkflowEntry[] {
  const bundled = scanDirectory(getBundledWorkflowsDir(), 'bundled');
  const user = scanDirectory(getUserWorkflowsDir(), 'user');

  // User entries override bundled on name collision
  const byName = new Map<string, WorkflowEntry>();
  for (const entry of bundled) {
    byName.set(entry.name, entry);
  }
  for (const entry of user) {
    byName.set(entry.name, entry);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolves a workflow reference to an absolute file path.
 *
 * Accepts either:
 * - A file path (absolute or relative) -- returned as-is if it exists
 * - A workflow name -- looked up in user dir first, then bundled dir
 *
 * Returns undefined if the reference cannot be resolved.
 */
export function resolveWorkflowPath(ref: string): string | undefined {
  // If it looks like a file path (has extension or separators), treat as path
  if (ref.includes('/') || ref.includes('\\') || extname(ref) === '.json') {
    const resolved = resolve(ref);
    return existsSync(resolved) ? resolved : undefined;
  }

  // Name-based lookup: user dir first, then bundled
  const userPath = resolve(getUserWorkflowsDir(), `${ref}.json`);
  if (existsSync(userPath)) return userPath;

  const bundledPath = resolve(getBundledWorkflowsDir(), `${ref}.json`);
  if (existsSync(bundledPath)) return bundledPath;

  return undefined;
}
