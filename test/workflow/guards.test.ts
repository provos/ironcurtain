import { describe, it, expect } from 'vitest';
import { guardImplementations, REGISTERED_GUARDS } from '../../src/workflow/guards.js';
import type { WorkflowContext, WorkflowEvent, AgentOutput } from '../../src/workflow/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    taskDescription: 'test task',
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
    previousAgentNotes: null,
    previousStateName: null,
    visitCounts: {},
    ...overrides,
  };
}

function makeOutput(overrides: Partial<AgentOutput> = {}): AgentOutput {
  return {
    completed: true,
    verdict: 'approved',
    confidence: 'high',
    escalation: null,
    testCount: null,
    notes: null,
    ...overrides,
  };
}

function completedEvent(outputOverrides: Partial<AgentOutput> = {}): WorkflowEvent {
  return { type: 'AGENT_COMPLETED', output: makeOutput(outputOverrides) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const { isRoundLimitReached, isStalled, isPassed } = guardImplementations;

describe('REGISTERED_GUARDS', () => {
  it('contains all guard names', () => {
    expect(REGISTERED_GUARDS).toContain('isRoundLimitReached');
    expect(REGISTERED_GUARDS).toContain('isStalled');
    expect(REGISTERED_GUARDS).toContain('isPassed');
  });

  it('does not contain removed guards', () => {
    expect(REGISTERED_GUARDS).not.toContain('isApproved');
    expect(REGISTERED_GUARDS).not.toContain('isRejected');
  });

  it('matches the keys of guardImplementations', () => {
    expect(REGISTERED_GUARDS.size).toBe(Object.keys(guardImplementations).length);
    for (const key of Object.keys(guardImplementations)) {
      expect(REGISTERED_GUARDS).toContain(key);
    }
  });
});

describe('isRoundLimitReached', () => {
  it('returns true when any state visit count >= maxRounds', () => {
    expect(
      isRoundLimitReached({
        context: baseContext({ visitCounts: { implement: 4 }, maxRounds: 4 }),
        event: completedEvent(),
      }),
    ).toBe(true);
  });

  it('returns true when visit count exceeds maxRounds', () => {
    expect(
      isRoundLimitReached({
        context: baseContext({ visitCounts: { implement: 5, review: 4 }, maxRounds: 4 }),
        event: completedEvent(),
      }),
    ).toBe(true);
  });

  it('returns false when all visit counts < maxRounds', () => {
    expect(
      isRoundLimitReached({
        context: baseContext({ visitCounts: { implement: 2, review: 1 }, maxRounds: 4 }),
        event: completedEvent(),
      }),
    ).toBe(false);
  });

  it('returns false when visitCounts is empty', () => {
    expect(
      isRoundLimitReached({
        context: baseContext({ visitCounts: {}, maxRounds: 4 }),
        event: completedEvent(),
      }),
    ).toBe(false);
  });
});

describe('isStalled', () => {
  it('returns false for non-agent events', () => {
    expect(isStalled({ context: baseContext(), event: { type: 'VALIDATION_FAILED', errors: 'err' } })).toBe(false);
  });

  it('returns false for agent completed events (Phase 1 stub)', () => {
    // Stall detection requires machine builder integration for stateId+hash
    expect(isStalled({ context: baseContext(), event: completedEvent() })).toBe(false);
  });
});

describe('isPassed', () => {
  it('returns true for VALIDATION_PASSED event', () => {
    expect(isPassed({ context: baseContext(), event: { type: 'VALIDATION_PASSED', testCount: 42 } })).toBe(true);
  });

  it('returns false for VALIDATION_FAILED event', () => {
    expect(isPassed({ context: baseContext(), event: { type: 'VALIDATION_FAILED', errors: 'fail' } })).toBe(false);
  });

  it('returns false for AGENT_COMPLETED event', () => {
    expect(isPassed({ context: baseContext(), event: completedEvent() })).toBe(false);
  });
});
