import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkflowId, WorkflowCheckpoint } from './types.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Persistent storage for workflow checkpoints. */
export interface CheckpointStore {
  /** Save a checkpoint. Overwrites any previous checkpoint for this workflow. */
  save(workflowId: WorkflowId, checkpoint: WorkflowCheckpoint): void;

  /** Load the most recent checkpoint for a workflow. Returns undefined if none exists. */
  load(workflowId: WorkflowId): WorkflowCheckpoint | undefined;

  /** List workflow IDs that have checkpoints (for resume discovery). */
  listAll(): WorkflowId[];

  /** Remove a checkpoint (on workflow completion or abort). */
  remove(workflowId: WorkflowId): void;
}

// ---------------------------------------------------------------------------
// File-based implementation
// ---------------------------------------------------------------------------

/**
 * File-based checkpoint store. Each workflow gets a directory at
 * `{baseDir}/{workflowId}/checkpoint.json`. Writes are atomic
 * (write to temp file, then rename) to prevent corruption from
 * partial writes.
 */
export class FileCheckpointStore implements CheckpointStore {
  constructor(private readonly baseDir: string) {}

  save(workflowId: WorkflowId, checkpoint: WorkflowCheckpoint): void {
    const filePath = this.checkpointPath(workflowId);
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });

    const content = JSON.stringify(checkpoint, null, 2);
    const tempPath = resolve(dir, `checkpoint.tmp.${randomUUID()}`);
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, filePath);
  }

  load(workflowId: WorkflowId): WorkflowCheckpoint | undefined {
    const filePath = this.checkpointPath(workflowId);
    if (!existsSync(filePath)) return undefined;

    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as WorkflowCheckpoint;
  }

  listAll(): WorkflowId[] {
    if (!existsSync(this.baseDir)) return [];

    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    const ids: WorkflowId[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const checkpointFile = resolve(this.baseDir, entry.name, 'checkpoint.json');
      if (existsSync(checkpointFile)) {
        ids.push(entry.name as WorkflowId);
      }
    }
    return ids;
  }

  remove(workflowId: WorkflowId): void {
    const filePath = this.checkpointPath(workflowId);
    if (existsSync(filePath)) {
      rmSync(filePath);
    }
  }

  private checkpointPath(workflowId: WorkflowId): string {
    return resolve(this.baseDir, workflowId, 'checkpoint.json');
  }
}
