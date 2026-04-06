import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEvent, type AppStateLike, type EventSideEffects } from '../event-handler.js';
import type { OutputLine, PendingEscalation, WorkflowSummaryDto, HumanGateRequestDto } from '../types.js';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function createMockState(): AppStateLike & { outputs: Map<number, OutputLine[]> } {
  const outputs = new Map<number, OutputLine[]>();
  return {
    daemonStatus: null,
    sessions: new Map(),
    selectedSessionLabel: null,
    pendingEscalations: new Map<string, PendingEscalation>(),
    jobs: [],
    workflows: new Map(),
    pendingGates: new Map(),
    outputs,
    addOutput(label: number, line: OutputLine) {
      let existing = outputs.get(label) ?? [];
      if (line.kind === 'tool_call' || line.kind === 'assistant' || line.kind === 'escalation') {
        existing = existing.filter((l) => l.kind !== 'thinking');
      }
      outputs.set(label, [...existing, line]);
    },
    removeOutput(label: number) {
      outputs.delete(label);
    },
    filterOutput(label: number, predicate: (line: OutputLine) => boolean) {
      const existing = outputs.get(label);
      if (!existing) return;
      outputs.set(label, existing.filter(predicate));
    },
  };
}

function createMockEffects(): EventSideEffects {
  return {
    refreshJobs: vi.fn(),
    assignDisplayNumber: vi.fn(() => 1),
  };
}

function mockWorkflow(id: string, overrides: Partial<WorkflowSummaryDto> = {}): WorkflowSummaryDto {
  return {
    workflowId: id,
    name: 'test-workflow',
    phase: 'running',
    currentState: 'plan',
    startedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workflow event handling', () => {
  let state: ReturnType<typeof createMockState>;
  let effects: ReturnType<typeof createMockEffects>;

  beforeEach(() => {
    state = createMockState();
    effects = createMockEffects();
  });

  describe('workflow.state_entered', () => {
    it('updates currentState and phase on existing workflow', () => {
      state.workflows.set('wf-1', mockWorkflow('wf-1'));

      handleEvent(state, effects, 'workflow.state_entered', {
        workflowId: 'wf-1',
        state: 'implement',
      });

      const wf = state.workflows.get('wf-1');
      expect(wf?.currentState).toBe('implement');
      expect(wf?.phase).toBe('running');
    });

    it('ignores state_entered for unknown workflow', () => {
      const result = handleEvent(state, effects, 'workflow.state_entered', {
        workflowId: 'unknown',
        state: 'plan',
      });
      expect(result).toBe(true);
      expect(state.workflows.size).toBe(0);
    });
  });

  describe('workflow.gate_raised', () => {
    it('adds gate to pendingGates and updates workflow phase', () => {
      state.workflows.set('wf-1', mockWorkflow('wf-1'));

      const gate: HumanGateRequestDto = {
        gateId: 'wf-1-plan_review',
        workflowId: 'wf-1',
        stateName: 'plan_review',
        acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
        presentedArtifacts: ['plan.md'],
        summary: 'Review the plan',
      };

      handleEvent(state, effects, 'workflow.gate_raised', {
        workflowId: 'wf-1',
        gate,
      });

      expect(state.pendingGates.size).toBe(1);
      expect(state.pendingGates.get('wf-1-plan_review')).toEqual(gate);
      expect(state.workflows.get('wf-1')?.phase).toBe('waiting_human');
      expect(state.workflows.get('wf-1')?.currentState).toBe('plan_review');
    });
  });

  describe('workflow.gate_dismissed', () => {
    it('removes gate from pendingGates', () => {
      state.pendingGates.set('wf-1-plan_review', {
        gateId: 'wf-1-plan_review',
        workflowId: 'wf-1',
        stateName: 'plan_review',
        acceptedEvents: ['APPROVE'],
        presentedArtifacts: [],
        summary: 'Review',
      });

      handleEvent(state, effects, 'workflow.gate_dismissed', {
        workflowId: 'wf-1',
        gateId: 'wf-1-plan_review',
      });

      expect(state.pendingGates.size).toBe(0);
    });
  });

  describe('workflow.completed', () => {
    it('sets phase to completed and cleans up gates', () => {
      state.workflows.set('wf-1', mockWorkflow('wf-1'));
      state.pendingGates.set('wf-1-review', {
        gateId: 'wf-1-review',
        workflowId: 'wf-1',
        stateName: 'review',
        acceptedEvents: ['APPROVE'],
        presentedArtifacts: [],
        summary: 'Review',
      });

      handleEvent(state, effects, 'workflow.completed', { workflowId: 'wf-1' });

      expect(state.workflows.get('wf-1')?.phase).toBe('completed');
      expect(state.workflows.get('wf-1')?.currentState).toBe('completed');
      expect(state.pendingGates.size).toBe(0);
    });

    it('does not clean up gates for other workflows', () => {
      state.workflows.set('wf-1', mockWorkflow('wf-1'));
      state.workflows.set('wf-2', mockWorkflow('wf-2'));
      state.pendingGates.set('wf-2-review', {
        gateId: 'wf-2-review',
        workflowId: 'wf-2',
        stateName: 'review',
        acceptedEvents: ['APPROVE'],
        presentedArtifacts: [],
        summary: 'Review',
      });

      handleEvent(state, effects, 'workflow.completed', { workflowId: 'wf-1' });

      expect(state.pendingGates.size).toBe(1);
    });
  });

  describe('workflow.failed', () => {
    it('sets phase to failed', () => {
      state.workflows.set('wf-1', mockWorkflow('wf-1'));

      handleEvent(state, effects, 'workflow.failed', {
        workflowId: 'wf-1',
        error: 'Something went wrong',
      });

      expect(state.workflows.get('wf-1')?.phase).toBe('failed');
    });
  });

  describe('workflow.agent_started and agent_completed', () => {
    it('are recognized as valid events', () => {
      const r1 = handleEvent(state, effects, 'workflow.agent_started', {
        workflowId: 'wf-1',
        stateId: 'plan',
        persona: 'planner',
      });
      expect(r1).toBe(true);

      const r2 = handleEvent(state, effects, 'workflow.agent_completed', {
        workflowId: 'wf-1',
        stateId: 'plan',
        verdict: 'success',
      });
      expect(r2).toBe(true);
    });
  });

  it('returns false for unrecognized event', () => {
    const result = handleEvent(state, effects, 'workflow.unknown_event', {});
    expect(result).toBe(false);
  });
});
