import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionOptions } from '../../src/session/types.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import {
  MessageLog,
  type MessageLogEntry,
  type AgentSentEntry,
  type AgentReceivedEntry,
} from '../../src/workflow/message-log.js';
import {
  MockSession,
  approvedResponse,
  rejectedResponse,
  noStatusResponse,
  simulateArtifacts,
  findWorkflowDir,
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

// ---------------------------------------------------------------------------
// Test-specific helpers
// ---------------------------------------------------------------------------

/** Read the message log for the first workflow dir in baseDir. */
function readMessageLog(baseDir: string): MessageLogEntry[] {
  const wfDir = findWorkflowDir(baseDir);
  const log = new MessageLog(resolve(wfDir, 'workspace', '.workflow', 'messages.jsonl'));
  return log.readAll();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator message log', () => {
  let tmpDir: string;
  let activeOrchestrator: WorkflowOrchestrator | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-log-test-'));
    activeOrchestrator = undefined;
  });

  afterEach(async () => {
    if (activeOrchestrator) {
      await activeOrchestrator.shutdownAll();
    }
    rmSync(tmpDir, { recursive: true, force: true });
    const baseName = resolve(tmpDir).split('/').pop()!;
    const ckptDir = resolve(tmpDir, '..', `${baseName}-ckpt`);
    rmSync(ckptDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Test 1: Happy path log completeness
  // -----------------------------------------------------------------------

  it('logs the full lifecycle of a plan-gate-implement workflow', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);

    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;
      if (persona === 'planner') {
        return createArtifactAwareSession(
          [{ text: approvedResponse('plan complete'), artifacts: ['plan'] }],
          tmpDir,
          'planner-session-1',
        );
      }
      if (persona === 'coder') {
        return createArtifactAwareSession(
          [{ text: approvedResponse('implementation done'), artifacts: ['code'] }],
          tmpDir,
          'coder-session-1',
        );
      }
      if (persona === 'reviewer') {
        return createArtifactAwareSession(
          [{ text: approvedResponse('looks good'), artifacts: ['reviews'] }],
          tmpDir,
          'reviewer-session-1',
        );
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, { createSession: sessionFactory, raiseGate });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'build a REST API');

    // Wait for plan_gate
    await waitForGate(raiseGate, 1);
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });

    await waitForCompletion(orchestrator, workflowId);

    const entries = readMessageLog(tmpDir);

    // Verify agent_sent for plan
    const planSent = entries.find((e) => e.type === 'agent_sent' && e.role === 'planner') as AgentSentEntry | undefined;
    expect(planSent).toBeDefined();
    expect(planSent!.message).toContain('You are a planner');

    // Verify agent_received for plan
    const planReceived = entries.find((e) => e.type === 'agent_received' && e.role === 'planner') as
      | AgentReceivedEntry
      | undefined;
    expect(planReceived).toBeDefined();
    expect(planReceived!.verdict).toBe('approved');

    // Verify gate_raised
    const gateRaised = entries.find((e) => e.type === 'gate_raised');
    expect(gateRaised).toBeDefined();
    expect(gateRaised!.acceptedEvents).toContain('APPROVE');

    // Verify gate_resolved with APPROVE
    const gateResolved = entries.find((e) => e.type === 'gate_resolved');
    expect(gateResolved).toBeDefined();
    expect(gateResolved!.event).toBe('APPROVE');

    // Verify agent_sent for implement
    const codeSent = entries.find((e) => e.type === 'agent_sent' && e.role === 'coder');
    expect(codeSent).toBeDefined();

    // Verify agent_received for implement
    const codeReceived = entries.find((e) => e.type === 'agent_received' && e.role === 'coder');
    expect(codeReceived).toBeDefined();

    // Verify state_transition entries exist
    const transitions = entries.filter((e) => e.type === 'state_transition');
    expect(transitions.length).toBeGreaterThanOrEqual(3);

    // Verify chronological order: all timestamps should be non-decreasing
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].ts >= entries[i - 1].ts).toBe(true);
    }

    // Verify each entry has the correct workflowId
    for (const entry of entries) {
      expect(entry.workflowId).toBe(workflowId);
    }
  });

  // -----------------------------------------------------------------------
  // Test 2: Retry is logged
  // -----------------------------------------------------------------------

  it('logs agent_retry when status block is missing on first response', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);

    let callCount = 0;
    const sessionFactory = vi.fn(async () => {
      return new MockSession({
        sessionId: 'retry-session',
        responses: () => {
          callCount++;
          if (callCount === 1) {
            // First call: send command -> no status block
            simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
            return noStatusResponse();
          }
          // Second call: reprompt -> valid status block
          return approvedResponse('done');
        },
      });
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'retry test');
    await waitForCompletion(orchestrator, workflowId);

    const entries = readMessageLog(tmpDir);

    // Should have: agent_sent, agent_received (no verdict), agent_retry, agent_received (with verdict)
    const sent = entries.filter((e) => e.type === 'agent_sent');
    expect(sent).toHaveLength(1);

    const received = entries.filter((e) => e.type === 'agent_received');
    expect(received).toHaveLength(2);

    // First received has no verdict
    expect(received[0].verdict).toBeNull();

    // Second received has verdict
    expect(received[1].verdict).toBe('approved');

    const retries = entries.filter((e) => e.type === 'agent_retry');
    expect(retries).toHaveLength(1);
    expect(retries[0].reason).toBe('missing_status_block');
  });

  // -----------------------------------------------------------------------
  // Test 3: Error is logged
  // -----------------------------------------------------------------------

  it('logs error when agent session throws', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);

    const sessionFactory = vi.fn(async () => {
      return new MockSession({
        sessionId: 'error-session',
        responses: () => {
          throw new Error('Agent crashed');
        },
      });
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    await orchestrator.start(defPath, 'error test');
    // The machine will transition to an error state; wait for it to settle
    await new Promise((r) => setTimeout(r, 500));

    const entries = readMessageLog(tmpDir);

    // Should have agent_sent, then error
    const sent = entries.filter((e) => e.type === 'agent_sent');
    expect(sent).toHaveLength(1);

    const errors = entries.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('Agent crashed');
  });

  // -----------------------------------------------------------------------
  // Test 4: Gate with feedback is logged
  // -----------------------------------------------------------------------

  it('logs gate_raised with acceptedEvents and gate_resolved with feedback', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);

    let coderCallCount = 0;
    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;
      if (persona === 'planner') {
        return createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir);
      }
      if (persona === 'coder') {
        coderCallCount++;
        return createArtifactAwareSession(
          [{ text: approvedResponse(`coder pass ${coderCallCount}`), artifacts: ['code'] }],
          tmpDir,
        );
      }
      if (persona === 'reviewer') {
        return createArtifactAwareSession([{ text: approvedResponse('looks good'), artifacts: ['reviews'] }], tmpDir);
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, { createSession: sessionFactory, raiseGate });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'feedback test');
    await waitForGate(raiseGate, 1);

    // Resolve with FORCE_REVISION + prompt
    orchestrator.resolveGate(workflowId, {
      type: 'FORCE_REVISION',
      prompt: 'Add error handling to the plan',
    });

    // Will loop back to plan, then hit gate again
    await waitForGate(raiseGate, 2);
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });

    await waitForCompletion(orchestrator, workflowId);

    const entries = readMessageLog(tmpDir);

    const gateResolved = entries.filter((e) => e.type === 'gate_resolved');
    expect(gateResolved.length).toBeGreaterThanOrEqual(2);

    // First gate resolution: FORCE_REVISION with feedback
    const forceRevision = gateResolved.find((e) => e.event === 'FORCE_REVISION');
    expect(forceRevision).toBeDefined();
    expect(forceRevision!.prompt).toBe('Add error handling to the plan');

    // Second gate resolution: APPROVE
    const approve = gateResolved.find((e) => e.event === 'APPROVE');
    expect(approve).toBeDefined();

    // gate_raised entries
    const gateRaised = entries.filter((e) => e.type === 'gate_raised');
    expect(gateRaised.length).toBeGreaterThanOrEqual(2);
    for (const g of gateRaised) {
      expect(g.acceptedEvents).toContain('APPROVE');
      expect(g.acceptedEvents).toContain('FORCE_REVISION');
    }
  });

  // -----------------------------------------------------------------------
  // Test 5: Resume preserves log
  // -----------------------------------------------------------------------

  it('appends to the same log file on resume', async () => {
    // Use a workflow where errors go to a gate so we can checkpoint at the gate
    const defWithErrorGate: WorkflowDefinition = {
      name: 'resume-log-test',
      description: 'Test resume log preservation',
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

    const defPath = writeDefinitionFile(tmpDir, defWithErrorGate);

    // First run: implement -> error_gate (checkpoint here)
    const raiseGate1 = vi.fn();
    const checkpointStore = createCheckpointStore(tmpDir);
    const deps1 = createDeps(tmpDir, {
      createSession: vi.fn(async () =>
        createArtifactAwareSession([{ text: approvedResponse('first run'), artifacts: ['code'] }], tmpDir, 'session-1'),
      ),
      raiseGate: raiseGate1,
      checkpointStore,
    });

    const orchestrator1 = new WorkflowOrchestrator(deps1);
    activeOrchestrator = orchestrator1;

    const workflowId = await orchestrator1.start(defPath, 'resume test');
    await waitForGate(raiseGate1, 1);

    // Read entries from first run
    const entriesAfterFirstRun = readMessageLog(tmpDir);
    const firstRunCount = entriesAfterFirstRun.length;
    expect(firstRunCount).toBeGreaterThan(0);

    // Save checkpoint before shutdown (abort removes it)
    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();

    // Shut down first orchestrator (simulating crash/stop)
    await orchestrator1.shutdownAll();

    // Re-save checkpoint to simulate a real crash (process died, no clean abort)
    checkpointStore.save(workflowId, checkpoint!);

    // Resume in a new orchestrator
    const raiseGate2 = vi.fn();
    const deps2 = createDeps(tmpDir, {
      createSession: vi.fn(async () => new MockSession({ responses: [] })),
      raiseGate: raiseGate2,
      checkpointStore,
    });

    const orchestrator2 = new WorkflowOrchestrator(deps2);
    activeOrchestrator = orchestrator2;

    await orchestrator2.resume(workflowId);
    await waitForGate(raiseGate2, 1);

    // Resolve gate to complete
    orchestrator2.resolveGate(workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator2, workflowId);

    // Read all entries - should include entries from both runs
    const allEntries = readMessageLog(tmpDir);
    expect(allEntries.length).toBeGreaterThan(firstRunCount);

    // Verify entries from first run are still there
    for (let i = 0; i < firstRunCount; i++) {
      expect(allEntries[i]).toEqual(entriesAfterFirstRun[i]);
    }
  });

  // -----------------------------------------------------------------------
  // Test 6: Full coder-critic loop is logged
  // -----------------------------------------------------------------------

  it('logs both rounds of a coder-critic loop', async () => {
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
            [{ text: rejectedResponse('missing tests'), artifacts: ['reviews'] }],
            tmpDir,
            'reviewer-session-1',
          );
        }
        return createArtifactAwareSession(
          [{ text: approvedResponse('all good'), artifacts: ['reviews'] }],
          tmpDir,
          'reviewer-session-2',
        );
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'coder-critic test');
    await waitForCompletion(orchestrator, workflowId);

    const entries = readMessageLog(tmpDir);

    // Should have sends for: coder(1), reviewer(1), coder(2), reviewer(2)
    const agentSent = entries.filter((e) => e.type === 'agent_sent');
    expect(agentSent).toHaveLength(4);

    const coderSent = agentSent.filter((e) => e.role === 'coder');
    expect(coderSent).toHaveLength(2);

    const reviewerSent = agentSent.filter((e) => e.role === 'reviewer');
    expect(reviewerSent).toHaveLength(2);

    // Should have receives for all 4
    const agentReceived = entries.filter((e) => e.type === 'agent_received');
    expect(agentReceived).toHaveLength(4);

    // First review is rejected, second is approved
    const reviewReceived = agentReceived.filter((e) => e.role === 'reviewer');
    expect(reviewReceived).toHaveLength(2);
    expect(reviewReceived[0].verdict).toBe('rejected');
    expect(reviewReceived[1].verdict).toBe('approved');

    // State transitions should cover: implement->review, review->implement, implement->review, review->done
    const transitions = entries.filter((e) => e.type === 'state_transition');
    expect(transitions.length).toBeGreaterThanOrEqual(4);
  });
});
