/**
 * Tests for the token stream fanout store.
 *
 * Uses injected `now()` for deterministic EMA math. All timing is expressed
 * in milliseconds in the test timeline; the EMA tuning constants are
 * TARGET_TOKENS_PER_SECOND=40, HALF_LIFE_MS=500, clamp [0.3, 2.0].
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTokenStreamStore, type TokenStreamListener } from '../token-stream-store.svelte.js';
import type { TokenStreamEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textDelta(text: string, timestamp = 0): TokenStreamEvent {
  return { kind: 'text_delta', text, timestamp };
}

function toolUse(toolName: string, inputDelta = ''): TokenStreamEvent {
  return { kind: 'tool_use', toolName, inputDelta, timestamp: 0 };
}

/** Make a clock you can advance. */
function fakeClock(): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}

/** Publish N text_delta events at `rate` tok/s for `durationMs`. */
function publishAtRate(
  store: ReturnType<typeof createTokenStreamStore>,
  clock: ReturnType<typeof fakeClock>,
  ratePerSecond: number,
  durationMs: number,
  batchIntervalMs = 50,
): void {
  const batchesRemaining = Math.floor(durationMs / batchIntervalMs);
  const tokensPerBatch = Math.max(1, Math.round((ratePerSecond * batchIntervalMs) / 1000));
  for (let i = 0; i < batchesRemaining; i++) {
    clock.advance(batchIntervalMs);
    const events: TokenStreamEvent[] = [];
    for (let k = 0; k < tokensPerBatch; k++) events.push(textDelta('x'));
    store.publish(1, events);
  }
}

// ---------------------------------------------------------------------------
// Fanout
// ---------------------------------------------------------------------------

describe('token-stream-store fanout', () => {
  it('publishes to a subscribed listener with correct label and events', () => {
    const store = createTokenStreamStore(fakeClock().now);
    const received: Array<{ label: number; events: ReadonlyArray<TokenStreamEvent> }> = [];
    store.subscribeToStream((label, events) => {
      received.push({ label, events });
    });

    const batch: TokenStreamEvent[] = [textDelta('hello'), toolUse('Read')];
    store.publish(42, batch);

    expect(received).toHaveLength(1);
    expect(received[0].label).toBe(42);
    expect(received[0].events).toEqual(batch);
  });

  it('unsubscribe stops delivery to that listener', () => {
    const store = createTokenStreamStore(fakeClock().now);
    const received: number[] = [];
    const unsub = store.subscribeToStream(() => {
      received.push(1);
    });

    store.publish(1, [textDelta('a')]);
    unsub();
    store.publish(1, [textDelta('b')]);

    expect(received).toHaveLength(1);
  });

  it('fans out to multiple listeners; error in one does not stop others', () => {
    // Suppress the expected console.warn from the throwing listener.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = createTokenStreamStore(fakeClock().now);
      const ok1: number[] = [];
      const ok2: number[] = [];
      store.subscribeToStream(() => {
        ok1.push(1);
      });
      const thrower: TokenStreamListener = () => {
        throw new Error('kaboom');
      };
      store.subscribeToStream(thrower);
      store.subscribeToStream(() => {
        ok2.push(1);
      });

      store.publish(1, [textDelta('a')]);
      store.publish(1, [textDelta('b')]);

      expect(ok1).toHaveLength(2);
      expect(ok2).toHaveLength(2);
      // Warn fired once per listener identity, not per publish.
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('empty events array is a no-op: no listener invocation, no EMA perturbation', () => {
    const clock = fakeClock();
    const store = createTokenStreamStore(clock.now);
    let calls = 0;
    store.subscribeToStream(() => {
      calls++;
    });

    // Drive up the EMA so an empty batch's effect (or lack thereof) is measurable.
    publishAtRate(store, clock, 40, 2000);
    const before = store.intensity.current();

    store.publish(1, []);

    expect(calls).toBeGreaterThan(0); // from publishAtRate
    const callsAfterEmpty = calls;
    store.publish(1, []);
    expect(calls).toBe(callsAfterEmpty);

    // The EMA should not have been nudged by the empty publish.
    expect(store.intensity.current()).toBeCloseTo(before, 5);
  });
});

// ---------------------------------------------------------------------------
// Intensity EMA
// ---------------------------------------------------------------------------

describe('token-stream-store intensity EMA', () => {
  it('approaches 1.0 under sustained 40 tok/s', () => {
    const clock = fakeClock();
    const store = createTokenStreamStore(clock.now);
    publishAtRate(store, clock, 40, 3000); // 3 s of sustained rate

    const m = store.intensity.current();
    // After many half-lives at exactly 40 tok/s the EMA should sit at ~1.0.
    expect(m).toBeGreaterThan(0.9);
    expect(m).toBeLessThan(1.1);
  });

  it('clamps to upper bound 2.0 under a very high rate', () => {
    const clock = fakeClock();
    const store = createTokenStreamStore(clock.now);
    publishAtRate(store, clock, 200, 3000);

    expect(store.intensity.current()).toBeCloseTo(2.0, 5);
  });

  it('clamps to lower bound 0.3 when idle', () => {
    const store = createTokenStreamStore(fakeClock().now);
    // No publishes at all — the seeded state must read as MIN_MULTIPLIER.
    expect(store.intensity.current()).toBeCloseTo(0.3, 5);
  });

  it('decays toward 0.3 during a quiet period (half-life ~500ms)', () => {
    const clock = fakeClock();
    const store = createTokenStreamStore(clock.now);

    // Drive the EMA up to about 1.0 with sustained 40 tok/s.
    publishAtRate(store, clock, 40, 3000);
    const hot = store.intensity.current();
    expect(hot).toBeGreaterThan(0.9);

    // No publishes. Advance 500 ms — one half-life. Passive decay should
    // roughly halve the multiplier's distance from the floor.
    clock.advance(500);
    const afterOne = store.intensity.current();
    // With ema ~40 tok/s and floor 0.3, decay by 0.5 gives ~0.5 multiplier.
    // Allow slack for numerical drift and initial EMA seed.
    expect(afterOne).toBeLessThan(hot);
    expect(afterOne).toBeGreaterThan(0.3);
    expect(afterOne).toBeLessThan(0.65);

    // Advance another 4.5 s (9 more half-lives). Must converge near the floor.
    clock.advance(4500);
    expect(store.intensity.current()).toBeCloseTo(0.3, 2);
  });

  it('ignores non-text_delta events for intensity', () => {
    const clock = fakeClock();
    const store = createTokenStreamStore(clock.now);

    // Batch contains 50 tool_use events but zero text_deltas. Over 2s the
    // EMA should stay at the floor because nothing is counted.
    for (let i = 0; i < 40; i++) {
      clock.advance(50);
      const batch: TokenStreamEvent[] = [];
      for (let k = 0; k < 50; k++) batch.push(toolUse('Read'));
      store.publish(1, batch);
    }

    expect(store.intensity.current()).toBeCloseTo(0.3, 5);
  });

  it('current() is a live function, not a snapshot', () => {
    const clock = fakeClock();
    const store = createTokenStreamStore(clock.now);
    publishAtRate(store, clock, 40, 2000);

    const fn = store.intensity.current;
    const hot = fn();
    clock.advance(5000);
    const cold = fn();

    expect(cold).toBeLessThan(hot);
    expect(cold).toBeCloseTo(0.3, 2);
  });
});

// ---------------------------------------------------------------------------
// Defensive cleanup
// ---------------------------------------------------------------------------

describe('token-stream-store lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a listener unsubscribed during publish does not break the iteration', () => {
    // Guardrail: we iterate a mutable Set inside publish(). If a listener
    // chooses to unsubscribe itself, later listeners must still fire.
    const store = createTokenStreamStore(fakeClock().now);
    const calls: string[] = [];
    let unsubB: (() => void) | null = null;
    store.subscribeToStream(() => {
      calls.push('A');
    });
    unsubB = store.subscribeToStream(() => {
      calls.push('B');
      unsubB?.();
    });
    store.subscribeToStream(() => {
      calls.push('C');
    });

    store.publish(1, [textDelta('hi')]);
    expect(calls).toEqual(['A', 'B', 'C']);

    calls.length = 0;
    store.publish(1, [textDelta('hi2')]);
    // B unsubscribed itself after first call; it must not fire again.
    expect(calls).toEqual(['A', 'C']);
  });
});
