import { describe, it, expect, beforeEach } from 'vitest';
import { getTokenStreamBus, resetTokenStreamBus } from '../../src/docker/token-stream-bus.js';
import type { SessionId } from '../../src/session/types.js';
import type { TokenStreamEvent } from '../../src/docker/token-stream-types.js';

const sessionId = 'session-smoke' as SessionId;

function makeEvent(text: string): TokenStreamEvent {
  return { kind: 'text_delta', text, timestamp: 0 };
}

describe('getTokenStreamBus (singleton)', () => {
  beforeEach(() => {
    resetTokenStreamBus();
  });

  it('returns the same instance on repeated calls', () => {
    const first = getTokenStreamBus();
    const second = getTokenStreamBus();

    expect(second).toBe(first);

    // Cross-check: publishing on the second reference reaches a listener
    // attached via the first. Identity alone would be enough, but this
    // also confirms the shared instance is actually wired up.
    const received: TokenStreamEvent[] = [];
    const unsubscribe = first.subscribe(sessionId, (_sid, event) => {
      received.push(event);
    });
    second.push(sessionId, makeEvent('hello'));
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: 'text_delta', text: 'hello' });
  });

  it('resetTokenStreamBus() causes the next call to return a fresh instance', () => {
    const before = getTokenStreamBus();
    resetTokenStreamBus();
    const after = getTokenStreamBus();

    expect(after).not.toBe(before);

    // A listener on the stale instance should not receive events pushed
    // to the fresh instance -- confirms they are genuinely independent.
    const staleEvents: TokenStreamEvent[] = [];
    before.subscribe(sessionId, (_sid, event) => {
      staleEvents.push(event);
    });
    after.push(sessionId, makeEvent('after-reset'));

    expect(staleEvents).toHaveLength(0);
  });
});
