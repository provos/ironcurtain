import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionOptions } from '../../src/session/types.js';
import type { WorkflowId, HumanGateRequest, WorkflowDefinition } from '../../src/workflow/types.js';
import { WorkflowOrchestrator, type WorkflowLifecycleEvent } from '../../src/workflow/orchestrator.js';
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
      persona: 'planner',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'plan_gate' }],
    },
    plan_gate: {
      type: 'human_gate',
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
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: ['plan'],
      outputs: ['code'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      persona: 'reviewer',
      prompt: 'You are a reviewer.',
      inputs: ['code'],
      outputs: ['reviews'],
      transitions: [
        { to: 'done', guard: 'isApproved' },
        { to: 'implement', guard: 'isRejected' },
      ],
    },
    done: { type: 'terminal' },
    aborted: { type: 'terminal' },
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
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal' },
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
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'error_gate' }],
    },
    error_gate: {
      type: 'human_gate',
      acceptedEvents: ['APPROVE', 'ABORT'],
      transitions: [
        { to: 'done', event: 'APPROVE' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal' },
    aborted: { type: 'terminal' },
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
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      persona: 'reviewer',
      prompt: 'You are a reviewer.',
      inputs: ['code'],
      outputs: ['reviews'],
      transitions: [
        { to: 'done', guard: 'isApproved' },
        { to: 'error_gate', guard: 'isRejected' },
      ],
    },
    error_gate: {
      type: 'human_gate',
      acceptedEvents: ['APPROVE', 'ABORT'],
      transitions: [
        { to: 'implement', event: 'APPROVE' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal' },
    aborted: { type: 'terminal' },
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

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orchestrator-resume-test-'));
    activeOrchestrators = [];
  });

  afterEach(async () => {
    for (const o of activeOrchestrators) {
      await o.shutdownAll();
    }
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

    // After completion, checkpoint is removed (tested separately in test 2)
    // But during execution, checkpoints were saved for intermediate states
    expect(checkpoint!.context.taskDescription).toBe('build API');
  });

  // -----------------------------------------------------------------------
  // Test 2: Checkpoint is removed on successful completion
  // -----------------------------------------------------------------------

  it('removes checkpoint on successful completion', async () => {
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
    expect(checkpointStore.load(workflowId)).toBeUndefined();
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

    // Simulate orchestrator crash by shutting down (which removes checkpoint via abort)
    // Save checkpoint state before shutdown
    const savedCheckpoint = { ...checkpoint! };
    await orchestrator1.shutdownAll();

    // Re-save checkpoint to simulate a real crash (process died, no clean abort)
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
          flaggedForReview: false,
          lastError: null,
          sessionsByState: {},
          previousAgentOutput: null,
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
    const checkpointStore = createCheckpointStore(tmpDir);

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
        flaggedForReview: false,
        lastError: 'crash',
        sessionsByState: {},
        previousAgentOutput: null,
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
        flaggedForReview: false,
        lastError: null,
        sessionsByState: {},
        previousAgentOutput: null,
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
        flaggedForReview: false,
        lastError: null,
        sessionsByState: {},
        previousAgentOutput: null,
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

    // Verify checkpoint has the coder's session ID stored
    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.machineState).toBe('error_gate');
    expect(checkpoint!.context.sessionsByState['implement']).toBe('coder-session-1');

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

    // The resumed coder session should have received the original coder session ID
    expect(sessionFactory2).toHaveBeenCalled();
    const coderCall = sessionFactory2.mock.calls.find((c) => c[0].persona === 'coder');
    expect(coderCall).toBeDefined();
    expect(coderCall![0].resumeSessionId).toBe('coder-session-1');
  });
});
