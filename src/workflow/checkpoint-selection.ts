/**
 * Past-run checkpoint selection helpers.
 *
 * Both the CLI (`workflow resume`) and the daemon's
 * `WorkflowManager.importExternalCheckpoint` need to scan a base directory
 * for resumable workflow runs and pick the most recent. Centralized here
 * so both paths use the same enumeration + filter + sort logic.
 *
 * Sort comparator: ISO-8601 string compare on `checkpoint.timestamp`. Both
 * the previous CLI implementation (`new Date(...).getTime()`) and the
 * previous daemon implementation (`a > b` string compare) produce the same
 * order; string compare is one fewer allocation per row.
 */

import { discoverWorkflowRuns } from './workflow-discovery.js';
import { isCheckpointResumable, type FileCheckpointStore } from './checkpoint.js';
import type { WorkflowCheckpoint, WorkflowId } from './types.js';

/** A resumable past run paired with its loaded checkpoint. */
export interface ResumableCheckpoint {
  readonly workflowId: WorkflowId;
  readonly checkpoint: WorkflowCheckpoint;
}

/**
 * Returns every resumable past run under `baseDir`, sorted newest-first by
 * `checkpoint.timestamp` (ISO-8601 string compare).
 *
 * "Resumable" means: the directory has a checkpoint file, the checkpoint
 * loads successfully, and {@link isCheckpointResumable} returns true
 * (i.e. the checkpoint is not in a `completed` final phase).
 */
export function findResumableCheckpoints(baseDir: string, store: FileCheckpointStore): ResumableCheckpoint[] {
  const candidates: ResumableCheckpoint[] = [];
  for (const run of discoverWorkflowRuns(baseDir)) {
    if (!run.hasCheckpoint) continue;
    const cp = store.load(run.workflowId);
    if (!cp || !isCheckpointResumable(cp)) continue;
    candidates.push({ workflowId: run.workflowId, checkpoint: cp });
  }
  candidates.sort((a, b) => {
    if (a.checkpoint.timestamp === b.checkpoint.timestamp) return 0;
    return a.checkpoint.timestamp < b.checkpoint.timestamp ? 1 : -1;
  });
  return candidates;
}

/**
 * Returns the most recent resumable past run under `baseDir`, or `undefined`
 * if none exist. Convenience wrapper over {@link findResumableCheckpoints}.
 */
export function findLatestResumableCheckpoint(
  baseDir: string,
  store: FileCheckpointStore,
): ResumableCheckpoint | undefined {
  return findResumableCheckpoints(baseDir, store)[0];
}
