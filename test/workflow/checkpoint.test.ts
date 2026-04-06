import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';
import type { WorkflowCheckpoint } from '../../src/workflow/types.js';
import { createWorkflowId } from '../../src/workflow/types.js';

function makeCheckpoint(overrides?: Partial<WorkflowCheckpoint>): WorkflowCheckpoint {
  return {
    machineState: 'coding',
    context: {
      taskDescription: 'Build a widget',
      artifacts: {},
      round: 1,
      maxRounds: 4,
      previousOutputHashes: {},
      previousTestCount: null,
      humanPrompt: null,
      reviewHistory: [],
      parallelResults: {},
      worktreeBranches: [],
      totalTokens: 500,
      flaggedForReview: false,
      lastError: null,
      sessionsByState: {},
      previousAgentOutput: null,
      previousStateName: null,
      visitCounts: {},
    },
    timestamp: new Date().toISOString(),
    transitionHistory: [],
    definitionPath: '/tmp/workflow.json',
    ...overrides,
  };
}

describe('FileCheckpointStore', () => {
  let baseDir: string;
  let store: FileCheckpointStore;

  beforeEach(() => {
    baseDir = resolve('/tmp', `ironcurtain-checkpoint-test-${process.pid}-${Date.now()}`);
    mkdirSync(baseDir, { recursive: true });
    store = new FileCheckpointStore(baseDir);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('round-trips a checkpoint through save and load', () => {
    const id = createWorkflowId();
    const checkpoint = makeCheckpoint();

    store.save(id, checkpoint);
    const loaded = store.load(id);

    expect(loaded).toEqual(checkpoint);
  });

  it('returns undefined for a missing checkpoint', () => {
    const id = createWorkflowId();
    expect(store.load(id)).toBeUndefined();
  });

  it('lists workflow IDs that have checkpoints', () => {
    const id1 = createWorkflowId();
    const id2 = createWorkflowId();
    const id3 = createWorkflowId();

    store.save(id1, makeCheckpoint());
    store.save(id2, makeCheckpoint());

    const listed = store.listAll();
    expect(listed).toContain(id1);
    expect(listed).toContain(id2);
    expect(listed).not.toContain(id3);
  });

  it('returns empty list when no checkpoints exist', () => {
    expect(store.listAll()).toEqual([]);
  });

  it('returns empty list when baseDir does not exist', () => {
    const nonExistentStore = new FileCheckpointStore(`/tmp/nonexistent-${Date.now()}`);
    expect(nonExistentStore.listAll()).toEqual([]);
  });

  it('removes a checkpoint', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint());
    expect(store.load(id)).toBeDefined();

    store.remove(id);
    expect(store.load(id)).toBeUndefined();
  });

  it('remove is a no-op for missing checkpoint', () => {
    const id = createWorkflowId();
    expect(() => store.remove(id)).not.toThrow();
  });

  it('overwrites previous checkpoint on re-save', () => {
    const id = createWorkflowId();
    const first = makeCheckpoint({ machineState: 'planning' });
    const second = makeCheckpoint({ machineState: 'coding' });

    store.save(id, first);
    store.save(id, second);

    const loaded = store.load(id);
    expect(loaded?.machineState).toBe('coding');
  });

  it('preserves complex context through serialization', () => {
    const id = createWorkflowId();
    const checkpoint = makeCheckpoint({
      machineState: { parent: 'coding', child: 'writing' },
      transitionHistory: [
        {
          from: 'planning',
          to: 'coding',
          event: 'AGENT_COMPLETED',
          timestamp: '2026-01-01T00:00:00Z',
          duration_ms: 5000,
        },
      ],
    });

    store.save(id, checkpoint);
    const loaded = store.load(id);

    expect(loaded?.machineState).toEqual({ parent: 'coding', child: 'writing' });
    expect(loaded?.transitionHistory).toHaveLength(1);
    expect(loaded?.transitionHistory[0].from).toBe('planning');
  });

  it('atomic write does not corrupt existing checkpoint on temp file rename', () => {
    const id = createWorkflowId();
    const original = makeCheckpoint({ machineState: 'original' });
    store.save(id, original);

    // Save again - the rename should atomically replace
    const updated = makeCheckpoint({ machineState: 'updated' });
    store.save(id, updated);

    const loaded = store.load(id);
    expect(loaded?.machineState).toBe('updated');
  });

  it('removed checkpoint no longer appears in listAll', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint());
    expect(store.listAll()).toContain(id);

    store.remove(id);
    expect(store.listAll()).not.toContain(id);
  });
});
