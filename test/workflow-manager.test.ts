/**
 * Tests for WorkflowManager.loadPastRun.
 *
 * Covers happy path (live and not-live, checkpointed and checkpoint-less),
 * not_found (empty directory, unknown workflowId, no-checkpoint + no-def),
 * and corruption paths (malformed checkpoint JSON, malformed definition
 * JSON, schema-invalid definition).
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
// and is irrelevant to the disk-loading paths we exercise here. We retain
// the real `isCheckpointResumable` predicate (pure, trivial, no I/O) so that
// `importExternalCheckpoint` still exercises the genuine phase filter.
vi.mock('../src/workflow/cli-support.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workflow/cli-support.js')>();
  return {
    ...actual,
    createWorkflowSessionFactory: () => () => Promise.reject(new Error('session factory not used in tests')),
  };
});

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
      expect(result.checkpoint).toBeDefined();
      expect(result.checkpoint?.machineState).toBe('reviewing');
      expect(result.checkpoint?.context.taskDescription).toBe('Test task');
      expect(result.definition.name).toBe('test-flow');
      expect(result.definition.initial).toBe('done');
      expect(result.isLive).toBe(false);
      // messageLogPath is always returned (existence unchecked).
      expect(result.messageLogPath).toBe(resolve(baseDir, id, 'messages.jsonl'));
    });

    it('loads a run with no checkpoint but a local definition.json', () => {
      // A directory that has only definition.json -- models the
      // "completed-pre-retention" case where checkpoint.json was deleted
      // but the definition copy remains. loadPastRun must succeed with
      // checkpoint=undefined so the dispatch layer can synthesize the DTO
      // from the definition + message log.
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'definition.json'), JSON.stringify(makeValidDefinition(), null, 2));

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.checkpoint).toBeUndefined();
      expect(result.definition.name).toBe('test-flow');
      expect(result.messageLogPath).toBe(resolve(baseDir, id, 'messages.jsonl'));
      expect(result.isLive).toBe(false);
    });

    it('loads a run with definition.json and messages.jsonl but no checkpoint', () => {
      // messageLogPath points at the on-disk log even though loadPastRun
      // itself does not read or validate it (callers use MessageLog.readAll
      // on demand; existence is not required).
      const id = `wf-${randomUUID()}` as WorkflowId;
      const runDir = resolve(baseDir, id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, 'definition.json'), JSON.stringify(makeValidDefinition(), null, 2));
      const logPath = resolve(runDir, 'messages.jsonl');
      // One arbitrary message log line -- the loader should not parse it.
      writeFileSync(logPath, '{"ts":"2026-04-23T00:00:00.000Z","kind":"state_transition","from":"plan","to":"done"}\n');

      const result = manager.loadPastRun(id);

      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.checkpoint).toBeUndefined();
      expect(result.definition.name).toBe('test-flow');
      expect(result.messageLogPath).toBe(logPath);
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
    it('returns not_found for a workflowId with nothing on disk', () => {
      // Nonexistent directory: no checkpoint and no definition to fall back
      // on, so nothing worth rendering. After B5 the discriminant is
      // "directory doesn't exist OR no loadable definition"; the end result
      // for a completely unknown id is still not_found.
      const result = manager.loadPastRun(`wf-${randomUUID()}` as WorkflowId);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('not_found');
    });

    it('returns not_found even if other workflows exist on disk', () => {
      // Seed an unrelated checkpoint.
      seedRun(baseDir, `wf-${randomUUID()}` as WorkflowId, makeCheckpoint());

      const result = manager.loadPastRun(`wf-${randomUUID()}` as WorkflowId);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('not_found');
    });

    it('returns not_found for an empty run directory', () => {
      // Directory exists but has neither checkpoint.json nor definition.json.
      // Under the relaxed B5 contract this is the canonical "nothing to
      // render" case -- checkpoint-less would otherwise try to proceed, but
      // the definition resolver has no file to load.
      const id = `wf-${randomUUID()}` as WorkflowId;
      mkdirSync(resolve(baseDir, id), { recursive: true });

      const result = manager.loadPastRun(id);
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('not_found');
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

    it('returns not_found when the definition file is missing entirely', () => {
      // Post-B5: a checkpoint whose definitionPath is gone and with no
      // local definition.json copy is "no renderable content" rather than
      // "corrupted file." `corrupted` is now reserved strictly for
      // present-but-malformed files.
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
      expect(result.error).toBe('not_found');
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
          expect(result.checkpoint?.machineState).toBe('external');

          // The default-baseDir manager should NOT see this run.
          const sameIdInDefault = manager.loadPastRun(id);
          expect('error' in sameIdInDefault).toBe(true);
          if (!('error' in sameIdInDefault)) return;
          expect(sameIdInDefault.error).toBe('not_found');
        } finally {
          await externalManager.shutdown();
        }
      } finally {
        rmSync(externalBase, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// importExternalCheckpoint
// ---------------------------------------------------------------------------

/**
 * Writes only a checkpoint (no definition.json) under {baseDir}/{id}/. Used
 * by importExternalCheckpoint tests where the copy-definition step is
 * optional and orthogonal to the selection logic under test.
 */
function seedCheckpointOnly(baseDir: string, workflowId: WorkflowId, checkpoint: WorkflowCheckpoint): void {
  const runDir = resolve(baseDir, workflowId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(resolve(runDir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));
}

describe('WorkflowManager.importExternalCheckpoint', () => {
  let tmpHome: string;
  let externalBase: string;
  let manager: WorkflowManager;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = resolve(tmpdir(), `ic-test-wfm-import-${randomUUID()}`);
    mkdirSync(tmpHome, { recursive: true });
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = tmpHome;

    externalBase = resolve(tmpdir(), `ic-test-wfm-import-ext-${randomUUID()}`);
    mkdirSync(externalBase, { recursive: true });

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
    rmSync(externalBase, { recursive: true, force: true });
  });

  it('skips completed checkpoints and imports the most-recent non-completed one', () => {
    const completedId = `wf-completed-${randomUUID()}` as WorkflowId;
    const abortedId = `wf-aborted-${randomUUID()}` as WorkflowId;

    // Completed run with the newer timestamp — must be skipped.
    seedCheckpointOnly(
      externalBase,
      completedId,
      makeCheckpoint({
        timestamp: '2026-04-23T12:00:00.000Z',
        finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
      }),
    );

    // Aborted run with an older timestamp — must be selected because the
    // completed one is filtered out even though it is "most recent."
    seedCheckpointOnly(
      externalBase,
      abortedId,
      makeCheckpoint({
        timestamp: '2026-04-20T12:00:00.000Z',
        finalStatus: { phase: 'aborted', reason: 'user cancelled' },
      }),
    );

    const imported = manager.importExternalCheckpoint(externalBase);
    expect(imported).toBe(abortedId);
  });

  it('throws when every external checkpoint is completed', () => {
    seedCheckpointOnly(
      externalBase,
      `wf-${randomUUID()}` as WorkflowId,
      makeCheckpoint({
        finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
      }),
    );

    expect(() => manager.importExternalCheckpoint(externalBase)).toThrow(/No valid checkpoints found/);
  });

  it('still imports a legacy checkpoint without finalStatus', () => {
    // Pre-B3b retained checkpoints (aborted/failed runs from before the
    // finalStatus field was added) carry no finalStatus. The resumable
    // predicate must treat these as importable.
    const legacyId = `wf-legacy-${randomUUID()}` as WorkflowId;
    seedCheckpointOnly(externalBase, legacyId, makeCheckpoint({ timestamp: '2026-01-01T00:00:00.000Z' }));

    const imported = manager.importExternalCheckpoint(externalBase);
    expect(imported).toBe(legacyId);
  });

  it('throws when the external baseDir has no checkpoints at all', () => {
    // Empty directory — no subdirectories, no checkpoint.json anywhere.
    expect(() => manager.importExternalCheckpoint(externalBase)).toThrow(/No checkpoints found/);
  });

  it('explicit targetId bypass still imports regardless of phase', () => {
    // Pre-existing contract: when the caller supplies an explicit workflowId,
    // enumeration is skipped entirely. Even a completed run can be re-imported
    // this way (e.g. for forensic replay of an archived completed workflow).
    const completedId = `wf-completed-${randomUUID()}` as WorkflowId;
    seedCheckpointOnly(
      externalBase,
      completedId,
      makeCheckpoint({
        finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
      }),
    );

    const imported = manager.importExternalCheckpoint(externalBase, completedId);
    expect(imported).toBe(completedId);
  });
});
