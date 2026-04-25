import { describe, it, expect } from 'vitest';
import {
  mergePastRuns,
  summaryToPastRun,
  terminalSummariesAsPastRuns,
  truncate,
  isResumablePhase,
  filterPastRuns,
  countByPhase,
  formatConfidence,
  formatDurationMs,
} from './workflows-helpers.js';
import type { PastRunDto, WorkflowSummaryDto, PastRunPhase, LiveWorkflowPhase } from '$lib/types.js';

function makePastRun(overrides: Partial<PastRunDto> & Pick<PastRunDto, 'workflowId'>): PastRunDto {
  return {
    name: overrides.workflowId,
    phase: 'completed',
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

function makeSummary(
  overrides: Partial<WorkflowSummaryDto> & Pick<WorkflowSummaryDto, 'workflowId'>,
): WorkflowSummaryDto {
  return {
    name: overrides.workflowId,
    phase: 'running' as LiveWorkflowPhase,
    currentState: 'running-state',
    taskDescription: 'live task',
    round: 2,
    maxRounds: 4,
    totalTokens: 1234,
    startedAt: '2026-04-23T08:00:00.000Z',
    ...overrides,
  };
}

describe('workflows-helpers', () => {
  describe('summaryToPastRun', () => {
    it('maps fields per the F4 spec', () => {
      const summary = makeSummary({
        workflowId: 'wf-1',
        phase: 'completed',
        currentState: 'final-state',
        startedAt: '2026-04-23T07:00:00.000Z',
        latestVerdict: { stateId: 's', verdict: 'pass', confidence: 0.91 },
        error: undefined,
      });
      const row = summaryToPastRun(summary);
      expect(row.workflowId).toBe('wf-1');
      expect(row.phase).toBe('completed' as PastRunPhase);
      expect(row.timestamp).toBe('2026-04-23T07:00:00.000Z');
      expect(row.lastState).toBe('final-state');
      expect(row.durationMs).toBeUndefined();
      expect(row.workspacePath).toBeUndefined();
      expect(row.latestVerdict?.verdict).toBe('pass');
    });
  });

  describe('terminalSummariesAsPastRuns', () => {
    it('keeps only completed/failed/aborted entries', () => {
      const summaries: WorkflowSummaryDto[] = [
        makeSummary({ workflowId: 'a', phase: 'running' }),
        makeSummary({ workflowId: 'b', phase: 'waiting_human' }),
        makeSummary({ workflowId: 'c', phase: 'completed' }),
        makeSummary({ workflowId: 'd', phase: 'failed' }),
        makeSummary({ workflowId: 'e', phase: 'aborted' }),
      ];
      const out = terminalSummariesAsPastRuns(summaries);
      expect(out.map((r) => r.workflowId).sort()).toEqual(['c', 'd', 'e']);
    });
  });

  describe('mergePastRuns', () => {
    it('sorts newest-first by timestamp', () => {
      const disk = [
        makePastRun({ workflowId: 'old', timestamp: '2026-04-20T00:00:00.000Z' }),
        makePastRun({ workflowId: 'mid', timestamp: '2026-04-22T00:00:00.000Z' }),
      ];
      const inMem = [makePastRun({ workflowId: 'new', timestamp: '2026-04-23T00:00:00.000Z' })];
      const out = mergePastRuns(disk, inMem);
      expect(out.map((r) => r.workflowId)).toEqual(['new', 'mid', 'old']);
    });

    it('dedups by workflowId with in-memory winning', () => {
      const disk = [
        makePastRun({
          workflowId: 'wf-x',
          taskDescription: 'stale-on-disk',
          phase: 'completed',
          latestVerdict: { stateId: 's', verdict: 'old' },
        }),
      ];
      const inMem = [
        makePastRun({
          workflowId: 'wf-x',
          taskDescription: 'fresh-in-memory',
          phase: 'failed',
          latestVerdict: { stateId: 's', verdict: 'new' },
        }),
      ];
      const out = mergePastRuns(disk, inMem);
      expect(out).toHaveLength(1);
      expect(out[0].taskDescription).toBe('fresh-in-memory');
      expect(out[0].phase).toBe('failed');
      expect(out[0].latestVerdict?.verdict).toBe('new');
    });

    it('places invalid timestamps last', () => {
      const out = mergePastRuns(
        [
          makePastRun({ workflowId: 'bad', timestamp: 'not-a-date' }),
          makePastRun({ workflowId: 'good', timestamp: '2026-04-23T00:00:00.000Z' }),
        ],
        [],
      );
      expect(out[0].workflowId).toBe('good');
      expect(out[1].workflowId).toBe('bad');
    });
  });

  describe('truncate', () => {
    it('passes through short strings', () => {
      expect(truncate('hello', 80)).toBe('hello');
    });
    it('truncates long strings with ellipsis', () => {
      const s = 'x'.repeat(100);
      const out = truncate(s, 80);
      expect(out.length).toBe(81);
      expect(out.endsWith('…')).toBe(true);
    });
  });

  describe('isResumablePhase', () => {
    it('allows waiting_human and interrupted', () => {
      expect(isResumablePhase('waiting_human')).toBe(true);
      expect(isResumablePhase('interrupted')).toBe(true);
    });
    it('rejects terminal phases', () => {
      for (const p of ['completed', 'failed', 'aborted'] as PastRunPhase[]) {
        expect(isResumablePhase(p)).toBe(false);
      }
    });
  });

  describe('filterPastRuns + countByPhase', () => {
    const rows = [
      makePastRun({ workflowId: '1', phase: 'completed' }),
      makePastRun({ workflowId: '2', phase: 'completed' }),
      makePastRun({ workflowId: '3', phase: 'failed' }),
      makePastRun({ workflowId: '4', phase: 'aborted' }),
      makePastRun({ workflowId: '5', phase: 'interrupted' }),
      makePastRun({ workflowId: '6', phase: 'waiting_human' }),
    ];

    it('all returns everything', () => {
      expect(filterPastRuns(rows, 'all')).toHaveLength(6);
    });

    it('failed returns only failed rows', () => {
      const out = filterPastRuns(rows, 'failed');
      expect(out).toHaveLength(1);
      expect(out[0].workflowId).toBe('3');
    });

    it('counts each phase plus the total', () => {
      const counts = countByPhase(rows);
      expect(counts.all).toBe(6);
      expect(counts.completed).toBe(2);
      expect(counts.failed).toBe(1);
      expect(counts.aborted).toBe(1);
      expect(counts.interrupted).toBe(1);
      expect(counts.waiting_human).toBe(1);
    });
  });

  describe('formatConfidence', () => {
    it('formats a value as percent', () => {
      expect(formatConfidence(0.91)).toBe('91%');
      expect(formatConfidence(0)).toBe('0%');
      expect(formatConfidence(1)).toBe('100%');
    });
    it('returns empty for undefined / NaN', () => {
      expect(formatConfidence(undefined)).toBe('');
      expect(formatConfidence(Number.NaN)).toBe('');
    });
  });

  describe('formatDurationMs', () => {
    it('handles seconds', () => {
      expect(formatDurationMs(12_000)).toBe('12s');
    });
    it('handles minutes/seconds', () => {
      expect(formatDurationMs(184_000)).toBe('3m 04s');
    });
    it('handles hours/minutes', () => {
      expect(formatDurationMs(3_720_000)).toBe('1h 02m');
    });
    it('returns empty for undefined or negative', () => {
      expect(formatDurationMs(undefined)).toBe('');
      expect(formatDurationMs(-1)).toBe('');
    });
  });
});
