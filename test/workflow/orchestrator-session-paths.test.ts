/**
 * Tests that the orchestrator routes per-state session artifacts under
 * the workflow-run directory (not under `~/.ironcurtain/sessions/`) in
 * borrow (shared-container) mode.
 *
 * Mocks `createSession` through deps to capture the options passed for
 * each state invocation and asserts:
 *   - `workflow.stateDir` paths follow `.../states/{stateId}.{visitCount}/`
 *   - `workflow.stateSlug` is `${stateId}.${visitCount}`
 *   - Re-entering a state produces `{stateId}.2` etc.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BundleId, SessionOptions } from '../../src/session/types.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import { getInvocationDir, getSessionsDir } from '../../src/config/paths.js';
import {
  MockSession,
  approvedResponse,
  rejectedResponse,
  simulateArtifacts,
  findWorkflowDir,
  createArtifactAwareSession,
  writeDefinitionFile,
  createDeps,
  waitForCompletion,
  stubPersonasForTest,
} from './test-helpers.js';

/** Stub DockerInfrastructure: orchestrator tracks identity and reads
 *  `bundleId` to key per-bundle paths (audit log, control socket,
 *  invocation dirs). Under Step 6's lazy-mint model, the orchestrator
 *  mints a fresh `BundleId` per scope via `createBundleId()` and passes
 *  it into the factory as `input.bundleId`; the stub echoes that value
 *  back so path assertions can reconstruct the expected paths.
 */
function makeStubInfrastructure(workflowId: string, bundleId: BundleId): DockerInfrastructure {
  return {
    __stub: true,
    workflowId,
    bundleId,
    setTokenSessionId: () => {},
  } as unknown as DockerInfrastructure;
}

const twoStateDef: WorkflowDefinition = {
  name: 'two-state',
  description: 'Fetch then summarize',
  initial: 'fetch',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    fetch: {
      type: 'agent',
      description: 'Fetch',
      persona: 'global',
      prompt: 'Fetch data.',
      inputs: [],
      outputs: ['data'],
      transitions: [{ to: 'summarize' }],
    },
    summarize: {
      type: 'agent',
      description: 'Summarize',
      persona: 'global',
      prompt: 'Summarize data.',
      inputs: ['data'],
      outputs: ['summary'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

// Three-state def that loops plan -> code -> review -> plan... so plan
// is entered twice, then approved on the second visit.
const looping: WorkflowDefinition = {
  name: 'plan-loop',
  description: 'Plan-code-review loop',
  initial: 'plan',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    plan: {
      type: 'agent',
      description: 'Plan',
      persona: 'global',
      prompt: 'Plan.',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'code' }],
    },
    code: {
      type: 'agent',
      description: 'Code',
      persona: 'global',
      prompt: 'Code.',
      inputs: ['plan'],
      outputs: ['code'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      description: 'Review',
      persona: 'global',
      prompt: 'Review.',
      inputs: ['code'],
      outputs: ['review'],
      // First review rejects (sends us back to plan); second approves.
      transitions: [
        { to: 'plan', when: { verdict: 'rejected' } },
        { to: 'done', when: { verdict: 'approved' } },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

describe('WorkflowOrchestrator per-state session paths (borrow mode)', () => {
  let tmpDir: string;
  let activeOrchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-session-paths-'));
    activeOrchestrator = undefined;
    cleanupPersonas = stubPersonasForTest(tmpDir, twoStateDef, looping);
  });

  afterEach(async () => {
    if (activeOrchestrator) {
      await activeOrchestrator.shutdownAll();
    }
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes each state invocation to states/{stateId}.{visitCount}/', async () => {
    const defPath = writeDefinitionFile(tmpDir, twoStateDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    const destroyInfra = vi.fn(async () => {});

    const capturedOptions: SessionOptions[] = [];
    const sessionFactory = vi.fn((opts: SessionOptions) => {
      capturedOptions.push(opts);
      return Promise.resolve(
        createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['data', 'summary'] }], tmpDir),
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

    expect(capturedOptions).toHaveLength(2);

    // The orchestrator lazy-mints a BundleId on first scope use; read
    // it from the factory call so the path assertions can reconstruct
    // the expected directory.
    const mintedBundleId = createInfra.mock.calls[0][0].bundleId;

    // State 1: fetch, visit 1 -> fetch.1
    expect(capturedOptions[0].workflow?.stateSlug).toBe('fetch.1');
    expect(capturedOptions[0].workflow?.stateDir).toBe(getInvocationDir(workflowId, mintedBundleId, 'fetch.1'));
    expect(existsSync(capturedOptions[0].workflow?.stateDir as string)).toBe(true);

    // State 2: summarize, visit 1 -> summarize.1
    expect(capturedOptions[1].workflow?.stateSlug).toBe('summarize.1');
    expect(capturedOptions[1].workflow?.stateDir).toBe(getInvocationDir(workflowId, mintedBundleId, 'summarize.1'));
    expect(existsSync(capturedOptions[1].workflow?.stateDir as string)).toBe(true);

    // Each invocation carries the same borrowed bundle.
    expect(capturedOptions[0].workflow?.infrastructure).toBe(capturedOptions[1].workflow?.infrastructure);
  });

  it('re-entering a state increments the visitCount portion of the slug', async () => {
    const defPath = writeDefinitionFile(tmpDir, looping);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    const destroyInfra = vi.fn(async () => {});

    // Capture per-state options; simulate artifacts and verdicts per slug.
    const capturedOptions: SessionOptions[] = [];
    const sessionFactory = vi.fn((opts: SessionOptions) => {
      capturedOptions.push(opts);
      const slug = opts.workflow?.stateSlug as string;
      // Per state: stamp the right artifact and pick verdict.
      const artifact = slug.startsWith('plan')
        ? 'plan'
        : slug.startsWith('code')
          ? 'code'
          : slug.startsWith('review')
            ? 'review'
            : '';
      const isFirstReview = slug === 'review.1';
      const responseText = isFirstReview ? rejectedResponse('needs more') : approvedResponse('ok');
      return Promise.resolve(
        new MockSession({
          sessionId: `mock-${slug}`,
          responses: () => {
            if (artifact) simulateArtifacts(findWorkflowDir(tmpDir), [artifact]);
            return responseText;
          },
        }),
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

    // Expected path: plan.1 -> code.1 -> review.1 (reject) ->
    //                plan.2 -> code.2 -> review.2 (approve) -> done
    const slugs = capturedOptions.map((o) => o.workflow?.stateSlug);
    expect(slugs).toEqual(['plan.1', 'code.1', 'review.1', 'plan.2', 'code.2', 'review.2']);

    // Second visit to plan lives under plan.2, not plan.1.
    const mintedBundleId = createInfra.mock.calls[0][0].bundleId;
    const plan2 = capturedOptions[3];
    expect(plan2.workflow?.stateSlug).toBe('plan.2');
    expect(plan2.workflow?.stateDir).toBe(getInvocationDir(workflowId, mintedBundleId, 'plan.2'));
  });

  it('non-shared-container workflows do NOT receive workflow.stateDir', async () => {
    // Per-state-container (opted-out of sharedContainer) workflows
    // construct their own infra per session — there is no borrow-mode
    // handshake to scope per-state dirs against.
    const optedOutDef: WorkflowDefinition = {
      ...twoStateDef,
      name: 'opted-out',
      settings: { mode: 'docker', dockerAgent: 'claude-code' /* no sharedContainer */ },
    };
    const cleanup2 = stubPersonasForTest(tmpDir, optedOutDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, optedOutDef);

      const capturedOptions: SessionOptions[] = [];
      const sessionFactory = vi.fn((opts: SessionOptions) => {
        capturedOptions.push(opts);
        return Promise.resolve(
          createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['data', 'summary'] }], tmpDir),
        );
      });

      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createSession: sessionFactory }));
      activeOrchestrator = orchestrator;

      const workflowId = await orchestrator.start(defPath, 'task');
      await waitForCompletion(orchestrator, workflowId);

      for (const opts of capturedOptions) {
        expect(opts.workflow?.stateDir).toBeUndefined();
        expect(opts.workflow?.stateSlug).toBeUndefined();
        expect(opts.workflow?.infrastructure).toBeUndefined();
      }
    } finally {
      cleanup2();
    }
  });

  it('leaves ~/.ironcurtain/sessions/ untouched when shared-container routes all artifacts to the workflow run', async () => {
    // This is an integration-lite check: we swap IRONCURTAIN_HOME to a
    // private dir for the orchestrator+factory path, then verify no
    // sessions/ entry is created through the workflow start. Because
    // createSession is mocked here, the only thing that could write to
    // sessions/ would be orchestrator-side code, so this primarily
    // guards against regressions in the loadDefaultInfrastructureFactory
    // bundle-path rewrite.
    const originalHome = process.env.IRONCURTAIN_HOME;
    const testHome = join(tmpDir, 'ironcurtain-home');
    process.env.IRONCURTAIN_HOME = testHome;
    try {
      const defPath = writeDefinitionFile(tmpDir, twoStateDef);
      const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
        makeStubInfrastructure(input.workflowId, input.bundleId),
      );
      const sessionFactory = vi.fn(async () =>
        createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['data', 'summary'] }], tmpDir),
      );

      const orchestrator = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: sessionFactory,
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: async () => {},
        }),
      );
      activeOrchestrator = orchestrator;

      await orchestrator.start(defPath, 'task');
      // Let any async infra setup finish even though session is mocked.
      await new Promise((r) => setTimeout(r, 20));

      const sessionsDir = getSessionsDir();
      const listing = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
      expect(listing).toEqual([]);
    } finally {
      if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = originalHome;
    }
  });
});
