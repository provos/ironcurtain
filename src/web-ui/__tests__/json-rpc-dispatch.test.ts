/**
 * Unit tests for the dispatch() function in json-rpc-dispatch.ts.
 *
 * Validates Zod param parsing, DTO builders, method routing,
 * and error code mapping without needing a running daemon.
 */

/* eslint-disable @typescript-eslint/unbound-method */

import { describe, it, expect, vi } from 'vitest';

import { dispatch, toSessionDto, toBudgetDto, buildStatusDto, type DispatchContext } from '../json-rpc-dispatch.js';
import {
  type MethodName,
  InvalidParamsError,
  SessionNotFoundError,
  MethodNotFoundError,
  RpcError,
} from '../web-ui-types.js';
import { WebEventBus } from '../web-event-bus.js';
import { SessionManager, type ManagedSession, type PendingEscalationData } from '../../session/session-manager.js';
import type { ControlRequestHandler, DaemonStatus } from '../../daemon/control-socket.js';
import type { Session, SessionInfo, BudgetStatus, ConversationTurn, DiagnosticEvent } from '../../session/types.js';
import type { Transport } from '../../session/transport.js';
import type { JobDefinition, JobId, RunRecord } from '../../cron/types.js';

// ---------------------------------------------------------------------------
// Mock external modules that dispatch() calls directly
// ---------------------------------------------------------------------------

vi.mock('../../cron/job-store.js', () => ({
  loadRecentRuns: vi.fn().mockReturnValue([]),
}));

vi.mock('../../mux/persona-scanner.js', () => ({
  scanPersonas: vi.fn().mockReturnValue([
    { name: 'code-reviewer', description: 'Reviews pull requests', compiled: true },
    { name: 'writer', description: 'Writes documentation', compiled: false },
  ]),
}));

// Mock createSession and loadConfig so sessions.create doesn't blow up
// (we don't test createWebSession in depth here)
vi.mock('../../config/index.js', () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));
vi.mock('../../session/index.js', () => ({
  createSession: vi.fn().mockResolvedValue({}),
}));
// shouldAutoSaveMemory now takes (config, scope?) but the mock returns
// the same value regardless of arguments — no signature update needed.
vi.mock('../../memory/auto-save.js', () => ({
  shouldAutoSaveMemory: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function createMockBudgetStatus(): BudgetStatus {
  return {
    totalInputTokens: 5000,
    totalOutputTokens: 2000,
    totalTokens: 7000,
    stepCount: 10,
    elapsedSeconds: 120,
    estimatedCostUsd: 0.15,
    tokenTrackingAvailable: true,
    limits: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5.0,
      warnThresholdPercent: 80,
    },
    cumulative: {
      totalInputTokens: 5000,
      totalOutputTokens: 2000,
      totalTokens: 7000,
      stepCount: 10,
      activeSeconds: 120,
      estimatedCostUsd: 0.15,
    },
  };
}

function createMockSessionInfo(overrides?: Partial<SessionInfo>): SessionInfo {
  return {
    id: 'test-session-id' as SessionInfo['id'],
    status: 'ready',
    turnCount: 3,
    createdAt: '2026-01-15T10:00:00.000Z',
    ...overrides,
  };
}

function createMockSession(overrides?: { info?: Partial<SessionInfo>; budgetStatus?: Partial<BudgetStatus> }): Session {
  const info = createMockSessionInfo(overrides?.info);
  const budgetStatus = { ...createMockBudgetStatus(), ...overrides?.budgetStatus };
  return {
    getInfo: vi.fn().mockReturnValue(info),
    getBudgetStatus: vi.fn().mockReturnValue(budgetStatus),
    getHistory: vi.fn().mockReturnValue([
      {
        turnNumber: 1,
        userMessage: 'Hello',
        assistantResponse: 'Hi there!',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0 },
        timestamp: '2026-01-15T10:00:00.000Z',
      },
    ] satisfies ConversationTurn[]),
    getDiagnosticLog: vi
      .fn()
      .mockReturnValue([
        { kind: 'tool_call', toolName: 'read_file', preview: '/tmp/test.txt' },
      ] satisfies DiagnosticEvent[]),
    sendMessage: vi.fn().mockResolvedValue('response'),
    resolveEscalation: vi.fn().mockResolvedValue(undefined),
    getPendingEscalation: vi.fn().mockReturnValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockTransport(): Transport & { forwardMessage: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    forwardMessage: vi.fn().mockResolvedValue('mock response'),
  };
}

function createMockManagedSession(overrides?: {
  label?: number;
  sourceKind?: 'signal' | 'cron' | 'web';
  persona?: string;
  pendingEscalation?: PendingEscalationData | null;
  messageInFlight?: boolean;
}): ManagedSession {
  const label = overrides?.label ?? 1;
  const sourceKind = overrides?.sourceKind ?? 'web';
  const source =
    sourceKind === 'cron'
      ? { kind: 'cron' as const, jobId: 'test-job' as JobDefinition['id'], jobName: 'Test Job' }
      : sourceKind === 'signal'
        ? { kind: 'signal' as const }
        : { kind: 'web' as const, persona: overrides?.persona };

  return {
    label,
    session: createMockSession(),
    transport: createMockTransport(),
    source,
    messageInFlight: overrides?.messageInFlight ?? false,
    pendingEscalation: overrides?.pendingEscalation ?? null,
    escalationResolving: false,
    runPromise: null,
  };
}

function createMockDaemonStatus(): DaemonStatus {
  return {
    uptimeSeconds: 300,
    jobs: { total: 2, enabled: 2, running: 1 },
    signalConnected: true,
    nextFireTime: new Date('2026-01-15T12:00:00.000Z'),
  };
}

function createMockHandler(overrides?: Partial<ControlRequestHandler>): ControlRequestHandler {
  return {
    getStatus: vi.fn().mockReturnValue(createMockDaemonStatus()),
    addJob: vi.fn().mockResolvedValue(undefined),
    removeJob: vi.fn().mockResolvedValue(undefined),
    enableJob: vi.fn().mockResolvedValue(undefined),
    disableJob: vi.fn().mockResolvedValue(undefined),
    recompileJob: vi.fn().mockResolvedValue(undefined),
    reloadJob: vi.fn().mockResolvedValue(undefined),
    runJobNow: vi.fn().mockResolvedValue({
      startedAt: '2026-01-15T10:00:00.000Z',
      completedAt: '2026-01-15T10:05:00.000Z',
      outcome: { kind: 'success' },
      budget: { totalTokens: 5000, stepCount: 10, elapsedSeconds: 300, estimatedCostUsd: 0.1 },
      summary: 'Job completed successfully',
      escalationsEncountered: 0,
      escalationsApproved: 0,
      discardedChanges: null,
    } satisfies RunRecord),
    listJobs: vi.fn().mockReturnValue([
      {
        job: {
          id: 'daily-review' as JobId,
          name: 'Daily Code Review',
          schedule: '0 9 * * 1-5',
          taskDescription: 'Review PRs',
          taskConstitution: 'Read-only access',
          notifyOnEscalation: false,
          notifyOnCompletion: true,
          enabled: true,
        } satisfies JobDefinition,
        nextRun: new Date('2026-01-16T09:00:00.000Z'),
        lastRun: undefined,
        isRunning: false,
      },
      {
        job: {
          id: 'nightly-sync' as JobId,
          name: 'Nightly Sync',
          schedule: '0 2 * * *',
          taskDescription: 'Sync repos',
          taskConstitution: 'Allow git operations',
          notifyOnEscalation: true,
          notifyOnCompletion: true,
          enabled: true,
        } satisfies JobDefinition,
        nextRun: new Date('2026-01-16T02:00:00.000Z'),
        lastRun: {
          startedAt: '2026-01-15T02:00:00.000Z',
          completedAt: '2026-01-15T02:10:00.000Z',
          outcome: { kind: 'success' },
          budget: { totalTokens: 3000, stepCount: 5, elapsedSeconds: 600, estimatedCostUsd: 0.05 },
          summary: 'Synced 3 repos',
          escalationsEncountered: 0,
          escalationsApproved: 0,
          discardedChanges: null,
        } satisfies RunRecord,
        isRunning: false,
      },
    ]),
    ...overrides,
  } as ControlRequestHandler;
}

function createMockContext(overrides?: Partial<DispatchContext>): DispatchContext {
  const sessionManager = new SessionManager();
  const managed1 = createMockManagedSession({ label: 1, sourceKind: 'web', persona: 'code-reviewer' });
  const managed2 = createMockManagedSession({ label: 2, sourceKind: 'cron' });

  // Register sessions so sessionManager.get/all/byKind work
  sessionManager.register(managed1.session, managed1.transport, managed1.source);
  sessionManager.register(managed2.session, managed2.transport, managed2.source);

  return {
    handler: createMockHandler(),
    sessionManager,
    mode: { kind: 'docker', agent: 'claude-code' as never },
    eventBus: new WebEventBus(),
    maxConcurrentWebSessions: 5,
    sessionQueues: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatch()', () => {
  // -----------------------------------------------------------------------
  // Zod validation
  // -----------------------------------------------------------------------
  describe('Zod param validation', () => {
    it('rejects sessions.send with missing label', async () => {
      const ctx = createMockContext();
      await expect(dispatch(ctx, 'sessions.send', { text: 'hello' })).rejects.toThrow(InvalidParamsError);
    });

    it('rejects sessions.send with missing text', async () => {
      const ctx = createMockContext();
      await expect(dispatch(ctx, 'sessions.send', { label: 1 })).rejects.toThrow(InvalidParamsError);
    });

    it('rejects sessions.send with non-integer label', async () => {
      const ctx = createMockContext();
      await expect(dispatch(ctx, 'sessions.send', { label: 1.5, text: 'hi' })).rejects.toThrow(InvalidParamsError);
    });

    it('rejects sessions.send with empty text', async () => {
      const ctx = createMockContext();
      await expect(dispatch(ctx, 'sessions.send', { label: 1, text: '' })).rejects.toThrow(InvalidParamsError);
    });

    it('rejects sessions.end with non-positive label', async () => {
      const ctx = createMockContext();
      await expect(dispatch(ctx, 'sessions.end', { label: 0 })).rejects.toThrow(InvalidParamsError);
    });

    it('rejects sessions.end with negative label', async () => {
      const ctx = createMockContext();
      await expect(dispatch(ctx, 'sessions.end', { label: -1 })).rejects.toThrow(InvalidParamsError);
    });

    it('rejects escalations.resolve with invalid decision', async () => {
      const ctx = createMockContext();
      await expect(
        dispatch(ctx, 'escalations.resolve', {
          escalationId: 'esc-1',
          decision: 'maybe',
        }),
      ).rejects.toThrow(InvalidParamsError);
    });

    it('rejects escalations.resolve with missing escalationId', async () => {
      const ctx = createMockContext();
      await expect(
        dispatch(ctx, 'escalations.resolve', {
          decision: 'approved',
        }),
      ).rejects.toThrow(InvalidParamsError);
    });

    it('rejects jobs.remove with empty jobId', async () => {
      const ctx = createMockContext();
      await expect(dispatch(ctx, 'jobs.remove', { jobId: '' })).rejects.toThrow(InvalidParamsError);
    });

    it('rejects jobs.remove with missing jobId', async () => {
      const ctx = createMockContext();
      await expect(dispatch(ctx, 'jobs.remove', {})).rejects.toThrow(InvalidParamsError);
    });

    it('accepts escalations.resolve with valid approved decision', async () => {
      const ctx = createMockContext();
      // Will throw ESCALATION_NOT_FOUND since no escalation is pending, but not InvalidParamsError
      await expect(
        dispatch(ctx, 'escalations.resolve', {
          escalationId: 'esc-1',
          decision: 'approved',
        }),
      ).rejects.toThrow(RpcError);
      await expect(
        dispatch(ctx, 'escalations.resolve', {
          escalationId: 'esc-1',
          decision: 'approved',
        }),
      ).rejects.not.toThrow(InvalidParamsError);
    });

    it('accepts escalations.resolve with valid denied decision', async () => {
      const ctx = createMockContext();
      await expect(
        dispatch(ctx, 'escalations.resolve', {
          escalationId: 'esc-1',
          decision: 'denied',
        }),
      ).rejects.toThrow(RpcError);
      await expect(
        dispatch(ctx, 'escalations.resolve', {
          escalationId: 'esc-1',
          decision: 'denied',
        }),
      ).rejects.not.toThrow(InvalidParamsError);
    });
  });

  // -----------------------------------------------------------------------
  // Method dispatch / routing
  // -----------------------------------------------------------------------
  describe('method dispatch', () => {
    it('status returns a DaemonStatusDto', async () => {
      const ctx = createMockContext();
      const result = (await dispatch(ctx, 'status', {})) as Record<string, unknown>;
      expect(result).toHaveProperty('uptimeSeconds', 300);
      expect(result).toHaveProperty('jobs');
      expect(result).toHaveProperty('signalConnected', true);
      expect(result).toHaveProperty('webUiListening', true);
      expect(result).toHaveProperty('activeSessions');
      expect(result).toHaveProperty('nextFireTime');
      // nextFireTime should be an ISO string (Date serialized)
      expect(typeof result.nextFireTime).toBe('string');
    });

    it('jobs.list returns array of JobListDto', async () => {
      const ctx = createMockContext();
      const result = (await dispatch(ctx, 'jobs.list', {})) as Array<Record<string, unknown>>;
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('job');
      expect(result[0]).toHaveProperty('nextRun');
      expect(result[0]).toHaveProperty('isRunning', false);
      // nextRun should be serialized as ISO string
      expect(typeof result[0].nextRun).toBe('string');
    });

    it('jobs.list returns null for lastRun when undefined', async () => {
      const ctx = createMockContext();
      const result = (await dispatch(ctx, 'jobs.list', {})) as Array<Record<string, unknown>>;
      expect(result[0].lastRun).toBeNull();
    });

    it('jobs.list returns RunRecord for lastRun when present', async () => {
      const ctx = createMockContext();
      const result = (await dispatch(ctx, 'jobs.list', {})) as Array<Record<string, unknown>>;
      expect(result[1].lastRun).not.toBeNull();
      expect((result[1].lastRun as RunRecord).outcome).toEqual({ kind: 'success' });
    });

    it('jobs.run returns accepted and emits job.started', async () => {
      const ctx = createMockContext();
      const emitSpy = vi.spyOn(ctx.eventBus, 'emit');

      const result = (await dispatch(ctx, 'jobs.run', { jobId: 'daily-review' })) as Record<string, unknown>;
      expect(result).toEqual({ accepted: true, jobId: 'daily-review' });
      expect(emitSpy).toHaveBeenCalledWith('job.started', { jobId: 'daily-review', sessionLabel: 0 });
    });

    it('jobs.enable calls handler.enableJob and emits job.list_changed', async () => {
      const ctx = createMockContext();
      const emitSpy = vi.spyOn(ctx.eventBus, 'emit');

      await dispatch(ctx, 'jobs.enable', { jobId: 'daily-review' });
      expect(vi.mocked(ctx.handler.enableJob)).toHaveBeenCalledWith('daily-review');
      expect(emitSpy).toHaveBeenCalledWith('job.list_changed', {});
    });

    it('jobs.disable calls handler.disableJob and emits job.list_changed', async () => {
      const ctx = createMockContext();
      const emitSpy = vi.spyOn(ctx.eventBus, 'emit');

      await dispatch(ctx, 'jobs.disable', { jobId: 'nightly-sync' });
      expect(vi.mocked(ctx.handler.disableJob)).toHaveBeenCalledWith('nightly-sync');
      expect(emitSpy).toHaveBeenCalledWith('job.list_changed', {});
    });

    it('jobs.remove calls handler.removeJob and emits job.list_changed', async () => {
      const ctx = createMockContext();
      const emitSpy = vi.spyOn(ctx.eventBus, 'emit');

      await dispatch(ctx, 'jobs.remove', { jobId: 'daily-review' });
      expect(vi.mocked(ctx.handler.removeJob)).toHaveBeenCalledWith('daily-review');
      expect(emitSpy).toHaveBeenCalledWith('job.list_changed', {});
    });

    it('jobs.recompile calls handler.recompileJob without emitting', async () => {
      const ctx = createMockContext();
      const emitSpy = vi.spyOn(ctx.eventBus, 'emit');

      await dispatch(ctx, 'jobs.recompile', { jobId: 'daily-review' });
      expect(vi.mocked(ctx.handler.recompileJob)).toHaveBeenCalledWith('daily-review');
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it('jobs.reload calls handler.reloadJob and emits job.list_changed', async () => {
      const ctx = createMockContext();
      const emitSpy = vi.spyOn(ctx.eventBus, 'emit');

      await dispatch(ctx, 'jobs.reload', { jobId: 'daily-review' });
      expect(vi.mocked(ctx.handler.reloadJob)).toHaveBeenCalledWith('daily-review');
      expect(emitSpy).toHaveBeenCalledWith('job.list_changed', {});
    });

    it('sessions.list returns array of SessionDto', async () => {
      const ctx = createMockContext();
      const result = (await dispatch(ctx, 'sessions.list', {})) as Array<Record<string, unknown>>;
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      // Each entry should have SessionDto shape
      for (const dto of result) {
        expect(dto).toHaveProperty('label');
        expect(dto).toHaveProperty('source');
        expect(dto).toHaveProperty('status');
        expect(dto).toHaveProperty('turnCount');
        expect(dto).toHaveProperty('budget');
      }
    });

    it('sessions.get returns SessionDetailDto for existing session', async () => {
      const ctx = createMockContext();
      const result = (await dispatch(ctx, 'sessions.get', { label: 1 })) as Record<string, unknown>;
      expect(result).toHaveProperty('label', 1);
      expect(result).toHaveProperty('history');
      expect(result).toHaveProperty('diagnosticLog');
      expect(Array.isArray(result.history)).toBe(true);
      expect(Array.isArray(result.diagnosticLog)).toBe(true);
    });

    it('sessions.budget returns BudgetSummaryDto for valid session', async () => {
      const ctx = createMockContext();
      const result = (await dispatch(ctx, 'sessions.budget', { label: 1 })) as Record<string, unknown>;
      expect(result).toHaveProperty('totalTokens');
      expect(result).toHaveProperty('stepCount');
      expect(result).toHaveProperty('elapsedSeconds');
      expect(result).toHaveProperty('estimatedCostUsd');
      expect(result).toHaveProperty('tokenTrackingAvailable');
      expect(result).toHaveProperty('limits');
    });

    it('sessions.history returns conversation turns', async () => {
      const ctx = createMockContext();
      const result = (await dispatch(ctx, 'sessions.history', { label: 1 })) as ConversationTurn[];
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toHaveProperty('turnNumber', 1);
      expect(result[0]).toHaveProperty('userMessage', 'Hello');
    });

    it('sessions.diagnostics returns diagnostic log', async () => {
      const ctx = createMockContext();
      const result = (await dispatch(ctx, 'sessions.diagnostics', { label: 1 })) as DiagnosticEvent[];
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toHaveProperty('kind', 'tool_call');
    });

    it('sessions.send to a web session returns accepted', async () => {
      const ctx = createMockContext();
      const result = (await dispatch(ctx, 'sessions.send', { label: 1, text: 'hello' })) as Record<string, unknown>;
      expect(result).toEqual({ accepted: true });
    });

    it('sessions.end ends the session and emits session.ended', async () => {
      const ctx = createMockContext();
      const emitSpy = vi.spyOn(ctx.eventBus, 'emit');

      await dispatch(ctx, 'sessions.end', { label: 1 });
      expect(emitSpy).toHaveBeenCalledWith('session.ended', { label: 1, reason: 'user_ended' });
    });

    it('escalations.list returns pending escalations', async () => {
      const escalation: PendingEscalationData = {
        escalationId: 'esc-123',
        sessionLabel: 1,
        toolName: 'write_file',
        serverName: 'filesystem',
        arguments: { path: '/tmp/test.txt' },
        reason: 'Write to protected path',
        receivedAt: '2026-01-15T10:05:00.000Z',
      };

      const sessionManager = new SessionManager();
      const session = createMockSession();
      const transport = createMockTransport();
      const label = sessionManager.register(session, transport, { kind: 'web' });
      sessionManager.setPendingEscalation(label, escalation);

      const ctx = createMockContext({ sessionManager });
      const result = (await dispatch(ctx, 'escalations.list', {})) as Array<Record<string, unknown>>;
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('escalationId', 'esc-123');
      expect(result[0]).toHaveProperty('toolName', 'write_file');
      expect(result[0]).toHaveProperty('sessionSource');
    });

    it('escalations.resolve calls sessionManager.resolveSessionEscalation', async () => {
      const sessionManager = new SessionManager();
      const session = createMockSession();
      const transport = createMockTransport();
      const label = sessionManager.register(session, transport, { kind: 'web' });

      const escalation: PendingEscalationData = {
        escalationId: 'esc-456',
        sessionLabel: label,
        toolName: 'delete_file',
        serverName: 'filesystem',
        arguments: { path: '/tmp/test.txt' },
        reason: 'Delete operation',
        receivedAt: '2026-01-15T10:05:00.000Z',
      };
      sessionManager.setPendingEscalation(label, escalation);

      const ctx = createMockContext({ sessionManager });

      // Should not throw -- escalation exists and is resolved
      await dispatch(ctx, 'escalations.resolve', {
        escalationId: 'esc-456',
        decision: 'approved',
      });

      // Verify the session's resolveEscalation was called
      expect(vi.mocked(session.resolveEscalation)).toHaveBeenCalledWith('esc-456', 'approved', undefined);
    });

    it('escalations.resolve passes whitelistSelection option', async () => {
      const sessionManager = new SessionManager();
      const session = createMockSession();
      const transport = createMockTransport();
      const label = sessionManager.register(session, transport, { kind: 'web' });

      sessionManager.setPendingEscalation(label, {
        escalationId: 'esc-789',
        sessionLabel: label,
        toolName: 'write_file',
        serverName: 'filesystem',
        arguments: {},
        reason: 'test',
        receivedAt: new Date().toISOString(),
      });

      const ctx = createMockContext({ sessionManager });

      await dispatch(ctx, 'escalations.resolve', {
        escalationId: 'esc-789',
        decision: 'denied',
        whitelistSelection: 2,
      });

      expect(vi.mocked(session.resolveEscalation)).toHaveBeenCalledWith('esc-789', 'denied', { whitelistSelection: 2 });
    });

    it('personas.list returns persona snapshots', async () => {
      const ctx = createMockContext();
      const result = (await dispatch(ctx, 'personas.list', {})) as Array<Record<string, unknown>>;
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: 'code-reviewer', description: 'Reviews pull requests', compiled: true });
      expect(result[1]).toEqual({ name: 'writer', description: 'Writes documentation', compiled: false });
    });

    it('jobs.logs calls loadRecentRuns with jobId and default limit', async () => {
      const { loadRecentRuns } = await import('../../cron/job-store.js');
      const ctx = createMockContext();

      await dispatch(ctx, 'jobs.logs', { jobId: 'daily-review' });
      expect(loadRecentRuns).toHaveBeenCalledWith('daily-review', 20);
    });

    it('jobs.logs passes custom limit', async () => {
      const { loadRecentRuns } = await import('../../cron/job-store.js');
      const ctx = createMockContext();

      await dispatch(ctx, 'jobs.logs', { jobId: 'daily-review', limit: 5 });
      expect(loadRecentRuns).toHaveBeenCalledWith('daily-review', 5);
    });
  });

  // -----------------------------------------------------------------------
  // Error codes
  // -----------------------------------------------------------------------
  describe('error codes', () => {
    it('unknown method returns MethodNotFoundError', async () => {
      const ctx = createMockContext();
      await expect(dispatch(ctx, 'not.a.real.method' as MethodName, {})).rejects.toThrow(MethodNotFoundError);
    });

    it('MethodNotFoundError has code METHOD_NOT_FOUND', async () => {
      const ctx = createMockContext();
      try {
        await dispatch(ctx, 'bogus' as MethodName, {});
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MethodNotFoundError);
        expect((err as RpcError).code).toBe('METHOD_NOT_FOUND');
      }
    });

    it('sessions.get with non-existent label returns SessionNotFoundError', async () => {
      const ctx = createMockContext();
      try {
        await dispatch(ctx, 'sessions.get', { label: 999 });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SessionNotFoundError);
        expect((err as RpcError).code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('sessions.budget with non-existent label returns SessionNotFoundError', async () => {
      const ctx = createMockContext();
      await expect(dispatch(ctx, 'sessions.budget', { label: 999 })).rejects.toThrow(SessionNotFoundError);
    });

    it('sessions.history with non-existent label returns SessionNotFoundError', async () => {
      const ctx = createMockContext();
      await expect(dispatch(ctx, 'sessions.history', { label: 999 })).rejects.toThrow(SessionNotFoundError);
    });

    it('sessions.diagnostics with non-existent label returns SessionNotFoundError', async () => {
      const ctx = createMockContext();
      await expect(dispatch(ctx, 'sessions.diagnostics', { label: 999 })).rejects.toThrow(SessionNotFoundError);
    });

    it('sessions.send to non-web session returns INVALID_PARAMS error', async () => {
      // Session #2 is a cron session in our default context
      const ctx = createMockContext();
      try {
        await dispatch(ctx, 'sessions.send', { label: 2, text: 'hello' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe('INVALID_PARAMS');
        expect((err as RpcError).message).toContain('not a web session');
      }
    });

    it('sessions.send to non-existent session returns SessionNotFoundError', async () => {
      const ctx = createMockContext();
      await expect(dispatch(ctx, 'sessions.send', { label: 999, text: 'hello' })).rejects.toThrow(SessionNotFoundError);
    });

    it('escalations.resolve when not found returns ESCALATION_NOT_FOUND', async () => {
      const ctx = createMockContext();
      try {
        await dispatch(ctx, 'escalations.resolve', {
          escalationId: 'nonexistent',
          decision: 'approved',
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe('ESCALATION_NOT_FOUND');
      }
    });

    it('escalations.resolve when already resolving returns SESSION_BUSY', async () => {
      const sessionManager = new SessionManager();
      const session = createMockSession();
      // Make resolveEscalation hang so the guard stays active
      vi.mocked(session.resolveEscalation).mockImplementation(
        () => new Promise(() => {}), // never resolves
      );
      const transport = createMockTransport();
      const label = sessionManager.register(session, transport, { kind: 'web' });

      sessionManager.setPendingEscalation(label, {
        escalationId: 'esc-busy',
        sessionLabel: label,
        toolName: 'write_file',
        serverName: 'filesystem',
        arguments: {},
        reason: 'test',
        receivedAt: new Date().toISOString(),
      });

      const ctx = createMockContext({ sessionManager });

      // First resolve call -- starts but doesn't finish (intentionally not awaited)
      void dispatch(ctx, 'escalations.resolve', {
        escalationId: 'esc-busy',
        decision: 'approved',
      });

      // Give the first call time to enter the resolving state
      await new Promise((r) => setTimeout(r, 10));

      // Second resolve call -- should hit the "already_resolving" guard
      try {
        await dispatch(ctx, 'escalations.resolve', {
          escalationId: 'esc-busy',
          decision: 'denied',
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe('SESSION_BUSY');
      }
    });
  });

  // -----------------------------------------------------------------------
  // DTO builder tests
  // -----------------------------------------------------------------------
  describe('toSessionDto()', () => {
    it('returns correct shape for a web session', () => {
      const managed = createMockManagedSession({
        label: 5,
        sourceKind: 'web',
        persona: 'code-reviewer',
      });
      const dto = toSessionDto(managed);
      expect(dto.label).toBe(5);
      expect(dto.source).toEqual({ kind: 'web', persona: 'code-reviewer' });
      expect(dto.status).toBe('ready');
      expect(dto.turnCount).toBe(3);
      expect(dto.createdAt).toBe('2026-01-15T10:00:00.000Z');
      expect(dto.hasPendingEscalation).toBe(false);
      expect(dto.messageInFlight).toBe(false);
      expect(dto.persona).toBe('code-reviewer');
      expect(dto.budget).toBeDefined();
    });

    it('includes persona only for web sessions', () => {
      const cronManaged = createMockManagedSession({ label: 3, sourceKind: 'cron' });
      const dto = toSessionDto(cronManaged);
      expect(dto.persona).toBeUndefined();
    });

    it('reflects hasPendingEscalation when escalation is set', () => {
      const managed = createMockManagedSession({
        pendingEscalation: {
          escalationId: 'esc-1',
          sessionLabel: 1,
          toolName: 'write_file',
          serverName: 'filesystem',
          arguments: {},
          reason: 'test',
          receivedAt: '2026-01-15T10:00:00.000Z',
        },
      });
      const dto = toSessionDto(managed);
      expect(dto.hasPendingEscalation).toBe(true);
    });

    it('reflects messageInFlight', () => {
      const managed = createMockManagedSession({ messageInFlight: true });
      const dto = toSessionDto(managed);
      expect(dto.messageInFlight).toBe(true);
    });
  });

  describe('toBudgetDto()', () => {
    it('returns all budget fields', () => {
      const managed = createMockManagedSession();
      const dto = toBudgetDto(managed);
      expect(dto.totalTokens).toBe(7000);
      expect(dto.stepCount).toBe(10);
      expect(dto.elapsedSeconds).toBe(120);
      expect(dto.estimatedCostUsd).toBe(0.15);
      expect(dto.tokenTrackingAvailable).toBe(true);
    });

    it('returns limits subobject', () => {
      const managed = createMockManagedSession();
      const dto = toBudgetDto(managed);
      expect(dto.limits).toEqual({
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
      });
    });
  });

  describe('buildStatusDto()', () => {
    it('returns correct DaemonStatusDto shape', () => {
      const ctx = createMockContext();
      const dto = buildStatusDto(ctx);
      expect(dto.uptimeSeconds).toBe(300);
      expect(dto.jobs).toEqual({ total: 2, enabled: 2, running: 1 });
      expect(dto.signalConnected).toBe(true);
      expect(dto.webUiListening).toBe(true);
      expect(dto.activeSessions).toBe(ctx.sessionManager.size);
      expect(typeof dto.nextFireTime).toBe('string');
    });

    it('returns null nextFireTime when no scheduled jobs', () => {
      const handler = createMockHandler({
        getStatus: vi.fn().mockReturnValue({
          uptimeSeconds: 10,
          jobs: { total: 0, enabled: 0, running: 0 },
          signalConnected: false,
          nextFireTime: null,
        }),
      });
      const ctx = createMockContext({ handler });
      const dto = buildStatusDto(ctx);
      expect(dto.nextFireTime).toBeNull();
    });
  });
});
