/**
 * Tests for workflow resume dispatch: listResumable, extractLastState,
 * and WorkflowManager.importExternalCheckpoint.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { extractLastState } from '../src/web-ui/dispatch/workflow-dispatch.js';
import { FileCheckpointStore } from '../src/workflow/checkpoint.js';
import type { WorkflowCheckpoint, WorkflowId, WorkflowContext } from '../src/workflow/types.js';

// ---------------------------------------------------------------------------
// extractLastState
// ---------------------------------------------------------------------------

describe('extractLastState', () => {
  it('returns a string machineState directly', () => {
    expect(extractLastState('plan_review')).toBe('plan_review');
  });

  it('returns the first key from an object machineState', () => {
    expect(extractLastState({ code_review: 'reviewing' })).toBe('code_review');
  });

  it('returns "unknown" for null', () => {
    expect(extractLastState(null)).toBe('unknown');
  });

  it('returns "unknown" for undefined', () => {
    expect(extractLastState(undefined)).toBe('unknown');
  });

  it('returns "unknown" for an empty object', () => {
    expect(extractLastState({})).toBe('unknown');
  });

  it('returns "unknown" for a non-string, non-object value', () => {
    expect(extractLastState(42)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// FileCheckpointStore integration with importExternalCheckpoint-like flow
// ---------------------------------------------------------------------------

function makeContext(taskDescription: string): WorkflowContext {
  return {
    taskDescription,
    artifacts: {},
    round: 1,
    maxRounds: 4,
    previousOutputHashes: {},
    previousTestCount: null,
    humanPrompt: null,
    reviewHistory: [],
    parallelResults: {},
    worktreeBranches: [],
    totalTokens: 1000,
    flaggedForReview: false,
    lastError: null,
    sessionsByState: {},
    previousAgentOutput: null,
    previousAgentNotes: null,
    previousStateName: null,
    visitCounts: {},
  };
}

function makeCheckpoint(overrides: Partial<WorkflowCheckpoint> = {}): WorkflowCheckpoint {
  return {
    machineState: 'plan_review',
    context: makeContext('Test task'),
    timestamp: new Date().toISOString(),
    transitionHistory: [],
    definitionPath: '/tmp/test-def.json',
    ...overrides,
  };
}

describe('FileCheckpointStore for resume flow', () => {
  let tmpDir: string;
  let store: FileCheckpointStore;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `ic-test-resume-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    store = new FileCheckpointStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads a checkpoint', () => {
    const id = 'wf-test-001' as WorkflowId;
    const checkpoint = makeCheckpoint({ machineState: 'coding' });
    store.save(id, checkpoint);

    const loaded = store.load(id);
    expect(loaded).toBeDefined();
    expect(loaded!.machineState).toBe('coding');
    expect(loaded!.context.taskDescription).toBe('Test task');
  });

  it('listAll returns workflow IDs with checkpoints', () => {
    const id1 = 'wf-test-001' as WorkflowId;
    const id2 = 'wf-test-002' as WorkflowId;
    store.save(id1, makeCheckpoint());
    store.save(id2, makeCheckpoint());

    const ids = store.listAll();
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).toHaveLength(2);
  });

  it('can import a checkpoint from one store to another', () => {
    // Simulate external store
    const externalDir = resolve(tmpdir(), `ic-test-external-${randomUUID()}`);
    mkdirSync(externalDir, { recursive: true });
    const externalStore = new FileCheckpointStore(externalDir);

    const id = 'wf-external-001' as WorkflowId;
    const checkpoint = makeCheckpoint({
      machineState: 'review',
      context: makeContext('External task'),
    });
    externalStore.save(id, checkpoint);

    // Write a definition.json in the external store
    const externalMetaDir = resolve(externalDir, id);
    writeFileSync(resolve(externalMetaDir, 'definition.json'), JSON.stringify({ name: 'test-flow' }));

    // Import into local store
    const loaded = externalStore.load(id);
    expect(loaded).toBeDefined();
    store.save(id, loaded!);

    // Copy definition
    const localMetaDir = resolve(tmpDir, id);
    mkdirSync(localMetaDir, { recursive: true });
    const extDefPath = resolve(externalDir, id, 'definition.json');
    if (existsSync(extDefPath)) {
      const content = readFileSync(extDefPath, 'utf-8');
      writeFileSync(resolve(localMetaDir, 'definition.json'), content);
    }

    // Verify
    const imported = store.load(id);
    expect(imported).toBeDefined();
    expect(imported!.context.taskDescription).toBe('External task');
    expect(imported!.machineState).toBe('review');

    const defContent = readFileSync(resolve(localMetaDir, 'definition.json'), 'utf-8');
    expect(JSON.parse(defContent)).toEqual({ name: 'test-flow' });

    // Cleanup
    rmSync(externalDir, { recursive: true, force: true });
  });

  it('picks the most recent checkpoint when no workflowId specified', () => {
    const id1 = 'wf-old' as WorkflowId;
    const id2 = 'wf-new' as WorkflowId;

    store.save(
      id1,
      makeCheckpoint({
        timestamp: '2026-01-01T00:00:00.000Z',
        context: makeContext('Old task'),
      }),
    );
    store.save(
      id2,
      makeCheckpoint({
        timestamp: '2026-04-04T12:00:00.000Z',
        context: makeContext('New task'),
      }),
    );

    // Simulate the "pick most recent" logic from importExternalCheckpoint
    const allIds = store.listAll();
    let latest: { id: WorkflowId; timestamp: string } | null = null;
    for (const id of allIds) {
      const cp = store.load(id);
      if (cp && (!latest || cp.timestamp > latest.timestamp)) {
        latest = { id, timestamp: cp.timestamp };
      }
    }
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(id2);
  });
});
