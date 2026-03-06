/**
 * Tests for SessionManager -- session registration, lookup,
 * escalation tracking, and currentLabel management.
 *
 * Uses minimal Session/Transport stubs (no real LLM or Docker).
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from '../src/session/session-manager.js';
import type { SessionSource } from '../src/session/session-manager.js';
import type { Session, SessionInfo } from '../src/session/types.js';
import type { Transport } from '../src/session/transport.js';
import type { JobId } from '../src/cron/types.js';

/** Minimal Session stub -- only methods actually called by SessionManager. */
function stubSession(): Session {
  return {
    getInfo: () =>
      ({ id: 'test-id', status: 'ready', turnCount: 0, createdAt: new Date().toISOString() }) as SessionInfo,
    sendMessage: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
    getDiagnosticLog: vi.fn().mockReturnValue([]),
    resolveEscalation: vi.fn(),
    getPendingEscalation: vi.fn(),
    getBudgetStatus: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** Minimal Transport stub. */
function stubTransport(): Transport {
  return {
    run: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

const signalSource: SessionSource = { kind: 'signal' };
const cronSource: SessionSource = { kind: 'cron', jobId: 'daily-check' as JobId, jobName: 'Daily Check' };

describe('SessionManager', () => {
  describe('register', () => {
    it('assigns monotonically increasing labels', () => {
      const mgr = new SessionManager();
      const l1 = mgr.register(stubSession(), stubTransport(), signalSource);
      const l2 = mgr.register(stubSession(), stubTransport(), signalSource);
      const l3 = mgr.register(stubSession(), stubTransport(), cronSource);

      expect(l1).toBe(1);
      expect(l2).toBe(2);
      expect(l3).toBe(3);
    });

    it('sets currentLabel for signal sessions', () => {
      const mgr = new SessionManager();
      mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.currentLabel).toBe(1);

      mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.currentLabel).toBe(2);
    });

    it('does NOT update currentLabel for cron sessions', () => {
      const mgr = new SessionManager();
      mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.currentLabel).toBe(1);

      mgr.register(stubSession(), stubTransport(), cronSource);
      expect(mgr.currentLabel).toBe(1); // unchanged
    });
  });

  describe('get / all / size', () => {
    it('retrieves a session by label', () => {
      const mgr = new SessionManager();
      const session = stubSession();
      const label = mgr.register(session, stubTransport(), signalSource);

      const managed = mgr.get(label);
      expect(managed).toBeDefined();
      expect(managed!.session).toBe(session);
      expect(managed!.source).toEqual(signalSource);
    });

    it('returns undefined for a non-existent label', () => {
      const mgr = new SessionManager();
      expect(mgr.get(999)).toBeUndefined();
    });

    it('returns all sessions as a snapshot', () => {
      const mgr = new SessionManager();
      mgr.register(stubSession(), stubTransport(), signalSource);
      mgr.register(stubSession(), stubTransport(), cronSource);

      const all = mgr.all();
      expect(all).toHaveLength(2);
    });

    it('reports the correct size', () => {
      const mgr = new SessionManager();
      expect(mgr.size).toBe(0);
      mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.size).toBe(1);
    });
  });

  describe('byKind', () => {
    it('filters sessions by source kind', () => {
      const mgr = new SessionManager();
      mgr.register(stubSession(), stubTransport(), signalSource);
      mgr.register(stubSession(), stubTransport(), cronSource);
      mgr.register(stubSession(), stubTransport(), signalSource);

      expect(mgr.byKind('signal')).toHaveLength(2);
      expect(mgr.byKind('cron')).toHaveLength(1);
    });
  });

  describe('end', () => {
    it('closes transport and session, then removes from map', async () => {
      const mgr = new SessionManager();
      const session = stubSession();
      const transport = stubTransport();
      const label = mgr.register(session, transport, signalSource);

      await mgr.end(label);

      expect(transport.close).toHaveBeenCalled();
      expect(session.close).toHaveBeenCalled();
      expect(mgr.get(label)).toBeUndefined();
      expect(mgr.size).toBe(0);
    });

    it('is a no-op for a non-existent label', async () => {
      const mgr = new SessionManager();
      await expect(mgr.end(999)).resolves.toBeUndefined();
    });

    it('updates currentLabel when the current session ends', async () => {
      const mgr = new SessionManager();
      const l1 = mgr.register(stubSession(), stubTransport(), signalSource);
      const l2 = mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.currentLabel).toBe(l2);

      await mgr.end(l2);
      // Should fall back to the remaining signal session
      expect(mgr.currentLabel).toBe(l1);
    });

    it('sets currentLabel to null when the last signal session ends', async () => {
      const mgr = new SessionManager();
      const l1 = mgr.register(stubSession(), stubTransport(), signalSource);
      mgr.register(stubSession(), stubTransport(), cronSource);

      await mgr.end(l1);
      // Cron sessions don't count for currentLabel
      expect(mgr.currentLabel).toBeNull();
    });

    it('does not change currentLabel when a non-current session ends', async () => {
      const mgr = new SessionManager();
      const l1 = mgr.register(stubSession(), stubTransport(), signalSource);
      const l2 = mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.currentLabel).toBe(l2);

      await mgr.end(l1);
      expect(mgr.currentLabel).toBe(l2);
    });

    it('handles transport.close() throwing without crashing', async () => {
      const mgr = new SessionManager();
      const transport = stubTransport();
      (transport.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('transport boom');
      });
      const label = mgr.register(stubSession(), transport, signalSource);

      // Should not throw
      await mgr.end(label);
      expect(mgr.get(label)).toBeUndefined();
    });

    it('handles session.close() rejecting without crashing', async () => {
      const mgr = new SessionManager();
      const session = stubSession();
      (session.close as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('session boom'));
      const label = mgr.register(session, stubTransport(), signalSource);

      await mgr.end(label);
      expect(mgr.get(label)).toBeUndefined();
    });
  });

  describe('escalation tracking', () => {
    it('setPendingEscalation records the escalation ID', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), signalSource);

      mgr.setPendingEscalation(label, 'esc-123');
      const managed = mgr.get(label)!;
      expect(managed.pendingEscalationId).toBe('esc-123');
    });

    it('clearPendingEscalation resets the escalation state', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), signalSource);

      mgr.setPendingEscalation(label, 'esc-123');
      mgr.clearPendingEscalation(label);

      const managed = mgr.get(label)!;
      expect(managed.pendingEscalationId).toBeNull();
      expect(managed.escalationResolving).toBe(false);
    });

    it('withPendingEscalation returns only sessions with active escalations', () => {
      const mgr = new SessionManager();
      const l1 = mgr.register(stubSession(), stubTransport(), signalSource);
      mgr.register(stubSession(), stubTransport(), signalSource);
      const l3 = mgr.register(stubSession(), stubTransport(), cronSource);

      mgr.setPendingEscalation(l1, 'esc-1');
      mgr.setPendingEscalation(l3, 'esc-3');

      const pending = mgr.withPendingEscalation();
      expect(pending).toHaveLength(2);
      expect(pending.map((m) => m.label).sort()).toEqual([l1, l3]);
    });

    it('setPendingEscalation is a no-op for non-existent labels', () => {
      const mgr = new SessionManager();
      expect(() => mgr.setPendingEscalation(999, 'esc')).not.toThrow();
    });

    it('clearPendingEscalation is a no-op for non-existent labels', () => {
      const mgr = new SessionManager();
      expect(() => mgr.clearPendingEscalation(999)).not.toThrow();
    });
  });

  describe('managed session initial state', () => {
    it('initializes with correct defaults', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), signalSource);
      const managed = mgr.get(label)!;

      expect(managed.label).toBe(label);
      expect(managed.messageInFlight).toBe(false);
      expect(managed.pendingEscalationId).toBeNull();
      expect(managed.escalationResolving).toBe(false);
    });
  });
});
