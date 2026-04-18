/**
 * Token stream fanout store for the workflow theater.
 *
 * Owns the hot path from the `session.token_stream` dispatch site to every
 * theater consumer. Deliberately imperative — no Svelte runes in this
 * module — so bursts of 20+ events per 50ms batch never perturb the
 * reactive graph. Per design §B.1, there is no intermediate bus; this
 * module is the single owner.
 *
 * Also computes a decaying EMA of assistant-visible tokens-per-second
 * which the theater reads via `intensity.current()` to modulate rain
 * density (§A.3).
 */

import type { TokenStreamEvent } from './types.js';

export type TokenStreamListener = (label: number, events: ReadonlyArray<TokenStreamEvent>) => void;

export interface TokenStreamStore {
  /** Called by event-handler.ts on 'session.token_stream' events. */
  publish(label: number, events: ReadonlyArray<TokenStreamEvent>): void;
  /**
   * Register a listener. Returns an unsubscribe function.
   * Listeners are invoked synchronously in publish order.
   * An error thrown by one listener does not prevent later listeners from firing.
   */
  subscribeToStream(listener: TokenStreamListener): () => void;
  /**
   * Tokens-per-second decaying EMA. Updated inside publish().
   * Theater reads this imperatively (not via a Svelte reactive signal) to
   * drive StreamRainEngine.setIntensity() — see §A.3.
   *
   * Target: 1.0 at ~40 tok/s, clamped to [0.3, 2.0].
   * Decay: exponential, half-life ~500ms.
   */
  readonly intensity: { readonly current: () => number };
  /**
   * Raw tokens-per-second EMA (pre-clamp). The HUD displays this as the
   * live tok/s number; the clamped `intensity.current()` drives rain density.
   * Both decay identically during idle.
   */
  readonly ratePerSecond: () => number;
}

// ---------------------------------------------------------------------------
// EMA tuning constants (§A.3)
// ---------------------------------------------------------------------------

/** tokens/second that maps to multiplier = 1.0. */
const TARGET_TOKENS_PER_SECOND = 40;
/** Lower bound on the intensity multiplier — idle rain should still feel alive. */
const MIN_MULTIPLIER = 0.3;
/** Upper bound — prevents runaway rain on bursty streams. */
const MAX_MULTIPLIER = 2.0;
/** Half-life of the EMA in milliseconds. */
const HALF_LIFE_MS = 500;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Count tokens in a batch for intensity purposes.
 *
 * Per §A.3, only `text_delta` events count — intensity tracks
 * assistant-visible output, not plumbing (message_start, tool_use, etc.).
 */
function countVisibleTokens(events: ReadonlyArray<TokenStreamEvent>): number {
  let n = 0;
  for (const event of events) {
    if (event.kind === 'text_delta' && typeof event.text === 'string') n += 1;
  }
  return n;
}

export function createTokenStreamStore(now: () => number = () => Date.now()): TokenStreamStore {
  // Listener set. We track "already warned" identities so a broken listener
  // only logs once — 40 tok/s at 50ms batches would otherwise flood the console.
  const listeners = new Set<TokenStreamListener>();
  const warned = new WeakSet<TokenStreamListener>();

  // Intensity EMA state.
  let ema = MIN_MULTIPLIER * TARGET_TOKENS_PER_SECOND; // seed so first read is MIN_MULTIPLIER
  let lastPublishMs: number | null = null;

  function decayedEma(): number {
    if (lastPublishMs !== null) {
      const deltaMs = Math.max(0, now() - lastPublishMs);
      if (deltaMs > 0) {
        const decay = Math.exp((-deltaMs / HALF_LIFE_MS) * Math.LN2);
        return ema * decay;
      }
    }
    return ema;
  }

  function computeCurrentMultiplier(): number {
    return clamp(decayedEma() / TARGET_TOKENS_PER_SECOND, MIN_MULTIPLIER, MAX_MULTIPLIER);
  }

  function updateEma(tokenCount: number, nowMs: number): void {
    if (lastPublishMs === null) {
      // First publish — bootstrap the EMA at the instantaneous rate so a
      // single burst doesn't need multiple ticks to register.
      lastPublishMs = nowMs;
      if (tokenCount > 0) ema = tokenCount * (1000 / Math.max(1, HALF_LIFE_MS));
      return;
    }
    const deltaMs = Math.max(1, nowMs - lastPublishMs);
    const rate = (tokenCount / deltaMs) * 1000; // tokens per second for this interval
    const decay = Math.exp((-deltaMs / HALF_LIFE_MS) * Math.LN2);
    ema = ema * decay + rate * (1 - decay);
    lastPublishMs = nowMs;
  }

  function dispatch(label: number, events: ReadonlyArray<TokenStreamEvent>): void {
    for (const listener of listeners) {
      try {
        listener(label, events);
      } catch (err) {
        if (!warned.has(listener)) {
          warned.add(listener);
          // Keep the error visible for devs without flooding on every subsequent batch.
          console.warn('[token-stream-store] listener threw; suppressing further warnings for this listener', err);
        }
      }
    }
  }

  return {
    publish(label, events) {
      // Empty-batch no-op (§A.3 spec): don't perturb the EMA, don't pay the
      // dispatch cost. The dispatcher may send empty arrays for keepalive.
      if (events.length === 0) return;
      updateEma(countVisibleTokens(events), now());
      dispatch(label, events);
    },
    subscribeToStream(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    intensity: {
      current: computeCurrentMultiplier,
    },
    ratePerSecond: decayedEma,
  };
}
