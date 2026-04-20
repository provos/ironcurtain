/**
 * Shared-container policy cycling: control-server wiring, per-state
 * persona RPC shape, session borrow, and start-time error handling.
 *
 * Uses in-memory seams (startWorkflowControlServer + loadPolicyRpc) so
 * the tests exercise the orchestrator's cycling logic without standing
 * up a real Docker bundle, a real coordinator, or a real UDS.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionOptions } from '../../src/session/types.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import {
  WorkflowOrchestrator,
  type CreateWorkflowInfrastructureInput,
  type LoadPolicyRpcInput,
} from '../../src/workflow/orchestrator.js';
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
 * Makes a stub infrastructure bundle with a marker field. Tests check
 * identity (was this specific bundle the one borrowed / torn down).
 */
function makeStubInfrastructure(workflowId: string): DockerInfrastructure {
  return { __stub: true, workflowId } as unknown as DockerInfrastructure;
}

/**
 * Seeds a minimal `compiled-policy.json` into every non-global persona
 * directory under `IRONCURTAIN_HOME`. `cyclePolicy` calls
 * `resolvePersona(name)` which asserts the file exists; without this
 * helper the resolver throws before the test can exercise cycling.
 *
 * `stubPersonasForTest` (from test-helpers) already created the
 * persona directories and the `persona.json` stub; here we just drop a
 * policy file next to them.
 */
function seedPersonaPolicies(personas: readonly string[]): void {
  const home = process.env.IRONCURTAIN_HOME;
  if (!home) throw new Error('IRONCURTAIN_HOME not set; call stubPersonasForTest first');
  for (const name of personas) {
    const generated = resolve(home, 'personas', name, 'generated');
    mkdirSync(generated, { recursive: true });
    writeFileSync(resolve(generated, 'compiled-policy.json'), JSON.stringify({ rules: [] }));
  }
}

/**
 * Two-state workflow that alternates personas, exercising the persona
 * change recorded on each loadPolicy RPC (global -> reviewer).
 */
const twoPersonaDef: WorkflowDefinition = {
  name: 'two-persona',
  description: 'Global then reviewer, to exercise persona transitions',
  initial: 'plan',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    plan: {
      type: 'agent',
      description: 'Planner',
      persona: 'global',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      description: 'Reviewer',
      persona: 'reviewer',
      prompt: 'You are a reviewer.',
      inputs: ['plan'],
      outputs: ['review'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

/**
 * Three-state workflow that returns to the same persona twice so we
 * can assert the RPC fires once per agent-state entry, including
 * re-entries (global -> reviewer -> global).
 */
const reentryDef: WorkflowDefinition = {
  name: 'reentry',
  description: 'Global visits twice to exercise re-entry',
  initial: 'plan',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    plan: {
      type: 'agent',
      description: 'First global visit',
      persona: 'global',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      description: 'Reviewer',
      persona: 'reviewer',
      prompt: 'You are a reviewer.',
      inputs: ['plan'],
      outputs: ['review'],
      transitions: [{ to: 'finalize' }],
    },
    finalize: {
      type: 'agent',
      description: 'Second global visit',
      persona: 'global',
      prompt: 'You are finalizing.',
      inputs: ['review'],
      outputs: ['final'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

const singleStateDef: WorkflowDefinition = {
  name: 'single',
  description: 'Minimal sharedContainer workflow for error-path tests',
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator shared-container mode — policy cycling', () => {
  let tmpDir: string;
  let activeOrchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'policy-cycle-test-'));
    activeOrchestrator = undefined;
    cleanupPersonas = stubPersonasForTest(tmpDir, twoPersonaDef, reentryDef, singleStateDef);
    // cyclePolicy resolves non-global personas through resolvePersona(),
    // which requires compiled-policy.json to exist. Drop in a minimal stub.
    seedPersonaPolicies(['reviewer']);
  });

  afterEach(async () => {
    if (activeOrchestrator) {
      await activeOrchestrator.shutdownAll();
    }
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: cyclePolicy fires once per agent state with expected shape
  // -------------------------------------------------------------------------

  it('invokes cyclePolicy once per agent state with the workflow socket path and persona', async () => {
    const defPath = writeDefinitionFile(tmpDir, twoPersonaDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId),
    );
    const destroyInfra = vi.fn(async () => {});
    const startCtrl = vi.fn(async () => {});
    const loadPolicy = vi.fn(async () => {});

    // Each state gets its own fresh MockSession with one scripted response,
    // matching the existing test patterns in orchestrator.test.ts.
    let callIdx = 0;
    const responsesByCall = [
      { text: approvedResponse('planned'), artifacts: ['plan'] },
      { text: approvedResponse('reviewed'), artifacts: ['review'] },
    ];
    const sessionFactory = vi.fn(async () => {
      const entry = responsesByCall[callIdx++];
      return createArtifactAwareSession([entry], tmpDir);
    });

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
        startWorkflowControlServer: startCtrl,
        loadPolicyRpc: loadPolicy,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // Control server is started exactly once, alongside infra creation.
    expect(startCtrl).toHaveBeenCalledTimes(1);
    expect(startCtrl.mock.calls[0][0].socketPath).toContain(workflowId);

    // cyclePolicy fires once per agent state (plan, review).
    expect(loadPolicy).toHaveBeenCalledTimes(2);
    const firstCall = loadPolicy.mock.calls[0][0];
    const secondCall = loadPolicy.mock.calls[1][0];

    expect(firstCall.persona).toBe('global');
    expect(firstCall.socketPath).toContain(workflowId);
    // No audit-path or version on the RPC: the coordinator uses a
    // single workflow-run audit file and stamps each entry with
    // `persona` instead.
    expect(firstCall).not.toHaveProperty('auditPath');
    expect(firstCall).not.toHaveProperty('version');

    expect(secondCall.persona).toBe('reviewer');
    expect(secondCall.socketPath).toBe(firstCall.socketPath);
    expect(secondCall).not.toHaveProperty('auditPath');
    expect(secondCall).not.toHaveProperty('version');
  });

  // -------------------------------------------------------------------------
  // Test 2: cyclePolicy fires once per agent-state entry, including re-entries
  // -------------------------------------------------------------------------

  it('fires cyclePolicy once per agent-state entry, including when a persona is revisited', async () => {
    // Under single-file audit, re-entering the same persona no longer
    // produces a distinct filename -- what matters is that the RPC
    // fires once per agent-state entry with the correct persona each
    // time. The coordinator stamps each audit entry so consumers can
    // slice by persona / re-entry from JSONL ordering.
    const defPath = writeDefinitionFile(tmpDir, reentryDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId),
    );
    const destroyInfra = vi.fn(async () => {});
    const startCtrl = vi.fn(async () => {});
    const loadPolicy = vi.fn(async () => {});

    let callIdx = 0;
    const responsesByCall = [
      { text: approvedResponse('planned'), artifacts: ['plan'] },
      { text: approvedResponse('reviewed'), artifacts: ['review'] },
      { text: approvedResponse('finalized'), artifacts: ['final'] },
    ];
    const sessionFactory = vi.fn(async () => {
      const entry = responsesByCall[callIdx++];
      return createArtifactAwareSession([entry], tmpDir);
    });

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
        startWorkflowControlServer: startCtrl,
        loadPolicyRpc: loadPolicy,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // Three agent states: global, reviewer, global.
    expect(loadPolicy).toHaveBeenCalledTimes(3);
    const personas = loadPolicy.mock.calls.map((c: LoadPolicyRpcInput[]) => c[0].persona);
    expect(personas).toEqual(['global', 'reviewer', 'global']);

    // Control server is still started exactly once, regardless of how
    // many times cyclePolicy fires.
    expect(startCtrl).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 3: the same bundle is borrowed by every session
  // -------------------------------------------------------------------------

  it('passes workflowInfrastructure (same bundle identity) to every session', async () => {
    const defPath = writeDefinitionFile(tmpDir, twoPersonaDef);

    let createdBundle: DockerInfrastructure | undefined;
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      createdBundle = makeStubInfrastructure(input.workflowId);
      return createdBundle;
    });
    const destroyInfra = vi.fn(async () => {});
    const startCtrl = vi.fn(async () => {});
    const loadPolicy = vi.fn(async () => {});

    const seenInfra: Array<DockerInfrastructure | undefined> = [];
    let callIdx = 0;
    const responsesByCall = [
      { text: approvedResponse('planned'), artifacts: ['plan'] },
      { text: approvedResponse('reviewed'), artifacts: ['review'] },
    ];
    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      seenInfra.push(opts.workflowInfrastructure);
      const entry = responsesByCall[callIdx++];
      return createArtifactAwareSession([entry], tmpDir);
    });

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
        startWorkflowControlServer: startCtrl,
        loadPolicyRpc: loadPolicy,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(seenInfra).toHaveLength(2);
    expect(seenInfra[0]).toBe(createdBundle);
    expect(seenInfra[1]).toBe(createdBundle);
    expect(createdBundle).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 4: cyclePolicy failure fails the state invoke (no silent fallback)
  // -------------------------------------------------------------------------

  it('fails the workflow when cyclePolicy rejects', async () => {
    const defPath = writeDefinitionFile(tmpDir, singleStateDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId),
    );
    const destroyInfra = vi.fn(async () => {});
    const startCtrl = vi.fn(async () => {});
    const loadPolicy = vi.fn(async () => {
      throw new Error('coordinator rejected load');
    });

    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
        startWorkflowControlServer: startCtrl,
        loadPolicyRpc: loadPolicy,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // cyclePolicy threw, so the session was never created.
    expect(sessionFactory).not.toHaveBeenCalled();
    expect(loadPolicy).toHaveBeenCalledTimes(1);
    // The XState machine still reaches its terminal state after an invoke
    // failure (onError routes to the configured error target), so we
    // can't assert on phase alone. What matters is that we never ran
    // the session — the assertion above covers that.
  });

  // -------------------------------------------------------------------------
  // Test 5: infra creation throws -> start() rejects, no workflow registered
  // -------------------------------------------------------------------------

  it('rejects start() and leaves no workflow registered when createWorkflowInfrastructure throws', async () => {
    const defPath = writeDefinitionFile(tmpDir, singleStateDef);

    const createInfra = vi.fn(async () => {
      throw new Error('docker unavailable');
    });
    const destroyInfra = vi.fn(async () => {});
    const startCtrl = vi.fn(async () => {});
    const loadPolicy = vi.fn(async () => {});
    const sessionFactory = vi.fn();

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
        startWorkflowControlServer: startCtrl,
        loadPolicyRpc: loadPolicy,
      }),
    );
    activeOrchestrator = orchestrator;

    await expect(orchestrator.start(defPath, 'task')).rejects.toThrow('docker unavailable');

    // No workflow registered, no bundle started, nothing destroyed, no
    // control server attempted (we never got that far), no session created.
    expect(orchestrator.listActive()).toHaveLength(0);
    expect(startCtrl).not.toHaveBeenCalled();
    expect(destroyInfra).not.toHaveBeenCalled();
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 6: control-server attach fails -> bundle is torn down
  // -------------------------------------------------------------------------

  it('tears down the bundle and rejects start() when startWorkflowControlServer throws', async () => {
    const defPath = writeDefinitionFile(tmpDir, singleStateDef);

    let createdBundle: DockerInfrastructure | undefined;
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      createdBundle = makeStubInfrastructure(input.workflowId);
      return createdBundle;
    });
    const destroyInfra = vi.fn(async () => {});
    const startCtrl = vi.fn(async () => {
      throw new Error('port in use');
    });
    const loadPolicy = vi.fn(async () => {});
    const sessionFactory = vi.fn();

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
        startWorkflowControlServer: startCtrl,
        loadPolicyRpc: loadPolicy,
      }),
    );
    activeOrchestrator = orchestrator;

    await expect(orchestrator.start(defPath, 'task')).rejects.toThrow('port in use');

    // Bundle was created then torn down in the recovery path.
    expect(createInfra).toHaveBeenCalledTimes(1);
    expect(destroyInfra).toHaveBeenCalledTimes(1);
    expect(destroyInfra).toHaveBeenCalledWith(createdBundle);

    // No workflow registered, no session created.
    expect(orchestrator.listActive()).toHaveLength(0);
    expect(sessionFactory).not.toHaveBeenCalled();
  });
});
