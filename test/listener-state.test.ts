import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  addSession,
  removeSession,
  addEscalation,
  resolveEscalation,
  expireEscalation,
} from '../src/escalation/listener-state.js';
import type { EscalationWatcher } from '../src/escalation/escalation-watcher.js';
import type { PtySessionRegistration } from '../src/docker/pty-types.js';
import type { EscalationRequest } from '../src/session/types.js';

function createMockRegistration(sessionId: string): PtySessionRegistration {
  return {
    sessionId,
    escalationDir: `/tmp/test/sessions/${sessionId}/escalations`,
    label: `Test Agent - task for ${sessionId}`,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
}

function createMockWatcher(): EscalationWatcher {
  return {
    start() {},
    stop() {},
    getPending() {
      return undefined;
    },
    resolve() {
      return true;
    },
  };
}

function createMockEscalation(escalationId: string, serverName = 'filesystem'): EscalationRequest {
  return {
    escalationId,
    toolName: 'write_file',
    serverName,
    arguments: { path: '/etc/passwd' },
    reason: 'Protected path',
  };
}

describe('createInitialState', () => {
  it('returns an empty state with correct defaults', () => {
    const state = createInitialState();

    expect(state.sessions.size).toBe(0);
    expect(state.pendingEscalations.size).toBe(0);
    expect(state.history).toHaveLength(0);
    expect(state.nextEscalationNumber).toBe(1);
    expect(state.nextSessionNumber).toBe(1);
  });
});

describe('addSession', () => {
  it('adds a session with an auto-incrementing display number', () => {
    let state = createInitialState();
    const reg1 = createMockRegistration('sess-1');
    const reg2 = createMockRegistration('sess-2');

    state = addSession(state, reg1, createMockWatcher());
    state = addSession(state, reg2, createMockWatcher());

    expect(state.sessions.size).toBe(2);
    expect(state.sessions.get('sess-1')?.displayNumber).toBe(1);
    expect(state.sessions.get('sess-2')?.displayNumber).toBe(2);
    expect(state.nextSessionNumber).toBe(3);
  });

  it('preserves the registration data', () => {
    let state = createInitialState();
    const reg = createMockRegistration('sess-1');
    state = addSession(state, reg, createMockWatcher());

    const session = state.sessions.get('sess-1');
    expect(session?.registration.sessionId).toBe('sess-1');
    expect(session?.registration.label).toContain('sess-1');
  });

  it('returns a new state object (immutability)', () => {
    const state1 = createInitialState();
    const state2 = addSession(state1, createMockRegistration('sess-1'), createMockWatcher());

    expect(state1).not.toBe(state2);
    expect(state1.sessions.size).toBe(0);
    expect(state2.sessions.size).toBe(1);
  });
});

describe('removeSession', () => {
  it('removes a session by ID', () => {
    let state = createInitialState();
    state = addSession(state, createMockRegistration('sess-1'), createMockWatcher());
    state = addSession(state, createMockRegistration('sess-2'), createMockWatcher());

    state = removeSession(state, 'sess-1');

    expect(state.sessions.size).toBe(1);
    expect(state.sessions.has('sess-1')).toBe(false);
    expect(state.sessions.has('sess-2')).toBe(true);
  });

  it('removes pending escalations for the removed session', () => {
    let state = createInitialState();
    state = addSession(state, createMockRegistration('sess-1'), createMockWatcher());
    state = addSession(state, createMockRegistration('sess-2'), createMockWatcher());
    state = addEscalation(state, 'sess-1', createMockEscalation('esc-1'));
    state = addEscalation(state, 'sess-2', createMockEscalation('esc-2'));

    state = removeSession(state, 'sess-1');

    expect(state.pendingEscalations.size).toBe(1);
    // Only sess-2's escalation remains
    expect([...state.pendingEscalations.values()][0].sessionId).toBe('sess-2');
  });

  it('handles removing a non-existent session gracefully', () => {
    const state = createInitialState();
    const result = removeSession(state, 'nonexistent');

    expect(result.sessions.size).toBe(0);
  });
});

describe('addEscalation', () => {
  it('assigns monotonically increasing display numbers', () => {
    let state = createInitialState();
    state = addSession(state, createMockRegistration('sess-1'), createMockWatcher());

    state = addEscalation(state, 'sess-1', createMockEscalation('esc-1'));
    state = addEscalation(state, 'sess-1', createMockEscalation('esc-2'));

    expect(state.pendingEscalations.size).toBe(2);
    expect(state.pendingEscalations.get(1)?.request.escalationId).toBe('esc-1');
    expect(state.pendingEscalations.get(2)?.request.escalationId).toBe('esc-2');
    expect(state.nextEscalationNumber).toBe(3);
  });

  it('records the session display number on each escalation', () => {
    let state = createInitialState();
    state = addSession(state, createMockRegistration('sess-1'), createMockWatcher());

    state = addEscalation(state, 'sess-1', createMockEscalation('esc-1'));

    const escalation = state.pendingEscalations.get(1);
    expect(escalation?.sessionDisplayNumber).toBe(1);
    expect(escalation?.sessionId).toBe('sess-1');
  });

  it('ignores escalation for an unknown session', () => {
    const state = createInitialState();
    const result = addEscalation(state, 'unknown', createMockEscalation('esc-1'));

    expect(result.pendingEscalations.size).toBe(0);
    // Number counter should not have advanced
    expect(result.nextEscalationNumber).toBe(1);
  });

  it('records receivedAt timestamp', () => {
    let state = createInitialState();
    state = addSession(state, createMockRegistration('sess-1'), createMockWatcher());

    const before = Date.now();
    state = addEscalation(state, 'sess-1', createMockEscalation('esc-1'));
    const after = Date.now();

    const escalation = state.pendingEscalations.get(1);
    expect(escalation?.receivedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(escalation?.receivedAt.getTime()).toBeLessThanOrEqual(after);
  });
});

describe('resolveEscalation', () => {
  it('moves an escalation from pending to history', () => {
    let state = createInitialState();
    state = addSession(state, createMockRegistration('sess-1'), createMockWatcher());
    state = addEscalation(state, 'sess-1', createMockEscalation('esc-1'));

    state = resolveEscalation(state, 1, 'approved');

    expect(state.pendingEscalations.size).toBe(0);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].decision).toBe('approved');
    expect(state.history[0].toolName).toBe('write_file');
    expect(state.history[0].serverName).toBe('filesystem');
  });

  it('records the denied decision in history', () => {
    let state = createInitialState();
    state = addSession(state, createMockRegistration('sess-1'), createMockWatcher());
    state = addEscalation(state, 'sess-1', createMockEscalation('esc-1'));

    state = resolveEscalation(state, 1, 'denied');

    expect(state.history[0].decision).toBe('denied');
  });

  it('prepends to history (most recent first)', () => {
    let state = createInitialState();
    state = addSession(state, createMockRegistration('sess-1'), createMockWatcher());
    state = addEscalation(state, 'sess-1', createMockEscalation('esc-1'));
    state = addEscalation(state, 'sess-1', createMockEscalation('esc-2'));

    state = resolveEscalation(state, 1, 'approved');
    state = resolveEscalation(state, 2, 'denied');

    expect(state.history).toHaveLength(2);
    expect(state.history[0].decision).toBe('denied'); // Most recent
    expect(state.history[1].decision).toBe('approved');
  });

  it('does nothing for an unknown display number', () => {
    let state = createInitialState();
    state = addSession(state, createMockRegistration('sess-1'), createMockWatcher());
    state = addEscalation(state, 'sess-1', createMockEscalation('esc-1'));

    const result = resolveEscalation(state, 999, 'approved');

    expect(result.pendingEscalations.size).toBe(1);
    expect(result.history).toHaveLength(0);
  });

  it('trims history to the maximum size', () => {
    let state = createInitialState();
    state = addSession(state, createMockRegistration('sess-1'), createMockWatcher());

    // Add and resolve 25 escalations (max history is 20)
    for (let i = 0; i < 25; i++) {
      state = addEscalation(state, 'sess-1', createMockEscalation(`esc-${i}`));
      state = resolveEscalation(state, state.nextEscalationNumber - 1, 'approved');
    }

    expect(state.history.length).toBeLessThanOrEqual(20);
  });
});

describe('expireEscalation', () => {
  it('removes the escalation and adds it to history as denied', () => {
    let state = createInitialState();
    state = addSession(state, createMockRegistration('sess-1'), createMockWatcher());
    state = addEscalation(state, 'sess-1', createMockEscalation('esc-1'));

    state = expireEscalation(state, 'sess-1', 'esc-1');

    expect(state.pendingEscalations.size).toBe(0);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].decision).toBe('denied');
  });

  it('does nothing for an unknown session or escalation', () => {
    let state = createInitialState();
    state = addSession(state, createMockRegistration('sess-1'), createMockWatcher());
    state = addEscalation(state, 'sess-1', createMockEscalation('esc-1'));

    // Wrong session
    let result = expireEscalation(state, 'unknown', 'esc-1');
    expect(result.pendingEscalations.size).toBe(1);

    // Wrong escalation ID
    result = expireEscalation(state, 'sess-1', 'esc-wrong');
    expect(result.pendingEscalations.size).toBe(1);
  });

  it('only removes the matching escalation', () => {
    let state = createInitialState();
    state = addSession(state, createMockRegistration('sess-1'), createMockWatcher());
    state = addEscalation(state, 'sess-1', createMockEscalation('esc-1'));
    state = addEscalation(state, 'sess-1', createMockEscalation('esc-2'));

    state = expireEscalation(state, 'sess-1', 'esc-1');

    expect(state.pendingEscalations.size).toBe(1);
    const remaining = [...state.pendingEscalations.values()][0];
    expect(remaining.request.escalationId).toBe('esc-2');
  });
});
