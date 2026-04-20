/**
 * Tests for token-stream-dispatch -- JSON-RPC subscribe/unsubscribe
 * methods for token stream events.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tokenStreamDispatch } from '../src/web-ui/dispatch/token-stream-dispatch.js';
import { TokenStreamBridge } from '../src/web-ui/token-stream-bridge.js';
import { resetTokenStreamBus } from '../src/docker/token-stream-bus.js';
import { SessionManager } from '../src/session/session-manager.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import type { DispatchContext } from '../src/web-ui/dispatch/types.js';
import type { ControlRequestHandler } from '../src/daemon/control-socket.js';
import type { Session, SessionInfo, BudgetStatus } from '../src/session/types.js';
import type { Transport } from '../src/session/transport.js';
import type { WebSocket as WsWebSocket } from 'ws';
import type { RunRecord } from '../src/cron/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockWs(): WsWebSocket {
  return { readyState: 1 } as unknown as WsWebSocket;
}

function makeBudgetStatus(): BudgetStatus {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    stepCount: 0,
    elapsedSeconds: 0,
    estimatedCostUsd: 0,
    tokenTrackingAvailable: false,
    cumulative: { totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 },
    limits: { maxTotalTokens: null, maxSteps: null, maxSessionSeconds: null, maxEstimatedCostUsd: null },
  };
}

function stubSession(id: string): Session {
  return {
    getInfo: () =>
      ({
        id,
        status: 'ready',
        turnCount: 0,
        createdAt: new Date().toISOString(),
      }) as SessionInfo,
    sendMessage: vi.fn().mockResolvedValue('ok'),
    getHistory: vi.fn().mockReturnValue([]),
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
      uptimeSeconds: 0,
      jobs: { total: 0, enabled: 0, running: 0 },
      signalConnected: false,
      nextFireTime: undefined,
    }),
    addJob: vi.fn().mockResolvedValue(undefined),
    removeJob: vi.fn().mockResolvedValue(undefined),
    enableJob: vi.fn().mockResolvedValue(undefined),
    disableJob: vi.fn().mockResolvedValue(undefined),
    recompileJob: vi.fn().mockResolvedValue(undefined),
    reloadJob: vi.fn().mockResolvedValue(undefined),
    runJobNow: vi.fn().mockResolvedValue({} as RunRecord),
    listJobs: vi.fn().mockReturnValue([]),
  };
}

function makeCtx(bridge: TokenStreamBridge): DispatchContext {
  return {
    handler: makeMockHandler(),
    sessionManager: new SessionManager(),
    mode: { kind: 'builtin' },
    eventBus: new WebEventBus(),
    maxConcurrentWebSessions: 5,
    sessionQueues: new Map(),
    tokenStreamBridge: bridge,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tokenStreamDispatch', () => {
  let bridge: TokenStreamBridge;
  let ctx: DispatchContext;

  beforeEach(() => {
    resetTokenStreamBus();
    const sender = { sendToSubscribers: vi.fn() };
    bridge = new TokenStreamBridge(sender);
    ctx = makeCtx(bridge);
  });

  describe('sessions.subscribeTokenStream', () => {
    it('subscribes a client to an existing session', () => {
      const ws = mockWs();
      const session = stubSession('sess-abc');
      const label = ctx.sessionManager.register(session, stubTransport(), { kind: 'web' });

      const result = tokenStreamDispatch(ctx, 'sessions.subscribeTokenStream', { label }, ws);
      expect(result).toEqual({ subscribed: true });
      expect(bridge.hasSubscription(ws, label)).toBe(true);
    });

    it('throws SESSION_NOT_FOUND for unknown label', () => {
      const ws = mockWs();
      expect(() => tokenStreamDispatch(ctx, 'sessions.subscribeTokenStream', { label: 999 }, ws)).toThrow(
        'Session #999 not found',
      );
    });

    it('validates label parameter', () => {
      const ws = mockWs();
      expect(() => tokenStreamDispatch(ctx, 'sessions.subscribeTokenStream', {}, ws)).toThrow();
      expect(() => tokenStreamDispatch(ctx, 'sessions.subscribeTokenStream', { label: -1 }, ws)).toThrow();
      expect(() => tokenStreamDispatch(ctx, 'sessions.subscribeTokenStream', { label: 1.5 }, ws)).toThrow();
    });
  });

  describe('sessions.unsubscribeTokenStream', () => {
    it('unsubscribes a client from a session', () => {
      const ws = mockWs();
      const session = stubSession('sess-abc');
      const label = ctx.sessionManager.register(session, stubTransport(), { kind: 'web' });

      tokenStreamDispatch(ctx, 'sessions.subscribeTokenStream', { label }, ws);
      expect(bridge.hasSubscription(ws, label)).toBe(true);

      const result = tokenStreamDispatch(ctx, 'sessions.unsubscribeTokenStream', { label }, ws);
      expect(result).toEqual({ unsubscribed: true });
      expect(bridge.hasSubscription(ws, label)).toBe(false);
    });

    it('is safe to unsubscribe from a label that was never subscribed', () => {
      const ws = mockWs();
      const result = tokenStreamDispatch(ctx, 'sessions.unsubscribeTokenStream', { label: 1 }, ws);
      expect(result).toEqual({ unsubscribed: true });
    });
  });

  describe('sessions.subscribeAllTokenStreams', () => {
    it('subscribes a client globally', () => {
      const ws = mockWs();
      const result = tokenStreamDispatch(ctx, 'sessions.subscribeAllTokenStreams', {}, ws);
      expect(result).toEqual({ subscribed: true });
      expect(bridge.hasGlobalSubscription(ws)).toBe(true);
    });

    it('registers existing sessions for label resolution', () => {
      const ws = mockWs();
      const session = stubSession('sess-abc');
      ctx.sessionManager.register(session, stubTransport(), { kind: 'web' });

      tokenStreamDispatch(ctx, 'sessions.subscribeAllTokenStreams', {}, ws);
      expect(bridge.hasGlobalSubscription(ws)).toBe(true);
    });
  });

  describe('sessions.unsubscribeAllTokenStreams', () => {
    it('removes global subscription', () => {
      const ws = mockWs();
      tokenStreamDispatch(ctx, 'sessions.subscribeAllTokenStreams', {}, ws);
      expect(bridge.hasGlobalSubscription(ws)).toBe(true);

      const result = tokenStreamDispatch(ctx, 'sessions.unsubscribeAllTokenStreams', {}, ws);
      expect(result).toEqual({ unsubscribed: true });
      expect(bridge.hasGlobalSubscription(ws)).toBe(false);
    });
  });

  describe('error handling', () => {
    it('throws INTERNAL_ERROR when bridge is not available', () => {
      const ctxNoBridge: DispatchContext = {
        ...ctx,
        tokenStreamBridge: undefined,
      };
      const ws = mockWs();

      expect(() => tokenStreamDispatch(ctxNoBridge, 'sessions.subscribeTokenStream', { label: 1 }, ws)).toThrow(
        'Token stream bridge not available',
      );
    });

    it('throws METHOD_NOT_FOUND for unknown method', () => {
      const ws = mockWs();
      expect(() => tokenStreamDispatch(ctx, 'sessions.unknownMethod', {}, ws)).toThrow('Unknown method');
    });
  });
});
