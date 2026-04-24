import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkflowId } from './types.js';

export interface WorkflowRunSummary {
  readonly workflowId: WorkflowId;
  readonly directoryPath: string;
  readonly hasCheckpoint: boolean;
  readonly hasDefinition: boolean;
  readonly hasMessageLog: boolean;
  readonly mtime: Date;
}

function buildSummary(directoryPath: string, workflowId: WorkflowId, mtime: Date): WorkflowRunSummary {
  return {
    workflowId,
    directoryPath,
    hasCheckpoint: existsSyncSafe(resolve(directoryPath, 'checkpoint.json')),
    hasDefinition: existsSyncSafe(resolve(directoryPath, 'definition.json')),
    hasMessageLog: existsSyncSafe(resolve(directoryPath, 'messages.jsonl')),
    mtime,
  };
}

function existsSyncSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Scan `baseDir` for workflow-run directories; one summary per immediate
 * subdirectory, sorted newest-first by `mtime`. Missing `baseDir` returns `[]`
 * (mirrors `FileCheckpointStore.listAll()`).
 */
export function discoverWorkflowRuns(baseDir: string): WorkflowRunSummary[] {
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const summaries: WorkflowRunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directoryPath = resolve(baseDir, entry.name);
    const stats = statSync(directoryPath);
    summaries.push(buildSummary(directoryPath, entry.name as WorkflowId, stats.mtime));
  }

  summaries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return summaries;
}

/** Single-id variant of {@link discoverWorkflowRuns}; returns `undefined` when the directory doesn't exist. */
export function summaryForId(baseDir: string, workflowId: WorkflowId): WorkflowRunSummary | undefined {
  const directoryPath = resolve(baseDir, workflowId);
  let stats;
  try {
    stats = statSync(directoryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  if (!stats.isDirectory()) return undefined;
  return buildSummary(directoryPath, workflowId, stats.mtime);
}
