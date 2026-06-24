import { describe, it, expect } from 'vitest';
import {
  computeWorkflowKpis,
  buildPhaseDistribution,
  sumWorkflowTokens,
  formatTokens,
  DISTRIBUTION_PHASES,
} from './dashboard-helpers.js';
import type { PastRunDto, WorkflowSummaryDto, LiveWorkflowPhase, PastRunPhase } from '$lib/types.js';

function makeSummary(
  overrides: Partial<WorkflowSummaryDto> & Pick<WorkflowSummaryDto, 'workflowId'>,
): WorkflowSummaryDto {
  return {
    name: overrides.workflowId,
    phase: 'running' as LiveWorkflowPhase,
    currentState: 'state',
    startedAt: '2026-04-22T10:00:00.000Z',
    taskDescription: 'live task',
    round: 1,
    maxRounds: 3,
    totalTokens: 0,
    ...overrides,
  };
}

function makePastRun(overrides: Partial<PastRunDto> & Pick<PastRunDto, 'workflowId'>): PastRunDto {
  return {
    name: overrides.workflowId,
    phase: 'completed' as PastRunPhase,
    currentState: 'done',
    taskDescription: 'a task',
    round: 1,
    maxRounds: 3,
    totalTokens: 0,
    timestamp: '2026-04-22T10:00:00.000Z',
    lastState: 'done',
    ...overrides,
  };
}

describe('computeWorkflowKpis', () => {
  it('counts only running / waiting_human live workflows as active', () => {
    const live = [
      makeSummary({ workflowId: 'a', phase: 'running' }),
      makeSummary({ workflowId: 'b', phase: 'waiting_human' }),
      // A terminal live entry must not be counted as active.
      makeSummary({ workflowId: 'c', phase: 'completed' }),
    ];
    const kpis = computeWorkflowKpis(live, [], 0);
    expect(kpis.active).toBe(2);
  });

  it('passes through the supplied awaiting-gate count', () => {
    expect(computeWorkflowKpis([], [], 3).awaitingGate).toBe(3);
  });

  it('splits past runs into completed vs issues (failed/aborted/interrupted)', () => {
    const past = [
      makePastRun({ workflowId: '1', phase: 'completed' }),
      makePastRun({ workflowId: '2', phase: 'completed' }),
      makePastRun({ workflowId: '3', phase: 'failed' }),
      makePastRun({ workflowId: '4', phase: 'aborted' }),
      makePastRun({ workflowId: '5', phase: 'interrupted' }),
      // waiting_human is neither completed nor an "issue" outcome.
      makePastRun({ workflowId: '6', phase: 'waiting_human' }),
    ];
    const kpis = computeWorkflowKpis([], past, 0);
    expect(kpis.completed).toBe(2);
    expect(kpis.issues).toBe(3);
  });

  it('returns all zeros for empty inputs', () => {
    expect(computeWorkflowKpis([], [], 0)).toEqual({ active: 0, awaitingGate: 0, completed: 0, issues: 0 });
  });
});

describe('buildPhaseDistribution', () => {
  it('tallies live active + past phases and computes percentages summing to 100', () => {
    const live = [
      makeSummary({ workflowId: 'a', phase: 'running' }),
      makeSummary({ workflowId: 'b', phase: 'waiting_human' }),
    ];
    const past = [
      makePastRun({ workflowId: '1', phase: 'waiting_human' }),
      makePastRun({ workflowId: '2', phase: 'completed' }),
      makePastRun({ workflowId: '3', phase: 'completed' }),
      makePastRun({ workflowId: '4', phase: 'failed' }),
      makePastRun({ workflowId: '5', phase: 'aborted' }),
      makePastRun({ workflowId: '6', phase: 'interrupted' }),
    ];
    const { segments, total } = buildPhaseDistribution(live, past);
    expect(total).toBe(8);

    const byPhase = Object.fromEntries(segments.map((s) => [s.phase, s.count]));
    expect(byPhase.running).toBe(1);
    expect(byPhase.waiting_human).toBe(2);
    expect(byPhase.completed).toBe(2);
    expect(byPhase.failed).toBe(1);
    expect(byPhase.aborted).toBe(1);
    expect(byPhase.interrupted).toBe(1);

    const pctSum = segments.reduce((acc, s) => acc + s.pct, 0);
    expect(pctSum).toBeCloseTo(100, 6);
  });

  it('returns a segment per distribution phase, in order, even when empty', () => {
    const { segments, total } = buildPhaseDistribution([], []);
    expect(total).toBe(0);
    expect(segments.map((s) => s.phase)).toEqual([...DISTRIBUTION_PHASES]);
    expect(segments.every((s) => s.count === 0 && s.pct === 0)).toBe(true);
  });

  it('ignores terminal live entries (only running/waiting_human contribute from live)', () => {
    const live = [makeSummary({ workflowId: 'x', phase: 'completed' })];
    const { total } = buildPhaseDistribution(live, []);
    expect(total).toBe(0);
  });
});

describe('sumWorkflowTokens', () => {
  it('sums tokens across live and past, coalescing missing values to 0', () => {
    const live = [
      makeSummary({ workflowId: 'a', totalTokens: 1000 }),
      // Simulate the slim live summary the daemon/mock may omit totalTokens on.
      makeSummary({ workflowId: 'b', totalTokens: undefined as unknown as number }),
    ];
    const past = [
      makePastRun({ workflowId: '1', totalTokens: 48200 }),
      makePastRun({ workflowId: '2', totalTokens: 300 }),
    ];
    expect(sumWorkflowTokens(live, past)).toBe(49500);
  });

  it('returns 0 for empty inputs', () => {
    expect(sumWorkflowTokens([], [])).toBe(0);
  });
});

describe('formatTokens', () => {
  it('formats small, thousand, and million ranges', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(942)).toBe('942');
    expect(formatTokens(4521)).toBe('4.5k');
    expect(formatTokens(173_400)).toBe('173k');
    expect(formatTokens(2_100_000)).toBe('2.1M');
  });

  it('promotes the rounding boundary to "M" instead of emitting "1000k"', () => {
    expect(formatTokens(999_499)).toBe('999k');
    expect(formatTokens(999_999)).toBe('1.0M');
  });

  it('guards against negative / non-finite input', () => {
    expect(formatTokens(-5)).toBe('0');
    expect(formatTokens(Number.NaN)).toBe('0');
  });
});
