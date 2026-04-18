import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionOptions } from '../../src/session/types.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import {
  approvedResponse,
  createArtifactAwareSession,
  writeDefinitionFile,
  createDeps,
  waitForCompletion,
  stubPersonasForTest,
} from './test-helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Builds a minimal stub DockerInfrastructure bundle. Tests never exercise
 * the bundle's fields directly — they only track identity (was this
 * bundle handed out, was it passed to destroy, etc.).
 */
function makeStubInfrastructure(workflowId: string): DockerInfrastructure {
  const bundle = { __stub: true, workflowId } as unknown as DockerInfrastructure;
  return bundle;
}

const dockerWorkflowDef: WorkflowDefinition = {
  name: 'docker-shared',
  description: 'Docker workflow exercising shared-container mode',
  initial: 'work',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    work: {
      type: 'agent',
      description: 'Does work',
      persona: 'global',
      prompt: 'You are a worker.',
      inputs: [],
      outputs: ['result'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

const builtinSharedDef: WorkflowDefinition = {
  name: 'builtin-shared',
  description: 'Builtin workflow with sharedContainer=true (should still opt out)',
  initial: 'work',
  // sharedContainer is set, but builtin mode means no Docker infra is needed.
  settings: { mode: 'builtin', sharedContainer: true },
  states: {
    work: {
      type: 'agent',
      description: 'Does work',
      persona: 'global',
      prompt: 'You are a worker.',
      inputs: [],
      outputs: ['result'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

const optedOutDockerDef: WorkflowDefinition = {
  name: 'docker-per-state',
  description: 'Docker workflow without sharedContainer (default behavior)',
  initial: 'work',
  settings: { mode: 'docker', dockerAgent: 'claude-code' },
  states: {
    work: {
      type: 'agent',
      description: 'Does work',
      persona: 'global',
      prompt: 'You are a worker.',
      inputs: [],
      outputs: ['result'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

const builtinDefaultDef: WorkflowDefinition = {
  name: 'builtin-default',
  description: 'Builtin workflow without sharedContainer',
  initial: 'work',
  settings: { mode: 'builtin' },
  states: {
    work: {
      type: 'agent',
      description: 'Does work',
      persona: 'global',
      prompt: 'You are a worker.',
      inputs: [],
      outputs: ['result'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator shared-container mode', () => {
  let tmpDir: string;
  let activeOrchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shared-container-test-'));
    activeOrchestrator = undefined;
    cleanupPersonas = stubPersonasForTest(
      tmpDir,
      dockerWorkflowDef,
      builtinSharedDef,
      optedOutDockerDef,
      builtinDefaultDef,
    );
  });

  afterEach(async () => {
    if (activeOrchestrator) {
      await activeOrchestrator.shutdownAll();
    }
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: Opt-out default (no sharedContainer flag -> no infra)
  // -------------------------------------------------------------------------

  it('does not create infra for Docker workflows without sharedContainer=true', async () => {
    const defPath = writeDefinitionFile(tmpDir, optedOutDockerDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId),
    );
    const destroyInfra = vi.fn(async () => {});

    // Sessions in opted-out mode go through the normal (non-borrow) path.
    // The test stubs the factory because the persona is 'global', which
    // would otherwise require a real session.
    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(createInfra).not.toHaveBeenCalled();
    expect(destroyInfra).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2: Opt-in creates infra at workflow start
  // -------------------------------------------------------------------------

  it('creates infra at start for Docker workflows with sharedContainer=true', async () => {
    const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId),
    );
    const destroyInfra = vi.fn(async () => {});

    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');

    // Infra created exactly once at start, before any session is invoked.
    expect(createInfra).toHaveBeenCalledTimes(1);
    expect(createInfra.mock.calls[0][0]).toMatchObject({
      workflowId,
      agentId: 'claude-code',
    });
    expect(createInfra.mock.calls[0][0].controlSocketPath).toContain(workflowId);

    await waitForCompletion(orchestrator, workflowId);
  });

  // -------------------------------------------------------------------------
  // Test 3: Terminal state destroys infra exactly once
  // -------------------------------------------------------------------------

  it('destroys infra exactly once when the workflow reaches a terminal state', async () => {
    const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);

    let createdBundle: DockerInfrastructure | undefined;
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      createdBundle = makeStubInfrastructure(input.workflowId);
      return createdBundle;
    });
    const destroyInfra = vi.fn(async () => {});

    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // destroy is kicked off asynchronously from handleWorkflowComplete.
    // Poll briefly for it to land.
    const start = Date.now();
    while (destroyInfra.mock.calls.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(destroyInfra).toHaveBeenCalledTimes(1);
    expect(destroyInfra).toHaveBeenCalledWith(createdBundle);
  });

  // -------------------------------------------------------------------------
  // Test 4: abort() destroys infra
  // -------------------------------------------------------------------------

  it('destroys infra when the workflow is aborted', async () => {
    // Use a definition that stalls at a human gate so abort() fires while
    // the workflow is still active (finalStatus not yet set).
    const gatedDef: WorkflowDefinition = {
      name: 'docker-gated',
      description: 'Docker workflow with a gate (for abort testing)',
      initial: 'work',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        work: {
          type: 'agent',
          description: 'Does work',
          persona: 'global',
          prompt: 'You are a worker.',
          inputs: [],
          outputs: ['result'],
          transitions: [{ to: 'gate' }],
        },
        gate: {
          type: 'human_gate',
          description: 'Human review',
          acceptedEvents: ['APPROVE', 'ABORT'],
          present: ['result'],
          transitions: [
            { to: 'done', event: 'APPROVE' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        done: { type: 'terminal', description: 'Done' },
        aborted: { type: 'terminal', description: 'Aborted' },
      },
    };

    const stubCleanup = stubPersonasForTest(tmpDir, gatedDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, gatedDef);

      let createdBundle: DockerInfrastructure | undefined;
      const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
        createdBundle = makeStubInfrastructure(input.workflowId);
        return createdBundle;
      });
      const destroyInfra = vi.fn(async () => {});

      const raiseGate = vi.fn();
      const sessionFactory = vi.fn(async () =>
        createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
      );

      const orchestrator = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: sessionFactory,
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: destroyInfra,
          raiseGate,
        }),
      );
      activeOrchestrator = orchestrator;

      const workflowId = await orchestrator.start(defPath, 'task');

      // Wait for the gate to open before aborting so the workflow is mid-run.
      const gateStart = Date.now();
      while (raiseGate.mock.calls.length === 0 && Date.now() - gateStart < 2000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(raiseGate).toHaveBeenCalled();

      await orchestrator.abort(workflowId);

      expect(destroyInfra).toHaveBeenCalledTimes(1);
      expect(destroyInfra).toHaveBeenCalledWith(createdBundle);
    } finally {
      stubCleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: shutdownAll destroys infra for every active workflow
  // -------------------------------------------------------------------------

  it('destroys infra for every instance on shutdownAll', async () => {
    const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId),
    );
    const destroyInfra = vi.fn(async () => {});

    // Never-completes session so the workflow stays active until shutdown.
    const sessionFactory = vi.fn(
      () =>
        new Promise(() => {
          /* hang */
        }),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory as unknown as (opts: SessionOptions) => Promise<never>,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const id1 = await orchestrator.start(defPath, 'task 1');
    // start() resolves after infra creation; then actor.start() kicks off
    // the hanging session. Spin briefly to ensure the workflow is registered.
    await new Promise((r) => setTimeout(r, 20));

    expect(createInfra).toHaveBeenCalledTimes(1);
    expect(orchestrator.listActive()).toContain(id1);

    await orchestrator.shutdownAll();
    activeOrchestrator = undefined; // already shut down

    // shutdownAll aborts the workflow (which destroys infra) and then
    // makes a second pass. The instance was destroyed only once because
    // destroyWorkflowInfrastructure is idempotent (clears instance.infra
    // on first call, early-returns on the second).
    expect(destroyInfra).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 6: Idempotent destroy
  // -------------------------------------------------------------------------

  it('destroyWorkflowInfrastructure is idempotent (second call is a no-op)', async () => {
    const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId),
    );
    const destroyInfra = vi.fn(async () => {});

    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // Wait for the async destroy dispatched from handleWorkflowComplete.
    const start = Date.now();
    while (destroyInfra.mock.calls.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(destroyInfra).toHaveBeenCalledTimes(1);

    // A follow-up abort or shutdownAll must not call destroy again.
    await orchestrator.shutdownAll();
    activeOrchestrator = undefined;

    expect(destroyInfra).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 7: Builtin workflows ignore the sharedContainer flag
  // -------------------------------------------------------------------------

  it('does not create infra for builtin workflows even when sharedContainer=true', async () => {
    const defPath = writeDefinitionFile(tmpDir, builtinSharedDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId),
    );
    const destroyInfra = vi.fn(async () => {});

    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(createInfra).not.toHaveBeenCalled();
    expect(destroyInfra).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 8: Builtin workflow without the flag also skips infra
  // -------------------------------------------------------------------------

  it('does not create infra for builtin workflows without sharedContainer', async () => {
    const defPath = writeDefinitionFile(tmpDir, builtinDefaultDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId),
    );
    const destroyInfra = vi.fn(async () => {});

    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(createInfra).not.toHaveBeenCalled();
    expect(destroyInfra).not.toHaveBeenCalled();
  });
});
