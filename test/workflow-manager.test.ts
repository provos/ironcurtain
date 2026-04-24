/**
 * Tests for WorkflowManager.loadPastRun.
 *
 * Covers happy path (live and not-live), not_found, and corruption paths
 * (malformed checkpoint JSON, malformed definition JSON, schema-invalid
 * definition, and missing definition).
 *
 * `createWorkflowSessionFactory` is mocked because it would otherwise
 * call `loadConfig()` and read the user's real config — heavy and not
 * relevant to the disk-loading logic under test. The mock returns a
 * stub session factory that the orchestrator never invokes during
 * `loadPastRun`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Mock the session factory before importing WorkflowManager. The real
// implementation calls loadConfig() which reads ~/.ironcurtain/config.json
// and is irrelevant to the disk-loading paths we exercise here.
vi.mock('../src/workflow/cli-support.js', () => ({
  createWorkflowSessionFactory: () => () => Promise.reject(new Error('session factory not used in tests')),
}));

import { WorkflowManager } from '../src/web-ui/workflow-manager.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import type { WorkflowId, WorkflowCheckpoint, WorkflowContext, WorkflowDefinition } from '../src/workflow/types.js';

// ---------------------------------------------------------------------------
// Fixtures
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
    lastError: null,
    agentConversationsByState: {},
    previousAgentOutput: null,
    previousAgentNotes: null,
    previousStateName: null,
    visitCounts: {},
  };
}

function makeCheckpoint(overrides: Partial<WorkflowCheckpoint> = {}): WorkflowCheckpoint {
  return {
    machineState: 'plan',
    context: makeContext('Test task'),
    timestamp: new Date().toISOString(),
    transitionHistory: [],
    definitionPath: '/tmp/test-def.json',
    ...overrides,
  };
}

/**
 * Minimal but schema-valid workflow definition. Uses a single terminal state
 * so semantic validation (initial-state-exists, reachability) passes without
 * needing transitions or guards.
 */
function makeValidDefinition(): WorkflowDefinition {
  return {
    name: 'test-flow',
    description: 'A minimal valid workflow for testing',
    initial: 'done',
    states: {
      done: {
        type: 'terminal',
        description: 'Terminal state',
      },
    },
  };
}

/** Writes both a checkpoint and a valid definition.json under {baseDir}/{id}/. */
function seedRun(baseDir: string, workflowId: WorkflowId, checkpoint: WorkflowCheckpoint): void {
  const runDir = resolve(baseDir, workflowId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(resolve(runDir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));
  writeFileSync(resolve(runDir, 'definition.json'), JSON.stringify(makeValidDefinition(), null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowManager.loadPastRun', () => {
  let tmpHome: string;
  let baseDir: string;
  let manager: WorkflowManager;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = resolve(tmpdir(), `ic-test-wfm-${randomUUID()}`);
    mkdirSync(tmpHome, { recursive: true });
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = tmpHome;
    // baseDir matches what WorkflowManager.getBaseDir() will compute.
    baseDir = resolve(tmpHome, 'workflow-runs');
    manager = new WorkflowManager({ eventBus: new WebEventBus() });
  });

  afterEach(async () => {
    await manager.shutdown();
    if (originalHome === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalHome;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('happy path', () => {
    it('loads a valid past run with isLive=false when not active', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      const checkpoint = makeCheckpoint({ machineState: 'reviewing' });
      seedRun(baseDir, id, checkpoint);

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(false);
      if ('error' in result) return; // type narrow
      expect(result.checkpoint.machineState).toBe('reviewing');
      expect(result.checkpoint.context.taskDescription).toBe('Test task');
      expect(result.definition.name).toBe('test-flow');
      expect(result.definition.initial).toBe('done');
      expect(result.isLive).toBe(false);
    });

    it('returns isLive=true when the workflow is in controller.listActive()', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      seedRun(baseDir, id, makeCheckpoint());

      // Force the orchestrator into existence and stub listActive() to claim
      // this workflow is live. Using a spy avoids needing to actually start
      // a workflow (which would require Docker, sessions, etc.).
      const controller = manager.getOrchestrator();
      vi.spyOn(controller, 'listActive').mockReturnValue([id]);

      const result = manager.loadPastRun(id);
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.isLive).toBe(true);
    });

    it('falls back to checkpoint.definitionPath when no local definition.json exists', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      // Write definition somewhere outside baseDir/{id}/
      const externalDefPath = resolve(tmpHome, 'external-def.json');
      writeFileSync(externalDefPath, JSON.stringify(makeValidDefinition(), null, 2));

      // Seed only the checkpoint -- no local definition.json copy.
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      const checkpoint = makeCheckpoint({ definitionPath: externalDefPath });
      writeFileSync(resolve(runDir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));

      const result = manager.loadPastRun(id);
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.definition.name).toBe('test-flow');
    });
  });

  // -------------------------------------------------------------------------
  // not_found
  // -------------------------------------------------------------------------

  describe('not_found', () => {
    it('returns not_found for a workflowId with no checkpoint on disk', () => {
      const result = manager.loadPastRun(`wf-${randomUUID()}` as WorkflowId);
      expect(result).toEqual({ error: 'not_found' });
    });

    it('returns not_found even if other workflows exist on disk', () => {
      // Seed an unrelated checkpoint.
      seedRun(baseDir, `wf-${randomUUID()}` as WorkflowId, makeCheckpoint());

      const result = manager.loadPastRun(`wf-${randomUUID()}` as WorkflowId);
      expect(result).toEqual({ error: 'not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // corrupted
  // -------------------------------------------------------------------------

  describe('corrupted', () => {
    it('returns corrupted with a message when checkpoint JSON is malformed', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'checkpoint.json'), '{ this is : not valid json');
      // Definition is fine; the error is in the checkpoint.
      writeFileSync(resolve(runDir, 'definition.json'), JSON.stringify(makeValidDefinition()));

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('corrupted');
      expect(result.message).toBeDefined();
      expect(result.message).toContain(id);
    });

    it('returns corrupted with a message when definition JSON is malformed', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'checkpoint.json'), JSON.stringify(makeCheckpoint()));
      writeFileSync(resolve(runDir, 'definition.json'), '{ broken json');

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('corrupted');
      expect(result.message).toBeDefined();
      expect(result.message).toContain('definition');
    });

    it('returns corrupted when the definition fails schema validation', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'checkpoint.json'), JSON.stringify(makeCheckpoint()));
      // Parses as JSON but fails Zod (missing required `initial`, `states`).
      writeFileSync(resolve(runDir, 'definition.json'), JSON.stringify({ name: 'incomplete' }));

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('corrupted');
      expect(result.message).toBeDefined();
    });

    it('returns corrupted when the definition file is missing entirely', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      // Checkpoint points to a definitionPath that does not exist, and there
      // is no local definition.json copy.
      const checkpoint = makeCheckpoint({ definitionPath: resolve(tmpHome, 'does-not-exist.json') });
      writeFileSync(resolve(runDir, 'checkpoint.json'), JSON.stringify(checkpoint));

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('corrupted');
      expect(result.message).toContain('missing');
    });

    it('does not throw on a corrupted file', () => {
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'checkpoint.json'), 'totally not json');

      expect(() => manager.loadPastRun(id)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // baseDirOverride
  // -------------------------------------------------------------------------

  describe('baseDirOverride', () => {
    it('reads checkpoints from the override directory instead of IRONCURTAIN_HOME', async () => {
      // Seed a checkpoint in a directory unrelated to IRONCURTAIN_HOME, then
      // confirm a manager with `baseDirOverride` set to that path can load it
      // even though `IRONCURTAIN_HOME` points elsewhere. Used by `workflow
      // inspect` to operate on user-supplied baseDir arguments.
      const externalBase = resolve(tmpdir(), `ic-test-wfm-ext-${randomUUID()}`);
      mkdirSync(externalBase, { recursive: true });
      try {
        const id = `wf-${randomUUID()}` as WorkflowId;
        seedRun(externalBase, id, makeCheckpoint({ machineState: 'external' }));

        const externalManager = new WorkflowManager({
          eventBus: new WebEventBus(),
          baseDirOverride: externalBase,
        });

        try {
          const result = externalManager.loadPastRun(id);
          expect('error' in result).toBe(false);
          if ('error' in result) return;
          expect(result.checkpoint.machineState).toBe('external');

          // The default-baseDir manager should NOT see this run.
          const sameIdInDefault = manager.loadPastRun(id);
          expect(sameIdInDefault).toEqual({ error: 'not_found' });
        } finally {
          await externalManager.shutdown();
        }
      } finally {
        rmSync(externalBase, { recursive: true, force: true });
      }
    });
  });
});
