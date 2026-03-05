/**
 * Filesystem-backed store for job definitions and run records.
 *
 * Directory layout:
 *   ~/.ironcurtain/jobs/{jobId}/
 *     job.json              -- JobDefinition
 *     generated/            -- per-job compiled policy artifacts
 *       compiled-policy.json
 *       dynamic-lists.json  -- (optional)
 *     workspace/            -- persistent agent workspace
 *     runs/                 -- run history
 *       2026-03-04T09:00:00.000Z.json
 *
 * Tool annotations (tool-annotations.json) are always loaded from
 * the global location, never stored per-job.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getJobsDir, getJobDir, getJobRunsDir } from '../config/paths.js';
import type { JobDefinition, JobId, RunRecord } from './types.js';
import { createJobId } from './types.js';
import { withFileLock, getJobLockDir } from './file-lock.js';

/** Loads a job definition from disk. Returns undefined if not found. */
export function loadJob(jobId: JobId): JobDefinition | undefined {
  const jobFile = resolve(getJobDir(jobId), 'job.json');
  if (!existsSync(jobFile)) return undefined;

  try {
    return JSON.parse(readFileSync(jobFile, 'utf-8')) as JobDefinition;
  } catch {
    return undefined;
  }
}

/** Loads all job definitions from disk. */
export function loadAllJobs(): JobDefinition[] {
  const jobsDir = getJobsDir();
  if (!existsSync(jobsDir)) return [];

  const jobs: JobDefinition[] = [];
  let entries: string[];
  try {
    entries = readdirSync(jobsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    try {
      const jobId = createJobId(entry);
      const job = loadJob(jobId);
      if (job) jobs.push(job);
    } catch {
      // Skip invalid directory names or malformed job files
    }
  }

  return jobs;
}

/**
 * Saves a job definition to disk. Creates directories as needed.
 * Acquires an advisory file lock to prevent concurrent write corruption.
 */
export async function saveJob(job: JobDefinition): Promise<void> {
  const jobDir = getJobDir(job.id);
  mkdirSync(jobDir, { recursive: true });

  await withFileLock(getJobLockDir(jobDir), () => {
    writeFileSync(resolve(jobDir, 'job.json'), JSON.stringify(job, null, 2) + '\n');
  });
}

/** Deletes a job and all its artifacts (generated, workspace, runs). */
export function deleteJob(jobId: JobId): void {
  rmSync(getJobDir(jobId), { recursive: true, force: true });
}

/** Records a completed run. Filenames are unique (timestamp-based), so no lock needed. */
export function saveRunRecord(jobId: JobId, record: RunRecord): void {
  const runsDir = getJobRunsDir(jobId);
  mkdirSync(runsDir, { recursive: true });

  const filename = record.startedAt.replace(/:/g, '-') + '.json';
  writeFileSync(resolve(runsDir, filename), JSON.stringify(record, null, 2) + '\n');
}

/**
 * Loads recent run records for a job, most recent first.
 * @param limit Maximum number of records to return (default 10).
 */
export function loadRecentRuns(jobId: JobId, limit: number = 10): RunRecord[] {
  const runsDir = getJobRunsDir(jobId);
  if (!existsSync(runsDir)) return [];

  let files: string[];
  try {
    files = readdirSync(runsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  // Sort by filename (ISO timestamp-based) descending
  files.sort((a, b) => b.localeCompare(a));

  const records: RunRecord[] = [];
  for (const file of files.slice(0, limit)) {
    try {
      const record = JSON.parse(readFileSync(resolve(runsDir, file), 'utf-8')) as RunRecord;
      records.push(record);
    } catch {
      // Skip malformed run records
    }
  }

  return records;
}
