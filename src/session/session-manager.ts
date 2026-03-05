/**
 * SessionManager -- Unified session state management.
 *
 * Extracted from SignalBotDaemon to serve as the single owner of all
 * managed session state. Both Signal-initiated and cron-initiated
 * sessions register here for unified lifecycle management and
 * escalation routing.
 *
 * This is the canonical location for SessionSource and ManagedSession
 * types. The daemon module re-exports them for convenience.
 */

import type { Session } from './types.js';
import type { Transport } from './transport.js';
import type { JobId } from '../cron/types.js';
import * as logger from '../logger.js';

/**
 * Source discriminant for managed sessions.
 * Determines cleanup behavior, notification routing, and
 * message forwarding eligibility.
 *
 * - 'signal': interactive session created via Signal message.
 *   Accepts follow-up messages via forwardToSession().
 * - 'cron': headless session created by the cron scheduler.
 *   Does NOT accept follow-up messages.
 */
export type SessionSource =
  | { readonly kind: 'signal' }
  | { readonly kind: 'cron'; readonly jobId: JobId; readonly jobName: string };

/**
 * Unified managed session entry. Used for both Signal-initiated
 * interactive sessions and cron-initiated headless sessions.
 *
 * The transport field uses the base Transport interface because
 * cron sessions use HeadlessTransport. Code that needs
 * Signal-specific methods must guard on source.kind === 'signal'.
 */
export interface ManagedSession {
  readonly label: number;
  readonly session: Session;
  readonly transport: Transport;
  readonly source: SessionSource;
  messageInFlight: boolean;
  pendingEscalationId: string | null;
  escalationResolving: boolean;
}

/**
 * Owns all managed session state. Both SignalBotDaemon and
 * CronScheduler delegate to this class for session registration,
 * lookup, and teardown.
 *
 * Invariants:
 * - Labels are monotonically increasing integers starting at 1.
 * - At most one session exists per label.
 * - currentLabel is always either null or a valid label in the map.
 */
export class SessionManager {
  private sessions = new Map<number, ManagedSession>();
  private nextLabel = 1;

  /**
   * The currently "focused" session label for Signal message routing.
   * When a Signal message arrives without an explicit #N prefix, it
   * is routed to this session.
   *
   * Only updated by register() for Signal sessions. Cron sessions
   * do not steal Signal focus.
   */
  currentLabel: number | null = null;

  /**
   * Registers a new session and returns its assigned label.
   *
   * For Signal sessions: sets currentLabel to the new session.
   * For cron sessions: currentLabel is NOT changed.
   */
  register(session: Session, transport: Transport, source: SessionSource): number {
    const label = this.nextLabel++;

    const managed: ManagedSession = {
      label,
      session,
      transport,
      source,
      messageInFlight: false,
      pendingEscalationId: null,
      escalationResolving: false,
    };

    this.sessions.set(label, managed);

    // Only Signal sessions update currentLabel
    if (source.kind === 'signal') {
      this.currentLabel = label;
    }

    return label;
  }

  /**
   * Ends a session by label: closes the transport, closes the
   * session, and removes it from the map.
   *
   * If the ended session was currentLabel, switches to the most
   * recently registered remaining Signal session, or null if none.
   */
  async end(label: number): Promise<void> {
    const managed = this.sessions.get(label);
    if (!managed) return;

    try {
      managed.transport.close();
    } catch (err: unknown) {
      logger.warn(`[SessionManager] Error closing transport for session #${label}: ${String(err)}`);
    }

    try {
      await managed.session.close();
    } catch (err: unknown) {
      logger.warn(`[SessionManager] Error closing session #${label}: ${String(err)}`);
    }

    this.sessions.delete(label);

    // If the ended session was the current label, find a replacement
    if (this.currentLabel === label) {
      this.currentLabel = this.findMostRecentSignalLabel();
    }
  }

  /** Returns the ManagedSession for a label, or undefined. */
  get(label: number): ManagedSession | undefined {
    return this.sessions.get(label);
  }

  /** Returns all managed sessions (snapshot). */
  all(): readonly ManagedSession[] {
    return [...this.sessions.values()];
  }

  /** Returns managed sessions filtered by source kind. */
  byKind(kind: SessionSource['kind']): readonly ManagedSession[] {
    return [...this.sessions.values()].filter((m) => m.source.kind === kind);
  }

  /** Returns the number of active sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Records that a session has a pending escalation. */
  setPendingEscalation(label: number, escalationId: string): void {
    const managed = this.sessions.get(label);
    if (managed) {
      managed.pendingEscalationId = escalationId;
    }
  }

  /** Clears a session's pending escalation. */
  clearPendingEscalation(label: number): void {
    const managed = this.sessions.get(label);
    if (managed) {
      managed.pendingEscalationId = null;
      managed.escalationResolving = false;
    }
  }

  /** Returns sessions that have pending escalations. */
  withPendingEscalation(): readonly ManagedSession[] {
    return [...this.sessions.values()].filter((m) => m.pendingEscalationId !== null);
  }

  /**
   * Finds the most recently registered Signal session label.
   * Returns null if no Signal sessions exist.
   */
  private findMostRecentSignalLabel(): number | null {
    const signalSessions = this.byKind('signal');
    if (signalSessions.length === 0) return null;
    return Math.max(...signalSessions.map((m) => m.label));
  }
}
