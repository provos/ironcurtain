/**
 * Bridge between TokenStreamBus and WebSocket clients.
 *
 * Manages per-label batching timers, reference-counted bus subscriptions,
 * global (all-sessions) subscriptions, and bidirectional label<->SessionId
 * maps. Events are delivered via WebUiServer.sendToSubscribers() for
 * targeted delivery to subscribed clients only.
 */

import type { WebSocket as WsWebSocket } from 'ws';

import type { SessionId } from '../session/types.js';
import type { TokenStreamBus } from '../docker/token-stream-bus.js';
import type { TokenStreamEvent } from '../docker/token-stream-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback interface for targeted event delivery. */
export interface TokenStreamSender {
  sendToSubscribers(clients: ReadonlySet<WsWebSocket>, event: string, payload: unknown): void;
}

/** Sentinel label value representing a global (all-sessions) subscription. */
const GLOBAL_LABEL = -1 as const;

/** Tracks a per-label bus subscription shared across WS clients. */
interface SessionSubscription {
  readonly sessionId: SessionId;
  readonly unsubscribe: () => void;
  readonly clients: Set<WsWebSocket>;
}

// ---------------------------------------------------------------------------
// TokenStreamBridge
// ---------------------------------------------------------------------------

export class TokenStreamBridge {
  /** Per-label subscription tracking with reference-counted bus listeners. */
  private readonly subscriptions = new Map<number, SessionSubscription>();

  /** Reverse index: which labels each client is subscribed to. */
  private readonly clientSubscriptions = new Map<WsWebSocket, Set<number>>();

  /** Bidirectional label <-> SessionId maps. */
  private readonly sessionToLabel = new Map<SessionId, number>();
  private readonly labelToSession = new Map<number, SessionId>();

  /** Pending event batches per label, flushed on timer. */
  private readonly pending = new Map<number, TokenStreamEvent[]>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  /** Global subscription tracking (subscribeAll). */
  private readonly globalClients = new Set<WsWebSocket>();
  private globalUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly sender: TokenStreamSender,
    private readonly bus: TokenStreamBus,
    private readonly flushIntervalMs = 50,
  ) {}

  // -------------------------------------------------------------------------
  // Per-session subscription
  // -------------------------------------------------------------------------

  /** Add a client's subscription to a specific session label. */
  addClient(client: WsWebSocket, label: number, sessionId: SessionId): void {
    this.sessionToLabel.set(sessionId, label);
    this.labelToSession.set(label, sessionId);

    let sub = this.subscriptions.get(label);
    if (!sub) {
      const unsubscribe = this.bus.subscribe(sessionId, (_sid, event) => {
        this.enqueue(label, event);
      });
      sub = { sessionId, unsubscribe, clients: new Set() };
      this.subscriptions.set(label, sub);
    }
    sub.clients.add(client);

    let labels = this.clientSubscriptions.get(client);
    if (!labels) {
      labels = new Set();
      this.clientSubscriptions.set(client, labels);
    }
    labels.add(label);
  }

  /** Remove a client's subscription from a specific session label. */
  removeClient(client: WsWebSocket, label: number): void {
    const sub = this.subscriptions.get(label);
    if (!sub) return;

    sub.clients.delete(client);
    this.clientSubscriptions.get(client)?.delete(label);

    // If no clients remain, tear down the bus subscription
    if (sub.clients.size === 0) {
      this.teardownLabel(label, sub);
    }
  }

  // -------------------------------------------------------------------------
  // Global subscription (subscribeAll)
  // -------------------------------------------------------------------------

  /** Subscribe a client to receive events from all sessions. */
  addGlobalClient(client: WsWebSocket): void {
    this.globalClients.add(client);

    let labels = this.clientSubscriptions.get(client);
    if (!labels) {
      labels = new Set();
      this.clientSubscriptions.set(client, labels);
    }
    labels.add(GLOBAL_LABEL);

    if (!this.globalUnsubscribe) {
      this.globalUnsubscribe = this.bus.subscribeAll((sessionId, event) => {
        const label = this.sessionToLabel.get(sessionId);
        if (label === undefined) return;
        this.enqueueGlobal(label, event);
      });
    }
  }

  /** Remove a client's global subscription. */
  removeGlobalClient(client: WsWebSocket): void {
    this.globalClients.delete(client);
    this.clientSubscriptions.get(client)?.delete(GLOBAL_LABEL);

    if (this.globalClients.size === 0 && this.globalUnsubscribe) {
      this.globalUnsubscribe();
      this.globalUnsubscribe = null;
    }
  }

  /** Check if a client has a global subscription. */
  hasGlobalSubscription(client: WsWebSocket): boolean {
    return this.globalClients.has(client);
  }

  /** Check if a client is subscribed to a specific label. */
  hasSubscription(client: WsWebSocket, label: number): boolean {
    return this.subscriptions.get(label)?.clients.has(client) ?? false;
  }

  // -------------------------------------------------------------------------
  // Session and client lifecycle
  // -------------------------------------------------------------------------

  /**
   * Clean up all state for a session: cancel pending timers,
   * discard buffered events, unsubscribe from the bus, and
   * remove all tracking entries.
   */
  closeSession(label: number): void {
    const sub = this.subscriptions.get(label);
    if (sub) {
      // Remove the label from each client's per-client tracking before teardown
      for (const client of sub.clients) {
        this.clientSubscriptions.get(client)?.delete(label);
      }
      this.teardownLabel(label, sub);
    } else {
      // No subscription, but bidirectional maps may exist from registerSession()
      this.cancelTimer(label);
      this.pending.delete(label);
      const sessionId = this.labelToSession.get(label);
      if (sessionId !== undefined) {
        this.sessionToLabel.delete(sessionId);
      }
      this.labelToSession.delete(label);
    }
  }

  /** Remove all subscriptions for a disconnecting client. */
  removeAllForClient(client: WsWebSocket): void {
    const labels = this.clientSubscriptions.get(client);
    if (!labels) return;

    // Copy to avoid mutation during iteration
    for (const label of [...labels]) {
      if (label === GLOBAL_LABEL) {
        this.removeGlobalClient(client);
      } else {
        this.removeClient(client, label);
      }
    }
    this.clientSubscriptions.delete(client);
  }

  /** Register a label<->sessionId mapping (for global subscription routing). */
  registerSession(label: number, sessionId: SessionId): void {
    this.sessionToLabel.set(sessionId, label);
    this.labelToSession.set(label, sessionId);
  }

  /** Shut down the entire bridge (daemon shutdown). */
  close(): void {
    // Close all labels with per-session subscriptions
    for (const [label] of [...this.subscriptions]) {
      this.closeSession(label);
    }
    // Close any register-only labels (from registerSession) that
    // have no per-session subscription
    for (const [label] of [...this.labelToSession]) {
      this.closeSession(label);
    }
    if (this.globalUnsubscribe) {
      this.globalUnsubscribe();
      this.globalUnsubscribe = null;
    }
    this.globalClients.clear();
    this.clientSubscriptions.clear();
  }

  // -------------------------------------------------------------------------
  // Batching internals
  // -------------------------------------------------------------------------

  private enqueue(label: number, event: TokenStreamEvent): void {
    let batch = this.pending.get(label);
    if (!batch) {
      batch = [];
      this.pending.set(label, batch);
    }
    batch.push(event);
    this.scheduleFlush(label);
  }

  private enqueueGlobal(label: number, event: TokenStreamEvent): void {
    // If a per-session subscription exists for this label, the per-session
    // bus listener already enqueues the event. Skip to avoid duplication.
    if (this.subscriptions.has(label)) return;

    // For labels with only global subscribers, batch per-label.
    // The flush sends to global clients.
    this.enqueue(label, event);
  }

  private scheduleFlush(label: number): void {
    if (this.timers.has(label)) return;
    this.timers.set(
      label,
      setTimeout(() => {
        this.timers.delete(label);
        this.flush(label);
      }, this.flushIntervalMs),
    );
  }

  private flush(label: number): void {
    const events = this.pending.get(label);
    if (!events || events.length === 0) return;
    this.pending.delete(label);

    const sub = this.subscriptions.get(label);
    const perSessionClients = sub && sub.clients.size > 0 ? sub.clients : undefined;
    const hasGlobal = this.globalClients.size > 0;

    if (!perSessionClients && !hasGlobal) return;

    // Avoid allocating a merged Set when only one source has clients
    let recipients: ReadonlySet<WsWebSocket>;
    if (perSessionClients && !hasGlobal) {
      recipients = perSessionClients;
    } else if (!perSessionClients) {
      recipients = this.globalClients;
    } else {
      const merged = new Set<WsWebSocket>(perSessionClients);
      for (const c of this.globalClients) merged.add(c);
      recipients = merged;
    }

    this.sender.sendToSubscribers(recipients, 'session.token_stream', { label, events });
  }

  private teardownLabel(label: number, sub: SessionSubscription): void {
    sub.unsubscribe();
    this.cancelTimer(label);
    this.pending.delete(label);
    this.subscriptions.delete(label);
    this.sessionToLabel.delete(sub.sessionId);
    this.labelToSession.delete(label);
  }

  private cancelTimer(label: number): void {
    const timer = this.timers.get(label);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(label);
    }
  }
}
