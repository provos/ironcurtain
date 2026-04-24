import { readdirSync, statSync, type Dirent } from 'node:fs';
import { resolve } from 'node:path';
import { SESSION_METADATA_FILENAME } from '../config/paths.js';
import { loadSessionMetadataFromPath } from '../session/session-metadata.js';
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

/** `readdirSync` that swallows ENOENT (returns `[]`); other errors propagate. */
function readDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Scan `baseDir` for workflow-run directories; one summary per immediate
 * subdirectory, sorted newest-first by `mtime`. Missing `baseDir` returns `[]`
 * (mirrors `FileCheckpointStore.listAll()`).
 */
export function discoverWorkflowRuns(baseDir: string): WorkflowRunSummary[] {
  const entries = readDirEntries(baseDir);
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

/**
 * Recovers the `workspacePath` for a checkpoint-less past run from session-
 * metadata files written per state actor under
 * `<runDir>/containers/*\/states/*\/{SESSION_METADATA_FILENAME}`. Picks the
 * entry with the newest `createdAt`. Returns `undefined` when no usable file
 * is found.
 */
export function discoverWorkspacePathFromContainers(runDir: string): string | undefined {
  const containersDir = resolve(runDir, 'containers');
  let bestWorkspace: string | undefined;
  let bestCreatedAt = '';

  for (const container of readDirEntries(containersDir)) {
    if (!container.isDirectory()) continue;
    const statesDir = resolve(containersDir, container.name, 'states');
    for (const state of readDirEntries(statesDir)) {
      if (!state.isDirectory()) continue;
      const metadata = loadSessionMetadataFromPath(resolve(statesDir, state.name, SESSION_METADATA_FILENAME));
      if (!metadata?.workspacePath || !metadata.createdAt) continue;
      if (metadata.createdAt > bestCreatedAt) {
        bestCreatedAt = metadata.createdAt;
        bestWorkspace = metadata.workspacePath;
      }
    }
  }

  return bestWorkspace;
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
