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
    sessionsByRole: {},
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

const { isApproved, isRejected, isLowConfidence, isRoundLimitReached, isStalled, hasTestCountRegression, isPassed } =
  guardImplementations;

describe('REGISTERED_GUARDS', () => {
  it('contains all guard names', () => {
    expect(REGISTERED_GUARDS).toContain('isApproved');
    expect(REGISTERED_GUARDS).toContain('isRejected');
    expect(REGISTERED_GUARDS).toContain('isLowConfidence');
    expect(REGISTERED_GUARDS).toContain('isRoundLimitReached');
    expect(REGISTERED_GUARDS).toContain('isStalled');
    expect(REGISTERED_GUARDS).toContain('hasTestCountRegression');
    expect(REGISTERED_GUARDS).toContain('isPassed');
  });

  it('matches the keys of guardImplementations', () => {
    expect(REGISTERED_GUARDS.size).toBe(Object.keys(guardImplementations).length);
    for (const key of Object.keys(guardImplementations)) {
      expect(REGISTERED_GUARDS).toContain(key);
    }
  });
});

describe('isApproved', () => {
  it('returns true for approved verdict', () => {
    expect(isApproved({ context: baseContext(), event: completedEvent({ verdict: 'approved' }) })).toBe(true);
  });

  it('returns true for approved with low confidence', () => {
    expect(
      isApproved({
        context: baseContext(),
        event: completedEvent({ verdict: 'approved', confidence: 'low' }),
      }),
    ).toBe(true);
  });

  it('returns false for rejected verdict', () => {
    expect(isApproved({ context: baseContext(), event: completedEvent({ verdict: 'rejected' }) })).toBe(false);
  });

  it('returns false for non-agent events', () => {
    expect(isApproved({ context: baseContext(), event: { type: 'AGENT_FAILED', error: 'oops' } })).toBe(false);
  });
});

describe('isRejected', () => {
  it('returns true for rejected verdict', () => {
    expect(isRejected({ context: baseContext(), event: completedEvent({ verdict: 'rejected' }) })).toBe(true);
  });

  it('returns false for approved verdict', () => {
    expect(isRejected({ context: baseContext(), event: completedEvent({ verdict: 'approved' }) })).toBe(false);
  });
});

describe('isLowConfidence', () => {
  it('returns true for approved + low confidence', () => {
    expect(
      isLowConfidence({
        context: baseContext(),
        event: completedEvent({ verdict: 'approved', confidence: 'low' }),
      }),
    ).toBe(true);
  });

  it('returns false for approved + high confidence', () => {
    expect(
      isLowConfidence({
        context: baseContext(),
        event: completedEvent({ verdict: 'approved', confidence: 'high' }),
      }),
    ).toBe(false);
  });

  it('returns false for rejected + low confidence', () => {
    expect(
      isLowConfidence({
        context: baseContext(),
        event: completedEvent({ verdict: 'rejected', confidence: 'low' }),
      }),
    ).toBe(false);
  });
});

describe('isRoundLimitReached', () => {
  it('returns true when round >= maxRounds', () => {
    expect(
      isRoundLimitReached({
        context: baseContext({ round: 4, maxRounds: 4 }),
        event: completedEvent(),
      }),
    ).toBe(true);
  });

  it('returns true when round exceeds maxRounds', () => {
    expect(
      isRoundLimitReached({
        context: baseContext({ round: 5, maxRounds: 4 }),
        event: completedEvent(),
      }),
    ).toBe(true);
  });

  it('returns false when round < maxRounds', () => {
    expect(
      isRoundLimitReached({
        context: baseContext({ round: 2, maxRounds: 4 }),
        event: completedEvent(),
      }),
    ).toBe(false);
  });
});

describe('isStalled', () => {
  it('returns false for non-agent events', () => {
    expect(isStalled({ context: baseContext(), event: { type: 'AGENT_FAILED', error: 'err' } })).toBe(false);
  });

  it('returns false for agent completed events (Phase 1 stub)', () => {
    // Stall detection requires machine builder integration for stateId+hash
    expect(isStalled({ context: baseContext(), event: completedEvent() })).toBe(false);
  });
});

describe('hasTestCountRegression', () => {
  it('detects count decrease', () => {
    expect(
      hasTestCountRegression({
        context: baseContext({ previousTestCount: 10 }),
        event: completedEvent({ testCount: 5 }),
      }),
    ).toBe(true);
  });

  it('returns false when count increases', () => {
    expect(
      hasTestCountRegression({
        context: baseContext({ previousTestCount: 5 }),
        event: completedEvent({ testCount: 10 }),
      }),
    ).toBe(false);
  });

  it('returns false when count is equal', () => {
    expect(
      hasTestCountRegression({
        context: baseContext({ previousTestCount: 10 }),
        event: completedEvent({ testCount: 10 }),
      }),
    ).toBe(false);
  });

  it('returns false when previousTestCount is null', () => {
    expect(
      hasTestCountRegression({
        context: baseContext({ previousTestCount: null }),
        event: completedEvent({ testCount: 5 }),
      }),
    ).toBe(false);
  });

  it('returns false when current testCount is null', () => {
    expect(
      hasTestCountRegression({
        context: baseContext({ previousTestCount: 10 }),
        event: completedEvent({ testCount: null }),
      }),
    ).toBe(false);
  });

  it('returns false for non-agent events', () => {
    expect(
      hasTestCountRegression({
        context: baseContext({ previousTestCount: 10 }),
        event: { type: 'AGENT_FAILED', error: 'err' },
      }),
    ).toBe(false);
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
