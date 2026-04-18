import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseJournalLines,
  translateEntry,
  extractStateGraphFromDefinition,
  createReplayController,
  type ReplayPlan,
  type ReplayController,
  type BroadcastFn,
} from '../../../scripts/replay-engine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKFLOW_ID = 'test-wf-001';

function makeDefinition() {
  return {
    name: 'test-workflow',
    description: 'A test workflow',
    initial: 'plan',
    states: {
      plan: {
        type: 'agent' as const,
        persona: 'planner',
        transitions: [{ to: 'plan_review' }],
      },
      plan_review: {
        type: 'human_gate' as const,
        acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
        present: ['plan'],
        transitions: [
          { to: 'implement', event: 'APPROVE' },
          { to: 'plan', event: 'FORCE_REVISION' },
          { to: 'aborted', event: 'ABORT' },
        ],
      },
      implement: {
        type: 'agent' as const,
        persona: 'coder',
        transitions: [{ to: 'done' }],
      },
      done: {
        type: 'terminal' as const,
      },
      aborted: {
        type: 'terminal' as const,
      },
    },
    settings: { maxRounds: 3 },
  };
}

function makeReplayState() {
  return {
    workflowId: WORKFLOW_ID,
    name: 'test-workflow',
    currentState: 'plan',
    phase: 'running' as 'running' | 'waiting_human' | 'completed' | 'failed' | 'aborted',
    startedAt: '2026-04-07T19:04:00.000Z',
    taskDescription: 'Test task',
    visitCounts: {} as Record<string, number>,
    transitionHistory: [] as Array<{
      from: string;
      to: string;
      event: string;
      timestamp: string;
      durationMs: number;
    }>,
    activeGateId: null as string | null,
    lastAgentMessage: null as string | null,
    lastHumanPrompt: null as string | null,
    lastStateEntryTime: '2026-04-07T19:04:00.000Z',
  };
}

function makePlan(entries: Array<Record<string, unknown>>): ReplayPlan {
  return {
    entries: entries as unknown as ReplayPlan['entries'],
    definition: makeDefinition(),
    workflowId: WORKFLOW_ID,
    taskDescription: 'Test task',
  };
}

// ---------------------------------------------------------------------------
// JSONL Parsing
// ---------------------------------------------------------------------------

describe('parseJournalLines', () => {
  it('parses valid entries', () => {
    const raw = [
      JSON.stringify({
        ts: '2026-04-07T19:04:21.789Z',
        workflowId: 'wf-1',
        state: 'plan',
        type: 'agent_sent',
        role: 'global',
        message: 'Hello',
      }),
      JSON.stringify({
        ts: '2026-04-07T19:05:36.540Z',
        workflowId: 'wf-1',
        state: 'plan',
        type: 'agent_received',
        message: 'Done',
        verdict: 'approved',
      }),
    ].join('\n');

    const entries = parseJournalLines(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('agent_sent');
    expect(entries[1].type).toBe('agent_received');
  });

  it('skips malformed lines', () => {
    const raw = [
      'not json at all',
      '{"ts": "2026-04-07T19:04:00.000Z", "workflowId": "wf-1", "state": "plan", "type": "agent_sent"}',
      '{"missing": "required fields"}',
      '',
    ].join('\n');

    const entries = parseJournalLines(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('agent_sent');
  });

  it('sorts entries by timestamp', () => {
    const raw = [
      JSON.stringify({
        ts: '2026-04-07T20:00:00.000Z',
        workflowId: 'wf-1',
        state: 'plan',
        type: 'agent_received',
      }),
      JSON.stringify({
        ts: '2026-04-07T19:00:00.000Z',
        workflowId: 'wf-1',
        state: 'plan',
        type: 'agent_sent',
      }),
    ].join('\n');

    const entries = parseJournalLines(raw);
    expect(entries[0].type).toBe('agent_sent');
    expect(entries[1].type).toBe('agent_received');
  });

  it('rejects entries with invalid type', () => {
    const raw = JSON.stringify({
      ts: '2026-04-07T19:00:00.000Z',
      workflowId: 'wf-1',
      state: 'plan',
      type: 'unknown_type',
    });
    const entries = parseJournalLines(raw);
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Event Translation
// ---------------------------------------------------------------------------

describe('translateEntry', () => {
  const definition = makeDefinition();

  it('translates agent_sent to workflow.agent_started', () => {
    const state = makeReplayState();
    const entry = {
      ts: '2026-04-07T19:04:21.789Z',
      workflowId: WORKFLOW_ID,
      state: 'plan',
      type: 'agent_sent' as const,
      role: 'planner',
      message: 'You are a planner',
    };

    const events = translateEntry(entry, definition, state);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('workflow.agent_started');
    expect(events[0].payload).toEqual({
      workflowId: WORKFLOW_ID,
      stateId: 'plan',
      persona: 'planner',
    });
  });

  it('translates agent_received to workflow.agent_completed', () => {
    const state = makeReplayState();
    const entry = {
      ts: '2026-04-07T19:05:36.540Z',
      workflowId: WORKFLOW_ID,
      state: 'plan',
      type: 'agent_received' as const,
      message: 'Plan complete',
      verdict: 'approved',
      confidence: 'high',
      notes: 'identified 3 subtasks',
    };

    const events = translateEntry(entry, definition, state);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('workflow.agent_completed');
    expect(events[0].payload).toEqual({
      workflowId: WORKFLOW_ID,
      stateId: 'plan',
      verdict: 'approved',
      confidence: 'high',
      notes: 'identified 3 subtasks',
    });
    // Should store last agent message
    expect(state.lastAgentMessage).toBe('Plan complete');
  });

  it('defaults notes to empty string when agent_received omits the field', () => {
    const state = makeReplayState();
    const entry = {
      ts: '2026-04-07T19:05:36.540Z',
      workflowId: WORKFLOW_ID,
      state: 'plan',
      type: 'agent_received' as const,
      message: 'Plan complete',
      verdict: 'approved',
      confidence: 'high',
    };

    const events = translateEntry(entry, definition, state);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('workflow.agent_completed');
    expect(events[0].payload).toMatchObject({ notes: '' });
  });

  it('translates state_transition to workflow.state_entered', () => {
    const state = makeReplayState();
    const entry = {
      ts: '2026-04-07T19:05:50.971Z',
      workflowId: WORKFLOW_ID,
      state: 'plan',
      type: 'state_transition' as const,
      from: 'plan',
      event: 'plan_review',
    };

    const events = translateEntry(entry, definition, state);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('workflow.state_entered');
    expect(events[0].payload).toEqual({
      workflowId: WORKFLOW_ID,
      state: 'plan_review',
      previousState: 'plan',
    });
    expect(state.currentState).toBe('plan_review');
  });

  it('translates gate_raised to workflow.gate_raised', () => {
    const state = makeReplayState();
    state.currentState = 'plan_review';
    state.lastAgentMessage = 'Plan is ready for review';

    const entry = {
      ts: '2026-04-07T19:05:50.972Z',
      workflowId: WORKFLOW_ID,
      state: 'plan_review',
      type: 'gate_raised' as const,
      acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'] as readonly string[],
    };

    const events = translateEntry(entry, definition, state);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('workflow.gate_raised');
    const payload = events[0].payload as { gate: Record<string, unknown> };
    expect(payload.gate.gateId).toBe(`${WORKFLOW_ID}-plan_review`);
    expect(payload.gate.acceptedEvents).toEqual(['APPROVE', 'FORCE_REVISION', 'ABORT']);
    expect(payload.gate.presentedArtifacts).toEqual(['plan']);
    expect(state.phase).toBe('waiting_human');
  });

  it('translates gate_resolved to workflow.gate_dismissed', () => {
    const state = makeReplayState();
    state.activeGateId = `${WORKFLOW_ID}-plan_review`;
    state.phase = 'waiting_human';

    const entry = {
      ts: '2026-04-07T20:21:11.701Z',
      workflowId: WORKFLOW_ID,
      state: 'plan_review',
      type: 'gate_resolved' as const,
      event: 'APPROVE',
      prompt: null,
    };

    const events = translateEntry(entry, definition, state);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('workflow.gate_dismissed');
    expect(state.activeGateId).toBeNull();
    expect(state.phase).toBe('running');
  });

  it('skips duplicate gate_raised for same state', () => {
    const state = makeReplayState();
    state.currentState = 'plan_review';
    state.activeGateId = `${WORKFLOW_ID}-plan_review`;
    state.phase = 'waiting_human';

    const entry = {
      ts: '2026-04-07T20:20:24.989Z',
      workflowId: WORKFLOW_ID,
      state: 'plan_review',
      type: 'gate_raised' as const,
      acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'] as readonly string[],
    };

    const events = translateEntry(entry, definition, state);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// State Accumulation
// ---------------------------------------------------------------------------

describe('state accumulation', () => {
  it('tracks visit counts', () => {
    const state = makeReplayState();
    const definition = makeDefinition();

    translateEntry(
      {
        ts: '2026-04-07T19:04:21.789Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'agent_sent',
        role: 'planner',
      },
      definition,
      state,
    );

    expect(state.visitCounts['plan']).toBe(1);

    // Second visit
    translateEntry(
      {
        ts: '2026-04-07T20:00:00.000Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'agent_sent',
        role: 'planner',
      },
      definition,
      state,
    );

    expect(state.visitCounts['plan']).toBe(2);
  });

  it('builds transition history', () => {
    const state = makeReplayState();
    const definition = makeDefinition();

    translateEntry(
      {
        ts: '2026-04-07T19:05:50.971Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'state_transition',
        from: 'plan',
        event: 'plan_review',
      },
      definition,
      state,
    );

    expect(state.transitionHistory).toHaveLength(1);
    expect(state.transitionHistory[0].from).toBe('plan');
    expect(state.transitionHistory[0].to).toBe('plan_review');
    expect(state.transitionHistory[0].durationMs).toBeGreaterThan(0);
  });

  it('tracks phase transitions', () => {
    const state = makeReplayState();
    const definition = makeDefinition();

    expect(state.phase).toBe('running');

    // Gate raised
    translateEntry(
      {
        ts: '2026-04-07T19:05:50.972Z',
        workflowId: WORKFLOW_ID,
        state: 'plan_review',
        type: 'gate_raised',
        acceptedEvents: ['APPROVE'],
      },
      definition,
      state,
    );
    expect(state.phase).toBe('waiting_human');

    // Gate resolved
    translateEntry(
      {
        ts: '2026-04-07T20:21:11.701Z',
        workflowId: WORKFLOW_ID,
        state: 'plan_review',
        type: 'gate_resolved',
        event: 'APPROVE',
      },
      definition,
      state,
    );
    expect(state.phase).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// State Graph Extraction
// ---------------------------------------------------------------------------

describe('extractStateGraphFromDefinition', () => {
  it('extracts states and transitions from definition', () => {
    const definition = makeDefinition();
    const graph = extractStateGraphFromDefinition(definition);

    expect(graph.states).toHaveLength(5);
    const planNode = graph.states.find((s) => s.id === 'plan');
    expect(planNode?.type).toBe('agent');
    expect(planNode?.label).toBe('Plan');

    const reviewNode = graph.states.find((s) => s.id === 'plan_review');
    expect(reviewNode?.type).toBe('human_gate');
    expect(reviewNode?.label).toBe('Plan Review');

    // Check transitions from plan_review
    const gateTransitions = graph.transitions.filter((t) => t.from === 'plan_review');
    expect(gateTransitions).toHaveLength(3);

    const approveEdge = gateTransitions.find((t) => t.event === 'APPROVE');
    expect(approveEdge?.to).toBe('implement');
    expect(approveEdge?.label).toBe('Approve');
  });
});

// ---------------------------------------------------------------------------
// Replay Controller
// ---------------------------------------------------------------------------

describe('createReplayController', () => {
  let broadcast: BroadcastFn;
  let emitted: Array<{ event: string; payload: unknown }>;
  let activeController: ReplayController | null = null;

  beforeEach(() => {
    emitted = [];
    broadcast = (event: string, payload: unknown) => {
      emitted.push({ event, payload });
    };
    activeController = null;
  });

  afterEach(() => {
    // Clean up any active controllers to prevent async leaks
    if (activeController?.isActive()) {
      activeController.abort();
    }
    activeController = null;
  });

  function startController(plan: ReplayPlan, speedup = 100000): ReplayController {
    const controller = createReplayController(plan, broadcast, speedup);
    activeController = controller;
    return controller;
  }

  it('emits workflow.started and workflow.state_entered on start()', () => {
    const plan = makePlan([
      {
        ts: '2026-04-07T19:04:21.000Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'agent_sent',
        role: 'planner',
        message: '## Task\n\nDo something\n\n---',
      },
      {
        ts: '2026-04-07T19:05:36.000Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'agent_received',
        message: 'Done',
        verdict: 'approved',
        confidence: 'high',
      },
    ]);

    const controller = startController(plan);
    controller.start();

    // Should emit started + state_entered synchronously
    expect(emitted[0].event).toBe('workflow.started');
    expect(emitted[1].event).toBe('workflow.state_entered');
  });

  it('reports active status correctly', () => {
    // Use a gate to keep the replay alive long enough to check isActive()
    const plan = makePlan([
      {
        ts: '2026-04-07T19:04:21.000Z',
        workflowId: WORKFLOW_ID,
        state: 'plan_review',
        type: 'gate_raised',
        acceptedEvents: ['APPROVE'],
      },
    ]);

    const controller = createReplayController(plan, broadcast, 100000);
    expect(controller.isActive()).toBe(false);
    controller.start();
    // The replay will pause at the gate, so it should still be active
    expect(controller.isActive()).toBe(true);
  });

  it('returns summary and detail DTOs', () => {
    // Use a gate to keep the replay alive
    const plan = makePlan([
      {
        ts: '2026-04-07T19:04:21.000Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'agent_sent',
        role: 'planner',
        message: 'Task',
      },
      {
        ts: '2026-04-07T19:04:21.001Z',
        workflowId: WORKFLOW_ID,
        state: 'plan_review',
        type: 'gate_raised',
        acceptedEvents: ['APPROVE'],
      },
    ]);

    const controller = startController(plan);
    controller.start();

    const status = controller.getStatus();
    expect(status.workflowId).toBe(WORKFLOW_ID);
    expect(status.name).toBe('test-workflow');
    // Phase may be waiting_human since entries process synchronously before the gate pause
    expect(['running', 'waiting_human']).toContain(status.phase);

    const detail = controller.getDetail();
    expect(detail.stateGraph).toBeDefined();
    expect(detail.context).toBeDefined();
    expect(detail.workspacePath).toBeDefined();
  });

  it('pauses at gate_raised and resumes on resolveGate()', async () => {
    const plan = makePlan([
      {
        ts: '2026-04-07T19:04:21.000Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'agent_sent',
        role: 'planner',
        message: 'Task',
      },
      {
        ts: '2026-04-07T19:04:21.001Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'agent_received',
        message: 'Done',
        verdict: 'approved',
      },
      {
        ts: '2026-04-07T19:04:21.002Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'state_transition',
        from: 'plan',
        event: 'plan_review',
      },
      {
        ts: '2026-04-07T19:04:21.003Z',
        workflowId: WORKFLOW_ID,
        state: 'plan_review',
        type: 'gate_raised',
        acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
      },
      // This gate_resolved should be skipped when user resolves manually
      {
        ts: '2026-04-07T19:30:00.000Z',
        workflowId: WORKFLOW_ID,
        state: 'plan_review',
        type: 'gate_resolved',
        event: 'APPROVE',
      },
      {
        ts: '2026-04-07T19:30:00.001Z',
        workflowId: WORKFLOW_ID,
        state: 'plan_review',
        type: 'state_transition',
        from: 'plan_review',
        event: 'implement',
      },
      {
        ts: '2026-04-07T19:30:00.002Z',
        workflowId: WORKFLOW_ID,
        state: 'implement',
        type: 'agent_sent',
        role: 'coder',
        message: 'Implementing',
      },
      {
        ts: '2026-04-07T19:30:00.003Z',
        workflowId: WORKFLOW_ID,
        state: 'implement',
        type: 'agent_received',
        message: 'Done implementing',
        verdict: 'approved',
      },
    ]);

    const controller = startController(plan);
    controller.start();

    // Wait a tick for the async loop to process entries up to the gate
    await new Promise((r) => setTimeout(r, 50));

    // Should be paused at the gate
    const detail = controller.getDetail() as { gate?: { gateId: string } };
    expect(detail.gate).toBeDefined();
    expect(controller.getStatus()).toHaveProperty('phase', 'waiting_human');

    // Resolve the gate
    controller.resolveGate('APPROVE');

    // Wait for replay to continue and complete
    await new Promise((r) => setTimeout(r, 100));

    // Should have completed
    const finalEvents = emitted.filter((e) => e.event === 'workflow.completed');
    expect(finalEvents).toHaveLength(1);
  });

  it('applies speedup factor to timing', async () => {
    // Two entries 1000ms apart
    const plan = makePlan([
      {
        ts: '2026-04-07T19:04:21.000Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'agent_sent',
        role: 'planner',
        message: 'Task',
      },
      {
        ts: '2026-04-07T19:04:22.000Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'agent_received',
        message: 'Done',
        verdict: 'approved',
      },
    ]);

    const start = Date.now();
    // Speedup of 100 means 1000ms becomes 10ms
    const controller = startController(plan, 100);
    controller.start();

    // Wait for completion
    await new Promise((r) => setTimeout(r, 200));

    const elapsed = Date.now() - start;
    // Should have completed much faster than 1000ms
    expect(elapsed).toBeLessThan(500);
    expect(emitted.some((e) => e.event === 'workflow.completed')).toBe(true);
  });

  it('aborts the replay', async () => {
    const plan = makePlan([
      {
        ts: '2026-04-07T19:04:21.000Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'agent_sent',
        role: 'planner',
        message: 'Task',
      },
      // Long gap to ensure the timer is active when we abort
      {
        ts: '2026-04-07T20:04:21.000Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'agent_received',
        message: 'Done',
        verdict: 'approved',
      },
    ]);

    const controller = startController(plan, 1);
    controller.start();

    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    expect(controller.isActive()).toBe(false);
    const failedEvents = emitted.filter((e) => e.event === 'workflow.failed');
    expect(failedEvents).toHaveLength(1);
  });

  it('emits workflow.failed when last verdict is not approved', async () => {
    const plan = makePlan([
      {
        ts: '2026-04-07T19:04:21.000Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'agent_sent',
        role: 'planner',
        message: 'Task',
      },
      {
        ts: '2026-04-07T19:04:21.001Z',
        workflowId: WORKFLOW_ID,
        state: 'plan',
        type: 'agent_received',
        message: 'Failed',
        verdict: 'rejected',
      },
    ]);

    const controller = startController(plan);
    controller.start();

    await new Promise((r) => setTimeout(r, 50));

    const failedEvents = emitted.filter((e) => e.event === 'workflow.failed');
    expect(failedEvents).toHaveLength(1);
  });
});
