/**
 * Workflow definition discovery.
 *
 * Workflows are packaged as directories: each workflow lives under its
 * own directory containing a `workflow.yaml` (or `workflow.yml`)
 * manifest plus optional sibling resources like a `skills/` subdir.
 *
 *   src/workflow/workflows/<name>/workflow.yaml      (bundled)
 *   ~/.ironcurtain/workflows/<name>/workflow.yaml    (user)
 *
 * The directory shape is what allows skills (and other future co-packaged
 * resources) to travel with the workflow definition. Single-file and
 * JSON manifest forms are not accepted as inputs; JSON remains an
 * internal serialization format used by workflow-resume checkpointing.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
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
  /**
   * Manifest `hidden: true` — the workflow is a smoke-test / fixture that
   * should not surface in the web UI. The CLI still lists it. Defaults to
   * false for manifests that omit the field.
   */
  readonly hidden: boolean;
  /** A `README.md` is co-packaged alongside the manifest. */
  readonly hasReadme: boolean;
}

// ---------------------------------------------------------------------------
// File format support
// ---------------------------------------------------------------------------

/** Manifest filenames probed inside a workflow package directory. */
const MANIFEST_BASENAMES = ['workflow.yaml', 'workflow.yml'] as const;

/** README filenames probed inside a workflow package directory (yaml-style precedence). */
const README_BASENAMES = ['README.md', 'readme.md'] as const;

/** Hard cap on README size returned to clients (defensive; READMEs are tiny). */
const MAX_README_BYTES = 512 * 1024;

/** Recognized YAML extensions for ad-hoc file-path workflow refs. */
const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);

/**
 * Parses a workflow definition file. Dispatches on extension:
 *   - `.yaml` / `.yml` -> YAML parse with alias expansion disabled
 *     (prevents YAML-bomb DoS via reference amplification)
 *   - `.json`          -> JSON parse
 *
 * Returns the parsed value unvalidated — the workflow definition Zod
 * schema enforces structure downstream.
 *
 * Note on the JSON branch: user-facing manifests must be YAML; the
 * discovery layer (`discoverWorkflows`, `resolveWorkflowPath`) only
 * looks for `workflow.{yaml,yml}` and rejects JSON path-style refs.
 * The JSON branch survives only for internal serialization — the
 * resume path reads `<runDir>/definition.json` written at workflow
 * start, which is JSON for compactness and because it round-trips a
 * validated `WorkflowDefinition` rather than user-authored markup.
 *
 * @throws if the file cannot be read or parsed
 */
export function parseDefinitionFile(filePath: string): unknown {
  const ext = extname(filePath).toLowerCase();
  const content = readFileSync(filePath, 'utf-8');
  if (ext === '.yaml' || ext === '.yml') {
    return YAML.parse(content, { maxAliasCount: 0 });
  }
  if (ext === '.json') {
    return JSON.parse(content);
  }
  throw new Error(`Unsupported workflow file extension: ${ext}`);
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

/**
 * Returns the directory containing a workflow's package, given the
 * absolute path to its manifest. Co-packaged resources (currently the
 * optional `skills/` subdir) live here.
 */
export function getWorkflowPackageDir(workflowFilePath: string): string {
  return dirname(workflowFilePath);
}

/** Returns the first `<dir>/<basename>` that exists on disk, or `undefined`. */
function findFirstExisting(dir: string, basenames: readonly string[]): string | undefined {
  for (const basename of basenames) {
    const candidate = resolve(dir, basename);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Locates the manifest file inside a workflow package directory.
 * Returns the absolute path to `workflow.yaml` or `workflow.yml` if
 * present (yaml takes precedence on collision), `undefined` otherwise.
 */
function findManifest(packageDir: string): string | undefined {
  return findFirstExisting(packageDir, MANIFEST_BASENAMES);
}

/**
 * Locates a co-packaged README inside a workflow package directory.
 * Returns the absolute path to `README.md` / `readme.md` if present,
 * `undefined` otherwise.
 */
function findReadme(packageDir: string): string | undefined {
  return findFirstExisting(packageDir, README_BASENAMES);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scans a workflows root for package directories and returns one entry
 * per directory that contains a valid manifest. Subdirectories without
 * a `workflow.yaml`/`workflow.yml`, or whose manifest fails to parse,
 * are skipped silently — the same forgiving posture other discovery
 * paths in this project take (e.g., `discoverSkills`).
 *
 * The entry's `name` is the package directory's name, NOT the
 * manifest's `name:` field. This matches `resolveWorkflowPath`, which
 * looks up workflows by directory name.
 */
function scanDirectory(dir: string, source: WorkflowSource): WorkflowEntry[] {
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const out: WorkflowEntry[] = [];
  for (const name of entries) {
    const packageDir = resolve(dir, name);
    let stats;
    try {
      stats = statSync(packageDir);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;

    const manifest = findManifest(packageDir);
    if (!manifest) continue;

    let description = '';
    let hidden = false;
    try {
      const raw = parseDefinitionFile(manifest) as Record<string, unknown>;
      if (typeof raw.description === 'string') description = raw.description;
      if (raw.hidden === true) hidden = true;
    } catch {
      // Skip packages with unparseable manifests
      continue;
    }
    const hasReadme = findReadme(packageDir) !== undefined;
    out.push({ name, description, path: manifest, source, hidden, hasReadme });
  }

  return out;
}

/**
 * Discovers all available workflow definitions from bundled and user
 * directories. User workflows override bundled ones on name collision.
 * Returned entries are sorted alphabetically by name.
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
 * Finds a discovered workflow by its directory name (which, by convention,
 * matches the manifest `name:` field — the value carried on workflow run
 * records). Used to resolve a running/past workflow back to its source
 * package (e.g. to read its README). User entries shadow bundled ones, per
 * {@link discoverWorkflows}.
 */
export function findWorkflowByName(name: string): WorkflowEntry | undefined {
  return discoverWorkflows().find((entry) => entry.name === name);
}

/**
 * Reads the README.md co-packaged with a workflow, given the absolute path
 * to its manifest. Returns the raw markdown, or `undefined` when no README
 * is present, it exceeds {@link MAX_README_BYTES}, or it cannot be read.
 */
export function readWorkflowReadme(manifestPath: string): string | undefined {
  const readme = findReadme(getWorkflowPackageDir(manifestPath));
  if (!readme) return undefined;
  try {
    if (statSync(readme).size > MAX_README_BYTES) return undefined;
    return readFileSync(readme, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Resolves a workflow reference to an absolute manifest path. User-facing
 * refs are YAML-only — JSON path-style refs are silently dropped because
 * `definition.json` is an internal serialization format produced by
 * workflow-resume checkpointing, not a manifest authors should reference.
 *
 * Resolution matrix:
 *  - bare name (`my-flow`)       → probe user dir then bundled dir for
 *                                  `<root>/<ref>/workflow.{yaml,yml}`
 *  - path with no extension      → treat as a package directory, probe
 *    (`./my-flow`, `/abs/foo`)     `<ref>/workflow.{yaml,yml}`
 *  - explicit `.yaml` / `.yml`   → return as-is when the file exists
 *  - any other extension         → undefined (JSON refs included; the
 *                                  resume path reads `definition.json`
 *                                  directly, not via this resolver)
 *
 * Returns `undefined` when the reference cannot be resolved.
 */
export function resolveWorkflowPath(ref: string): string | undefined {
  const ext = extname(ref).toLowerCase();
  const isPathStyle = ref.includes('/') || ref.includes('\\');

  if (YAML_EXTENSIONS.has(ext)) {
    const resolved = resolve(ref);
    return existsSync(resolved) ? resolved : undefined;
  }

  if (isPathStyle) {
    // No extension → package directory. A non-yaml extension (e.g.
    // `.json`) on a path-style ref falls through to undefined: not a
    // user-facing form.
    if (ext === '') {
      return findManifest(resolve(ref));
    }
    return undefined;
  }

  const userManifest = findManifest(resolve(getUserWorkflowsDir(), ref));
  if (userManifest) return userManifest;

  const bundledManifest = findManifest(resolve(getBundledWorkflowsDir(), ref));
  if (bundledManifest) return bundledManifest;

  return undefined;
}
