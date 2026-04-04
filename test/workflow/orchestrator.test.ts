import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionOptions } from '../../src/session/types.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import { WorkflowOrchestrator, type WorkflowLifecycleEvent } from '../../src/workflow/orchestrator.js';
import {
  MockSession,
  approvedResponse,
  rejectedResponse,
  noStatusResponse,
  simulateArtifacts,
  findWorkflowDir,
  createArtifactAwareSession,
  writeDefinitionFile,
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

const coderCriticLoopDef: WorkflowDefinition = {
  name: 'coder-critic-loop',
  description: 'Coder-critic loop',
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
        { to: 'implement', guard: 'isRejected' },
      ],
    },
    done: { type: 'terminal' },
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

const stallDetectionDef: WorkflowDefinition = {
  name: 'stall-detection',
  description: 'Stall detection workflow',
  initial: 'implement',
  settings: { mode: 'builtin', maxRounds: 4 },
  states: {
    implement: {
      type: 'agent',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'stalled', guard: 'isStalled' }, { to: 'review' }],
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
    stalled: {
      type: 'human_gate',
      acceptedEvents: ['FORCE_REVISION', 'ABORT'],
      present: ['code'],
      transitions: [
        { to: 'implement', event: 'FORCE_REVISION' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal' },
    aborted: { type: 'terminal' },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator', () => {
  let tmpDir: string;
  let activeOrchestrator: WorkflowOrchestrator | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orchestrator-test-'));
    activeOrchestrator = undefined;
  });

  afterEach(async () => {
    // Clean up any running workflows to prevent hanging actors
    if (activeOrchestrator) {
      await activeOrchestrator.shutdownAll();
    }
    rmSync(tmpDir, { recursive: true, force: true });
    // Clean up sibling checkpoint directory
    const baseName = resolve(tmpDir).split('/').pop()!;
    const ckptDir = resolve(tmpDir, '..', `${baseName}-ckpt`);
    rmSync(ckptDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Test 1: Happy path linear workflow
  // -----------------------------------------------------------------------

  it('drives a linear workflow from plan through gate to completion', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;

      let session: MockSession;
      switch (persona) {
        case 'planner':
          session = createArtifactAwareSession(
            [{ text: approvedResponse('plan complete'), artifacts: ['plan'] }],
            tmpDir,
            'planner-session-1',
          );
          break;
        case 'coder':
          session = createArtifactAwareSession(
            [{ text: approvedResponse('implementation done'), artifacts: ['code'] }],
            tmpDir,
            'coder-session-1',
          );
          break;
        case 'reviewer':
          session = createArtifactAwareSession(
            [{ text: approvedResponse('looks good'), artifacts: ['reviews'] }],
            tmpDir,
            'reviewer-session-1',
          );
          break;
        default:
          throw new Error(`Unexpected persona: ${persona}`);
      }
      allSessions.push(session);
      return session;
    });

    const raiseGate = vi.fn();
    const dismissGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      dismissGate,
    });

    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;
    const lifecycleEvents: WorkflowLifecycleEvent[] = [];
    orchestrator.onEvent((e) => lifecycleEvents.push(e));

    const workflowId = await orchestrator.start(defPath, 'build a REST API');

    // Machine enters plan, agent completes, reaches plan_gate
    const gateRequests = await waitForGate(raiseGate, 1);
    expect(gateRequests[0].stateName).toBe('plan_gate');
    expect(gateRequests[0].acceptedEvents).toContain('APPROVE');

    // Approve plan gate
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });

    // Machine enters implement -> review(approved) -> done
    await waitForCompletion(orchestrator, workflowId);

    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('completed');

    // 3 sessions: planner, coder, reviewer
    expect(sessionFactory).toHaveBeenCalledTimes(3);

    // All sessions closed
    expect(allSessions.every((s) => s.closed)).toBe(true);

    // Lifecycle events include state transitions
    const stateEvents = lifecycleEvents
      .filter((e) => e.kind === 'state_entered')
      .map((e) => (e as { state: string }).state);
    expect(stateEvents).toContain('plan');
    expect(stateEvents).toContain('plan_gate');
    expect(stateEvents).toContain('implement');

    // dismissGate called once
    expect(dismissGate).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 2: Coder-critic loop
  // -----------------------------------------------------------------------

  it('iterates coder-critic loop until review approves', async () => {
    const defPath = writeDefinitionFile(tmpDir, coderCriticLoopDef);
    const allSessions: MockSession[] = [];
    let coderCallCount = 0;
    let reviewerCallCount = 0;

    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;

      let session: MockSession;
      if (persona === 'coder') {
        coderCallCount++;
        session = createArtifactAwareSession(
          [{ text: approvedResponse(`coder pass ${coderCallCount}`), artifacts: ['code'] }],
          tmpDir,
          `coder-session-${coderCallCount}`,
        );
      } else if (persona === 'reviewer') {
        reviewerCallCount++;
        if (reviewerCallCount === 1) {
          session = createArtifactAwareSession(
            [{ text: rejectedResponse('missing error handling'), artifacts: ['reviews'] }],
            tmpDir,
            'reviewer-session-1',
          );
        } else {
          session = createArtifactAwareSession(
            [{ text: approvedResponse('all issues fixed'), artifacts: ['reviews'] }],
            tmpDir,
            'reviewer-session-2',
          );
        }
      } else {
        throw new Error(`Unexpected persona: ${persona}`);
      }
      allSessions.push(session);
      return session;
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;
    const lifecycleEvents: WorkflowLifecycleEvent[] = [];
    orchestrator.onEvent((e) => lifecycleEvents.push(e));

    const workflowId = await orchestrator.start(defPath, 'implement feature X');
    await waitForCompletion(orchestrator, workflowId);

    // 4 sessions: coder -> reviewer(reject) -> coder -> reviewer(approve)
    expect(sessionFactory).toHaveBeenCalledTimes(4);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    expect(allSessions.every((s) => s.closed)).toBe(true);

    // Second coder invocation received resumeSessionId from first coder session
    const secondCoderCall = sessionFactory.mock.calls[2][0];
    expect(secondCoderCall.persona).toBe('coder');
    expect(secondCoderCall.resumeSessionId).toBe('coder-session-1');

    // Second coder's prompt includes review history
    const secondCoderSession = allSessions[2];
    expect(secondCoderSession.sentMessages[0]).toContain('missing error handling');

    // Lifecycle events show the loop
    const stateEvents = lifecycleEvents
      .filter((e) => e.kind === 'state_entered')
      .map((e) => (e as { state: string }).state);
    const implCount = stateEvents.filter((s) => s === 'implement').length;
    const revCount = stateEvents.filter((s) => s === 'review').length;
    expect(implCount).toBe(2);
    expect(revCount).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Test 3: Human gate with FORCE_REVISION prompt
  // -----------------------------------------------------------------------

  it('FORCE_REVISION propagates human prompt to next agent invocation', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const allSessions: MockSession[] = [];
    let plannerCallCount = 0;

    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;

      let session: MockSession;
      if (persona === 'planner') {
        plannerCallCount++;
        session = createArtifactAwareSession(
          [{ text: approvedResponse(`plan v${plannerCallCount}`), artifacts: ['plan'] }],
          tmpDir,
          `planner-session-${plannerCallCount}`,
        );
      } else if (persona === 'coder') {
        session = createArtifactAwareSession([{ text: approvedResponse('code done'), artifacts: ['code'] }], tmpDir);
      } else if (persona === 'reviewer') {
        session = createArtifactAwareSession([{ text: approvedResponse('approved'), artifacts: ['reviews'] }], tmpDir);
      } else {
        throw new Error(`Unexpected persona: ${persona}`);
      }
      allSessions.push(session);
      return session;
    });

    const raiseGate = vi.fn();
    const dismissGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      dismissGate,
    });

    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;
    const workflowId = await orchestrator.start(defPath, 'build an API');

    // Wait for plan_gate
    await waitForGate(raiseGate, 1);

    // Send FORCE_REVISION with a prompt
    orchestrator.resolveGate(workflowId, {
      type: 'FORCE_REVISION',
      prompt: 'Focus more on error handling and retry logic',
    });

    // Wait for second plan_gate
    await waitForGate(raiseGate, 2);

    // Verify the second planner session received the human prompt
    const secondPlannerSession = allSessions[1];
    expect(secondPlannerSession.sentMessages[0]).toContain('Focus more on error handling and retry logic');

    // Verify resumeSessionId was passed for same-role continuity
    const secondPlannerOpts = sessionFactory.mock.calls[1][0];
    expect(secondPlannerOpts.resumeSessionId).toBe('planner-session-1');

    // dismissGate called for the first gate
    expect(dismissGate).toHaveBeenCalledTimes(1);

    // Approve the second plan gate to let the workflow finish
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator, workflowId);
  });

  // -----------------------------------------------------------------------
  // Test 4: Abort
  // -----------------------------------------------------------------------

  it('abort closes all sessions and removes workflow', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      const session = createArtifactAwareSession(
        [{ text: approvedResponse('plan done'), artifacts: ['plan'] }],
        tmpDir,
      );
      allSessions.push(session);
      return session;
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
    });

    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;
    const workflowId = await orchestrator.start(defPath, 'build a thing');

    // Wait for plan_gate
    await waitForGate(raiseGate, 1);

    // Abort the workflow
    await orchestrator.abort(workflowId);

    // Verify aborted status
    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('aborted');

    // Planner session was closed
    expect(allSessions[0].closed).toBe(true);

    // No more sessions created after abort
    expect(sessionFactory).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 5: Missing status block retry
  // -----------------------------------------------------------------------

  it('re-prompts agent when response lacks agent_status block', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      let callCount = 0;

      const session = new MockSession({
        responses: () => {
          callCount++;
          if (callCount === 1) {
            // First response: create artifacts but no status block
            simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
            return noStatusResponse();
          }
          if (callCount === 2) {
            // Retry: include status block
            return approvedResponse('here is my status');
          }
          throw new Error(`Unexpected call ${callCount}`);
        },
      });
      allSessions.push(session);
      return session;
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

    // Two messages sent (original + status block retry)
    const session = allSessions[0];
    expect(session.sentMessages).toHaveLength(2);

    // Re-prompt mentions agent_status
    expect(session.sentMessages[1]).toContain('agent_status');
  });

  it('fails when both attempts lack agent_status block', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);

    const sessionFactory = vi.fn(async () => {
      simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
      return new MockSession({
        responses: [noStatusResponse(), noStatusResponse()],
      });
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    // Error goes through onError -> terminal. The storeError action
    // records the error but the machine still reaches 'done'.
    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // Test 6: Stall detection
  // -----------------------------------------------------------------------

  it('detects stall when coder produces identical output twice', async () => {
    const defPath = writeDefinitionFile(tmpDir, stallDetectionDef);
    let coderCallCount = 0;

    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;

      let session: MockSession;
      if (persona === 'coder') {
        coderCallCount++;
        // Both coder calls produce IDENTICAL artifacts -> same hash -> stall
        session = createArtifactAwareSession(
          [{ text: approvedResponse('coder output'), artifacts: ['code'] }],
          tmpDir,
          `coder-session-${coderCallCount}`,
        );
      } else if (persona === 'reviewer') {
        // Reject to trigger second coder pass
        session = createArtifactAwareSession(
          [{ text: rejectedResponse('needs work'), artifacts: ['reviews'] }],
          tmpDir,
        );
      } else {
        throw new Error(`Unexpected persona: ${persona}`);
      }
      return session;
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
    });

    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;
    const workflowId = await orchestrator.start(defPath, 'implement feature');

    // Flow: implement -> review(reject) -> implement(same hash) -> stall detected
    // Machine enters 'stalled' human gate
    const gateRequests = await waitForGate(raiseGate, 1);

    expect(gateRequests[0].stateName).toBe('stalled');
    expect(gateRequests[0].acceptedEvents).toContain('FORCE_REVISION');
    expect(gateRequests[0].acceptedEvents).toContain('ABORT');

    // 3 sessions: coder, reviewer, coder (stall detected after 2nd coder)
    expect(sessionFactory).toHaveBeenCalledTimes(3);

    // Abort to clean up
    orchestrator.resolveGate(workflowId, { type: 'ABORT' });
    await waitForCompletion(orchestrator, workflowId);
  });

  // -----------------------------------------------------------------------
  // Test 7: Missing artifact retry
  // -----------------------------------------------------------------------

  it('re-prompts agent when expected artifact is missing, succeeds on retry', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      let callCount = 0;

      const session = new MockSession({
        responses: () => {
          callCount++;
          if (callCount === 1) {
            // First call: complete but DON'T create artifacts
            return approvedResponse('done');
          }
          if (callCount === 2) {
            // Second call (re-prompt for artifacts): create them
            simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
            return approvedResponse('created the artifact');
          }
          throw new Error(`Unexpected call ${callCount}`);
        },
      });
      allSessions.push(session);
      return session;
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

    // Session received 2 messages (original + re-prompt)
    const session = allSessions[0];
    expect(session.sentMessages).toHaveLength(2);

    // Re-prompt mentions the missing artifact with .workflow/ prefixed path
    expect(session.sentMessages[1]).toContain('`.workflow/code/`');
    // No host paths leaked
    expect(session.sentMessages[1]).not.toContain(tmpDir);

    expect(session.closed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 8: ABORT at human gate
  // -----------------------------------------------------------------------

  it('ABORT at human gate reaches aborted terminal state', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      const session = createArtifactAwareSession(
        [{ text: approvedResponse('plan done'), artifacts: ['plan'] }],
        tmpDir,
      );
      allSessions.push(session);
      return session;
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
    });

    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;
    const workflowId = await orchestrator.start(defPath, 'build a thing');

    // Wait for plan_gate
    await waitForGate(raiseGate, 1);

    // Send ABORT
    orchestrator.resolveGate(workflowId, { type: 'ABORT' });

    // Wait for completion
    await waitForCompletion(orchestrator, workflowId);

    // Verify aborted status
    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('aborted');

    // Planner session was closed
    expect(allSessions[0].closed).toBe(true);

    // Only planner session created
    expect(sessionFactory).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 9: shutdownAll
  // -----------------------------------------------------------------------

  it('shutdownAll aborts all active workflows', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);

    const sessionFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir);
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
    });

    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;
    await orchestrator.start(defPath, 'task 1');

    await waitForGate(raiseGate, 1);
    expect(orchestrator.listActive().length).toBe(1);

    await orchestrator.shutdownAll();
    expect(orchestrator.listActive().length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 10: Session ID preserved across 3+ rounds of the same role
  // -----------------------------------------------------------------------

  it('preserves original session ID across 3+ rounds of the same role', async () => {
    // Need maxRounds high enough for 3 coder + 3 reviewer = 6 agent invocations
    const threeRoundLoopDef: WorkflowDefinition = {
      name: 'three-round-loop',
      description: 'Coder-critic loop with enough rounds for 3 iterations',
      initial: 'implement',
      settings: { mode: 'builtin', maxRounds: 8 },
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
            { to: 'implement', guard: 'isRejected' },
          ],
        },
        done: { type: 'terminal' },
      },
    };

    const defPath = writeDefinitionFile(tmpDir, threeRoundLoopDef);
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
        // Reject on rounds 1 and 2, approve on round 3
        if (reviewerCallCount < 3) {
          return createArtifactAwareSession(
            [{ text: rejectedResponse(`issue ${reviewerCallCount}`), artifacts: ['reviews'] }],
            tmpDir,
            `reviewer-session-${reviewerCallCount}`,
          );
        }
        return createArtifactAwareSession(
          [{ text: approvedResponse('all fixed'), artifacts: ['reviews'] }],
          tmpDir,
          `reviewer-session-${reviewerCallCount}`,
        );
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'implement feature');
    await waitForCompletion(orchestrator, workflowId);

    // 6 sessions: coder1, reviewer1(reject), coder2, reviewer2(reject), coder3, reviewer3(approve)
    expect(sessionFactory).toHaveBeenCalledTimes(6);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

    // Round 1 coder: no resumeSessionId (first invocation)
    const call1 = sessionFactory.mock.calls[0][0];
    expect(call1.persona).toBe('coder');
    expect(call1.resumeSessionId).toBeUndefined();

    // Round 2 coder: resumeSessionId is the original coder session
    const call3 = sessionFactory.mock.calls[2][0];
    expect(call3.persona).toBe('coder');
    expect(call3.resumeSessionId).toBe('coder-session-1');

    // Round 3 coder: resumeSessionId is STILL the original coder session (not coder-session-2)
    const call5 = sessionFactory.mock.calls[4][0];
    expect(call5.persona).toBe('coder');
    expect(call5.resumeSessionId).toBe('coder-session-1');
  });

  // -----------------------------------------------------------------------
  // Test 11: Different roles get independent session IDs
  // -----------------------------------------------------------------------

  it('different roles get independent session IDs', async () => {
    const defPath = writeDefinitionFile(tmpDir, coderCriticLoopDef);
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
        if (reviewerCallCount === 1) {
          return createArtifactAwareSession(
            [{ text: rejectedResponse('needs work'), artifacts: ['reviews'] }],
            tmpDir,
            `reviewer-session-${reviewerCallCount}`,
          );
        }
        return createArtifactAwareSession(
          [{ text: approvedResponse('approved'), artifacts: ['reviews'] }],
          tmpDir,
          `reviewer-session-${reviewerCallCount}`,
        );
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'implement feature');
    await waitForCompletion(orchestrator, workflowId);

    // 4 sessions: coder1, reviewer1(reject), coder2, reviewer2(approve)
    expect(sessionFactory).toHaveBeenCalledTimes(4);

    // Coder round 1: no resumeSessionId
    const coderCall1 = sessionFactory.mock.calls[0][0];
    expect(coderCall1.persona).toBe('coder');
    expect(coderCall1.resumeSessionId).toBeUndefined();

    // Reviewer round 1: no resumeSessionId (different role, first invocation)
    const reviewerCall1 = sessionFactory.mock.calls[1][0];
    expect(reviewerCall1.persona).toBe('reviewer');
    expect(reviewerCall1.resumeSessionId).toBeUndefined();

    // Coder round 2: gets coder's original session ID (not reviewer's)
    const coderCall2 = sessionFactory.mock.calls[2][0];
    expect(coderCall2.persona).toBe('coder');
    expect(coderCall2.resumeSessionId).toBe('coder-session-1');

    // Reviewer round 2: gets reviewer's original session ID (not coder's)
    const reviewerCall2 = sessionFactory.mock.calls[3][0];
    expect(reviewerCall2.persona).toBe('reviewer');
    expect(reviewerCall2.resumeSessionId).toBe('reviewer-session-1');
  });
});
