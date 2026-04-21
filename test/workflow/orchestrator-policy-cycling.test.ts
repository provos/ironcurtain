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
import type { BundleId, SessionOptions } from '../../src/session/types.js';
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
 *
 * Under Step 6's lazy-mint model the orchestrator passes a freshly
 * minted `BundleId` into the factory; the stub echoes it back so
 * follow-up identity comparisons (was THIS bundle the one we borrowed,
 * destroyed, etc.) resolve correctly.
 */
function makeStubInfrastructure(workflowId: string, bundleId: BundleId): DockerInfrastructure {
  return {
    __stub: true,
    workflowId,
    bundleId,
  } as unknown as DockerInfrastructure;
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
 * Two-state workflow exercising persona transitions within one bundle.
 * Both states default to the "primary" scope, so they share the same
 * bundle and control socket. `cyclePolicy` hot-swaps the active policy
 * on each state entry.
 */
const twoPersonaDef: WorkflowDefinition = {
  name: 'two-persona',
  description: 'Global then reviewer, both on the default (primary) scope',
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
 * Three-state workflow that returns to the global persona twice so we
 * can assert the RPC fires once per agent-state entry, including
 * re-entries. All three states share the default (primary) scope — one
 * bundle, one coordinator, persona hot-swaps per entry.
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
      makeStubInfrastructure(input.workflowId, input.bundleId),
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

    // Control server is started once per bundle. Both states share the
    // default (primary) scope, so one bundle, one control server.
    expect(startCtrl).toHaveBeenCalledTimes(1);
    // Socket path now lives under `~/.ironcurtain/run/<bundleId[0:12]>/`
    // (the workflow id is no longer part of it — bundle identity alone
    // is enough under the namespace-unique 12-char slug). Match on the
    // minted bundle's short id instead.
    // `getBundleRuntimeRoot` strips UUID hyphens before truncating so the
    // slug is 12 pure hex chars (16^12 collision space, not 16^11).
    const mintedBundleId = createInfra.mock.calls[0][0].bundleId;
    const expectedShortId = mintedBundleId.replace(/-/g, '').substring(0, 12);
    expect(startCtrl.mock.calls[0][0].socketPath).toContain(expectedShortId);

    // cyclePolicy fires once per agent state (plan, review).
    expect(loadPolicy).toHaveBeenCalledTimes(2);
    const firstCall = loadPolicy.mock.calls[0][0];
    const secondCall = loadPolicy.mock.calls[1][0];

    expect(firstCall.persona).toBe('global');
    expect(firstCall.socketPath).toContain(expectedShortId);
    // No audit-path or version on the RPC: the coordinator uses a
    // per-bundle audit file and stamps each entry with `persona` instead.
    expect(firstCall).not.toHaveProperty('auditPath');
    expect(firstCall).not.toHaveProperty('version');

    expect(secondCall.persona).toBe('reviewer');
    expect(secondCall.socketPath).toContain(expectedShortId);
    // Same scope → same bundle → same socket. Persona hot-swaps via
    // loadPolicy; the socket identifies the coordinator, not the
    // persona.
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
      makeStubInfrastructure(input.workflowId, input.bundleId),
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

    // All three states share the default (primary) scope — one bundle,
    // one control server. Persona hot-swaps per-entry via loadPolicy.
    expect(startCtrl).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 3: distinct scopes borrow distinct bundles
  // -------------------------------------------------------------------------

  it('passes a distinct workflowInfrastructure bundle to each scope', async () => {
    // Two states on explicitly distinct `containerScope` values. Under
    // lazy-mint, the factory is called once per distinct scope, and
    // each state borrows the bundle for its own scope — not a shared
    // one. This pins down the cross-scope bundle-isolation invariant.
    const crossScopeDef: WorkflowDefinition = {
      name: 'cross-scope',
      description: 'Two scopes → two bundles',
      initial: 'plan',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        plan: {
          type: 'agent',
          description: 'Planner on scope-a',
          persona: 'global',
          prompt: 'You are a planner.',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'review' }],
          containerScope: 'scope-a',
        },
        review: {
          type: 'agent',
          description: 'Reviewer on scope-b',
          persona: 'reviewer',
          prompt: 'You are a reviewer.',
          inputs: ['plan'],
          outputs: ['review'],
          transitions: [{ to: 'done' }],
          containerScope: 'scope-b',
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };

    const defPath = writeDefinitionFile(tmpDir, crossScopeDef);

    const createdBundles: DockerInfrastructure[] = [];
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      const bundle = makeStubInfrastructure(input.workflowId, input.bundleId);
      createdBundles.push(bundle);
      return bundle;
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

    expect(createdBundles).toHaveLength(2);
    expect(seenInfra).toHaveLength(2);
    // Each state borrows the bundle the factory produced for its scope
    // — and they are NOT the same bundle.
    expect(seenInfra[0]).toBe(createdBundles[0]);
    expect(seenInfra[1]).toBe(createdBundles[1]);
    expect(seenInfra[0]).not.toBe(seenInfra[1]);
  });

  // -------------------------------------------------------------------------
  // Test 4: cyclePolicy failure fails the state invoke (no silent fallback)
  // -------------------------------------------------------------------------

  it('fails the workflow when cyclePolicy rejects', async () => {
    const defPath = writeDefinitionFile(tmpDir, singleStateDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
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
  // Test 5: infra creation throws -> state invoke fails, session never runs
  // -------------------------------------------------------------------------

  it('fails the state invoke without running a session when createWorkflowInfrastructure throws', async () => {
    // Under lazy-mint the bundle is created inside `executeAgentState`,
    // not `start()`. A Docker-unavailable error therefore surfaces as an
    // invoke failure — the workflow still registers and the machine
    // routes to its error target. What matters is that no session ran.
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

    // start() now succeeds — infra is lazy-minted, not created eagerly.
    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // The factory was called once and rejected. No control server
    // attach attempted (createInfra threw first). No session created.
    expect(createInfra).toHaveBeenCalledTimes(1);
    expect(startCtrl).not.toHaveBeenCalled();
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 6: control-server attach fails -> bundle is torn down, no session
  // -------------------------------------------------------------------------

  it('tears down the bundle and fails the state invoke when startWorkflowControlServer throws', async () => {
    // Under lazy-mint, a control-server attach failure now surfaces
    // during `executeAgentState`. The recovery path still tears down
    // the just-created bundle so Docker resources don't leak.
    const defPath = writeDefinitionFile(tmpDir, singleStateDef);

    let createdBundle: DockerInfrastructure | undefined;
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      createdBundle = makeStubInfrastructure(input.workflowId, input.bundleId);
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

    // start() succeeds — infra is lazy-minted inside executeAgentState.
    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // Bundle was created then torn down in the recovery path. The
    // factory and destroy hook are still called exactly once apiece.
    expect(createInfra).toHaveBeenCalledTimes(1);
    expect(destroyInfra).toHaveBeenCalledTimes(1);
    expect(destroyInfra).toHaveBeenCalledWith(createdBundle);
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 7: consecutive same-persona states skip the loadPolicy RPC
  // -------------------------------------------------------------------------

  it('skips loadPolicyRpc on consecutive same-persona states in the same scope', async () => {
    // Two agent states on the same default scope, both using the `global`
    // persona. The first state triggers `cyclePolicy` which loads the
    // policy; the second state observes the cached persona and short-circuits
    // — the coordinator already has the right policy, so a second RPC would
    // be a pure round-trip cost. Contrast with the re-entry test above,
    // where persona flips between entries and every entry fires an RPC.
    const sameScopeSamePersonaDef: WorkflowDefinition = {
      name: 'same-persona',
      description: 'Two consecutive global states on the default scope',
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
          description: 'Same persona, next state',
          persona: 'global',
          prompt: 'You are still a planner.',
          inputs: ['plan'],
          outputs: ['review'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
    const defPath = writeDefinitionFile(tmpDir, sameScopeSamePersonaDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    const loadPolicy = vi.fn(async () => {});

    let callIdx = 0;
    const responsesByCall = [
      { text: approvedResponse('planned'), artifacts: ['plan'] },
      { text: approvedResponse('reviewed'), artifacts: ['review'] },
    ];
    const sessionFactory = vi.fn(async () => createArtifactAwareSession([responsesByCall[callIdx++]], tmpDir));

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: async () => {},
        startWorkflowControlServer: async () => {},
        loadPolicyRpc: loadPolicy,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // The second state finds the cache already pointing at `global`, so
    // its cyclePolicy call short-circuits. Exactly ONE RPC for two
    // agent-state entries.
    expect(loadPolicy).toHaveBeenCalledTimes(1);
    expect(loadPolicy.mock.calls[0][0].persona).toBe('global');
  });

  // -------------------------------------------------------------------------
  // Test 8: loadPolicy failure invalidates the cache so the next call retries
  // -------------------------------------------------------------------------

  it('clears the persona cache when loadPolicyRpc fails so the next cycle re-fires', async () => {
    // The BLOCKER fix: `cyclePolicy` deletes the cache entry BEFORE the
    // RPC and re-sets it only on success. If the RPC fails, the cache
    // must remain empty so the next `cyclePolicy` call with the same
    // persona re-sends the RPC — otherwise a transient failure would
    // leave the coordinator stuck on the wrong policy and silently skip
    // the recovery cycle.
    //
    // The error-recovery path in the workflow machine routes to a
    // terminal state (findErrorTarget prefers any terminal over falling
    // back to the next agent state), so a second agent state never runs.
    // We instead observe the BLOCKER fix via the orchestrator's internal
    // `currentPersonaByBundle` map: after a failed RPC that map must not
    // contain the target bundle, demonstrating that the next cycle on
    // the same persona would fire the RPC again.
    const defPath = writeDefinitionFile(tmpDir, singleStateDef);

    let bundleMinted: DockerInfrastructure | undefined;
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      bundleMinted = makeStubInfrastructure(input.workflowId, input.bundleId);
      return bundleMinted;
    });
    const loadPolicy = vi.fn(async () => {
      throw new Error('coordinator rejected load');
    });
    const sessionFactory = vi.fn();

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: async () => {},
        startWorkflowControlServer: async () => {},
        loadPolicyRpc: loadPolicy,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // One call, which failed. Session never ran.
    expect(loadPolicy).toHaveBeenCalledTimes(1);
    expect(sessionFactory).not.toHaveBeenCalled();
    expect(bundleMinted).toBeDefined();

    // BLOCKER fix invariant: after a failed RPC, the per-bundle persona
    // cache must not retain the failed persona. Access the private map
    // via a type cast — white-box because the "second RPC fires" path
    // through public behavior requires an error-recovery transition to
    // another agent state, which `findErrorTarget` refuses to produce
    // while a terminal is reachable.
    const internal = orchestrator as unknown as {
      workflows: Map<string, { currentPersonaByBundle: Map<string, string> }>;
    };
    const instance = internal.workflows.get(workflowId);
    expect(instance).toBeDefined();
    if (!instance || !bundleMinted) throw new Error('unreachable');
    // After the failed RPC, the cache must be empty for this bundle.
    // Pre-fix (cache set BEFORE the RPC) this map would still contain
    // the stale `global` entry and the next cycle would short-circuit.
    expect(instance.currentPersonaByBundle.has(bundleMinted.bundleId)).toBe(false);
  });
});
