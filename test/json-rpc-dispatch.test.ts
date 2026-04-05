/**
 * Tests for json-rpc-dispatch: parameter validation, method routing,
 * error handling, and DTO builders.
 *
 * These tests exercise the dispatch function directly with a mock
 * DispatchContext, avoiding the need for a real HTTP/WS server.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  dispatch,
  toSessionDto,
  toBudgetDto,
  buildStatusDto,
  type DispatchContext,
} from '../src/web-ui/json-rpc-dispatch.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import { SessionManager, type PendingEscalationData } from '../src/session/session-manager.js';
import type { ControlRequestHandler } from '../src/daemon/control-socket.js';
import type { Session, SessionInfo, BudgetStatus } from '../src/session/types.js';
import type { Transport } from '../src/session/transport.js';
import type { RunRecord } from '../src/cron/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBudgetStatus(): BudgetStatus {
  return {
    totalInputTokens: 500,
    totalOutputTokens: 300,
    totalTokens: 800,
    stepCount: 5,
    elapsedSeconds: 120,
    estimatedCostUsd: 0.05,
    tokenTrackingAvailable: true,
    cumulative: { totalInputTokens: 500, totalOutputTokens: 300, totalTokens: 800 },
    limits: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5,
    },
  };
}

function stubSession(): Session {
  return {
    getInfo: () =>
      ({
        id: 'test-id',
        status: 'ready',
        turnCount: 3,
        createdAt: '2026-01-01T00:00:00Z',
      }) as SessionInfo,
    sendMessage: vi.fn().mockResolvedValue('response text'),
    getHistory: vi.fn().mockReturnValue([
      {
        turnNumber: 1,
        userMessage: 'hi',
        assistantResponse: 'hello',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
        timestamp: '2026-01-01T00:00:00Z',
      },
    ]),
    getDiagnosticLog: vi.fn().mockReturnValue([]),
    resolveEscalation: vi.fn().mockResolvedValue(undefined),
    getPendingEscalation: vi.fn(),
    getBudgetStatus: vi.fn().mockReturnValue(makeBudgetStatus()),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function stubTransport(): Transport {
  return {
    run: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

function makeMockHandler(): ControlRequestHandler {
  return {
    getStatus: vi.fn().mockReturnValue({
      uptimeSeconds: 300,
      jobs: { total: 2, enabled: 1, running: 0 },
      signalConnected: false,
      nextFireTime: new Date('2026-03-05T10:00:00Z'),
    }),
    addJob: vi.fn().mockResolvedValue(undefined),
    removeJob: vi.fn().mockResolvedValue(undefined),
    enableJob: vi.fn().mockResolvedValue(undefined),
    disableJob: vi.fn().mockResolvedValue(undefined),
    recompileJob: vi.fn().mockResolvedValue(undefined),
    reloadJob: vi.fn().mockResolvedValue(undefined),
    runJobNow: vi.fn().mockResolvedValue({
      startedAt: '2026-03-05T09:00:00Z',
      completedAt: '2026-03-05T09:01:00Z',
      outcome: { kind: 'success' },
      budget: { totalTokens: 100, stepCount: 3, elapsedSeconds: 60, estimatedCostUsd: 0.01 },
      summary: 'Done',
      escalationsEncountered: 0,
      escalationsApproved: 0,
      discardedChanges: null,
    } as RunRecord),
    listJobs: vi.fn().mockReturnValue([]),
  };
}

function makeCtx(overrides?: Partial<DispatchContext>): DispatchContext {
  return {
    handler: makeMockHandler(),
    sessionManager: new SessionManager(),
    mode: { kind: 'builtin' },
    eventBus: new WebEventBus(),
    maxConcurrentWebSessions: 5,
    sessionQueues: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('json-rpc-dispatch', () => {
  describe('parameter validation', () => {
    it('rejects missing label for sessions.get', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'sessions.get', {})).rejects.toThrow();
    });

    it('rejects negative label', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'sessions.get', { label: -1 })).rejects.toThrow();
    });

    it('rejects non-integer label', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'sessions.get', { label: 1.5 })).rejects.toThrow();
    });

    it('rejects empty jobId', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'jobs.remove', { jobId: '' })).rejects.toThrow();
    });

    it('rejects missing escalationId for escalations.resolve', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'escalations.resolve', { decision: 'approved' })).rejects.toThrow();
    });

    it('rejects invalid decision for escalations.resolve', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'escalations.resolve', { escalationId: 'e1', decision: 'maybe' })).rejects.toThrow();
    });

    it('rejects empty text for sessions.send', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'sessions.send', { label: 1, text: '' })).rejects.toThrow();
    });
  });

  describe('method routing', () => {
    it('throws MethodNotFoundError for unknown methods', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'nonexistent' as never, {})).rejects.toThrow('Unknown method: nonexistent');
    });

    it('status returns DaemonStatusDto', async () => {
      const ctx = makeCtx();
      const result = await dispatch(ctx, 'status', {});
      expect(result).toMatchObject({
        uptimeSeconds: 300,
        jobs: { total: 2, enabled: 1, running: 0 },
        webUiListening: true,
      });
    });

    it('sessions.list returns empty array when no sessions', async () => {
      const ctx = makeCtx();
      const result = await dispatch(ctx, 'sessions.list', {});
      expect(result).toEqual([]);
    });

    it('sessions.list returns session DTOs', async () => {
      const ctx = makeCtx();
      const session = stubSession();
      ctx.sessionManager.register(session, stubTransport(), { kind: 'web' });

      const result = (await dispatch(ctx, 'sessions.list', {})) as unknown[];
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ label: 1, source: { kind: 'web' } });
    });

    it('sessions.get returns detail for existing session', async () => {
      const ctx = makeCtx();
      ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'signal' });

      const result = await dispatch(ctx, 'sessions.get', { label: 1 });
      expect(result).toMatchObject({
        label: 1,
        history: expect.any(Array),
        diagnosticLog: expect.any(Array),
      });
    });

    it('sessions.get throws SessionNotFoundError for missing session', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'sessions.get', { label: 99 })).rejects.toThrow('Session #99 not found');
    });

    it('sessions.end removes the session', async () => {
      const ctx = makeCtx();
      ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'web' });

      await dispatch(ctx, 'sessions.end', { label: 1 });
      expect(ctx.sessionManager.get(1)).toBeUndefined();
    });

    it('sessions.end emits session.ended event', async () => {
      const ctx = makeCtx();
      ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'web' });
      const handler = vi.fn();
      ctx.eventBus.subscribe(handler);

      await dispatch(ctx, 'sessions.end', { label: 1 });

      expect(handler).toHaveBeenCalledWith('session.ended', { label: 1, reason: 'user_ended' });
    });

    it('sessions.budget returns budget DTO', async () => {
      const ctx = makeCtx();
      ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'web' });

      const result = await dispatch(ctx, 'sessions.budget', { label: 1 });
      expect(result).toMatchObject({
        totalTokens: 800,
        stepCount: 5,
        tokenTrackingAvailable: true,
      });
    });

    it('sessions.history returns conversation history', async () => {
      const ctx = makeCtx();
      ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'web' });

      const result = await dispatch(ctx, 'sessions.history', { label: 1 });
      expect(result).toHaveLength(1);
    });

    it('sessions.diagnostics returns diagnostic log', async () => {
      const ctx = makeCtx();
      ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'web' });

      const result = await dispatch(ctx, 'sessions.diagnostics', { label: 1 });
      expect(result).toEqual([]);
    });
  });

  describe('escalations', () => {
    it('escalations.list returns empty when no escalations', async () => {
      const ctx = makeCtx();
      const result = await dispatch(ctx, 'escalations.list', {});
      expect(result).toEqual([]);
    });

    it('escalations.list includes sessions with pending escalations', async () => {
      const ctx = makeCtx();
      const label = ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'web' });
      const data: PendingEscalationData = {
        escalationId: 'esc-1',
        sessionLabel: label,
        toolName: 'write_file',
        serverName: 'filesystem',
        arguments: { path: '/test' },
        reason: 'Protected path',
        receivedAt: '2026-01-01T00:00:00Z',
      };
      ctx.sessionManager.setPendingEscalation(label, data);

      const result = (await dispatch(ctx, 'escalations.list', {})) as unknown[];
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        escalationId: 'esc-1',
        toolName: 'write_file',
        sessionSource: { kind: 'web' },
      });
    });

    it('escalations.resolve calls resolveSessionEscalation', async () => {
      const ctx = makeCtx();
      const session = stubSession();
      const label = ctx.sessionManager.register(session, stubTransport(), { kind: 'web' });
      ctx.sessionManager.setPendingEscalation(label, {
        escalationId: 'esc-2',
        sessionLabel: label,
        toolName: 'delete_file',
        serverName: 'filesystem',
        arguments: {},
        reason: 'Dangerous',
        receivedAt: '2026-01-01T00:00:00Z',
      });

      await dispatch(ctx, 'escalations.resolve', {
        escalationId: 'esc-2',
        decision: 'denied',
      });

      expect(session.resolveEscalation).toHaveBeenCalledWith('esc-2', 'denied', undefined);
    });

    it('escalations.resolve throws when escalation not found', async () => {
      const ctx = makeCtx();
      await expect(
        dispatch(ctx, 'escalations.resolve', {
          escalationId: 'nonexistent',
          decision: 'approved',
        }),
      ).rejects.toThrow('not_found');
    });
  });

  describe('jobs', () => {
    it('jobs.list returns formatted job list', async () => {
      const handler = makeMockHandler();
      (handler.listJobs as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          job: { id: 'j1', name: 'Test Job', schedule: '0 9 * * *', task: 'do stuff', enabled: true },
          nextRun: new Date('2026-03-05T09:00:00Z'),
          lastRun: undefined,
          isRunning: false,
        },
      ]);
      const ctx = makeCtx({ handler });

      const result = (await dispatch(ctx, 'jobs.list', {})) as unknown[];
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        job: { id: 'j1' },
        nextRun: '2026-03-05T09:00:00.000Z',
        lastRun: null,
        isRunning: false,
      });
    });

    it('jobs.remove calls handler and emits event', async () => {
      const handler = makeMockHandler();
      const ctx = makeCtx({ handler });
      const eventHandler = vi.fn();
      ctx.eventBus.subscribe(eventHandler);

      await dispatch(ctx, 'jobs.remove', { jobId: 'j1' });

      expect(handler.removeJob).toHaveBeenCalledWith('j1');
      expect(eventHandler).toHaveBeenCalledWith('job.list_changed', {});
    });

    it('jobs.enable calls handler and emits event', async () => {
      const handler = makeMockHandler();
      const ctx = makeCtx({ handler });

      await dispatch(ctx, 'jobs.enable', { jobId: 'j1' });
      expect(handler.enableJob).toHaveBeenCalledWith('j1');
    });

    it('jobs.disable calls handler and emits event', async () => {
      const handler = makeMockHandler();
      const ctx = makeCtx({ handler });

      await dispatch(ctx, 'jobs.disable', { jobId: 'j1' });
      expect(handler.disableJob).toHaveBeenCalledWith('j1');
    });

    it('jobs.run returns accepted and emits job.started', async () => {
      const handler = makeMockHandler();
      const ctx = makeCtx({ handler });
      const eventHandler = vi.fn();
      ctx.eventBus.subscribe(eventHandler);

      const result = await dispatch(ctx, 'jobs.run', { jobId: 'j1' });
      expect(result).toEqual({ accepted: true, jobId: 'j1' });
      expect(eventHandler).toHaveBeenCalledWith('job.started', { jobId: 'j1', sessionLabel: 0 });
    });
  });

  describe('DTO builders', () => {
    it('toSessionDto maps managed session correctly', () => {
      const mgr = new SessionManager();
      const session = stubSession();
      const label = mgr.register(session, stubTransport(), { kind: 'web' });
      const managed = mgr.get(label)!;

      const dto = toSessionDto(managed);

      expect(dto).toMatchObject({
        label: 1,
        source: { kind: 'web' },
        status: 'ready',
        turnCount: 3,
        hasPendingEscalation: false,
        messageInFlight: false,
      });
    });

    it('toSessionDto reflects pending escalation', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), { kind: 'web' });
      mgr.setPendingEscalation(label, {
        escalationId: 'e1',
        sessionLabel: label,
        toolName: 't',
        serverName: 's',
        arguments: {},
        reason: 'r',
        receivedAt: '2026-01-01T00:00:00Z',
      });
      const managed = mgr.get(label)!;

      expect(toSessionDto(managed).hasPendingEscalation).toBe(true);
    });

    it('toBudgetDto maps budget fields correctly', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), { kind: 'web' });
      const managed = mgr.get(label)!;

      const dto = toBudgetDto(managed);

      expect(dto).toMatchObject({
        totalTokens: 800,
        stepCount: 5,
        elapsedSeconds: 120,
        estimatedCostUsd: 0.05,
        tokenTrackingAvailable: true,
        limits: {
          maxTotalTokens: 1_000_000,
          maxSteps: 200,
          maxSessionSeconds: 1800,
          maxEstimatedCostUsd: 5,
        },
      });
    });

    it('buildStatusDto includes webUiListening=true', () => {
      const ctx = makeCtx();
      const dto = buildStatusDto(ctx);

      expect(dto.webUiListening).toBe(true);
      expect(dto.uptimeSeconds).toBe(300);
      expect(dto.nextFireTime).toBe('2026-03-05T10:00:00.000Z');
    });

    it('buildStatusDto handles null nextFireTime', () => {
      const handler = makeMockHandler();
      (handler.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
        uptimeSeconds: 10,
        jobs: { total: 0, enabled: 0, running: 0 },
        signalConnected: false,
        nextFireTime: undefined,
      });
      const ctx = makeCtx({ handler });

      const dto = buildStatusDto(ctx);
      expect(dto.nextFireTime).toBeNull();
    });
  });
});
