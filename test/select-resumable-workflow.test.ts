/**
 * Tests for `selectResumableWorkflow` in `src/workflow/cli-support.ts`.
 *
 * Covers the unified-discovery rewrite: enumeration through
 * `discoverWorkflowRuns`, the shared `isCheckpointResumable` predicate
 * (excluding `phase === 'completed'` while including legacy
 * `finalStatus`-less checkpoints), most-recent-by-checkpoint-timestamp
 * ordering, and the empty-baseDir error path that calls `process.exit(1)`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { FileCheckpointStore } from '../src/workflow/checkpoint.js';
import { selectResumableWorkflow } from '../src/workflow/cli-support.js';
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

describe('selectResumableWorkflow', () => {
  let baseDir: string;
  let store: FileCheckpointStore;

  beforeEach(() => {
    baseDir = mkdtempSync(resolve(tmpdir(), 'select-resumable-'));
    store = new FileCheckpointStore(baseDir);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('excludes completed checkpoints, returning the aborted one', () => {
    const completedId = 'completed-run' as WorkflowId;
    const abortedId = 'aborted-run' as WorkflowId;

    store.save(
      completedId,
      makeCheckpoint({
        finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
      }),
    );
    store.save(
      abortedId,
      makeCheckpoint({
        finalStatus: { phase: 'aborted', reason: 'user abort' },
      }),
    );

    const selected = selectResumableWorkflow(store, baseDir);
    expect(selected.workflowId).toBe(abortedId);
  });

  it('includes legacy checkpoints with no finalStatus', () => {
    const legacyId = 'legacy-run' as WorkflowId;
    store.save(legacyId, makeCheckpoint({ finalStatus: undefined }));

    const selected = selectResumableWorkflow(store, baseDir);
    expect(selected.workflowId).toBe(legacyId);
    expect(selected.checkpoint.finalStatus).toBeUndefined();
  });

  it('calls process.exit(1) when baseDir is empty', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      expect(() => selectResumableWorkflow(store, baseDir)).toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('calls process.exit(1) when only completed checkpoints exist', () => {
    const completedId = 'completed-only' as WorkflowId;
    store.save(
      completedId,
      makeCheckpoint({
        finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
      }),
    );

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      expect(() => selectResumableWorkflow(store, baseDir)).toThrow('process.exit:1');
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('picks the most-recent checkpoint by timestamp when multiple are resumable', () => {
    const olderId = 'older-run' as WorkflowId;
    const newerId = 'newer-run' as WorkflowId;

    store.save(
      olderId,
      makeCheckpoint({
        timestamp: '2026-01-01T00:00:00.000Z',
        finalStatus: { phase: 'aborted', reason: 'older abort' },
      }),
    );
    store.save(
      newerId,
      makeCheckpoint({
        timestamp: '2026-04-01T00:00:00.000Z',
        finalStatus: { phase: 'aborted', reason: 'newer abort' },
      }),
    );

    // Suppress the "Found N..." stdout banner emitted on multi-candidate paths.
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const selected = selectResumableWorkflow(store, baseDir);
      expect(selected.workflowId).toBe(newerId);
      expect(selected.checkpoint.timestamp).toBe('2026-04-01T00:00:00.000Z');
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
