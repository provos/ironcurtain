/**
 * Workflow definition discovery.
 *
 * Scans bundled and user directories for workflow definition files (YAML or JSON),
 * and resolves workflow references (by name or file path) to absolute paths.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
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
// File format support
// ---------------------------------------------------------------------------

/** File extensions recognized as workflow definition files. */
const DEFINITION_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

/**
 * Extension priority for name-based resolution.
 * YAML is preferred over JSON for bundled/user workflows.
 */
const EXTENSION_PRIORITY = ['.yaml', '.yml', '.json'] as const;

/**
 * Parses a workflow definition file, dispatching on extension.
 * Returns the parsed object (unvalidated).
 *
 * @throws if the file cannot be read or parsed
 */
export function parseDefinitionFile(filePath: string): unknown {
  const ext = extname(filePath).toLowerCase();
  const content = readFileSync(filePath, 'utf-8');

  if (ext === '.yaml' || ext === '.yml') {
    // Workflow definitions should not use YAML aliases/anchors.
    // Limit alias expansion to prevent YAML bomb DoS.
    return YAML.parse(content, { maxAliasCount: 100 });
  }
  return JSON.parse(content);
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
 * Scans a directory for workflow definition files (.yaml, .yml, .json).
 * Returns entries with the given source tag.
 * When multiple files share a name, YAML takes precedence over JSON.
 */
function scanDirectory(dir: string, source: WorkflowSource): WorkflowEntry[] {
  if (!existsSync(dir)) return [];

  const byName = new Map<string, WorkflowEntry>();

  for (const fileName of readdirSync(dir)) {
    const ext = extname(fileName).toLowerCase();
    if (!DEFINITION_EXTENSIONS.has(ext)) continue;

    const filePath = resolve(dir, fileName);
    const name = basename(fileName, ext);

    // When multiple files share a name, higher-priority extensions win (.yaml > .yml > .json)
    const existing = byName.get(name);
    if (existing) {
      const existingExt = extname(existing.path).toLowerCase();
      const existingPri = EXTENSION_PRIORITY.indexOf(existingExt as (typeof EXTENSION_PRIORITY)[number]);
      const newPri = EXTENSION_PRIORITY.indexOf(ext as (typeof EXTENSION_PRIORITY)[number]);
      if (newPri >= existingPri) continue;
    }

    try {
      const raw: unknown = parseDefinitionFile(filePath);
      const obj = raw as Record<string, unknown>;
      const description = typeof obj.description === 'string' ? obj.description : '';
      byName.set(name, { name, description, path: filePath, source });
    } catch {
      // Skip files that cannot be parsed
    }
  }

  return [...byName.values()];
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
 * For name-based lookup, tries extensions in priority order: .yaml, .yml, .json.
 * Returns undefined if the reference cannot be resolved.
 */
export function resolveWorkflowPath(ref: string): string | undefined {
  // If it looks like a file path (has extension or separators), treat as path
  const ext = extname(ref).toLowerCase();
  if (ref.includes('/') || ref.includes('\\') || DEFINITION_EXTENSIONS.has(ext)) {
    const resolved = resolve(ref);
    return existsSync(resolved) ? resolved : undefined;
  }

  // Name-based lookup: user dir first, then bundled, YAML preferred
  for (const searchExt of EXTENSION_PRIORITY) {
    const userPath = resolve(getUserWorkflowsDir(), `${ref}${searchExt}`);
    if (existsSync(userPath)) return userPath;
  }

  for (const searchExt of EXTENSION_PRIORITY) {
    const bundledPath = resolve(getBundledWorkflowsDir(), `${ref}${searchExt}`);
    if (existsSync(bundledPath)) return bundledPath;
  }

  return undefined;
}
