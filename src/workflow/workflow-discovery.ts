import { readdirSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkflowId } from './types.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Lightweight metadata for a single workflow-run directory on disk. Produced
 * by {@link discoverWorkflowRuns}; callers decide which probe files matter
 * and load richer content (checkpoints, definitions, message logs) on demand.
 */
export interface WorkflowRunSummary {
  /** Directory name, cast to the branded workflow-id type. */
  readonly workflowId: WorkflowId;
  /** Absolute path to the run directory. */
  readonly directoryPath: string;
  /** `true` if `checkpoint.json` exists in the directory. */
  readonly hasCheckpoint: boolean;
  /** `true` if `definition.json` exists in the directory. */
  readonly hasDefinition: boolean;
  /** `true` if `messages.jsonl` exists in the directory. */
  readonly hasMessageLog: boolean;
  /** Directory mtime from `statSync`. Used as the default sort key. */
  readonly mtime: Date;
}

/**
 * Scan `baseDir` for workflow-run directories and return one summary per
 * immediate subdirectory. Files at the base are skipped. Results are sorted
 * newest-first by directory `mtime`.
 *
 * Returns `[]` when `baseDir` does not exist (mirrors
 * `FileCheckpointStore.listAll()`). Any other I/O error — permission denied
 * mid-scan, malformed filesystem entries — is allowed to bubble as a thrown
 * `Error`.
 *
 * Probe-file checks use `existsSync` only; no JSON parsing is performed.
 */
export function discoverWorkflowRuns(baseDir: string): WorkflowRunSummary[] {
  if (!existsSync(baseDir)) return [];

  const entries = readdirSync(baseDir, { withFileTypes: true });
  const summaries: WorkflowRunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directoryPath = resolve(baseDir, entry.name);
    const stats = statSync(directoryPath);
    summaries.push({
      workflowId: entry.name as WorkflowId,
      directoryPath,
      hasCheckpoint: existsSync(resolve(directoryPath, 'checkpoint.json')),
      hasDefinition: existsSync(resolve(directoryPath, 'definition.json')),
      hasMessageLog: existsSync(resolve(directoryPath, 'messages.jsonl')),
      mtime: stats.mtime,
    });
  }

  summaries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return summaries;
}

/**
 * Returns the `WorkflowRunSummary` for a single `workflowId` under `baseDir`,
 * or `undefined` when the directory does not exist.
 *
 * This is a one-shot variant of {@link discoverWorkflowRuns} for call sites
 * that already know the id they care about (e.g. the daemon's `workflows.get`
 * disk-fallback path) and shouldn't pay the cost of enumerating every sibling
 * directory just to look up one summary. The probe-file checks and stat are
 * intentionally identical to the enumeration path to keep the two sources of
 * truth in lockstep.
 */
export function summaryForId(baseDir: string, workflowId: WorkflowId): WorkflowRunSummary | undefined {
  const directoryPath = resolve(baseDir, workflowId);
  if (!existsSync(directoryPath)) return undefined;
  const stats = statSync(directoryPath);
  if (!stats.isDirectory()) return undefined;
  return {
    workflowId,
    directoryPath,
    hasCheckpoint: existsSync(resolve(directoryPath, 'checkpoint.json')),
    hasDefinition: existsSync(resolve(directoryPath, 'definition.json')),
    hasMessageLog: existsSync(resolve(directoryPath, 'messages.jsonl')),
    mtime: stats.mtime,
  };
}
