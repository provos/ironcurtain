import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEvent, type AppStateLike, type EventSideEffects } from '../event-handler.js';
import type { SessionDto, EscalationDto, BudgetSummaryDto, OutputLine, PendingEscalation } from '../types.js';

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
});
