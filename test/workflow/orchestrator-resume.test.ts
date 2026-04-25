import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionOptions } from '../../src/session/types.js';
import type { WorkflowId, HumanGateRequest, WorkflowDefinition } from '../../src/workflow/types.js';
import { WorkflowOrchestrator, type WorkflowLifecycleEvent } from '../../src/workflow/orchestrator.js';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';
import {
  MockSession,
  approvedResponse,
  rejectedResponse,
  simulateArtifacts,
  createArtifactAwareSession,
  writeDefinitionFile,
  createCheckpointStore,
  createDeps,
  waitForGate,
  waitForCompletion,
  stubPersonasForTest,
} from './test-helpers.js';

// ---------------------------------------------------------------------------
// Workflow definitions
// ---------------------------------------------------------------------------

const linearWorkflowDef: WorkflowDefinition = {
  name: 'linear-workflow',
  description: 'Full linear workflow',
  initial: 'plan',
  settings: { mode: 'builtin', maxRounds: 4 },
  states: {
    plan: {
      type: 'agent',
      description: 'Creates a plan',
      persona: 'planner',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'plan_gate' }],
    },
    plan_gate: {
      type: 'human_gate',
      description: 'Human review gate',
      acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
      present: ['plan'],
      transitions: [
        { to: 'implement', event: 'APPROVE' },
        { to: 'plan', event: 'FORCE_REVISION' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: ['plan'],
      outputs: ['code'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      description: 'Reviews code',
      persona: 'reviewer',
      prompt: 'You are a reviewer.',
      inputs: ['code'],
      outputs: ['reviews'],
      transitions: [
        { to: 'done', when: { verdict: 'approved' } },
        { to: 'implement', when: { verdict: 'rejected' } },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

const simpleAgentDef: WorkflowDefinition = {
  name: 'simple-agent',
  description: 'Single agent to done',
  initial: 'implement',
  settings: { mode: 'builtin' },
  states: {
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

/**
 * Agent definition where errors go to a human gate instead of terminal.
 * This allows checkpoints to survive agent failures.
 */
const agentWithErrorGateDef: WorkflowDefinition = {
  name: 'agent-with-error-gate',
  description: 'Agent with human gate as error target',
  initial: 'implement',
  settings: { mode: 'builtin' },
  states: {
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'error_gate' }],
    },
    error_gate: {
      type: 'human_gate',
      description: 'Error escalation gate',
      acceptedEvents: ['APPROVE', 'ABORT'],
      transitions: [
        { to: 'done', event: 'APPROVE' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

/**
 * Coder-critic loop where errors go to a human gate.
 */
const loopWithErrorGateDef: WorkflowDefinition = {
  name: 'loop-with-error-gate',
  description: 'Coder-critic loop with error gate',
  initial: 'implement',
  settings: { mode: 'builtin', maxRounds: 4 },
  states: {
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      freshSession: false,
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      description: 'Reviews code',
      persona: 'reviewer',
      freshSession: false,
      prompt: 'You are a reviewer.',
      inputs: ['code'],
      outputs: ['reviews'],
      transitions: [
        { to: 'done', when: { verdict: 'approved' } },
        { to: 'error_gate', when: { verdict: 'rejected' } },
      ],
    },
    error_gate: {
      type: 'human_gate',
      description: 'Error escalation gate',
      acceptedEvents: ['APPROVE', 'ABORT'],
      transitions: [
        { to: 'implement', event: 'APPROVE' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

// ---------------------------------------------------------------------------
// Test-specific helpers
// ---------------------------------------------------------------------------

async function waitForLifecycleEvent(
  events: WorkflowLifecycleEvent[],
  predicate: (e: WorkflowLifecycleEvent) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!events.some(predicate)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for lifecycle event');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator checkpoint + resume', () => {
  let tmpDir: string;
  let activeOrchestrators: WorkflowOrchestrator[];
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orchestrator-resume-test-'));
    activeOrchestrators = [];
    cleanupPersonas = stubPersonasForTest(
      tmpDir,
      linearWorkflowDef,
      simpleAgentDef,
      agentWithErrorGateDef,
      loopWithErrorGateDef,
    );
  });

  afterEach(async () => {
    for (const o of activeOrchestrators) {
      await o.shutdownAll();
    }
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
    const baseName = resolve(tmpDir).split('/').pop()!;
    const ckptDir = resolve(tmpDir, '..', `${baseName}-ckpt`);
    rmSync(ckptDir, { recursive: true, force: true });
  });

  function trackOrchestrator(o: WorkflowOrchestrator): WorkflowOrchestrator {
    activeOrchestrators.push(o);
    return o;
  }

  // -----------------------------------------------------------------------
  // Test 1: Checkpoint is saved on every state transition
  // -----------------------------------------------------------------------

  it('saves a checkpoint on every state transition', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;
      if (persona === 'planner') {
        return createArtifactAwareSession([{ text: approvedResponse('plan complete'), artifacts: ['plan'] }], tmpDir);
      }
      if (persona === 'coder') {
        return createArtifactAwareSession([{ text: approvedResponse('code done'), artifacts: ['code'] }], tmpDir);
      }
      if (persona === 'reviewer') {
        return createArtifactAwareSession([{ text: approvedResponse('looks good'), artifacts: ['reviews'] }], tmpDir);
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'build API');

    // After plan completes, machine enters plan_gate => checkpoint saved
    await waitForGate(raiseGate, 1);

    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.machineState).toBe('plan_gate');
    expect(checkpoint!.definitionPath).toBe(defPath);
    expect(checkpoint!.transitionHistory.length).toBeGreaterThan(0);

    // Approve gate -> implement -> review -> done
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator, workflowId);

    // Checkpoints were saved during execution for intermediate states; the
    // final retained checkpoint (tested separately in test 2) carries
    // `finalStatus`.
    expect(checkpoint!.context.taskDescription).toBe('build API');
  });

  // -----------------------------------------------------------------------
  // Test 2: Checkpoint is retained with finalStatus on successful completion
  // -----------------------------------------------------------------------

  it('retains checkpoint with finalStatus.phase === "completed" on successful completion', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['code'] }], tmpDir);
    });

    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

    // B3b: The checkpoint is retained on disk with `finalStatus` populated
    // so the past-runs UI can surface the canonical phase and `listResumable`
    // can exclude completed runs via `isCheckpointResumable`.
    const surviving = checkpointStore.load(workflowId);
    expect(surviving).toBeDefined();
    expect(surviving?.finalStatus?.phase).toBe('completed');
    if (surviving?.finalStatus?.phase === 'completed') {
      expect(surviving.finalStatus.result.finalArtifacts).toBeDefined();
    }
  });

  // -----------------------------------------------------------------------
  // Test 2a: finalStatus persistence — completed with expected artifacts
  // -----------------------------------------------------------------------

  it('persists finalStatus.result.finalArtifacts on completion', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['code'] }], tmpDir);
    });

    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    const surviving = checkpointStore.load(workflowId);
    expect(surviving).toBeDefined();
    expect(surviving?.finalStatus).toBeDefined();
    expect(surviving?.finalStatus?.phase).toBe('completed');
    if (surviving?.finalStatus?.phase === 'completed') {
      // The `code` artifact produced by the agent should appear in the
      // persisted final artifacts map.
      expect(surviving.finalStatus.result.finalArtifacts).toHaveProperty('code');
    }
  });

  // -----------------------------------------------------------------------
  // Test 2c: finalStatus persistence — aborted via ABORT event
  // -----------------------------------------------------------------------

  it('persists finalStatus.phase === "aborted" with a reason on ABORT-event terminal', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir);
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'build a thing');

    await waitForGate(raiseGate, 1);
    orchestrator.resolveGate(workflowId, { type: 'ABORT' });
    await waitForCompletion(orchestrator, workflowId);

    const surviving = checkpointStore.load(workflowId);
    expect(surviving).toBeDefined();
    expect(surviving?.finalStatus?.phase).toBe('aborted');
    if (surviving?.finalStatus?.phase === 'aborted') {
      expect(surviving.finalStatus.reason).toBeTruthy();
      expect(typeof surviving.finalStatus.reason).toBe('string');
    }
  });

  // -----------------------------------------------------------------------
  // Test 2b: Aborted workflows keep their checkpoint so resume can restart them
  // -----------------------------------------------------------------------

  it('preserves checkpoint on user-invoked abort so resume can restart it', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir);
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'build a thing');

    // Wait for plan_gate so a checkpoint is persisted.
    await waitForGate(raiseGate, 1);
    expect(checkpointStore.load(workflowId)).toBeDefined();

    // User-invoked abort: should leave the checkpoint on disk.
    await orchestrator.abort(workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');
    const surviving = checkpointStore.load(workflowId);
    expect(surviving).toBeDefined();
    expect(surviving!.machineState).toBe('plan_gate');
  });

  it('preserves checkpoint when workflow reaches aborted state via ABORT event', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir);
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'build a thing');

    // Wait for plan_gate so a checkpoint is persisted.
    await waitForGate(raiseGate, 1);
    expect(checkpointStore.load(workflowId)).toBeDefined();

    // Resolve the gate with ABORT, which drives the machine into the
    // `aborted` terminal state via handleWorkflowComplete.
    orchestrator.resolveGate(workflowId, { type: 'ABORT' });
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');
    // Post-B3b: `handleWorkflowComplete` writes a final checkpoint with
    // `finalStatus` populated for all terminal phases. The surviving
    // checkpoint therefore carries the terminal machineState plus a
    // canonical `finalStatus.phase === 'aborted'` so the past-runs UI
    // and `listResumable` predicate don't have to heuristically scrape
    // state names.
    const surviving = checkpointStore.load(workflowId);
    expect(surviving).toBeDefined();
    expect(surviving?.finalStatus?.phase).toBe('aborted');
  });

  // -----------------------------------------------------------------------
  // Regression: aborted-state checkpoint must keep the LAST non-terminal
  // machineState so resume() can re-enter a meaningful state.
  // -----------------------------------------------------------------------

  it('keeps last non-terminal machineState on disk when terminating via ABORT', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir);
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'build a thing');

    // Wait for plan_gate so a non-terminal checkpoint is persisted.
    await waitForGate(raiseGate, 1);
    const preAbort = checkpointStore.load(workflowId);
    expect(preAbort?.machineState).toBe('plan_gate');

    // Drive into the `aborted` terminal via ABORT.
    orchestrator.resolveGate(workflowId, { type: 'ABORT' });
    await waitForCompletion(orchestrator, workflowId);

    const surviving = checkpointStore.load(workflowId);
    expect(surviving).toBeDefined();
    expect(surviving?.finalStatus?.phase).toBe('aborted');
    // The on-disk machineState must still be the last non-terminal state.
    // Persisting the terminal `aborted` snapshot would cause `resume()` to
    // re-enter the terminal and immediately re-complete.
    expect(surviving?.machineState).toBe('plan_gate');
  });

  // -----------------------------------------------------------------------
  // Test 3: Resume a failed workflow from checkpoint
  // -----------------------------------------------------------------------

  it('resumes a failed workflow from checkpoint', async () => {
    // agentWithErrorGateDef routes errors to error_gate (human gate),
    // so the checkpoint survives instead of being removed on terminal.
    const defPath = writeDefinitionFile(tmpDir, agentWithErrorGateDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    // First orchestrator: session that fails on sendMessage
    const failingFactory = vi.fn(async () => {
      return new MockSession({
        responses: () => {
          throw new Error('Session crashed');
        },
      });
    });

    const raiseGate1 = vi.fn();
    const deps1 = createDeps(tmpDir, {
      createSession: failingFactory,
      raiseGate: raiseGate1,
      checkpointStore,
    });

    const orchestrator1 = trackOrchestrator(new WorkflowOrchestrator(deps1));
    const workflowId = await orchestrator1.start(defPath, 'write code');

    // The agent fails, machine transitions to error_gate (human gate)
    await waitForGate(raiseGate1, 1);

    // Checkpoint should exist at error_gate
    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.machineState).toBe('error_gate');

    // Simulate an orchestrator crash by shutting down. Clean abort now
    // preserves the checkpoint, but we still re-save the snapshot to be
    // explicit about the state under test (a real crash where the process
    // died without even running the abort path).
    const savedCheckpoint = { ...checkpoint! };
    await orchestrator1.shutdownAll();

    checkpointStore.save(workflowId, savedCheckpoint);

    // Resume with a new orchestrator that has working sessions
    const fixedFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('code written'), artifacts: ['code'] }], tmpDir);
    });

    const raiseGate2 = vi.fn();
    const deps2 = createDeps(tmpDir, {
      createSession: fixedFactory,
      raiseGate: raiseGate2,
      checkpointStore,
    });

    const orchestrator2 = trackOrchestrator(new WorkflowOrchestrator(deps2));
    await orchestrator2.resume(workflowId);

    // The gate should be re-raised at error_gate
    await waitForGate(raiseGate2, 1);

    // Approve the gate to retry (APPROVE goes to 'done' in this definition)
    orchestrator2.resolveGate(workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator2, workflowId);
    expect(orchestrator2.getStatus(workflowId)?.phase).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // Test 4: Resume preserves context (round count, review history)
  // -----------------------------------------------------------------------

  it('resume preserves context including round count and review history', async () => {
    // loopWithErrorGateDef: implement -> review(reject -> error_gate) -> ...
    // The review rejection goes to error_gate (human gate), preserving the checkpoint.
    const defPath = writeDefinitionFile(tmpDir, loopWithErrorGateDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    let coderCallCount = 0;
    let reviewerCallCount = 0;

    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;

      if (persona === 'coder') {
        coderCallCount++;
        return createArtifactAwareSession(
          [{ text: approvedResponse(`coder pass ${coderCallCount}`), artifacts: ['code'] }],
          tmpDir,
          `coder-session-${coderCallCount}`,
        );
      }
      if (persona === 'reviewer') {
        reviewerCallCount++;
        // Reject: goes to error_gate in this definition
        return createArtifactAwareSession(
          [{ text: rejectedResponse(`issue ${reviewerCallCount}`), artifacts: ['reviews'] }],
          tmpDir,
        );
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const raiseGate1 = vi.fn();
    const deps1 = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate: raiseGate1,
      checkpointStore,
    });

    const orchestrator1 = trackOrchestrator(new WorkflowOrchestrator(deps1));
    const workflowId = await orchestrator1.start(defPath, 'implement feature');

    // Flow: implement -> review(reject) -> error_gate
    await waitForGate(raiseGate1, 1);

    // Approve gate to continue: error_gate APPROVE -> implement
    orchestrator1.resolveGate(workflowId, { type: 'APPROVE' });

    // Flow continues: implement -> review(reject) -> error_gate again
    await waitForGate(raiseGate1, 2);

    // Checkpoint should reflect accumulated context: round >= 2, review history populated
    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.machineState).toBe('error_gate');
    // 4 agent completions: coder1 + reviewer1 + coder2 + reviewer2
    expect(checkpoint!.context.round).toBeGreaterThanOrEqual(4);
    expect(checkpoint!.context.reviewHistory.length).toBeGreaterThanOrEqual(1);
    expect(checkpoint!.context.reviewHistory).toContain('issue 1');

    // Save checkpoint state and simulate crash
    const savedCheckpoint = { ...checkpoint! };
    await orchestrator1.shutdownAll();
    checkpointStore.save(workflowId, savedCheckpoint);

    // Resume with fixed sessions that approve
    const fixedFactory = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;
      if (persona === 'coder') {
        return createArtifactAwareSession([{ text: approvedResponse('fixed code'), artifacts: ['code'] }], tmpDir);
      }
      if (persona === 'reviewer') {
        return createArtifactAwareSession([{ text: approvedResponse('approved'), artifacts: ['reviews'] }], tmpDir);
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const raiseGate2 = vi.fn();
    const deps2 = createDeps(tmpDir, {
      createSession: fixedFactory,
      raiseGate: raiseGate2,
      checkpointStore,
    });

    const orchestrator2 = trackOrchestrator(new WorkflowOrchestrator(deps2));
    await orchestrator2.resume(workflowId);

    // Gate is re-raised at error_gate
    await waitForGate(raiseGate2, 1);

    // Approve -> implement -> review(approve) -> done
    orchestrator2.resolveGate(workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator2, workflowId);

    expect(orchestrator2.getStatus(workflowId)?.phase).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // Test 5: Resume with human gate
  // -----------------------------------------------------------------------

  it('resume re-raises human gate', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const raiseGate1 = vi.fn();
    const sessionFactory1 = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir);
    });

    const deps1 = createDeps(tmpDir, {
      createSession: sessionFactory1,
      raiseGate: raiseGate1,
      checkpointStore,
    });

    const orchestrator1 = trackOrchestrator(new WorkflowOrchestrator(deps1));
    const workflowId = await orchestrator1.start(defPath, 'build an API');

    // Wait for plan_gate
    await waitForGate(raiseGate1, 1);

    // Simulate orchestrator crash by stopping it without resolving the gate
    await orchestrator1.shutdownAll();

    // Checkpoint should exist at plan_gate
    // (abort removes checkpoint, but the plan_gate checkpoint was saved before abort)
    // We need to save a checkpoint manually since abort removes it.
    // Actually, let's re-think: abort removes the checkpoint. So we need
    // to test this differently - stop the actor without calling abort.

    // Alternative approach: Save the checkpoint before abort cleans it up.
    // Actually, let's just directly save a checkpoint that simulates being at plan_gate.
    const planGateCheckpoint = checkpointStore.load(workflowId);
    // The checkpoint was removed by shutdownAll -> abort. We need a different approach.
    // Let's re-save it to simulate the crash scenario.
    if (!planGateCheckpoint) {
      // Re-create a checkpoint that represents being at plan_gate
      checkpointStore.save(workflowId, {
        machineState: 'plan_gate',
        context: {
          taskDescription: 'build an API',
          artifacts: {},
          round: 1,
          maxRounds: 4,
          previousOutputHashes: {},
          previousTestCount: null,
          humanPrompt: null,
          reviewHistory: [],
          parallelResults: {},
          worktreeBranches: [],
          totalTokens: 0,
          lastError: null,
          agentConversationsByState: {},
          previousAgentOutput: null,
          previousAgentNotes: null,
          previousStateName: null,
          visitCounts: {},
        },
        timestamp: new Date().toISOString(),
        transitionHistory: [],
        definitionPath: defPath,
        workspacePath: resolve(tmpDir, workflowId, 'workspace'),
      });
    }

    // Resume with new orchestrator
    const raiseGate2 = vi.fn();
    const sessionFactory2 = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;
      if (persona === 'coder') {
        return createArtifactAwareSession([{ text: approvedResponse('code done'), artifacts: ['code'] }], tmpDir);
      }
      if (persona === 'reviewer') {
        return createArtifactAwareSession([{ text: approvedResponse('approved'), artifacts: ['reviews'] }], tmpDir);
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const deps2 = createDeps(tmpDir, {
      createSession: sessionFactory2,
      raiseGate: raiseGate2,
      checkpointStore,
    });

    const orchestrator2 = trackOrchestrator(new WorkflowOrchestrator(deps2));
    await orchestrator2.resume(workflowId);

    // The gate should be re-raised
    await waitForGate(raiseGate2, 1);
    const gateRequests = raiseGate2.mock.calls.map((c: unknown[]) => c[0] as HumanGateRequest);
    expect(gateRequests[0].stateName).toBe('plan_gate');

    // Approve the gate
    orchestrator2.resolveGate(workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator2, workflowId);
    expect(orchestrator2.getStatus(workflowId)?.phase).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // Test 6: listResumable returns failed workflow IDs
  // -----------------------------------------------------------------------

  it('listResumable returns only failed workflow IDs, not completed ones', async () => {
    // listResumable now enumerates baseDir via discoverWorkflowRuns and
    // checks for checkpoint.json in each workflow directory. Align the
    // checkpoint-store baseDir with the orchestrator baseDir so checkpoints
    // land where the enumeration looks (this matches production, where the
    // two always coincide).
    const checkpointStore = new FileCheckpointStore(tmpDir);

    // Start and complete a workflow
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const completedFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['code'] }], tmpDir);
    });

    const deps1 = createDeps(tmpDir, {
      createSession: completedFactory,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps1));
    const completedId = await orchestrator.start(defPath, 'completed task');
    await waitForCompletion(orchestrator, completedId);

    // Start and fail a workflow
    const failingFactory = vi.fn(async () => {
      return new MockSession({
        responses: () => {
          throw new Error('crash');
        },
      });
    });

    // Need a separate orchestrator to avoid findWorkflowDir confusion
    const deps2 = createDeps(tmpDir, {
      createSession: failingFactory,
      checkpointStore,
    });

    const orchestrator2 = trackOrchestrator(new WorkflowOrchestrator(deps2));
    const events: WorkflowLifecycleEvent[] = [];
    orchestrator2.onEvent((e) => events.push(e));

    const failedId = await orchestrator2.start(defPath, 'failing task');
    await waitForLifecycleEvent(events, (e) => e.kind === 'failed');
    // Wait for completion (machine reaches done via onError)
    await waitForCompletion(orchestrator2, failedId);

    // The completed workflow's checkpoint was removed. The failed one
    // may or may not still have a checkpoint depending on whether it
    // reached a terminal state. For simpleAgentDef, onError goes to 'done'
    // which is terminal, so checkpoint is removed. Let's manually create
    // a checkpoint to represent a truly failed (non-terminal) workflow.
    checkpointStore.save(failedId, {
      machineState: 'implement',
      context: {
        taskDescription: 'failing task',
        artifacts: {},
        round: 0,
        maxRounds: 4,
        previousOutputHashes: {},
        previousTestCount: null,
        humanPrompt: null,
        reviewHistory: [],
        parallelResults: {},
        worktreeBranches: [],
        totalTokens: 0,
        lastError: 'crash',
        agentConversationsByState: {},
        previousAgentOutput: null,
        previousAgentNotes: null,
        previousStateName: null,
        visitCounts: {},
      },
      timestamp: new Date().toISOString(),
      transitionHistory: [],
      definitionPath: defPath,
      workspacePath: resolve(tmpDir, failedId, 'workspace'),
    });

    // listResumable should return only the failed one (not currently active)
    const resumable = orchestrator.listResumable();
    expect(resumable).toContain(failedId);
    expect(resumable).not.toContain(completedId);
  });

  it('listResumable skips corrupt checkpoints instead of throwing', async () => {
    // Place a valid + a corrupt checkpoint side by side. A single corrupt
    // file must not break enumeration of all other resumable runs.
    const checkpointStore = new FileCheckpointStore(tmpDir);

    const validId = 'valid-run' as WorkflowId;
    const corruptId = 'corrupt-run' as WorkflowId;

    checkpointStore.save(validId, {
      machineState: 'implement',
      context: {
        taskDescription: 'still resumable',
        artifacts: {},
        round: 0,
        maxRounds: 4,
        previousOutputHashes: {},
        previousTestCount: null,
        humanPrompt: null,
        reviewHistory: [],
        parallelResults: {},
        worktreeBranches: [],
        totalTokens: 0,
        lastError: null,
        agentConversationsByState: {},
        previousAgentOutput: null,
        previousAgentNotes: null,
        previousStateName: null,
        visitCounts: {},
      },
      timestamp: new Date().toISOString(),
      transitionHistory: [],
      definitionPath: writeDefinitionFile(tmpDir, simpleAgentDef),
      workspacePath: resolve(tmpDir, validId, 'workspace'),
    });

    // Write raw bytes that won't parse as JSON.
    const corruptDir = resolve(tmpDir, corruptId);
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(resolve(corruptDir, 'checkpoint.json'), 'not json');

    const deps = createDeps(tmpDir, { checkpointStore });
    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));

    const resumable = orchestrator.listResumable();
    expect(resumable).toContain(validId);
    expect(resumable).not.toContain(corruptId);
  });

  // -----------------------------------------------------------------------
  // Test 7: Resume non-existent workflow throws
  // -----------------------------------------------------------------------

  it('resume throws for non-existent workflow', async () => {
    const checkpointStore = createCheckpointStore(tmpDir);
    const deps = createDeps(tmpDir, { checkpointStore });
    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));

    await expect(orchestrator.resume('nonexistent' as WorkflowId)).rejects.toThrow(
      'No checkpoint found for workflow nonexistent',
    );
  });

  // -----------------------------------------------------------------------
  // Test 8: Resume from an agent invoke state re-triggers the service
  // -----------------------------------------------------------------------

  it('resume from agent invoke state re-triggers the service instead of hanging', async () => {
    // Use linearWorkflowDef: plan -> plan_gate -> implement -> review -> done
    // Simulate a checkpoint at the "review" state (an agent invoke state).
    // Before the fix, XState would restore to "review" but never start the
    // agentService invoke, causing the workflow to hang indefinitely.
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    // Create artifact directory structure that would exist at this point
    const fakeWorkflowId = 'resume-invoke-test' as WorkflowId;
    const workspacePath = resolve(tmpDir, fakeWorkflowId, 'workspace');
    const artifactDir = resolve(workspacePath, '.workflow');
    mkdirSync(artifactDir, { recursive: true });
    // Also write definition.json for resume
    mkdirSync(resolve(tmpDir, fakeWorkflowId), { recursive: true });
    writeFileSync(resolve(tmpDir, fakeWorkflowId, 'definition.json'), JSON.stringify(linearWorkflowDef));
    simulateArtifacts(resolve(tmpDir, fakeWorkflowId), ['plan', 'code']);

    // Save a checkpoint at the "review" agent state
    checkpointStore.save(fakeWorkflowId, {
      machineState: 'review',
      context: {
        taskDescription: 'build an API',
        artifacts: {
          plan: resolve(artifactDir, 'plan'),
          code: resolve(artifactDir, 'code'),
        },
        round: 2,
        maxRounds: 4,
        previousOutputHashes: {},
        previousTestCount: null,
        humanPrompt: null,
        reviewHistory: [],
        parallelResults: {},
        worktreeBranches: [],
        totalTokens: 0,
        lastError: null,
        agentConversationsByState: {},
        previousAgentOutput: null,
        previousAgentNotes: null,
        previousStateName: null,
        visitCounts: {},
      },
      timestamp: new Date().toISOString(),
      transitionHistory: [
        { from: 'plan', to: 'plan_gate', event: 'transition', timestamp: new Date().toISOString(), duration_ms: 100 },
        {
          from: 'plan_gate',
          to: 'implement',
          event: 'transition',
          timestamp: new Date().toISOString(),
          duration_ms: 50,
        },
        {
          from: 'implement',
          to: 'review',
          event: 'transition',
          timestamp: new Date().toISOString(),
          duration_ms: 200,
        },
      ],
      definitionPath: defPath,
      workspacePath,
    });

    // The reviewer approves, so the workflow should proceed to "done"
    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      expect(opts.persona).toBe('reviewer');
      return createArtifactAwareSession(
        [{ text: approvedResponse('code looks great'), artifacts: ['reviews'] }],
        tmpDir,
        'reviewer-session-resumed',
      );
    });

    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const events: WorkflowLifecycleEvent[] = [];
    orchestrator.onEvent((e) => events.push(e));

    await orchestrator.resume(fakeWorkflowId);

    // The workflow should complete (not hang)
    await waitForCompletion(orchestrator, fakeWorkflowId, 5000);

    expect(orchestrator.getStatus(fakeWorkflowId)?.phase).toBe('completed');
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(sessionFactory.mock.calls[0][0].persona).toBe('reviewer');
  });

  // -----------------------------------------------------------------------
  // Test 9: Resume from agent invoke state handles service failure
  // -----------------------------------------------------------------------

  it('resume from agent invoke state handles service failure gracefully', async () => {
    // Use agentWithErrorGateDef: implement -> (error) -> error_gate
    // Checkpoint at "implement" (invoke state), service fails on resume.
    const defPath = writeDefinitionFile(tmpDir, agentWithErrorGateDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const fakeWorkflowId = 'resume-invoke-error-test' as WorkflowId;
    const workspacePath = resolve(tmpDir, fakeWorkflowId, 'workspace');
    const artifactDir = resolve(workspacePath, '.workflow');
    mkdirSync(artifactDir, { recursive: true });
    // Write definition.json for resume
    mkdirSync(resolve(tmpDir, fakeWorkflowId), { recursive: true });
    writeFileSync(resolve(tmpDir, fakeWorkflowId, 'definition.json'), JSON.stringify(agentWithErrorGateDef));

    checkpointStore.save(fakeWorkflowId, {
      machineState: 'implement',
      context: {
        taskDescription: 'write code',
        artifacts: {},
        round: 0,
        maxRounds: 4,
        previousOutputHashes: {},
        previousTestCount: null,
        humanPrompt: null,
        reviewHistory: [],
        parallelResults: {},
        worktreeBranches: [],
        totalTokens: 0,
        lastError: null,
        agentConversationsByState: {},
        previousAgentOutput: null,
        previousAgentNotes: null,
        previousStateName: null,
        visitCounts: {},
      },
      timestamp: new Date().toISOString(),
      transitionHistory: [],
      definitionPath: defPath,
      workspacePath,
    });

    // Session factory that fails
    const sessionFactory = vi.fn(async () => {
      return new MockSession({
        responses: () => {
          throw new Error('Network timeout on resume');
        },
      });
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    await orchestrator.resume(fakeWorkflowId);

    // The error should transition the machine to error_gate (human gate)
    await waitForGate(raiseGate, 1);

    const gateRequest = raiseGate.mock.calls[0][0] as HumanGateRequest;
    expect(gateRequest.stateName).toBe('error_gate');
  });

  // -----------------------------------------------------------------------
  // Test 10: Session IDs survive checkpoint and resume
  // -----------------------------------------------------------------------

  it('session IDs survive checkpoint and resume', async () => {
    // loopWithErrorGateDef: implement -> review(reject -> error_gate) -> ...
    // Run coder round 1 -> reviewer rejects -> error_gate (checkpoint).
    // Resume from checkpoint. Approve gate -> coder round 2 should get
    // the original coder session ID via resumeSessionId.
    const defPath = writeDefinitionFile(tmpDir, loopWithErrorGateDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    let coderCallCount = 0;

    const sessionFactory1 = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;

      if (persona === 'coder') {
        coderCallCount++;
        return createArtifactAwareSession(
          [{ text: approvedResponse(`coder pass ${coderCallCount}`), artifacts: ['code'] }],
          tmpDir,
          `coder-session-${coderCallCount}`,
        );
      }
      if (persona === 'reviewer') {
        return createArtifactAwareSession([{ text: rejectedResponse('needs fixing'), artifacts: ['reviews'] }], tmpDir);
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const raiseGate1 = vi.fn();
    const deps1 = createDeps(tmpDir, {
      createSession: sessionFactory1,
      raiseGate: raiseGate1,
      checkpointStore,
    });

    const orchestrator1 = trackOrchestrator(new WorkflowOrchestrator(deps1));
    const workflowId = await orchestrator1.start(defPath, 'implement feature');

    // Flow: implement(coder) -> review(reject) -> error_gate
    await waitForGate(raiseGate1, 1);

    // Verify checkpoint captured the coder's agentConversationId so a
    // post-resume coder invocation can reuse it.
    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.machineState).toBe('error_gate');
    const coderConversationId = checkpoint!.context.agentConversationsByState['implement'];
    expect(coderConversationId).toBeDefined();
    // Confirm the orchestrator passed the same id on the first coder turn.
    const coderCall1 = sessionFactory1.mock.calls.find((c) => c[0].persona === 'coder');
    expect(coderCall1).toBeDefined();
    expect(coderCall1![0].agentConversationId).toBe(coderConversationId);

    // Simulate crash: save checkpoint, shutdown (which removes it), re-save
    const savedCheckpoint = { ...checkpoint! };
    await orchestrator1.shutdownAll();
    checkpointStore.save(workflowId, savedCheckpoint);

    // Resume with a new orchestrator
    const sessionFactory2 = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;

      if (persona === 'coder') {
        return createArtifactAwareSession(
          [{ text: approvedResponse('fixed code'), artifacts: ['code'] }],
          tmpDir,
          'coder-session-resumed',
        );
      }
      if (persona === 'reviewer') {
        return createArtifactAwareSession([{ text: approvedResponse('approved'), artifacts: ['reviews'] }], tmpDir);
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const raiseGate2 = vi.fn();
    const deps2 = createDeps(tmpDir, {
      createSession: sessionFactory2,
      raiseGate: raiseGate2,
      checkpointStore,
    });

    const orchestrator2 = trackOrchestrator(new WorkflowOrchestrator(deps2));
    await orchestrator2.resume(workflowId);

    // Gate is re-raised at error_gate
    await waitForGate(raiseGate2, 1);

    // Approve gate -> implement(coder round 2) -> review(approve) -> done
    orchestrator2.resolveGate(workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator2, workflowId);

    expect(orchestrator2.getStatus(workflowId)?.phase).toBe('completed');

    // The resumed coder session should have received the original coder
    // agentConversationId captured in the pre-resume checkpoint.
    expect(sessionFactory2).toHaveBeenCalled();
    const coderCall = sessionFactory2.mock.calls.find((c) => c[0].persona === 'coder');
    expect(coderCall).toBeDefined();
    expect(coderCall![0].agentConversationId).toBe(coderConversationId);
  });
});
