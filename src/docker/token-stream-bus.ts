/**
 * Stateless pub/sub dispatcher for LLM token stream events.
 *
 * A module-scoped singleton (see `getTokenStreamBus()`) is shared
 * across all publishers and subscribers in-process. No buffering --
 * events are delivered synchronously to current listeners and
 * discarded if none exist.
 */

import type { SessionId } from '../session/types.js';
import type { TokenStreamEvent, TokenStreamListener } from './token-stream-types.js';

/**
 * Invoke a listener without propagating errors. The bus is best-effort;
 * listener errors are swallowed so `push()` never throws and one misbehaving
 * consumer cannot break fan-out to other subscribers.
 */
function safeInvoke(fn: TokenStreamListener, sessionId: SessionId, event: TokenStreamEvent): void {
  try {
    fn(sessionId, event);
  } catch {
    // Intentionally swallow -- no sensible recovery for subscriber errors.
  }
}

/**
 * Stateless pub/sub dispatcher for LLM token stream events.
 *
 * The bus maintains two listener collections:
 * - Per-session: `Map<SessionId, Set<Listener>>` for consumers watching
 *   a specific session (web UI session view, CLI `observe <session>`)
 * - Global: `Set<Listener>` for consumers watching all sessions
 *   (CLI `observe --all`, future Matrix rain visualization)
 *
 * `push(sessionId, event)` dispatches to both the session-specific
 * listener set and the global listener set.
 *
 * Invariants:
 * - `subscribe()` and `subscribeAll()` return unsubscribe functions
 *   for RAII-style cleanup.
 * - Subscribers receive only live events from the point of subscription
 *   forward. There is no history or replay.
 * - Push never blocks or throws, even with zero subscribers.
 */
export interface TokenStreamBus {
  /**
   * Push an event to all listeners for the given session and all
   * global listeners. Discarded silently if no listeners exist.
   */
  push(sessionId: SessionId, event: TokenStreamEvent): void;

  /**
   * Subscribe to a single session's token stream.
   * The listener receives only live events from this point forward.
   *
   * @returns An unsubscribe function. Calling it removes the listener.
   */
  subscribe(sessionId: SessionId, listener: TokenStreamListener): () => void;

  /**
   * Subscribe to token stream events from all sessions.
   * The listener receives every event pushed to the bus,
   * regardless of session.
   *
   * @returns An unsubscribe function. Calling it removes the listener.
   */
  subscribeAll(listener: TokenStreamListener): () => void;

  /**
   * Signal that a session has ended. Removes the session's
   * per-session listener set.
   */
  endSession(sessionId: SessionId): void;
}

/** Creates a new TokenStreamBus instance. */
export function createTokenStreamBus(): TokenStreamBus {
  const sessions = new Map<SessionId, Set<TokenStreamListener>>();
  const globalListeners = new Set<TokenStreamListener>();

  return {
    push(sessionId, event) {
      // Invariant: push() never throws, even if a listener does.
      const listeners = sessions.get(sessionId);
      if (listeners) {
        for (const fn of listeners) safeInvoke(fn, sessionId, event);
      }
      for (const fn of globalListeners) safeInvoke(fn, sessionId, event);
    },

    subscribe(sessionId, listener) {
      let listeners = sessions.get(sessionId);
      if (!listeners) {
        listeners = new Set();
        sessions.set(sessionId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) sessions.delete(sessionId);
      };
    },

    subscribeAll(listener) {
      globalListeners.add(listener);
      return () => {
        globalListeners.delete(listener);
      };
    },

    endSession(sessionId) {
      sessions.delete(sessionId);
    },
  };
}

/**
 * Module-scoped singleton instance. Lazily created on first call to
 * `getTokenStreamBus()`. Cleared by `resetTokenStreamBus()` for tests.
 */
let singleton: TokenStreamBus | undefined;

/**
 * Returns the module-scoped singleton TokenStreamBus, creating it on
 * first access. Subsequent calls return the same instance.
 *
 * Use this from daemon-level producers/consumers (MITM proxy, web UI
 * bridge, observe CLI) that all need to share a single bus. Tests that
 * want isolated, stack-local instances should call `createTokenStreamBus()`
 * directly.
 */
export function getTokenStreamBus(): TokenStreamBus {
  if (!singleton) {
    singleton = createTokenStreamBus();
  }
  return singleton;
}

/**
 * Clears the module-scoped singleton so the next `getTokenStreamBus()`
 * call returns a fresh instance. Intended for test `beforeEach` hooks.
 *
 * INVARIANT: do NOT call this while any `TokenStreamBridge` instance has
 * active subscriptions. The bridge caches bus unsubscribe handles in
 * `this.subscriptions` / `this.globalUnsubscribe` that are bound to the
 * old bus; after reset, subsequent `addClient`/`addGlobalClient` calls
 * will subscribe on the NEW bus, but events pushed on behalf of old
 * subscriptions still target the stale bus and never reach the new one.
 * The safe pattern is: construct a fresh `TokenStreamBridge` after every
 * reset (i.e. build both in the same `beforeEach`). Daemon production
 * code never resets.
 */
export function resetTokenStreamBus(): void {
  singleton = undefined;
}
