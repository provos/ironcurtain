/**
 * Tests for `findResumableCheckpoints` and `findLatestResumableCheckpoint`
 * in `src/workflow/checkpoint-selection.ts`.
 *
 * These helpers replace duplicate inline scanning logic that previously
 * lived in both `cli-support.selectResumableWorkflow` (CLI resume) and
 * `WorkflowManager.importExternalCheckpoint` (web UI). The test suite
 * exercises the empty/single/multi/completed-only cases plus the
 * newest-first ordering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { findLatestResumableCheckpoint, findResumableCheckpoints } from '../src/workflow/checkpoint-selection.js';
import { FileCheckpointStore } from '../src/workflow/checkpoint.js';
import type { WorkflowCheckpoint, WorkflowId, WorkflowStatus } from '../src/workflow/types.js';

function makeCheckpoint(opts: { timestamp?: string; finalStatus?: WorkflowStatus } = {}): WorkflowCheckpoint {
  return {
    machineState: 'coding',
    context: {
      taskDescription: 'test',
      artifacts: {},
      round: 1,
      maxRounds: 4,
      previousOutputHashes: {},
      previousTestCount: null,
      humanPrompt: null,
      reviewHistory: [],
      parallelResults: {},
      worktreeBranches: [],
      totalTokens: 0,
      lastError: null,
      agentConversationsByState: {},
      previousAgentOutput: null,
      previousAgentNotes: null,
      previousStateName: null,
      visitCounts: {},
    },
    timestamp: opts.timestamp ?? new Date().toISOString(),
    transitionHistory: [],
    definitionPath: '/tmp/workflow.json',
    finalStatus: opts.finalStatus,
  };
}

describe('checkpoint-selection', () => {
  let baseDir: string;
  let store: FileCheckpointStore;

  beforeEach(() => {
    baseDir = mkdtempSync(resolve(tmpdir(), 'checkpoint-selection-'));
    store = new FileCheckpointStore(baseDir);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  describe('findResumableCheckpoints', () => {
    it('returns [] for an empty baseDir', () => {
      const result = findResumableCheckpoints(baseDir, store);
      expect(result).toEqual([]);
    });

    it('returns [] when only completed runs exist', () => {
      store.save(
        'completed-run' as WorkflowId,
        makeCheckpoint({
          finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
        }),
      );

      const result = findResumableCheckpoints(baseDir, store);
      expect(result).toEqual([]);
    });

    it('returns a single resumable run', () => {
      const id = 'aborted-run' as WorkflowId;
      store.save(
        id,
        makeCheckpoint({
          finalStatus: { phase: 'aborted', reason: 'user abort' },
        }),
      );

      const result = findResumableCheckpoints(baseDir, store);
      expect(result.length).toBe(1);
      expect(result[0].workflowId).toBe(id);
    });

    it('includes legacy checkpoints with no finalStatus', () => {
      const id = 'legacy-run' as WorkflowId;
      store.save(id, makeCheckpoint({ finalStatus: undefined }));

      const result = findResumableCheckpoints(baseDir, store);
      expect(result.length).toBe(1);
      expect(result[0].workflowId).toBe(id);
      expect(result[0].checkpoint.finalStatus).toBeUndefined();
    });

    it('filters completed runs out of mixed results', () => {
      store.save(
        'completed-run' as WorkflowId,
        makeCheckpoint({
          finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
        }),
      );
      store.save(
        'aborted-run' as WorkflowId,
        makeCheckpoint({
          finalStatus: { phase: 'aborted', reason: 'user abort' },
        }),
      );

      const result = findResumableCheckpoints(baseDir, store);
      expect(result.length).toBe(1);
      expect(result[0].workflowId).toBe('aborted-run');
    });

    it('returns multiple resumable runs sorted newest-first by checkpoint.timestamp', () => {
      const oldestId = 'oldest-run' as WorkflowId;
      const middleId = 'middle-run' as WorkflowId;
      const newestId = 'newest-run' as WorkflowId;

      store.save(
        oldestId,
        makeCheckpoint({
          timestamp: '2026-01-01T00:00:00.000Z',
          finalStatus: { phase: 'aborted', reason: 'oldest' },
        }),
      );
      store.save(
        newestId,
        makeCheckpoint({
          timestamp: '2026-04-23T00:00:00.000Z',
          finalStatus: { phase: 'aborted', reason: 'newest' },
        }),
      );
      store.save(
        middleId,
        makeCheckpoint({
          timestamp: '2026-02-15T00:00:00.000Z',
          finalStatus: { phase: 'aborted', reason: 'middle' },
        }),
      );

      const result = findResumableCheckpoints(baseDir, store);
      expect(result.length).toBe(3);
      expect(result.map((r) => r.workflowId)).toEqual([newestId, middleId, oldestId]);
      // Sanity: timestamps are strictly descending in the result.
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].checkpoint.timestamp > result[i].checkpoint.timestamp).toBe(true);
      }
    });
  });

  describe('findLatestResumableCheckpoint', () => {
    it('returns undefined for an empty baseDir', () => {
      expect(findLatestResumableCheckpoint(baseDir, store)).toBeUndefined();
    });

    it('returns undefined when only completed runs exist', () => {
      store.save(
        'completed-run' as WorkflowId,
        makeCheckpoint({
          finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
        }),
      );
      expect(findLatestResumableCheckpoint(baseDir, store)).toBeUndefined();
    });

    it('returns the most-recent resumable run when multiple exist', () => {
      const olderId = 'older-run' as WorkflowId;
      const newerId = 'newer-run' as WorkflowId;

      store.save(
        olderId,
        makeCheckpoint({
          timestamp: '2026-01-01T00:00:00.000Z',
          finalStatus: { phase: 'aborted', reason: 'older' },
        }),
      );
      store.save(
        newerId,
        makeCheckpoint({
          timestamp: '2026-04-01T00:00:00.000Z',
          finalStatus: { phase: 'aborted', reason: 'newer' },
        }),
      );

      const latest = findLatestResumableCheckpoint(baseDir, store);
      expect(latest).toBeDefined();
      expect(latest?.workflowId).toBe(newerId);
      expect(latest?.checkpoint.timestamp).toBe('2026-04-01T00:00:00.000Z');
    });

    it('returns the single resumable run when only one exists', () => {
      const id = 'only-run' as WorkflowId;
      store.save(id, makeCheckpoint({ finalStatus: { phase: 'aborted', reason: 'only' } }));

      const latest = findLatestResumableCheckpoint(baseDir, store);
      expect(latest).toBeDefined();
      expect(latest?.workflowId).toBe(id);
    });
  });
});
