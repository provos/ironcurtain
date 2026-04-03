import { readFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { WorkflowId } from './types.js';

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

    const files = readdirSync(dir).filter((f) => {
      const stat = statSync(resolve(dir, f));
      return stat.isFile();
    });
    if (files.length === 0) return undefined;

    return readFileSync(resolve(dir, files.sort()[0]), 'utf-8');
  }

  listArtifactFiles(workflowId: WorkflowId, artifactName: string): string[] {
    const dir = resolve(this.artifactDir(workflowId), artifactName);
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter((f) => statSync(resolve(dir, f)).isFile())
      .sort();
  }

  findMissing(workflowId: WorkflowId, expectedOutputs: readonly string[]): string[] {
    const artifactDir = this.artifactDir(workflowId);
    const missing: string[] = [];

    for (const name of expectedOutputs) {
      const dir = resolve(artifactDir, name);
      if (!existsSync(dir)) {
        missing.push(name);
        continue;
      }
      const files = readdirSync(dir).filter((f) => statSync(resolve(dir, f)).isFile());
      if (files.length === 0) {
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
      if (!existsSync(dir)) continue;

      const files = readdirSync(dir)
        .filter((f) => statSync(join(dir, f)).isFile())
        .sort();

      for (const file of files) {
        const content = readFileSync(resolve(dir, file));
        hash.update(file);
        hash.update(content);
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
