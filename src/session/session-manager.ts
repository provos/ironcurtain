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
 * Minimal escalation data stored on a ManagedSession. Allows
 * late-connecting clients (e.g. a new browser tab) to enumerate
 * pending escalations without having received the original event.
 */
export interface PendingEscalationData {
  readonly escalationId: string;
  readonly sessionLabel: number;
  readonly toolName: string;
  readonly serverName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
  readonly context?: Record<string, string>;
  readonly receivedAt: string;
}

/**
 * Source discriminant for managed sessions.
 * Determines cleanup behavior, notification routing, and
 * message forwarding eligibility.
 *
 * - 'signal': interactive session created via Signal message.
 *   Accepts follow-up messages via forwardToSession().
 * - 'cron': headless session created by the cron scheduler.
 *   Does NOT accept follow-up messages.
 * - 'web': interactive session created via the web UI.
 *   Always targeted by explicit label (no currentLabel focus).
 */
export type SessionSource =
  | { readonly kind: 'signal' }
  | { readonly kind: 'cron'; readonly jobId: JobId; readonly jobName: string }
  | { readonly kind: 'web' };

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
  /** Full escalation data for late-connecting clients and expiry handling. */
  pendingEscalation: PendingEscalationData | null;
  escalationResolving: boolean;
  /**
   * The promise returned by transport.run(). When set, SessionManager.end()
   * awaits it after closing the transport but before closing the session,
   * giving the transport time to finish cleanup (e.g., auto-save).
   */
  runPromise: Promise<void> | null;
}

export interface EscalationResolutionResult {
  readonly resolved: boolean;
  readonly reason?: 'not_found' | 'no_escalation' | 'already_resolving';
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
   * Only updated by register() for Signal sessions. Cron and web
   * sessions do not steal Signal focus.
   */
  currentLabel: number | null = null;

  /**
   * Registers a new session and returns its assigned label.
   *
   * For Signal sessions: sets currentLabel to the new session.
   * For cron/web sessions: currentLabel is NOT changed.
   */
  register(session: Session, transport: Transport, source: SessionSource): number {
    const label = this.nextLabel++;

    const managed: ManagedSession = {
      label,
      session,
      transport,
      source,
      messageInFlight: false,
      pendingEscalation: null,
      escalationResolving: false,
      runPromise: null,
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

    // Wait for the transport's run() to finish (e.g., auto-save) before
    // closing the session. Bounded to 30s to avoid hanging on stuck transports.
    if (managed.runPromise) {
      try {
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000));
        await Promise.race([managed.runPromise, timeout]);
      } catch {
        // run() errors are already handled by the caller that started it
      }
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
  setPendingEscalation(label: number, escalation: PendingEscalationData | string): void {
    const managed = this.sessions.get(label);
    if (!managed) return;

    if (typeof escalation === 'string') {
      // Backward compat: Signal transport passes just the ID
      managed.pendingEscalation = {
        escalationId: escalation,
        sessionLabel: label,
        toolName: '',
        serverName: '',
        arguments: {},
        reason: '',
        receivedAt: new Date().toISOString(),
      };
    } else {
      managed.pendingEscalation = escalation;
    }
  }

  /** Clears a session's pending escalation. */
  clearPendingEscalation(label: number): void {
    const managed = this.sessions.get(label);
    if (managed) {
      managed.pendingEscalation = null;
      managed.escalationResolving = false;
    }
  }

  /** Returns sessions that have pending escalations. */
  withPendingEscalation(): readonly ManagedSession[] {
    return [...this.sessions.values()].filter((m) => m.pendingEscalation !== null);
  }

  /** Finds a session by pending escalation ID. */
  findByEscalation(escalationId: string): ManagedSession | undefined {
    return [...this.sessions.values()].find((m) => m.pendingEscalation?.escalationId === escalationId);
  }

  /**
   * Resolves a pending escalation on any session. Encapsulates the
   * escalationResolving guard, the resolveEscalation call, and the
   * clearPendingEscalation cleanup.
   *
   * This is the single codepath for escalation resolution. All three
   * transports (Signal, web, cron auto-deny) call through here.
   */
  async resolveSessionEscalation(
    escalationId: string,
    decision: 'approved' | 'denied',
    options?: { whitelistSelection?: number },
  ): Promise<EscalationResolutionResult> {
    const managed = this.findByEscalation(escalationId);
    if (!managed) {
      return { resolved: false, reason: 'not_found' };
    }

    if (managed.escalationResolving) {
      return { resolved: false, reason: 'already_resolving' };
    }

    managed.escalationResolving = true;
    try {
      await managed.session.resolveEscalation(escalationId, decision, options);
      return { resolved: true };
    } finally {
      managed.escalationResolving = false;
      if (managed.pendingEscalation?.escalationId === escalationId) {
        managed.pendingEscalation = null;
      }
    }
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
