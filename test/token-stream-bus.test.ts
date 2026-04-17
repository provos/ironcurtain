/**
 * Tests for TokenStreamBus -- stateless pub/sub dispatcher for
 * LLM token stream events.
 */

import { describe, it, expect, vi } from 'vitest';
import { createTokenStreamBus } from '../src/docker/token-stream-bus.js';
import type { SessionId } from '../src/session/types.js';
import type { TokenStreamEvent } from '../src/docker/token-stream-types.js';

function sessionId(id: string): SessionId {
  return id as SessionId;
}

function textDelta(text: string): TokenStreamEvent {
  return { kind: 'text_delta', text, timestamp: Date.now() };
}

describe('TokenStreamBus', () => {
  it('push dispatches to per-session listeners', () => {
    const bus = createTokenStreamBus();
    const listener = vi.fn();
    const sid = sessionId('session-a');
    bus.subscribe(sid, listener);

    const event = textDelta('hello');
    bus.push(sid, event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(sid, event);
  });

  it('push dispatches to global listeners', () => {
    const bus = createTokenStreamBus();
    const listener = vi.fn();
    const sid = sessionId('session-a');
    bus.subscribeAll(listener);

    const event = textDelta('world');
    bus.push(sid, event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(sid, event);
  });

  it('push dispatches to both per-session and global listeners', () => {
    const bus = createTokenStreamBus();
    const perSession = vi.fn();
    const global = vi.fn();
    const sid = sessionId('session-a');

    bus.subscribe(sid, perSession);
    bus.subscribeAll(global);

    const event = textDelta('both');
    bus.push(sid, event);

    expect(perSession).toHaveBeenCalledOnce();
    expect(perSession).toHaveBeenCalledWith(sid, event);
    expect(global).toHaveBeenCalledOnce();
    expect(global).toHaveBeenCalledWith(sid, event);
  });

  it('unsubscribe stops delivery for per-session listener', () => {
    const bus = createTokenStreamBus();
    const listener = vi.fn();
    const sid = sessionId('session-a');
    const unsub = bus.subscribe(sid, listener);

    unsub();
    bus.push(sid, textDelta('after-unsub'));

    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribe stops delivery for global listener', () => {
    const bus = createTokenStreamBus();
    const listener = vi.fn();
    const sid = sessionId('session-a');
    const unsub = bus.subscribeAll(listener);

    unsub();
    bus.push(sid, textDelta('after-unsub'));

    expect(listener).not.toHaveBeenCalled();
  });

  it('endSession clears per-session listeners', () => {
    const bus = createTokenStreamBus();
    const listener = vi.fn();
    const sid = sessionId('session-a');
    bus.subscribe(sid, listener);

    bus.endSession(sid);
    bus.push(sid, textDelta('after-end'));

    expect(listener).not.toHaveBeenCalled();
  });

  it('endSession does not affect global listeners', () => {
    const bus = createTokenStreamBus();
    const global = vi.fn();
    const sidA = sessionId('session-a');
    const sidB = sessionId('session-b');

    bus.subscribeAll(global);
    bus.endSession(sidA);

    const event = textDelta('still-alive');
    bus.push(sidB, event);

    expect(global).toHaveBeenCalledOnce();
    expect(global).toHaveBeenCalledWith(sidB, event);
  });

  it('push to session with no listeners is a no-op', () => {
    const bus = createTokenStreamBus();
    // No subscribers at all -- should not throw.
    expect(() => bus.push(sessionId('nobody'), textDelta('silence'))).not.toThrow();
  });

  it('multi-session isolation: push to session A does not invoke session B listener', () => {
    const bus = createTokenStreamBus();
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    bus.subscribe(sessionId('a'), listenerA);
    bus.subscribe(sessionId('b'), listenerB);

    bus.push(sessionId('a'), textDelta('for-a'));

    expect(listenerA).toHaveBeenCalledOnce();
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('multiple listeners on the same session all receive events', () => {
    const bus = createTokenStreamBus();
    const l1 = vi.fn();
    const l2 = vi.fn();
    const sid = sessionId('shared');

    bus.subscribe(sid, l1);
    bus.subscribe(sid, l2);

    bus.push(sid, textDelta('shared-event'));

    expect(l1).toHaveBeenCalledOnce();
    expect(l2).toHaveBeenCalledOnce();
  });

  it('unsubscribing one listener does not affect other listeners on the same session', () => {
    const bus = createTokenStreamBus();
    const l1 = vi.fn();
    const l2 = vi.fn();
    const sid = sessionId('shared');

    const unsub1 = bus.subscribe(sid, l1);
    bus.subscribe(sid, l2);

    unsub1();
    bus.push(sid, textDelta('only-l2'));

    expect(l1).not.toHaveBeenCalled();
    expect(l2).toHaveBeenCalledOnce();
  });

  it('subscribeAll receives events from multiple sessions', () => {
    const bus = createTokenStreamBus();
    const global = vi.fn();
    bus.subscribeAll(global);

    const sidA = sessionId('a');
    const sidB = sessionId('b');

    bus.push(sidA, textDelta('from-a'));
    bus.push(sidB, textDelta('from-b'));

    expect(global).toHaveBeenCalledTimes(2);
    expect(global).toHaveBeenCalledWith(sidA, expect.objectContaining({ text: 'from-a' }));
    expect(global).toHaveBeenCalledWith(sidB, expect.objectContaining({ text: 'from-b' }));
  });

  it('push does not throw if a per-session listener throws', () => {
    const bus = createTokenStreamBus();
    const bad = vi.fn(() => {
      throw new Error('consumer boom');
    });
    const good = vi.fn();
    const sid = sessionId('with-bad-listener');

    bus.subscribe(sid, bad);
    bus.subscribe(sid, good);

    // Must not throw out of push(); must still invoke the good listener.
    expect(() => bus.push(sid, textDelta('survive'))).not.toThrow();
    expect(bad).toHaveBeenCalledOnce();
    expect(good).toHaveBeenCalledOnce();
  });

  it('push does not throw if a global listener throws', () => {
    const bus = createTokenStreamBus();
    const badGlobal = vi.fn(() => {
      throw new Error('global boom');
    });
    const goodGlobal = vi.fn();
    const perSession = vi.fn();
    const sid = sessionId('session-a');

    bus.subscribe(sid, perSession);
    bus.subscribeAll(badGlobal);
    bus.subscribeAll(goodGlobal);

    // Bad global listener must not prevent other global listeners or the
    // per-session listener from receiving the event.
    expect(() => bus.push(sid, textDelta('global-survive'))).not.toThrow();
    expect(perSession).toHaveBeenCalledOnce();
    expect(badGlobal).toHaveBeenCalledOnce();
    expect(goodGlobal).toHaveBeenCalledOnce();
  });

  it('unsubscribing last per-session listener cleans up session entry', () => {
    const bus = createTokenStreamBus();
    const listener = vi.fn();
    const sid = sessionId('cleanup');
    const unsub = bus.subscribe(sid, listener);

    unsub();

    // Subscribing a new listener after cleanup should work fine.
    const listener2 = vi.fn();
    bus.subscribe(sid, listener2);
    bus.push(sid, textDelta('new'));
    expect(listener2).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
  });
});
