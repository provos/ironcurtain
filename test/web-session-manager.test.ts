/**
 * Tests for SessionManager web UI additions: findByEscalation(),
 * resolveSessionEscalation(), PendingEscalationData storage,
 * and web session source handling.
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from '../src/session/session-manager.js';
import type { PendingEscalationData, SessionSource } from '../src/session/session-manager.js';
import type { Session, SessionInfo } from '../src/session/types.js';
import type { Transport } from '../src/session/transport.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubSession(overrides?: Partial<Session>): Session {
  return {
    getInfo: () =>
      ({ id: 'test-id', status: 'ready', turnCount: 0, createdAt: new Date().toISOString() }) as SessionInfo,
    sendMessage: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
    getDiagnosticLog: vi.fn().mockReturnValue([]),
    resolveEscalation: vi.fn().mockResolvedValue(undefined),
    getPendingEscalation: vi.fn(),
    getBudgetStatus: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function stubTransport(): Transport {
  return {
    run: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

function makeEscalationData(id: string, label: number): PendingEscalationData {
  return {
    escalationId: id,
    sessionLabel: label,
    toolName: 'write_file',
    serverName: 'filesystem',
    arguments: { path: '/tmp/test' },
    reason: 'Write to protected path',
    receivedAt: new Date().toISOString(),
  };
}

const webSource: SessionSource = { kind: 'web' };
const signalSource: SessionSource = { kind: 'signal' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager web UI additions', () => {
  describe('web session source', () => {
    it('does NOT update currentLabel for web sessions', () => {
      const mgr = new SessionManager();
      mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.currentLabel).toBe(1);

      mgr.register(stubSession(), stubTransport(), webSource);
      expect(mgr.currentLabel).toBe(1); // unchanged
    });

    it('byKind("web") returns only web sessions', () => {
      const mgr = new SessionManager();
      mgr.register(stubSession(), stubTransport(), signalSource);
      mgr.register(stubSession(), stubTransport(), webSource);
      mgr.register(stubSession(), stubTransport(), webSource);

      expect(mgr.byKind('web')).toHaveLength(2);
      expect(mgr.byKind('signal')).toHaveLength(1);
    });
  });

  describe('setPendingEscalation with PendingEscalationData', () => {
    it('stores full escalation data object', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), webSource);
      const data = makeEscalationData('esc-full', label);

      mgr.setPendingEscalation(label, data);

      const managed = mgr.get(label)!;
      expect(managed.pendingEscalation).toEqual(data);
      expect(managed.pendingEscalation!.toolName).toBe('write_file');
      expect(managed.pendingEscalation!.serverName).toBe('filesystem');
    });

    it('backward compat: stores string escalation ID', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), signalSource);

      mgr.setPendingEscalation(label, 'esc-string');

      const managed = mgr.get(label)!;
      expect(managed.pendingEscalation!.escalationId).toBe('esc-string');
      // Should fill in defaults for other fields
      expect(managed.pendingEscalation!.toolName).toBe('');
      expect(managed.pendingEscalation!.serverName).toBe('');
    });
  });

  describe('findByEscalation', () => {
    it('finds a session by escalation ID', () => {
      const mgr = new SessionManager();
      const l1 = mgr.register(stubSession(), stubTransport(), webSource);
      const l2 = mgr.register(stubSession(), stubTransport(), webSource);

      mgr.setPendingEscalation(l1, makeEscalationData('esc-a', l1));
      mgr.setPendingEscalation(l2, makeEscalationData('esc-b', l2));

      const found = mgr.findByEscalation('esc-b');
      expect(found).toBeDefined();
      expect(found!.label).toBe(l2);
    });

    it('returns undefined for non-existent escalation ID', () => {
      const mgr = new SessionManager();
      mgr.register(stubSession(), stubTransport(), webSource);

      expect(mgr.findByEscalation('nonexistent')).toBeUndefined();
    });

    it('returns undefined after escalation is cleared', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), webSource);
      mgr.setPendingEscalation(label, makeEscalationData('esc-c', label));

      mgr.clearPendingEscalation(label);
      expect(mgr.findByEscalation('esc-c')).toBeUndefined();
    });
  });

  describe('resolveSessionEscalation', () => {
    it('resolves an existing escalation and clears it', async () => {
      const session = stubSession();
      const mgr = new SessionManager();
      const label = mgr.register(session, stubTransport(), webSource);
      mgr.setPendingEscalation(label, makeEscalationData('esc-resolve', label));

      const result = await mgr.resolveSessionEscalation('esc-resolve', 'approved');

      expect(result).toEqual({ resolved: true });
      expect(session.resolveEscalation).toHaveBeenCalledWith('esc-resolve', 'approved', undefined);
      // Escalation should be cleared after resolution
      expect(mgr.get(label)!.pendingEscalation).toBeNull();
    });

    it('passes whitelistSelection option through', async () => {
      const session = stubSession();
      const mgr = new SessionManager();
      const label = mgr.register(session, stubTransport(), webSource);
      mgr.setPendingEscalation(label, makeEscalationData('esc-wl', label));

      await mgr.resolveSessionEscalation('esc-wl', 'approved', { whitelistSelection: 2 });

      expect(session.resolveEscalation).toHaveBeenCalledWith('esc-wl', 'approved', { whitelistSelection: 2 });
    });

    it('returns not_found for unknown escalation ID', async () => {
      const mgr = new SessionManager();
      mgr.register(stubSession(), stubTransport(), webSource);

      const result = await mgr.resolveSessionEscalation('unknown', 'denied');
      expect(result).toEqual({ resolved: false, reason: 'not_found' });
    });

    it('returns already_resolving when escalation is being resolved concurrently', async () => {
      const resolvePromise = new Promise<void>(() => {}); // never resolves
      const session = stubSession({
        resolveEscalation: vi.fn().mockReturnValue(resolvePromise),
      });
      const mgr = new SessionManager();
      const label = mgr.register(session, stubTransport(), webSource);
      mgr.setPendingEscalation(label, makeEscalationData('esc-concurrent', label));

      // Start first resolution (will hang)
      const firstAttempt = mgr.resolveSessionEscalation('esc-concurrent', 'approved');

      // Second attempt should fail immediately
      const result = await mgr.resolveSessionEscalation('esc-concurrent', 'denied');
      expect(result).toEqual({ resolved: false, reason: 'already_resolving' });

      // Clean up: the first attempt is still pending, just ignore it
      void firstAttempt;
    });

    it('clears escalationResolving flag even when session.resolveEscalation throws', async () => {
      const session = stubSession({
        resolveEscalation: vi.fn().mockRejectedValue(new Error('boom')),
      });
      const mgr = new SessionManager();
      const label = mgr.register(session, stubTransport(), webSource);
      mgr.setPendingEscalation(label, makeEscalationData('esc-error', label));

      await expect(mgr.resolveSessionEscalation('esc-error', 'denied')).rejects.toThrow('boom');

      // escalationResolving should be reset
      const managed = mgr.get(label)!;
      expect(managed.escalationResolving).toBe(false);
      // pendingEscalation should also be cleared
      expect(managed.pendingEscalation).toBeNull();
    });
  });
});
