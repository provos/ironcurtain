import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionId, SessionOptions } from '../../src/session/types.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import type { BundleId } from '../../src/session/types.js';
import type { TokenStreamBus } from '../../src/docker/token-stream-bus.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import {
  approvedResponse,
  createArtifactAwareSession,
  writeDefinitionFile,
  createDeps,
  waitForCompletion,
  waitForGate,
  stubPersonasForTest,
  MockSession,
  simulateArtifacts,
  findWorkflowDir,
} from './test-helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Builds a minimal stub DockerInfrastructure bundle. Tests never exercise
 * the bundle's fields directly — they only track identity (was this
 * bundle handed out, was it passed to destroy, etc.) and use `bundleId`
 * to key per-bundle paths (audit log, control socket, invocation dirs).
 *
 * Under Step 6's lazy-mint model the orchestrator mints a fresh
 * `BundleId` per scope and passes it into the factory as `input.bundleId`;
 * the stub echoes that value back so identity comparisons work across
 * subsequent calls.
 *
 * `setTokenSessionId` is a no-op so the orchestrator's per-agent
 * rerouting calls don't crash. Tests that care about the routing calls
 * should override it with a `vi.fn()`.
 */
function makeStubInfrastructure(workflowId: string, bundleId: BundleId): DockerInfrastructure {
  const bundle = {
    __stub: true,
    workflowId,
    bundleId,
    setTokenSessionId: () => {},
  } as unknown as DockerInfrastructure;
  return bundle;
}

/**
 * Builds a `createWorkflowInfrastructure` stub that records every
 * `setTokenSessionId(id)` call into a shared array. Used by the
 * `setTokenSessionId` regression tests that need to assert the exact
 * sequence of session-id flips driven by the orchestrator around each
 * agent run.
 *
 * Returns `{ createInfra, tokenSessionIdCalls }` so the caller can
 * install the factory into `createDeps` and then assert against the
 * recorded call log.
 */
function createRecordingInfra(): {
  createInfra: ReturnType<typeof vi.fn>;
  tokenSessionIdCalls: Array<string | undefined>;
} {
  const tokenSessionIdCalls: Array<string | undefined> = [];
  const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
    return {
      __stub: true,
      workflowId: input.workflowId,
      bundleId: input.bundleId,
      setTokenSessionId: (id: string | undefined) => {
        tokenSessionIdCalls.push(id);
      },
    } as unknown as DockerInfrastructure;
  });
  return { createInfra, tokenSessionIdCalls };
}

/**
 * Builds a MockSession that simulates the MITM proxy's SSE tap firing
 * during `sendMessage`: pushes a `message_end` event onto the provided
 * bus under `opts.sessionId` with `opts.outputTokens`, simulates the
 * listed `artifacts` in the workflow dir, and returns a status-approved
 * response (with optional `responseNotes`).
 *
 * Used by the `ctx.totalTokens` accumulation tests, which need the
 * orchestrator's bus subscriber to observe a token event keyed on the
 * per-agent session id so the total lands in the workflow instance.
 */
function makeTokenEmittingSession(opts: {
  sessionId: string;
  outputTokens: number;
  artifacts: readonly string[];
  tmpDir: string;
  bus: TokenStreamBus;
  responseNotes?: string;
}): MockSession {
  return new MockSession({
    sessionId: opts.sessionId,
    responses: () => {
      opts.bus.push(opts.sessionId as unknown as SessionId, {
        kind: 'message_end',
        stopReason: 'end_turn',
        inputTokens: 0,
        outputTokens: opts.outputTokens,
        timestamp: Date.now(),
      });
      simulateArtifacts(findWorkflowDir(opts.tmpDir), [...opts.artifacts]);
      return approvedResponse(opts.responseNotes ?? 'done');
    },
  });
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
      makeStubInfrastructure(input.workflowId, input.bundleId),
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
  // Test 2: Opt-in lazy-mints the primary bundle on first state entry
  // -------------------------------------------------------------------------

  it('lazy-mints the primary bundle on first agent-state entry under sharedContainer=true', async () => {
    const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
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

    // With a single-scope workflow, exactly one bundle is minted.
    // Under lazy-mint, the factory is NOT called until the first
    // `executeAgentState` — not at `start()` — but for a single-state
    // workflow we just observe the end state: exactly one call total.
    expect(createInfra).toHaveBeenCalledTimes(1);
    expect(createInfra.mock.calls[0][0]).toMatchObject({
      workflowId,
      agentId: 'claude-code',
      scope: 'primary',
    });
    // Control socket lives under `~/.ironcurtain/run/<bundleId[0:12]>/`
    // — the workflow id is no longer part of the path. Match on the
    // minted bundle's short slug instead.
    // Slug is derived with hyphens stripped; see `toBundleSlug` in paths.ts.
    const mintedBundleId = createInfra.mock.calls[0][0].bundleId;
    expect(createInfra.mock.calls[0][0].controlSocketPath).toContain(mintedBundleId.replace(/-/g, '').substring(0, 12));
  });

  // -------------------------------------------------------------------------
  // Test 3: Terminal state destroys infra exactly once
  // -------------------------------------------------------------------------

  it('destroys infra exactly once when the workflow reaches a terminal state', async () => {
    const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);

    let createdBundle: DockerInfrastructure | undefined;
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      createdBundle = makeStubInfrastructure(input.workflowId, input.bundleId);
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
        createdBundle = makeStubInfrastructure(input.workflowId, input.bundleId);
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
      makeStubInfrastructure(input.workflowId, input.bundleId),
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
      makeStubInfrastructure(input.workflowId, input.bundleId),
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
      makeStubInfrastructure(input.workflowId, input.bundleId),
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
      makeStubInfrastructure(input.workflowId, input.bundleId),
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
  // Regression: per-agent `setTokenSessionId` on the shared MITM proxy
  // -------------------------------------------------------------------------
  //
  // Before the fix, `createWorkflowInfrastructure` baked the workflow ID
  // into the MITM proxy as a static sessionId. Each per-state agent session
  // has its own generated SessionId, so token events extracted by the
  // long-lived MITM proxy were pushed under the workflow ID instead of the
  // active agent's session ID. The daemon's `TokenStreamBridge` registers
  // the per-state ID (via the `agent_started` lifecycle event), so events
  // keyed on the workflow ID never reached any subscriber — silently
  // dropped at the bridge.
  //
  // The fix is that the orchestrator flips
  // `instance.infra.setTokenSessionId` around each agent run:
  //   - Before emitting `agent_started`: set to the session's ID.
  //   - In the `finally` block, BEFORE emitting `agent_session_ended`:
  //     set to `undefined`.
  //
  // These tests lock that contract.

  it('flips setTokenSessionId to the per-agent session ID around each agent run', async () => {
    // Two sequential agent states so we can observe two distinct session
    // IDs flow through the MITM proxy.
    const twoAgentDef: WorkflowDefinition = {
      name: 'docker-two-agents',
      description: 'Two back-to-back agents in shared-container mode',
      initial: 'first',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        first: {
          type: 'agent',
          description: 'First agent',
          persona: 'global',
          prompt: 'You are the first agent.',
          inputs: [],
          outputs: ['a'],
          transitions: [{ to: 'second' }],
        },
        second: {
          type: 'agent',
          description: 'Second agent',
          persona: 'global',
          prompt: 'You are the second agent.',
          inputs: ['a'],
          outputs: ['b'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };

    const stubCleanup = stubPersonasForTest(tmpDir, twoAgentDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, twoAgentDef);

      // Record every setTokenSessionId call on the shared bundle.
      const { createInfra, tokenSessionIdCalls } = createRecordingInfra();
      const destroyInfra = vi.fn(async () => {});

      // Each invocation returns a distinct session ID so the test can
      // assert the orchestrator used the session's ID (not the workflow's).
      let sessionCounter = 0;
      const sessionFactory = vi.fn(async () => {
        sessionCounter++;
        return createArtifactAwareSession(
          [{ text: approvedResponse('done'), artifacts: [sessionCounter === 1 ? 'a' : 'b'] }],
          tmpDir,
          `agent-session-${sessionCounter}`,
        );
      });

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

      // Expect the orchestrator to have driven the following sequence:
      //   1. set('agent-session-1')    ← before `agent_started` for "first"
      //   2. set(undefined)            ← in `finally` of "first"
      //   3. set('agent-session-2')    ← before `agent_started` for "second"
      //   4. set(undefined)            ← in `finally` of "second"
      // The per-agent ID (NOT the workflowId) is what lands on the proxy.
      expect(tokenSessionIdCalls).toEqual(['agent-session-1', undefined, 'agent-session-2', undefined]);
      // Sanity: the workflow ID was NEVER used as a routing target.
      expect(tokenSessionIdCalls).not.toContain(workflowId);
    } finally {
      stubCleanup();
    }
  });

  it('clears setTokenSessionId on failure so the next agent does not inherit a stale ID', async () => {
    // A workflow where the agent fails (no status block + retry also
    // fails). The `finally` block must still flip setTokenSessionId back
    // to `undefined` — otherwise a subsequent agent in a follow-up run
    // would see events routed under the previous session's ID.
    const failingAgentDef: WorkflowDefinition = {
      name: 'docker-failing-agent',
      description: 'Single agent that fails (status block retry exhausted)',
      initial: 'broken',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        broken: {
          type: 'agent',
          description: 'Fails to produce a status block',
          persona: 'global',
          prompt: 'You are broken.',
          inputs: [],
          outputs: ['result'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };

    const stubCleanup = stubPersonasForTest(tmpDir, failingAgentDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, failingAgentDef);

      const { createInfra, tokenSessionIdCalls } = createRecordingInfra();
      const destroyInfra = vi.fn(async () => {});

      // Import inline to avoid leaking this helper import into every test
      // above.
      const { noStatusResponse } = await import('./test-helpers.js');

      const sessionFactory = vi.fn(async () => {
        simulateArtifacts(findWorkflowDir(tmpDir), ['result']);
        return new MockSession({
          sessionId: 'failing-session-abc',
          responses: [noStatusResponse(), noStatusResponse()],
        });
      });

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

      // Even on the failure path (status retry exhausted → throw), the
      // `finally` block must set sessionId back to undefined.
      expect(tokenSessionIdCalls).toEqual(['failing-session-abc', undefined]);
    } finally {
      stubCleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Regression: workflow totalTokens accumulation via the token-stream bus
  // -------------------------------------------------------------------------
  //
  // Before the fix, `ctx.totalTokens` was initialized to 0 in the machine
  // but never written again — the workflow summary's "Total Tokens" card
  // always showed 0 regardless of LLM usage. The orchestrator now
  // subscribes to the token-stream bus at workflow start, accumulates
  // `message_end.outputTokens` into a per-workflow counter, and threads
  // that total through `AgentInvokeResult` into `ctx.totalTokens`.

  it('accumulates outputTokens from message_end events into ctx.totalTokens', async () => {
    // Reset the bus so this test is isolated from any other bus state.
    const { resetTokenStreamBus, getTokenStreamBus } = await import('../../src/docker/token-stream-bus.js');
    resetTokenStreamBus();
    const bus = getTokenStreamBus();

    const twoAgentDef: WorkflowDefinition = {
      name: 'docker-token-accum',
      description: 'Two agents emitting token events',
      initial: 'first',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        first: {
          type: 'agent',
          description: 'First agent',
          persona: 'global',
          prompt: 'You are the first agent.',
          inputs: [],
          outputs: ['a'],
          transitions: [{ to: 'second' }],
        },
        second: {
          type: 'agent',
          description: 'Second agent',
          persona: 'global',
          prompt: 'You are the second agent.',
          inputs: ['a'],
          outputs: ['b'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };

    const stubCleanup = stubPersonasForTest(tmpDir, twoAgentDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, twoAgentDef);

      const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
        makeStubInfrastructure(input.workflowId, input.bundleId),
      );
      const destroyInfra = vi.fn(async () => {});

      // `makeTokenEmittingSession` simulates the MITM proxy's SSE tap firing
      // during `sendMessage`: before returning the agent's response, it pushes
      // a `message_end` event onto the bus under the agent's session ID. The
      // orchestrator's bus subscriber accumulates `outputTokens` into
      // `instance.outputTokens`.
      let sessionCounter = 0;
      const sessionFactory = vi.fn(async () => {
        sessionCounter++;
        return makeTokenEmittingSession({
          sessionId: `agent-session-${sessionCounter}`,
          outputTokens: sessionCounter === 1 ? 100 : 50,
          artifacts: [sessionCounter === 1 ? 'a' : 'b'],
          tmpDir,
          bus,
        });
      });

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

      const detail = orchestrator.getDetail(workflowId);
      expect(detail).toBeDefined();
      // Sum: 100 (first agent) + 50 (second agent) = 150.
      expect(detail!.context.totalTokens).toBe(150);
    } finally {
      stubCleanup();
    }
  });

  it('keeps ctx.totalTokens at 0 when no token events arrive on the bus', async () => {
    const { resetTokenStreamBus } = await import('../../src/docker/token-stream-bus.js');
    resetTokenStreamBus();

    const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
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

    const detail = orchestrator.getDetail(workflowId);
    expect(detail).toBeDefined();
    expect(detail!.context.totalTokens).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Regression: resume carries checkpointed totalTokens into the new instance
  // -------------------------------------------------------------------------
  //
  // `orchestrator.ts:1020-1021` seeds `instance.tokens.outputTokens` from
  // `checkpoint.context.totalTokens` on resume so post-resume token events
  // accumulate on top of the pre-crash total rather than starting from zero.
  // Lock that wiring end-to-end: pre-checkpoint agent contributes N tokens,
  // post-resume agent contributes M, and `ctx.totalTokens` ends at N+M.

  it('carries checkpointed totalTokens through resume into the next agents ctx', async () => {
    const { resetTokenStreamBus, getTokenStreamBus } = await import('../../src/docker/token-stream-bus.js');
    const { createCheckpointStore } = await import('./test-helpers.js');
    resetTokenStreamBus();
    const bus = getTokenStreamBus();

    // Two agents separated by a human gate so the workflow parks at the
    // gate after agent 1, writing a checkpoint with totalTokens=100. We
    // shut down, re-save the checkpoint (abort removes it on shutdown),
    // resume, approve the gate, and let agent 2 add 50 more.
    const resumeAcrossGateDef: WorkflowDefinition = {
      name: 'docker-resume-token-accum',
      description: 'Two agents with a gate between them for resume testing',
      initial: 'first',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        first: {
          type: 'agent',
          description: 'First agent',
          persona: 'global',
          prompt: 'You are the first agent.',
          inputs: [],
          outputs: ['a'],
          transitions: [{ to: 'gate' }],
        },
        gate: {
          type: 'human_gate',
          description: 'Human review between agents',
          acceptedEvents: ['APPROVE', 'ABORT'],
          present: ['a'],
          transitions: [
            { to: 'second', event: 'APPROVE' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        second: {
          type: 'agent',
          description: 'Second agent',
          persona: 'global',
          prompt: 'You are the second agent.',
          inputs: ['a'],
          outputs: ['b'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
        aborted: { type: 'terminal', description: 'Aborted' },
      },
    };

    const stubCleanup = stubPersonasForTest(tmpDir, resumeAcrossGateDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, resumeAcrossGateDef);
      const checkpointStore = createCheckpointStore(tmpDir);

      // ---- Orchestrator 1: run agent 1, stall at the gate ----

      const createInfra1 = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
        makeStubInfrastructure(input.workflowId, input.bundleId),
      );
      const destroyInfra1 = vi.fn(async () => {});

      const raiseGate1 = vi.fn();
      // Emit 100 tokens under agent 1's session id before returning.
      const sessionFactory1 = vi.fn(async () =>
        makeTokenEmittingSession({
          sessionId: 'agent-session-1',
          outputTokens: 100,
          artifacts: ['a'],
          tmpDir,
          bus,
          responseNotes: 'first done',
        }),
      );

      const orchestrator1 = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: sessionFactory1,
          createWorkflowInfrastructure: createInfra1,
          destroyWorkflowInfrastructure: destroyInfra1,
          raiseGate: raiseGate1,
          checkpointStore,
        }),
      );
      activeOrchestrator = orchestrator1;

      const workflowId = await orchestrator1.start(defPath, 'task');
      // Wait until the machine parks at the gate. By this point agent 1 has
      // finished and its outputTokens=100 has landed on ctx.totalTokens.
      await waitForGate(raiseGate1, 1);

      const checkpointAtGate = checkpointStore.load(workflowId);
      expect(checkpointAtGate).toBeDefined();
      expect(checkpointAtGate!.machineState).toBe('gate');
      expect(checkpointAtGate!.context.totalTokens).toBe(100);

      // shutdownAll triggers abort, which removes the checkpoint. Snapshot
      // it first so we can re-save and simulate a fresh process.
      const savedCheckpoint = { ...checkpointAtGate! };
      await orchestrator1.shutdownAll();
      activeOrchestrator = undefined;
      checkpointStore.save(workflowId, savedCheckpoint);

      // ---- Orchestrator 2: resume, approve the gate, run agent 2 ----

      const createInfra2 = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
        makeStubInfrastructure(input.workflowId, input.bundleId),
      );
      const destroyInfra2 = vi.fn(async () => {});

      const raiseGate2 = vi.fn();
      // Emit 50 tokens under agent 2's session id. If resume failed to seed
      // outputTokens from the checkpoint, the final ctx.totalTokens would be
      // 50; the test's 150 assertion is what locks that path.
      const sessionFactory2 = vi.fn(async () =>
        makeTokenEmittingSession({
          sessionId: 'agent-session-2',
          outputTokens: 50,
          artifacts: ['b'],
          tmpDir,
          bus,
          responseNotes: 'second done',
        }),
      );

      const orchestrator2 = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: sessionFactory2,
          createWorkflowInfrastructure: createInfra2,
          destroyWorkflowInfrastructure: destroyInfra2,
          raiseGate: raiseGate2,
          checkpointStore,
        }),
      );
      activeOrchestrator = orchestrator2;

      await orchestrator2.resume(workflowId);

      // resume() re-raises the gate; approve it so agent 2 runs.
      await waitForGate(raiseGate2, 1);
      orchestrator2.resolveGate(workflowId, { type: 'APPROVE' });
      await waitForCompletion(orchestrator2, workflowId);

      const detail = orchestrator2.getDetail(workflowId);
      expect(detail).toBeDefined();
      // 100 (pre-checkpoint) + 50 (post-resume) = 150.
      expect(detail!.context.totalTokens).toBe(150);
    } finally {
      stubCleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Regression: abort mid-agent must clear MITM token routing
  // -------------------------------------------------------------------------
  //
  // If the user aborts while the agent is mid-`sendMessage`, the
  // `executeAgentState` finally block still needs to fire so
  // `setTokenSessionId(undefined)` clears the shared MITM routing. Otherwise
  // a subsequent workflow restarted against the same infrastructure bundle
  // (or a late event emerging after teardown) would land under a stale
  // session id. We simulate the abort path with a session whose
  // `sendMessage` rejects on `close()` — that's the observable contract the
  // real Session implementations (DockerAgentSession etc.) expose: pending
  // messages fail once the session is torn down.

  it('clears setTokenSessionId from the finally block when aborted mid-agent', async () => {
    const stubCleanup = stubPersonasForTest(tmpDir, dockerWorkflowDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);

      const { createInfra, tokenSessionIdCalls } = createRecordingInfra();
      const destroyInfra = vi.fn(async () => {});

      // Hanging session: sendMessage returns a promise that only rejects
      // when close() fires. Mirrors real Session behavior under abort.
      // `closeCount` tracks every close() call so we can assert the
      // abort + agent-finally double-close path stays idempotent.
      let closeCount = 0;
      let rejectPending: ((err: Error) => void) | null = null;
      const hangingSession = new MockSession({
        sessionId: 'hanging-session-xyz',
        responses: () =>
          new Promise<string>((_resolve, reject) => {
            rejectPending = reject;
          }),
      });
      // Replace close() with a version that rejects the in-flight sendMessage
      // and increments the counter. MockSession.close is otherwise safe to
      // call repeatedly (idempotent), but we wrap to observe the count.
      const originalClose = hangingSession.close.bind(hangingSession);
      hangingSession.close = async () => {
        closeCount++;
        if (rejectPending) {
          const reject = rejectPending;
          rejectPending = null;
          reject(new Error('session closed'));
        }
        await originalClose();
      };

      const sessionFactory = vi.fn(async () => hangingSession);

      const orchestrator = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: sessionFactory,
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: destroyInfra,
        }),
      );
      activeOrchestrator = orchestrator;

      const workflowId = await orchestrator.start(defPath, 'task');

      // Wait until the orchestrator has entered `sendMessage` (i.e. the
      // bundle has been flipped to this session's id). Without this spin
      // the abort could race ahead of agent_started.
      const spinStart = Date.now();
      while (tokenSessionIdCalls.length === 0 && Date.now() - spinStart < 2000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(tokenSessionIdCalls).toEqual(['hanging-session-xyz']);

      await orchestrator.abort(workflowId);

      // The agent's finally block runs when the rejected sendMessage unwinds;
      // that may happen after abort()'s own await chain completes. Spin until
      // the undefined clear lands (bounded) or fail the assertion.
      const finallyStart = Date.now();
      while (tokenSessionIdCalls.length < 2 && Date.now() - finallyStart < 2000) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Finally cleared the MITM routing even though sendMessage never
      // produced a response. Sequence: set('hanging-session-xyz') before
      // agent_started, set(undefined) in the finally after close rejection.
      expect(tokenSessionIdCalls).toEqual(['hanging-session-xyz', undefined]);

      // close() is called exactly twice under the orchestrator's current
      // teardown: once from `abort()` iterating `activeSessions` (which
      // rejects the pending `sendMessage`), and once from the agent's
      // `finally` block as the rejected promise unwinds. Both paths are
      // deterministic; if either silently stops firing the assertion
      // surfaces the regression instead of tolerating it.
      expect(closeCount).toBe(2);
      expect(hangingSession.closed).toBe(true);
    } finally {
      stubCleanup();
    }
  });
});
