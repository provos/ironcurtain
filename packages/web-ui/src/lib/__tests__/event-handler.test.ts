import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleEvent,
  evictTerminalIfOverCap,
  MAX_TERMINAL_WORKFLOWS,
  type AppStateLike,
  type EventSideEffects,
} from '../event-handler.js';
import type {
  SessionDto,
  EscalationDto,
  BudgetSummaryDto,
  OutputLine,
  PendingEscalation,
  WorkflowSummaryDto,
  LiveWorkflowPhase,
} from '../types.js';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function mockBudget(): BudgetSummaryDto {
  return {
    totalTokens: 0,
    stepCount: 0,
    elapsedSeconds: 0,
    estimatedCostUsd: 0,
    tokenTrackingAvailable: true,
    limits: {
      maxTotalTokens: null,
      maxSteps: null,
      maxSessionSeconds: null,
      maxEstimatedCostUsd: null,
    },
  };
}

function mockSession(label: number, overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    label,
    source: { kind: 'web' },
    status: 'ready',
    turnCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    hasPendingEscalation: false,
    messageInFlight: false,
    budget: mockBudget(),
    ...overrides,
  };
}

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
      // Replicate the thinking-line filtering from AppState.addOutput:
      // when a tool_call, assistant, or escalation line arrives, remove preceding thinking lines.
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
      const filtered = existing.filter(predicate);
      if (filtered.length !== existing.length) {
        outputs.set(label, filtered);
      }
    },
  };
}

let displayNumberCounter = 0;

function createMockEffects(): EventSideEffects {
  return {
    refreshJobs: vi.fn(),
    assignDisplayNumber: vi.fn(() => ++displayNumberCounter),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleEvent', () => {
  beforeEach(() => {
    displayNumberCounter = 0;
  });

  it('sets daemon status', () => {
    const state = createMockState();
    handleEvent(state, createMockEffects(), 'daemon.status', {
      uptimeSeconds: 120,
      jobs: { total: 2, enabled: 1, running: 0 },
      signalConnected: false,
      webUiListening: true,
      activeSessions: 1,
      nextFireTime: null,
    });
    expect(state.daemonStatus?.uptimeSeconds).toBe(120);
  });

  it('adds session on session.created', () => {
    const state = createMockState();
    const session = mockSession(1);
    handleEvent(state, createMockEffects(), 'session.created', session);
    expect(state.sessions.get(1)?.status).toBe('ready');
  });

  it('updates session on session.updated', () => {
    const state = createMockState();
    state.sessions.set(1, mockSession(1));
    const updated = mockSession(1, { status: 'processing', turnCount: 3 });
    handleEvent(state, createMockEffects(), 'session.updated', updated);
    expect(state.sessions.get(1)?.status).toBe('processing');
    expect(state.sessions.get(1)?.turnCount).toBe(3);
  });

  it('removes session, clears output, and clears selection on session.ended', () => {
    const state = createMockState();
    state.sessions.set(1, mockSession(1));
    state.selectedSessionLabel = 1;
    state.addOutput(1, { kind: 'assistant', text: 'Hello', timestamp: '' });

    handleEvent(state, createMockEffects(), 'session.ended', { label: 1, reason: 'user_ended' });

    expect(state.sessions.has(1)).toBe(false);
    expect(state.selectedSessionLabel).toBeNull();
    expect(state.outputs.has(1)).toBe(false);
  });

  it('does not clear selection when a different session ends', () => {
    const state = createMockState();
    state.sessions.set(1, mockSession(1));
    state.sessions.set(2, mockSession(2));
    state.selectedSessionLabel = 2;

    handleEvent(state, createMockEffects(), 'session.ended', { label: 1 });

    expect(state.selectedSessionLabel).toBe(2);
  });

  it('transitions session to processing and adds thinking line on session.thinking', () => {
    const state = createMockState();
    state.sessions.set(1, mockSession(1));

    handleEvent(state, createMockEffects(), 'session.thinking', { label: 1, turnNumber: 1 });

    expect(state.sessions.get(1)?.status).toBe('processing');
    expect(state.outputs.get(1)?.[0]?.kind).toBe('thinking');
  });

  it('adds tool_call line and clears thinking lines on session.tool_call', () => {
    const state = createMockState();
    state.addOutput(1, { kind: 'thinking', text: 'Thinking...', timestamp: '' });

    handleEvent(state, createMockEffects(), 'session.tool_call', {
      label: 1,
      toolName: 'filesystem__read_file',
      preview: 'Reading ./foo.ts',
    });

    const lines = state.outputs.get(1) ?? [];
    expect(lines.every((l) => l.kind !== 'thinking')).toBe(true);
    expect(lines.some((l) => l.kind === 'tool_call')).toBe(true);
  });

  it('adds assistant line and clears thinking lines on session.output', () => {
    const state = createMockState();
    state.addOutput(1, { kind: 'thinking', text: 'Thinking...', timestamp: '' });

    handleEvent(state, createMockEffects(), 'session.output', {
      label: 1,
      text: 'Here is the answer.',
      turnNumber: 1,
    });

    const lines = state.outputs.get(1) ?? [];
    expect(lines.every((l) => l.kind !== 'thinking')).toBe(true);
    expect(lines.some((l) => l.kind === 'assistant')).toBe(true);
  });

  it('updates session budget on session.budget_update', () => {
    const state = createMockState();
    state.sessions.set(1, mockSession(1));

    const budget: BudgetSummaryDto = {
      ...mockBudget(),
      totalTokens: 5000,
      stepCount: 3,
      estimatedCostUsd: 0.42,
    };
    handleEvent(state, createMockEffects(), 'session.budget_update', { label: 1, budget });

    expect(state.sessions.get(1)?.budget.totalTokens).toBe(5000);
    expect(state.sessions.get(1)?.budget.estimatedCostUsd).toBe(0.42);
  });

  it('ignores budget_update for unknown session', () => {
    const state = createMockState();
    const result = handleEvent(state, createMockEffects(), 'session.budget_update', {
      label: 99,
      budget: mockBudget(),
    });
    expect(result).toBe(true);
    expect(state.sessions.has(99)).toBe(false);
  });

  it('adds escalation on escalation.created', () => {
    const state = createMockState();
    const esc: EscalationDto = {
      escalationId: 'esc-1',
      sessionLabel: 1,
      sessionSource: { kind: 'web' },
      toolName: 'filesystem__write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/hosts' },
      reason: 'Protected path',
      receivedAt: '2026-01-01T00:00:00Z',
    };
    handleEvent(state, createMockEffects(), 'escalation.created', esc);
    expect(state.pendingEscalations.size).toBe(1);
    expect(state.pendingEscalations.get('esc-1')?.toolName).toBe('filesystem__write_file');
  });

  it('assigns a display number to escalations on escalation.created', () => {
    const state = createMockState();
    const effects = createMockEffects();
    const esc: EscalationDto = {
      escalationId: 'esc-dn-1',
      sessionLabel: 1,
      sessionSource: { kind: 'web' },
      toolName: 'filesystem__write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/hosts' },
      reason: 'Protected path',
      receivedAt: '2026-01-01T00:00:00Z',
    };
    handleEvent(state, effects, 'escalation.created', esc);

    const pending = state.pendingEscalations.get('esc-dn-1');
    expect(pending).toBeDefined();
    expect(pending!.displayNumber).toBe(1);
    expect(effects.assignDisplayNumber).toHaveBeenCalledWith('esc-dn-1');
  });

  it('injects an escalation output line on escalation.created', () => {
    const state = createMockState();
    const esc: EscalationDto = {
      escalationId: 'esc-out-1',
      sessionLabel: 1,
      sessionSource: { kind: 'web' },
      toolName: 'filesystem__write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/hosts' },
      reason: 'Protected path',
      receivedAt: '2026-01-01T00:00:00Z',
    };
    handleEvent(state, createMockEffects(), 'escalation.created', esc);

    const lines = state.outputs.get(1) ?? [];
    expect(lines.length).toBe(1);
    expect(lines[0].kind).toBe('escalation');
    expect(lines[0].text).toContain('filesystem/filesystem__write_file');
    expect(lines[0].escalationId).toBe('esc-out-1');
  });

  it('removes escalation output line on escalation.resolved', () => {
    const state = createMockState();
    const effects = createMockEffects();
    const esc: EscalationDto = {
      escalationId: 'esc-rem-1',
      sessionLabel: 1,
      sessionSource: { kind: 'web' },
      toolName: 'filesystem__write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/hosts' },
      reason: 'Protected path',
      receivedAt: '2026-01-01T00:00:00Z',
    };
    handleEvent(state, effects, 'escalation.created', esc);
    expect(state.outputs.get(1)?.length).toBe(1);

    handleEvent(state, effects, 'escalation.resolved', { escalationId: 'esc-rem-1', decision: 'approved' });
    expect(state.outputs.get(1)?.length).toBe(0);
  });

  it('removes escalation output line on escalation.expired', () => {
    const state = createMockState();
    const effects = createMockEffects();
    const esc: EscalationDto = {
      escalationId: 'esc-exp-1',
      sessionLabel: 1,
      sessionSource: { kind: 'web' },
      toolName: 'filesystem__delete_file',
      serverName: 'filesystem',
      arguments: { path: '/tmp/foo' },
      reason: 'Delete outside sandbox',
      receivedAt: '2026-01-01T00:00:00Z',
    };
    handleEvent(state, effects, 'escalation.created', esc);
    expect(state.outputs.get(1)?.length).toBe(1);

    handleEvent(state, effects, 'escalation.expired', { escalationId: 'esc-exp-1', sessionLabel: 1 });
    expect(state.outputs.get(1)?.length).toBe(0);
  });

  it('removes escalation on escalation.resolved', () => {
    const state = createMockState();
    const esc: EscalationDto = {
      escalationId: 'esc-1',
      sessionLabel: 1,
      sessionSource: { kind: 'web' },
      toolName: 'filesystem__write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/hosts' },
      reason: 'Protected path',
      receivedAt: '2026-01-01T00:00:00Z',
    };
    handleEvent(state, createMockEffects(), 'escalation.created', esc);
    expect(state.pendingEscalations.size).toBe(1);

    handleEvent(state, createMockEffects(), 'escalation.resolved', { escalationId: 'esc-1' });
    expect(state.pendingEscalations.size).toBe(0);
  });

  it('removes escalation on escalation.expired', () => {
    const state = createMockState();
    const esc: EscalationDto = {
      escalationId: 'esc-2',
      sessionLabel: 1,
      sessionSource: { kind: 'web' },
      toolName: 'filesystem__delete_file',
      serverName: 'filesystem',
      arguments: { path: '/tmp/foo' },
      reason: 'Delete outside sandbox',
      receivedAt: '2026-01-01T00:00:00Z',
    };
    handleEvent(state, createMockEffects(), 'escalation.created', esc);
    expect(state.pendingEscalations.size).toBe(1);

    handleEvent(state, createMockEffects(), 'escalation.expired', { escalationId: 'esc-2' });
    expect(state.pendingEscalations.size).toBe(0);
  });

  it('calls refreshJobs for job.list_changed', () => {
    const state = createMockState();
    const effects = createMockEffects();
    handleEvent(state, effects, 'job.list_changed', {});
    expect(effects.refreshJobs).toHaveBeenCalledOnce();
  });

  it('calls refreshJobs for job.completed', () => {
    const state = createMockState();
    const effects = createMockEffects();
    handleEvent(state, effects, 'job.completed', {});
    expect(effects.refreshJobs).toHaveBeenCalledOnce();
  });

  it('calls refreshJobs for job.failed', () => {
    const state = createMockState();
    const effects = createMockEffects();
    handleEvent(state, effects, 'job.failed', {});
    expect(effects.refreshJobs).toHaveBeenCalledOnce();
  });

  it('calls refreshJobs for job.started', () => {
    const state = createMockState();
    const effects = createMockEffects();
    handleEvent(state, effects, 'job.started', {});
    expect(effects.refreshJobs).toHaveBeenCalledOnce();
  });

  it('returns false for unknown events', () => {
    const state = createMockState();
    const handled = handleEvent(state, createMockEffects(), 'unknown.event', {});
    expect(handled).toBe(false);
  });

  it('returns true for recognized events', () => {
    const state = createMockState();
    const handled = handleEvent(state, createMockEffects(), 'daemon.status', {
      uptimeSeconds: 0,
      jobs: { total: 0, enabled: 0, running: 0 },
      signalConnected: false,
      webUiListening: false,
      activeSessions: 0,
      nextFireTime: null,
    });
    expect(handled).toBe(true);
  });

  // ── Workflow events ──────────────────────────────────────────────────

  describe('workflow events', () => {
    it('updates workflow state on workflow.state_entered', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-1',
          {
            workflowId: 'wf-1',
            name: 'test',
            phase: 'running' as const,
            currentState: 'plan',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.state_entered', {
        workflowId: 'wf-1',
        state: 'implement',
      });

      expect(state.workflows.get('wf-1')?.currentState).toBe('implement');
      expect(state.workflows.get('wf-1')?.phase).toBe('running');
    });

    it('marks workflow completed on workflow.completed and preserves terminal state name', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-1',
          {
            workflowId: 'wf-1',
            name: 'test',
            phase: 'running' as const,
            currentState: 'done',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.completed', { workflowId: 'wf-1' });

      expect(state.workflows.get('wf-1')?.phase).toBe('completed');
      // currentState should preserve the terminal state name set by the prior state_entered event
      expect(state.workflows.get('wf-1')?.currentState).toBe('done');
    });

    it('marks workflow failed on workflow.failed', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-1',
          {
            workflowId: 'wf-1',
            name: 'test',
            phase: 'running' as const,
            currentState: 'implement',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.failed', {
        workflowId: 'wf-1',
        error: 'Agent crashed',
      });

      expect(state.workflows.get('wf-1')?.phase).toBe('failed');
    });

    it('adds gate on workflow.gate_raised', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-1',
          {
            workflowId: 'wf-1',
            name: 'test',
            phase: 'running' as const,
            currentState: 'plan',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.gate_raised', {
        workflowId: 'wf-1',
        gate: {
          gateId: 'wf-1-plan_review',
          workflowId: 'wf-1',
          stateName: 'plan_review',
          acceptedEvents: ['APPROVE', 'FORCE_REVISION'],
          presentedArtifacts: ['plan'],
          summary: 'Review the plan',
        },
      });

      expect(state.pendingGates.size).toBe(1);
      expect(state.pendingGates.get('wf-1-plan_review')?.stateName).toBe('plan_review');
      expect(state.workflows.get('wf-1')?.phase).toBe('waiting_human');
    });

    it('removes gate on workflow.gate_dismissed', () => {
      const state = createMockState();
      state.pendingGates = new Map([
        [
          'wf-1-plan_review',
          {
            gateId: 'wf-1-plan_review',
            workflowId: 'wf-1',
            stateName: 'plan_review',
            acceptedEvents: ['APPROVE'],
            presentedArtifacts: [],
            summary: 'Review',
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.gate_dismissed', {
        workflowId: 'wf-1',
        gateId: 'wf-1-plan_review',
      });

      expect(state.pendingGates.size).toBe(0);
    });

    it('transitions phase from waiting_human to running on gate_dismissed when no gates remain', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-1',
          {
            workflowId: 'wf-1',
            name: 'test',
            phase: 'waiting_human' as const,
            currentState: 'plan_review',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);
      state.pendingGates = new Map([
        [
          'wf-1-plan_review',
          {
            gateId: 'wf-1-plan_review',
            workflowId: 'wf-1',
            stateName: 'plan_review',
            acceptedEvents: ['APPROVE'],
            presentedArtifacts: [],
            summary: 'Review',
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.gate_dismissed', {
        workflowId: 'wf-1',
        gateId: 'wf-1-plan_review',
      });

      expect(state.pendingGates.size).toBe(0);
      expect(state.workflows.get('wf-1')?.phase).toBe('running');
    });

    it('keeps waiting_human phase on gate_dismissed when other gates remain for same workflow', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-1',
          {
            workflowId: 'wf-1',
            name: 'test',
            phase: 'waiting_human' as const,
            currentState: 'plan_review',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);
      state.pendingGates = new Map([
        [
          'wf-1-gate-a',
          {
            gateId: 'wf-1-gate-a',
            workflowId: 'wf-1',
            stateName: 'review_a',
            acceptedEvents: ['APPROVE'],
            presentedArtifacts: [],
            summary: 'Review A',
          },
        ],
        [
          'wf-1-gate-b',
          {
            gateId: 'wf-1-gate-b',
            workflowId: 'wf-1',
            stateName: 'review_b',
            acceptedEvents: ['APPROVE'],
            presentedArtifacts: [],
            summary: 'Review B',
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.gate_dismissed', {
        workflowId: 'wf-1',
        gateId: 'wf-1-gate-a',
      });

      expect(state.pendingGates.size).toBe(1);
      expect(state.workflows.get('wf-1')?.phase).toBe('waiting_human');
    });

    it('does not change phase on gate_dismissed when workflow is not waiting_human', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-1',
          {
            workflowId: 'wf-1',
            name: 'test',
            phase: 'completed' as const,
            currentState: 'done',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);
      state.pendingGates = new Map([
        [
          'wf-1-leftover',
          {
            gateId: 'wf-1-leftover',
            workflowId: 'wf-1',
            stateName: 'review',
            acceptedEvents: ['APPROVE'],
            presentedArtifacts: [],
            summary: 'Leftover gate',
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.gate_dismissed', {
        workflowId: 'wf-1',
        gateId: 'wf-1-leftover',
      });

      expect(state.pendingGates.size).toBe(0);
      expect(state.workflows.get('wf-1')?.phase).toBe('completed');
    });

    it('cleans up gates on workflow.completed', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-1',
          {
            workflowId: 'wf-1',
            name: 'test',
            phase: 'waiting_human' as const,
            currentState: 'review',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);
      state.pendingGates = new Map([
        [
          'wf-1-review',
          {
            gateId: 'wf-1-review',
            workflowId: 'wf-1',
            stateName: 'review',
            acceptedEvents: ['APPROVE'],
            presentedArtifacts: [],
            summary: 'Review',
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.completed', { workflowId: 'wf-1' });

      expect(state.pendingGates.size).toBe(0);
    });

    it('removes gate on gate_dismissed even when workflowId is unknown', () => {
      const state = createMockState();
      state.pendingGates = new Map([
        [
          'orphan-gate',
          {
            gateId: 'orphan-gate',
            workflowId: 'wf-unknown',
            stateName: 'review',
            acceptedEvents: ['APPROVE'],
            presentedArtifacts: [],
            summary: 'Orphan gate',
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.gate_dismissed', {
        workflowId: 'wf-unknown',
        gateId: 'orphan-gate',
      });

      expect(state.pendingGates.size).toBe(0);
      // workflows map should remain empty (unchanged)
      expect(state.workflows.size).toBe(0);
    });

    it('handles gate_dismissed with unknown gateId without crashing', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-1',
          {
            workflowId: 'wf-1',
            name: 'test',
            phase: 'running' as const,
            currentState: 'plan',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);
      state.pendingGates = new Map([
        [
          'wf-1-real-gate',
          {
            gateId: 'wf-1-real-gate',
            workflowId: 'wf-1',
            stateName: 'review',
            acceptedEvents: ['APPROVE'],
            presentedArtifacts: [],
            summary: 'Real gate',
          },
        ],
      ]);

      const result = handleEvent(state, createMockEffects(), 'workflow.gate_dismissed', {
        workflowId: 'wf-1',
        gateId: 'wf-1-nonexistent',
      });

      expect(result).toBe(true);
      // The real gate should still be present
      expect(state.pendingGates.size).toBe(1);
      expect(state.pendingGates.has('wf-1-real-gate')).toBe(true);
    });

    it('keeps waiting_human phase on state_entered when workflow has active gates', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-1',
          {
            workflowId: 'wf-1',
            name: 'test',
            phase: 'waiting_human' as const,
            currentState: 'plan_review',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);
      state.pendingGates = new Map([
        [
          'wf-1-gate',
          {
            gateId: 'wf-1-gate',
            workflowId: 'wf-1',
            stateName: 'plan_review',
            acceptedEvents: ['APPROVE'],
            presentedArtifacts: [],
            summary: 'Review gate',
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.state_entered', {
        workflowId: 'wf-1',
        state: 'implement',
      });

      expect(state.workflows.get('wf-1')?.currentState).toBe('implement');
      expect(state.workflows.get('wf-1')?.phase).toBe('waiting_human');
    });

    it('sets running phase on state_entered when workflow has no active gates', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-1',
          {
            workflowId: 'wf-1',
            name: 'test',
            phase: 'waiting_human' as const,
            currentState: 'plan_review',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);
      // No pending gates

      handleEvent(state, createMockEffects(), 'workflow.state_entered', {
        workflowId: 'wf-1',
        state: 'implement',
      });

      expect(state.workflows.get('wf-1')?.currentState).toBe('implement');
      expect(state.workflows.get('wf-1')?.phase).toBe('running');
    });

    it('returns true for workflow.agent_started and workflow.agent_completed', () => {
      const state = createMockState();
      const effects = createMockEffects();

      const handled1 = handleEvent(state, effects, 'workflow.agent_started', {
        workflowId: 'wf-1',
        stateId: 'plan',
        persona: 'planner',
      });
      expect(handled1).toBe(true);

      const handled2 = handleEvent(state, effects, 'workflow.agent_completed', {
        workflowId: 'wf-1',
        stateId: 'plan',
        verdict: 'approved',
      });
      expect(handled2).toBe(true);
    });

    // ── F2: error capture, latestVerdict capture, terminal-cap eviction ──

    it('populates taskDescription from the workflow.started event payload', () => {
      const state = createMockState();
      handleEvent(state, createMockEffects(), 'workflow.started', {
        workflowId: 'wf-task',
        name: 'vuln-discovery',
        taskDescription: 'Investigate the auth bypass report',
      });
      expect(state.workflows.get('wf-task')?.taskDescription).toBe('Investigate the auth bypass report');
    });

    it('captures error string from workflow.failed onto the summary', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-err',
          {
            workflowId: 'wf-err',
            name: 'test',
            phase: 'running' as const,
            currentState: 'implement',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.failed', {
        workflowId: 'wf-err',
        error: 'agent OOMed at round 3',
      });

      const wf = state.workflows.get('wf-err');
      expect(wf?.phase).toBe('failed');
      expect(wf?.error).toBe('agent OOMed at round 3');
    });

    it('captures latestVerdict from workflow.agent_completed onto the summary', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-v',
          {
            workflowId: 'wf-v',
            name: 'test',
            phase: 'running' as const,
            currentState: 'review',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.agent_completed', {
        workflowId: 'wf-v',
        stateId: 'plan_review',
        verdict: 'approved',
        confidence: '0.92',
      });

      const wf = state.workflows.get('wf-v');
      expect(wf?.latestVerdict).toEqual({
        stateId: 'plan_review',
        verdict: 'approved',
        confidence: 0.92,
      });
    });

    it('overwrites latestVerdict with the most recent agent_completed event', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-v2',
          {
            workflowId: 'wf-v2',
            name: 'test',
            phase: 'running' as const,
            currentState: 'review',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.agent_completed', {
        workflowId: 'wf-v2',
        stateId: 'plan_review',
        verdict: 'needs_revision',
        confidence: '0.40',
      });
      handleEvent(state, createMockEffects(), 'workflow.agent_completed', {
        workflowId: 'wf-v2',
        stateId: 'final_review',
        verdict: 'approved',
        confidence: '0.95',
      });

      expect(state.workflows.get('wf-v2')?.latestVerdict).toEqual({
        stateId: 'final_review',
        verdict: 'approved',
        confidence: 0.95,
      });
    });

    it('omits confidence on latestVerdict when wire payload omits it', () => {
      const state = createMockState();
      state.workflows = new Map([
        [
          'wf-nc',
          {
            workflowId: 'wf-nc',
            name: 'test',
            phase: 'running' as const,
            currentState: 'review',
            startedAt: '2026-01-01T00:00:00Z',
            taskDescription: '',
            round: 0,
            maxRounds: 0,
            totalTokens: 0,
          },
        ],
      ]);

      handleEvent(state, createMockEffects(), 'workflow.agent_completed', {
        workflowId: 'wf-nc',
        stateId: 'plan_review',
        verdict: 'approved',
      });

      const verdict = state.workflows.get('wf-nc')?.latestVerdict;
      expect(verdict?.verdict).toBe('approved');
      expect(verdict?.confidence).toBeUndefined();
    });
  });

  // ── F2: terminal-cap eviction (D7) ─────────────────────────────────────

  describe('terminal-phase eviction', () => {
    /** Build a workflow summary with a fixed `startedAt` and phase. */
    function makeWorkflow(id: string, startedAt: string, phase: LiveWorkflowPhase): WorkflowSummaryDto {
      return {
        workflowId: id,
        name: id,
        phase,
        currentState: phase === 'running' ? 'implement' : 'done',
        startedAt,
        taskDescription: '',
        round: 0,
        maxRounds: 0,
        totalTokens: 0,
      };
    }

    /** Count terminal workflows in a map. */
    function countTerminal(workflows: ReadonlyMap<string, WorkflowSummaryDto>): number {
      let n = 0;
      for (const wf of workflows.values()) {
        if (wf.phase === 'completed' || wf.phase === 'failed' || wf.phase === 'aborted') n++;
      }
      return n;
    }

    it('drops the oldest terminal entry when a 51st terminal completion arrives', () => {
      const state = createMockState();

      // Seed 50 terminal completed workflows (startedAt 2026-01-01..2026-02-19).
      const terminal = new Map<string, WorkflowSummaryDto>();
      for (let i = 0; i < MAX_TERMINAL_WORKFLOWS; i++) {
        const day = String(i + 1).padStart(2, '0');
        const startedAt = i < 31 ? `2026-01-${day}T00:00:00Z` : `2026-02-${String(i - 30).padStart(2, '0')}T00:00:00Z`;
        terminal.set(`done-${i}`, makeWorkflow(`done-${i}`, startedAt, 'completed'));
      }
      // Plus 5 active running workflows.
      for (let i = 0; i < 5; i++) {
        terminal.set(`live-${i}`, makeWorkflow(`live-${i}`, `2026-03-0${i + 1}T00:00:00Z`, 'running'));
      }
      state.workflows = terminal;

      // Sanity check seeding.
      expect(countTerminal(state.workflows)).toBe(MAX_TERMINAL_WORKFLOWS);
      expect(state.workflows.size).toBe(MAX_TERMINAL_WORKFLOWS + 5);

      // The 51st terminal workflow: introduce a new running one and complete it.
      const newId = 'new-completion';
      state.workflows = new Map(state.workflows).set(newId, makeWorkflow(newId, '2026-03-15T00:00:00Z', 'running'));
      handleEvent(state, createMockEffects(), 'workflow.completed', { workflowId: newId });

      // Cap should hold at 50 terminal entries; oldest (done-0 with 2026-01-01) gone.
      expect(countTerminal(state.workflows)).toBe(MAX_TERMINAL_WORKFLOWS);
      expect(state.workflows.has('done-0')).toBe(false);
      // New completion survives.
      expect(state.workflows.get(newId)?.phase).toBe('completed');
      // All 5 running workflows survive untouched.
      for (let i = 0; i < 5; i++) {
        const wf = state.workflows.get(`live-${i}`);
        expect(wf?.phase).toBe('running');
      }
    });

    it('also evicts on workflow.failed transitions', () => {
      const state = createMockState();
      const terminal = new Map<string, WorkflowSummaryDto>();
      for (let i = 0; i < MAX_TERMINAL_WORKFLOWS; i++) {
        const day = String(i + 1).padStart(2, '0');
        const startedAt = i < 31 ? `2026-01-${day}T00:00:00Z` : `2026-02-${String(i - 30).padStart(2, '0')}T00:00:00Z`;
        terminal.set(`done-${i}`, makeWorkflow(`done-${i}`, startedAt, 'completed'));
      }
      const newId = 'failing-wf';
      terminal.set(newId, makeWorkflow(newId, '2026-03-15T00:00:00Z', 'running'));
      state.workflows = terminal;

      handleEvent(state, createMockEffects(), 'workflow.failed', {
        workflowId: newId,
        error: 'crashed',
      });

      expect(countTerminal(state.workflows)).toBe(MAX_TERMINAL_WORKFLOWS);
      expect(state.workflows.has('done-0')).toBe(false);
      expect(state.workflows.get(newId)?.error).toBe('crashed');
    });

    it('evicts the oldest by startedAt — not by Map insertion order', () => {
      // Insert workflows in an order where the oldest startedAt is NOT first inserted.
      const workflows = new Map<string, WorkflowSummaryDto>();
      // Insert "newer" entries first; the truly-oldest entry is inserted last.
      workflows.set('w-newer-a', makeWorkflow('w-newer-a', '2026-05-01T00:00:00Z', 'completed'));
      workflows.set('w-newer-b', makeWorkflow('w-newer-b', '2026-04-01T00:00:00Z', 'completed'));
      workflows.set('w-truly-oldest', makeWorkflow('w-truly-oldest', '2026-01-01T00:00:00Z', 'completed'));

      // Use a small cap so we can prove eviction picks by startedAt.
      const evicted = evictTerminalIfOverCap(workflows, 2);
      expect(evicted.size).toBe(2);
      expect(evicted.has('w-truly-oldest')).toBe(false);
      expect(evicted.has('w-newer-a')).toBe(true);
      expect(evicted.has('w-newer-b')).toBe(true);
    });

    it('does not evict when terminal count is at or below cap', () => {
      const workflows = new Map<string, WorkflowSummaryDto>();
      workflows.set('w-1', makeWorkflow('w-1', '2026-01-01T00:00:00Z', 'completed'));
      workflows.set('w-2', makeWorkflow('w-2', '2026-01-02T00:00:00Z', 'completed'));
      // Plus a few running ones — these never count toward the cap.
      workflows.set('w-3', makeWorkflow('w-3', '2026-01-03T00:00:00Z', 'running'));
      workflows.set('w-4', makeWorkflow('w-4', '2026-01-04T00:00:00Z', 'running'));

      const evicted = evictTerminalIfOverCap(workflows, 2);
      expect(evicted.size).toBe(4);
      expect(evicted.has('w-1')).toBe(true);
      expect(evicted.has('w-2')).toBe(true);
    });

    it('never evicts running or waiting_human entries even when over cap', () => {
      const workflows = new Map<string, WorkflowSummaryDto>();
      // 3 terminal completions.
      workflows.set('term-1', makeWorkflow('term-1', '2026-01-01T00:00:00Z', 'completed'));
      workflows.set('term-2', makeWorkflow('term-2', '2026-01-02T00:00:00Z', 'completed'));
      workflows.set('term-3', makeWorkflow('term-3', '2026-01-03T00:00:00Z', 'completed'));
      // A running and a waiting_human entry, BOTH older than every terminal one.
      workflows.set('run-old', makeWorkflow('run-old', '2025-12-01T00:00:00Z', 'running'));
      workflows.set('gate-old', makeWorkflow('gate-old', '2025-12-02T00:00:00Z', 'waiting_human'));

      const evicted = evictTerminalIfOverCap(workflows, 2);
      // Cap is 2 terminals; 3 present -> drop oldest terminal (term-1).
      expect(evicted.has('term-1')).toBe(false);
      expect(evicted.has('term-2')).toBe(true);
      expect(evicted.has('term-3')).toBe(true);
      // Running and waiting_human entries never evicted, even though they are older.
      expect(evicted.has('run-old')).toBe(true);
      expect(evicted.has('gate-old')).toBe(true);
    });
  });
});
