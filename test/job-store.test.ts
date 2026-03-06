/**
 * Tests for the filesystem-backed job store (CRUD + run records).
 * Uses real temp directories -- no filesystem mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { saveJob, loadJob, loadAllJobs, deleteJob, saveRunRecord, loadRecentRuns } from '../src/cron/job-store.js';
import { createJobId } from '../src/cron/types.js';
import type { JobDefinition, RunRecord } from '../src/cron/types.js';

const TEST_DIR = resolve(`/tmp/ironcurtain-jobstore-test-${process.pid}`);

function makeJob(id: string, overrides?: Partial<JobDefinition>): JobDefinition {
  return {
    id: createJobId(id),
    name: `Test Job ${id}`,
    schedule: '0 9 * * *',
    taskDescription: 'do something',
    taskConstitution: 'be safe',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
    ...overrides,
  };
}

function makeRunRecord(startedAt: string, overrides?: Partial<RunRecord>): RunRecord {
  return {
    startedAt,
    completedAt: '2026-03-04T09:05:00.000Z',
    outcome: { kind: 'success' },
    budget: { totalTokens: 1000, stepCount: 5, elapsedSeconds: 60, estimatedCostUsd: 0.1 },
    summary: 'All good',
    escalationsEncountered: 0,
    escalationsApproved: 0,
    discardedChanges: null,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.IRONCURTAIN_HOME = TEST_DIR;
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env.IRONCURTAIN_HOME;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('job-store', () => {
  describe('saveJob / loadJob', () => {
    it('round-trips a job definition through save and load', async () => {
      const job = makeJob('my-job');
      await saveJob(job);
      const loaded = loadJob(job.id);
      expect(loaded).toEqual(job);
    });

    it('creates the job directory structure on save', async () => {
      const job = makeJob('new-job');
      await saveJob(job);
      const jobDir = resolve(TEST_DIR, 'jobs', 'new-job');
      expect(existsSync(jobDir)).toBe(true);
      expect(existsSync(resolve(jobDir, 'job.json'))).toBe(true);
    });

    it('overwrites an existing job on re-save', async () => {
      const job = makeJob('overwrite-job');
      await saveJob(job);

      const updated = makeJob('overwrite-job', { name: 'Updated Name' });
      await saveJob(updated);

      const loaded = loadJob(job.id);
      expect(loaded?.name).toBe('Updated Name');
    });

    it('returns undefined for a non-existent job', () => {
      const loaded = loadJob(createJobId('nonexistent'));
      expect(loaded).toBeUndefined();
    });

    it('returns undefined for a malformed job file', () => {
      const jobDir = resolve(TEST_DIR, 'jobs', 'bad-job');
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(resolve(jobDir, 'job.json'), 'not json!!!');
      const loaded = loadJob(createJobId('bad-job'));
      expect(loaded).toBeUndefined();
    });
  });

  describe('loadAllJobs', () => {
    it('returns an empty array when no jobs directory exists', () => {
      const jobs = loadAllJobs();
      expect(jobs).toEqual([]);
    });

    it('loads all valid jobs from disk', async () => {
      await saveJob(makeJob('alpha'));
      await saveJob(makeJob('beta'));
      await saveJob(makeJob('gamma'));

      const jobs = loadAllJobs();
      expect(jobs).toHaveLength(3);
      const ids = jobs.map((j) => j.id).sort();
      expect(ids).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('skips directories that are not valid job IDs', async () => {
      await saveJob(makeJob('valid-job'));

      // Create a directory with an invalid job ID (uppercase)
      const badDir = resolve(TEST_DIR, 'jobs', 'INVALID');
      mkdirSync(badDir, { recursive: true });

      const jobs = loadAllJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe('valid-job');
    });

    it('skips directories with malformed job.json', async () => {
      await saveJob(makeJob('good'));
      const badDir = resolve(TEST_DIR, 'jobs', 'bad');
      mkdirSync(badDir, { recursive: true });
      writeFileSync(resolve(badDir, 'job.json'), '{broken');

      const jobs = loadAllJobs();
      expect(jobs).toHaveLength(1);
    });
  });

  describe('deleteJob', () => {
    it('removes the job directory and all contents', async () => {
      const job = makeJob('doomed');
      await saveJob(job);
      const jobDir = resolve(TEST_DIR, 'jobs', 'doomed');
      expect(existsSync(jobDir)).toBe(true);

      deleteJob(job.id);
      expect(existsSync(jobDir)).toBe(false);
    });

    it('is a no-op for non-existent jobs', () => {
      expect(() => deleteJob(createJobId('ghost'))).not.toThrow();
    });
  });

  describe('saveRunRecord / loadRecentRuns', () => {
    const jobId = createJobId('run-test');

    beforeEach(async () => {
      await saveJob(makeJob('run-test'));
    });

    it('saves and loads a single run record', () => {
      const record = makeRunRecord('2026-03-04T09:00:00.000Z');
      saveRunRecord(jobId, record);

      const runs = loadRecentRuns(jobId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toEqual(record);
    });

    it('returns runs in reverse chronological order', () => {
      saveRunRecord(jobId, makeRunRecord('2026-03-01T09:00:00.000Z'));
      saveRunRecord(jobId, makeRunRecord('2026-03-03T09:00:00.000Z'));
      saveRunRecord(jobId, makeRunRecord('2026-03-02T09:00:00.000Z'));

      const runs = loadRecentRuns(jobId);
      expect(runs).toHaveLength(3);
      expect(runs[0].startedAt).toBe('2026-03-03T09:00:00.000Z');
      expect(runs[1].startedAt).toBe('2026-03-02T09:00:00.000Z');
      expect(runs[2].startedAt).toBe('2026-03-01T09:00:00.000Z');
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        saveRunRecord(jobId, makeRunRecord(`2026-03-0${i + 1}T09:00:00.000Z`));
      }

      const runs = loadRecentRuns(jobId, 2);
      expect(runs).toHaveLength(2);
    });

    it('returns an empty array when no runs exist', () => {
      const runs = loadRecentRuns(jobId);
      expect(runs).toEqual([]);
    });

    it('returns an empty array for a non-existent job', () => {
      const runs = loadRecentRuns(createJobId('no-such-job'));
      expect(runs).toEqual([]);
    });

    it('stores different outcome types correctly', () => {
      saveRunRecord(
        jobId,
        makeRunRecord('2026-03-01T09:00:00.000Z', {
          outcome: { kind: 'error', message: 'something broke' },
        }),
      );
      saveRunRecord(
        jobId,
        makeRunRecord('2026-03-02T09:00:00.000Z', {
          outcome: { kind: 'budget_exhausted', dimension: 'tokens' },
        }),
      );

      const runs = loadRecentRuns(jobId);
      expect(runs[0].outcome).toEqual({ kind: 'budget_exhausted', dimension: 'tokens' });
      expect(runs[1].outcome).toEqual({ kind: 'error', message: 'something broke' });
    });
  });
});
