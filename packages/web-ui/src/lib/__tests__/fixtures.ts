// ---------------------------------------------------------------------------
// Shared test factories
// ---------------------------------------------------------------------------

import type { BudgetSummaryDto, SessionDto } from '../types.js';
import { vi } from 'vitest';

export function createMockWsClient(
  request = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(),
) {
  const events = new Set<(event: string, payload: unknown) => void>();
  const connections = new Set<(connected: boolean) => void>();
  let connected = false;
  return {
    request,
    connect: vi.fn(),
    disconnect: vi.fn(),
    get isConnected() {
      return connected;
    },
    onEvent: vi.fn((handler: (event: string, payload: unknown) => void) => {
      events.add(handler);
      return () => events.delete(handler);
    }),
    onConnectionChange: vi.fn((handler: (value: boolean) => void) => {
      connections.add(handler);
      return () => connections.delete(handler);
    }),
    onAuthError: vi.fn(() => () => {}),
    emitEvent(event: string, payload: unknown) {
      for (const handler of events) handler(event, payload);
    },
    emitConnectionChange(value: boolean) {
      connected = value;
      for (const handler of connections) handler(value);
    },
  };
}

export function defaultRpcResponse(method: string): unknown {
  switch (method) {
    case 'status':
      return {};
    case 'config.getModelProviders':
      return { profiles: {} };
    case 'personas.listCompiles':
      return { active: [], recent: [], queueDepth: 0 };
    case 'sessions.list':
    case 'jobs.list':
    case 'escalations.list':
    case 'workflows.list':
    case 'personas.list':
      return [];
    default:
      return undefined;
  }
}

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
