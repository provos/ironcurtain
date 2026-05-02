/**
 * Bifurcated shared-container workflows: two agent states on distinct
 * `containerScope` values get two distinct bundles, each with its own
 * bundleId, control socket, and per-bundle artifact paths. Exercises
 * the Step 6 payoff: scope-keyed lazy mint + bifurcated teardown.
 *
 * Uses in-memory seams (the factory and control-server hooks are
 * stubbed) — no Docker, no real sockets. The test focuses on:
 *   - Scope resolution ("env-a" vs "env-b" passed to the factory)
 *   - Distinct bundleIds per scope (two minted UUIDs)
 *   - Per-bundle control-socket paths
 *   - `ironcurtain.scope=<scope>` threading via the factory's scope
 *     input (the orchestrator's contract; not exercising the docker-run
 *     --label emission, which lives in docker-manager tests)
 *   - Policy cycling targets the right bundle's socket per state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BundleId } from '../../src/session/types.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import { getBundleControlSocketPath } from '../../src/config/paths.js';
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
 * Bundle stub that echoes the orchestrator-minted `bundleId` and
 * records the scope the factory was invoked with. Tests key assertions
 * on bundle identity (distinct per scope) and on the scope string
 * reaching the factory.
 */
function makeStubInfrastructure(
  workflowId: string,
  bundleId: BundleId,
  scope: string,
): DockerInfrastructure & { readonly __scope: string } {
  return {
    __stub: true,
    __scope: scope,
    workflowId,
    bundleId,
    scope,
    setTokenSessionId: () => {},
  } as unknown as DockerInfrastructure & { readonly __scope: string };
}

/**
 * Two-state workflow that splits states across two scopes. Both
 * states use the same persona so the homogeneous-persona rule is
 * irrelevant to the shape under test (we're asserting on the
 * multi-bundle lifecycle, not the persona-per-scope check).
 */
const bifurcatedDef: WorkflowDefinition = {
  name: 'bifurcated',
  description: 'Two states on two distinct container scopes',
  initial: 'work_a',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    work_a: {
      type: 'agent',
      description: 'Work on env-a',
      persona: 'global',
      prompt: 'Work.',
      inputs: [],
      outputs: ['result_a'],
      transitions: [{ to: 'work_b' }],
      containerScope: 'env-a',
    },
    work_b: {
      type: 'agent',
      description: 'Work on env-b',
      persona: 'global',
      prompt: 'Work.',
      inputs: ['result_a'],
      outputs: ['result_b'],
      transitions: [{ to: 'done' }],
      containerScope: 'env-b',
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator bifurcated workflow (containerScope)', () => {
  let tmpDir: string;
  let activeOrchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bifurcated-test-'));
    activeOrchestrator = undefined;
    cleanupPersonas = stubPersonasForTest(tmpDir, bifurcatedDef);
  });

  afterEach(async () => {
    if (activeOrchestrator) {
      await activeOrchestrator.shutdownAll();
    }
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mints one bundle per distinct containerScope, each with its own bundleId', async () => {
    const defPath = writeDefinitionFile(tmpDir, bifurcatedDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId, input.scope),
    );
    const destroyInfra = vi.fn(async () => {});
    const startCtrl = vi.fn(async () => {});
    const loadPolicy = vi.fn(async () => {});

    const responses = [
      { text: approvedResponse('a-done'), artifacts: ['result_a'] },
      { text: approvedResponse('b-done'), artifacts: ['result_b'] },
    ];
    let callIdx = 0;
    const sessionFactory = vi.fn(async () => createArtifactAwareSession([responses[callIdx++]], tmpDir));

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

    // Two scopes → two factory calls → two distinct bundleIds.
    expect(createInfra).toHaveBeenCalledTimes(2);
    const call0 = createInfra.mock.calls[0][0];
    const call1 = createInfra.mock.calls[1][0];
    expect(call0.scope).toBe('env-a');
    expect(call1.scope).toBe('env-b');
    expect(call0.bundleId).not.toBe(call1.bundleId);
    expect(call0.workflowId).toBe(workflowId);
    expect(call1.workflowId).toBe(workflowId);
  });

  it('each bundle has its own control-socket path under ~/.ironcurtain/run/<bundleId>/', async () => {
    const defPath = writeDefinitionFile(tmpDir, bifurcatedDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId, input.scope),
    );
    const startCtrl = vi.fn(async () => {});
    const responses = [
      { text: approvedResponse('a-done'), artifacts: ['result_a'] },
      { text: approvedResponse('b-done'), artifacts: ['result_b'] },
    ];
    let callIdx = 0;
    const sessionFactory = vi.fn(async () => createArtifactAwareSession([responses[callIdx++]], tmpDir));

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: async () => {},
        startWorkflowControlServer: startCtrl,
        loadPolicyRpc: async () => {},
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // Each bundle's control socket lives at
    // `~/.ironcurtain/run/<bundleId[0:12]>/ctrl.sock` — the directory
    // slug is truncated to fit macOS `sun_path`; the full UUID remains
    // authoritative in Docker labels and directory keys. Resolve
    // through the helper from the orchestrator-minted bundleIds.
    const bundleIdA = createInfra.mock.calls[0][0].bundleId;
    const bundleIdB = createInfra.mock.calls[1][0].bundleId;
    const expectedA = getBundleControlSocketPath(bundleIdA);
    const expectedB = getBundleControlSocketPath(bundleIdB);

    expect(createInfra.mock.calls[0][0].controlSocketPath).toBe(expectedA);
    expect(createInfra.mock.calls[1][0].controlSocketPath).toBe(expectedB);
    expect(expectedA).not.toBe(expectedB);

    // startWorkflowControlServer receives the same path per bundle.
    expect(startCtrl.mock.calls[0][0].socketPath).toBe(expectedA);
    expect(startCtrl.mock.calls[1][0].socketPath).toBe(expectedB);
  });

  it('policy cycling targets the scope-resolved bundle socket per state', async () => {
    const defPath = writeDefinitionFile(tmpDir, bifurcatedDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId, input.scope),
    );
    const loadPolicy = vi.fn(async () => {});
    const responses = [
      { text: approvedResponse('a-done'), artifacts: ['result_a'] },
      { text: approvedResponse('b-done'), artifacts: ['result_b'] },
    ];
    let callIdx = 0;
    const sessionFactory = vi.fn(async () => createArtifactAwareSession([responses[callIdx++]], tmpDir));

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

    // Each state's cyclePolicy call hits its own bundle's socket — the
    // cross-bundle routing invariant from §6.7.
    expect(loadPolicy).toHaveBeenCalledTimes(2);
    const bundleIdA = createInfra.mock.calls[0][0].bundleId;
    const bundleIdB = createInfra.mock.calls[1][0].bundleId;
    expect(loadPolicy.mock.calls[0][0].socketPath).toBe(getBundleControlSocketPath(bundleIdA));
    expect(loadPolicy.mock.calls[1][0].socketPath).toBe(getBundleControlSocketPath(bundleIdB));
    expect(loadPolicy.mock.calls[0][0].persona).toBe('global');
    expect(loadPolicy.mock.calls[1][0].persona).toBe('global');
  });

  it('each session borrows its scope-matched bundle', async () => {
    const defPath = writeDefinitionFile(tmpDir, bifurcatedDef);

    const bundlesCreated: Array<DockerInfrastructure & { readonly __scope: string }> = [];
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      const bundle = makeStubInfrastructure(input.workflowId, input.bundleId, input.scope);
      bundlesCreated.push(bundle);
      return bundle;
    });
    const borrowedBundles: Array<DockerInfrastructure | undefined> = [];
    const responses = [
      { text: approvedResponse('a-done'), artifacts: ['result_a'] },
      { text: approvedResponse('b-done'), artifacts: ['result_b'] },
    ];
    let callIdx = 0;
    const sessionFactory = vi.fn(async (opts: import('../../src/session/types.js').SessionOptions) => {
      borrowedBundles.push(opts.workflow?.infrastructure);
      return createArtifactAwareSession([responses[callIdx++]], tmpDir);
    });

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: async () => {},
        startWorkflowControlServer: async () => {},
        loadPolicyRpc: async () => {},
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // State A borrows bundle A, state B borrows bundle B — never each other's.
    expect(borrowedBundles[0]).toBe(bundlesCreated[0]);
    expect(borrowedBundles[1]).toBe(bundlesCreated[1]);
    expect(borrowedBundles[0]).not.toBe(borrowedBundles[1]);
    expect((borrowedBundles[0] as DockerInfrastructure & { __scope: string }).__scope).toBe('env-a');
    expect((borrowedBundles[1] as DockerInfrastructure & { __scope: string }).__scope).toBe('env-b');
  });

  it('tears down every bundle in parallel on workflow terminal', async () => {
    const defPath = writeDefinitionFile(tmpDir, bifurcatedDef);

    const bundlesCreated: DockerInfrastructure[] = [];
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      const bundle = makeStubInfrastructure(input.workflowId, input.bundleId, input.scope);
      bundlesCreated.push(bundle);
      return bundle;
    });
    const destroyInfra = vi.fn(async () => {});

    const responses = [
      { text: approvedResponse('a-done'), artifacts: ['result_a'] },
      { text: approvedResponse('b-done'), artifacts: ['result_b'] },
    ];
    let callIdx = 0;
    const sessionFactory = vi.fn(async () => createArtifactAwareSession([responses[callIdx++]], tmpDir));

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
        startWorkflowControlServer: async () => {},
        loadPolicyRpc: async () => {},
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // destroy fires from handleWorkflowComplete asynchronously.
    await vi.waitFor(() => expect(destroyInfra.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
      interval: 10,
    });

    expect(destroyInfra).toHaveBeenCalledTimes(2);
    const destroyed = destroyInfra.mock.calls.map((c) => c[0]);
    expect(destroyed).toContain(bundlesCreated[0]);
    expect(destroyed).toContain(bundlesCreated[1]);
  });

  it('destroys a mid-mint bundle when abort lands during createWorkflowInfrastructure', async () => {
    // Race scenario: start() enters executeAgentState which calls
    // ensureBundleForScope → awaits createWorkflowInfrastructure(). While
    // the factory promise is suspended, orchestrator.abort() runs,
    // setting instance.aborted = true and snapshotting
    // bundlesByScope BEFORE the just-minted bundle gets published.
    //
    // The orchestrator's invariant: the resuming ensureBundleForScope
    // must observe the abort flag, destroy the orphan inline, and throw
    // — without ever publishing into `bundlesByScope`. Otherwise the
    // leaked entry would either survive teardown (a resource leak) or
    // trip the "Leaked workflow bundle scopes" assertion in
    // destroyWorkflowInfrastructure.
    //
    // We gate the factory on a manual resolver so the test controls
    // when `await factory(...)` in ensureBundleForScope resolves. The
    // factory resolves AFTER abort() completes, forcing the post-await
    // abort check to fire.
    const defPath = writeDefinitionFile(tmpDir, bifurcatedDef);

    let releaseFactory: (value: DockerInfrastructure) => void = () => {};
    const factoryGate = new Promise<DockerInfrastructure>((resolve) => {
      releaseFactory = resolve;
    });
    let factoryInput: CreateWorkflowInfrastructureInput | undefined;
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      factoryInput = input;
      return factoryGate;
    });
    const destroyInfra = vi.fn(async () => {});

    // If the test is working, no session ever runs: abort races the
    // first state's bundle mint.
    const sessionFactory = vi.fn();

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
        startWorkflowControlServer: async () => {},
        loadPolicyRpc: async () => {},
      }),
    );
    activeOrchestrator = orchestrator;

    // Capture any "Leaked workflow bundle scopes" stderr. A post-abort
    // leaked-scope error would surface here; the test fails loudly if we
    // see it.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const workflowId = await orchestrator.start(defPath, 'task');

    // Wait for the factory to be called (state A suspended inside
    // ensureBundleForScope awaiting the gate).
    await vi.waitFor(() => expect(createInfra).toHaveBeenCalledTimes(1), {
      timeout: 2000,
      interval: 10,
    });
    expect(factoryInput).toBeDefined();

    // Abort the workflow. This flips instance.aborted → true; the
    // suspended ensureBundleForScope will see it on resume.
    const abortPromise = orchestrator.abort(workflowId);

    // Release the factory's promise. ensureBundleForScope resumes,
    // observes aborted=true, destroys the just-minted bundle, and throws.
    const mintedBundle = {
      __stub: true,
      __scope: factoryInput?.scope ?? '',
      workflowId,
      bundleId: factoryInput?.bundleId ?? ('fake' as BundleId),
      scope: factoryInput?.scope,
    } as unknown as DockerInfrastructure;
    releaseFactory(mintedBundle);

    await abortPromise;
    await waitForCompletion(orchestrator, workflowId);

    // The mid-mint bundle was destroyed exactly once.
    expect(destroyInfra).toHaveBeenCalledTimes(1);
    expect(destroyInfra).toHaveBeenCalledWith(mintedBundle);
    // Session never started.
    expect(sessionFactory).not.toHaveBeenCalled();
    // The orphan never landed in bundlesByScope: we never saw the
    // leak assertion.
    const leakCalls = stderrSpy.mock.calls.filter((c) => String(c[0]).includes('Leaked workflow bundle scopes'));
    expect(leakCalls).toHaveLength(0);

    stderrSpy.mockRestore();
  });

  it('per-bundle audit log paths are scoped under containers/<bundleId>/', async () => {
    // The per-bundle audit path helper is the orchestrator's contract:
    // each bundle's `audit.jsonl` lives under
    // `workflow-runs/<wfId>/containers/<bundleId>/audit.jsonl`. Reasserts
    // that the orchestrator minted different bundleIds per scope so
    // the audit paths genuinely diverge.
    const defPath = writeDefinitionFile(tmpDir, bifurcatedDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId, input.scope),
    );
    const responses = [
      { text: approvedResponse('a-done'), artifacts: ['result_a'] },
      { text: approvedResponse('b-done'), artifacts: ['result_b'] },
    ];
    let callIdx = 0;
    const sessionFactory = vi.fn(async () => createArtifactAwareSession([responses[callIdx++]], tmpDir));

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: async () => {},
        startWorkflowControlServer: async () => {},
        loadPolicyRpc: async () => {},
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    const { getBundleAuditLogPath } = await import('../../src/config/paths.js');
    const bundleIdA = createInfra.mock.calls[0][0].bundleId;
    const bundleIdB = createInfra.mock.calls[1][0].bundleId;
    const auditA = getBundleAuditLogPath(workflowId, bundleIdA);
    const auditB = getBundleAuditLogPath(workflowId, bundleIdB);
    expect(auditA).not.toBe(auditB);
    expect(auditA).toContain(bundleIdA);
    expect(auditB).toContain(bundleIdB);
  });
});
