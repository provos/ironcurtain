import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkflowId, WorkflowCheckpoint } from './types.js';

// ---------------------------------------------------------------------------
// Resumability predicate
// ---------------------------------------------------------------------------

/**
 * Resumable iff not completed. `finalStatus` is undefined for mid-run and
 * pre-B3b legacy checkpoints — both correctly resolve to `true`.
 *
 * Co-located with `WorkflowCheckpoint` storage so other modules can import
 * the predicate without pulling in CLI / session dependencies.
 */
export function isCheckpointResumable(cp: WorkflowCheckpoint): boolean {
  return cp.finalStatus?.phase !== 'completed';
}

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
    try {
      const content = readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as WorkflowCheckpoint;
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
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
    try {
      rmSync(filePath);
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }

  private checkpointPath(workflowId: WorkflowId): string {
    return resolve(this.baseDir, workflowId, 'checkpoint.json');
  }
}
