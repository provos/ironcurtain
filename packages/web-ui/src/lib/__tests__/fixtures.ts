// ---------------------------------------------------------------------------
// Shared test factories
// ---------------------------------------------------------------------------

import type { BudgetSummaryDto, SessionDto } from '../types.js';

/** A zeroed BudgetSummaryDto with all limits disabled. */
export function mockBudget(): BudgetSummaryDto {
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

/** A ready web-source SessionDto; `overrides` replace fields after the defaults. */
export function mockSession(label: number, overrides: Partial<SessionDto> = {}): SessionDto {
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

/** A promise whose resolve/reject are reachable from the test body. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
