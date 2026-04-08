import { readFileSync, mkdirSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { WorkflowId } from './types.js';

// ---------------------------------------------------------------------------
// Shared filesystem helpers (used by orchestrator, prompt-builder, and manager)
// ---------------------------------------------------------------------------

export interface CollectedFile {
  /** Path relative to the root directory, using forward slashes. */
  readonly relativePath: string;
  /** Absolute path on disk. */
  readonly fullPath: string;
}

/**
 * Recursively walks a directory and returns all regular files (not directories
 * or symlinks). Results are sorted by relative path for deterministic ordering.
 */
export function collectFilesRecursive(dir: string): CollectedFile[] {
  if (!existsSync(dir)) return [];

  const results: CollectedFile[] = [];
  walkDir(dir, dir, results);
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

function walkDir(rootDir: string, currentDir: string, results: CollectedFile[]): void {
  let entries: string[];
  try {
    entries = readdirSync(currentDir);
  } catch {
    return; // Directory removed or inaccessible
  }
  for (const entry of entries) {
    const fullPath = resolve(currentDir, entry);
    try {
      const lstats = lstatSync(fullPath);
      if (lstats.isSymbolicLink()) continue;
      if (lstats.isDirectory()) {
        walkDir(rootDir, fullPath, results);
      } else if (lstats.isFile()) {
        results.push({
          relativePath: relative(rootDir, fullPath).split(sep).join('/'),
          fullPath,
        });
      }
    } catch {
      // File removed between readdir and lstat, or permission error — skip
      continue;
    }
  }
}

/**
 * Recursively checks whether a directory contains any regular files.
 * More efficient than collectFilesRecursive when you only need a boolean.
 */
export function hasAnyFiles(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return hasAnyFilesInDir(dir);
}

function hasAnyFilesInDir(currentDir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(currentDir);
  } catch {
    return false; // Directory removed or inaccessible
  }
  for (const entry of entries) {
    const fullPath = resolve(currentDir, entry);
    try {
      const lstats = lstatSync(fullPath);
      if (lstats.isSymbolicLink()) continue;
      if (lstats.isFile()) return true;
      if (lstats.isDirectory() && hasAnyFilesInDir(fullPath)) return true;
    } catch {
      // File removed between readdir and lstat, or permission error — skip
      continue;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Manages artifact directories and files for workflow state transitions. */
export interface ArtifactManager {
  /** Ensure the artifact directory structure exists for a workflow. Returns artifact dir path. */
  initialize(workflowId: WorkflowId): string;

  /** Read an artifact file's content. Returns undefined if not found. */
  read(workflowId: WorkflowId, artifactName: string): string | undefined;

  /** List all files in an artifact subdirectory. */
  listArtifactFiles(workflowId: WorkflowId, artifactName: string): string[];

  /** Check which expected outputs are missing. Returns list of missing artifact names. */
  findMissing(workflowId: WorkflowId, expectedOutputs: readonly string[]): string[];

  /** Compute SHA-256 hash of artifact directories' contents. Deterministic ordering. */
  computeHash(workflowId: WorkflowId, artifactNames: readonly string[]): string;
}

// ---------------------------------------------------------------------------
// File-based implementation
// ---------------------------------------------------------------------------

/**
 * File-based artifact manager. Each workflow gets an artifact directory at
 * `{baseDir}/{workflowId}/artifacts/`. Within that, each artifact name
 * maps to a subdirectory containing one or more files.
 */
export class FileArtifactManager implements ArtifactManager {
  constructor(private readonly baseDir: string) {}

  initialize(workflowId: WorkflowId): string {
    const artifactDir = this.artifactDir(workflowId);
    mkdirSync(artifactDir, { recursive: true });
    return artifactDir;
  }

  read(workflowId: WorkflowId, artifactName: string): string | undefined {
    const dir = resolve(this.artifactDir(workflowId), artifactName);
    if (!existsSync(dir)) return undefined;

    // Try convention name first, then fall back to first file
    const conventionPath = resolve(dir, `${artifactName}.md`);
    if (existsSync(conventionPath)) {
      return readFileSync(conventionPath, 'utf-8');
    }

    const files = collectFilesRecursive(dir);
    if (files.length === 0) return undefined;

    return readFileSync(files[0].fullPath, 'utf-8');
  }

  listArtifactFiles(workflowId: WorkflowId, artifactName: string): string[] {
    const dir = resolve(this.artifactDir(workflowId), artifactName);
    return collectFilesRecursive(dir).map((f) => f.relativePath);
  }

  findMissing(workflowId: WorkflowId, expectedOutputs: readonly string[]): string[] {
    const artifactDir = this.artifactDir(workflowId);
    const missing: string[] = [];

    for (const name of expectedOutputs) {
      const dir = resolve(artifactDir, name);
      if (!hasAnyFiles(dir)) {
        missing.push(name);
      }
    }

    return missing;
  }

  computeHash(workflowId: WorkflowId, artifactNames: readonly string[]): string {
    const hash = createHash('sha256');
    const artifactDir = this.artifactDir(workflowId);

    for (const name of [...artifactNames].sort()) {
      const dir = resolve(artifactDir, name);
      const files = collectFilesRecursive(dir);
      for (const file of files) {
        hash.update(file.relativePath);
        hash.update(readFileSync(file.fullPath));
      }
    }

    return hash.digest('hex');
  }

  /** Get the artifact directory path for a workflow. */
  artifactDirFor(workflowId: WorkflowId): string {
    return this.artifactDir(workflowId);
  }

  private artifactDir(workflowId: WorkflowId): string {
    return resolve(this.baseDir, workflowId, 'artifacts');
  }
}
