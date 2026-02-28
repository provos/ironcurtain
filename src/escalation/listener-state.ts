/**
 * State management for the escalation listener TUI.
 *
 * Immutable state updates -- each mutation returns a new state object.
 * The rendering layer reads state and redraws on change.
 */

import type { PtySessionRegistration } from '../docker/pty-types.js';
import type { EscalationWatcher } from './escalation-watcher.js';
import type { EscalationRequest } from '../session/types.js';

export interface ActiveSession {
  readonly registration: PtySessionRegistration;
  readonly watcher: EscalationWatcher;
  /** Sequential display number assigned when the session was first detected. */
  readonly displayNumber: number;
}

export interface PendingEscalation {
  readonly sessionId: string;
  readonly sessionDisplayNumber: number;
  readonly request: EscalationRequest;
  /** Monotonically increasing display number for /approve and /deny commands. */
  readonly displayNumber: number;
  readonly receivedAt: Date;
}

export interface ResolvedEscalation {
  readonly sessionId: string;
  readonly toolName: string;
  readonly serverName: string;
  readonly decision: 'approved' | 'denied';
  readonly resolvedAt: Date;
}

export interface ListenerState {
  readonly sessions: ReadonlyMap<string, ActiveSession>;
  readonly pendingEscalations: ReadonlyMap<number, PendingEscalation>;
  readonly history: readonly ResolvedEscalation[];
  readonly nextEscalationNumber: number;
  readonly nextSessionNumber: number;
}

/** Maximum number of resolved escalations to keep in history. */
const MAX_HISTORY = 20;

/** Creates an empty initial state. */
export function createInitialState(): ListenerState {
  return {
    sessions: new Map(),
    pendingEscalations: new Map(),
    history: [],
    nextEscalationNumber: 1,
    nextSessionNumber: 1,
  };
}

/** Adds a new session to the state. */
export function addSession(
  state: ListenerState,
  registration: PtySessionRegistration,
  watcher: EscalationWatcher,
): ListenerState {
  const sessions = new Map(state.sessions);
  sessions.set(registration.sessionId, {
    registration,
    watcher,
    displayNumber: state.nextSessionNumber,
  });
  return {
    ...state,
    sessions,
    nextSessionNumber: state.nextSessionNumber + 1,
  };
}

/** Removes a session and its pending escalations from the state. */
export function removeSession(state: ListenerState, sessionId: string): ListenerState {
  const sessions = new Map(state.sessions);
  sessions.delete(sessionId);

  // Remove any pending escalations for this session
  const pendingEscalations = new Map(state.pendingEscalations);
  for (const [num, esc] of pendingEscalations) {
    if (esc.sessionId === sessionId) {
      pendingEscalations.delete(num);
    }
  }

  return { ...state, sessions, pendingEscalations };
}

/** Adds a new pending escalation to the state. */
export function addEscalation(state: ListenerState, sessionId: string, request: EscalationRequest): ListenerState {
  const session = state.sessions.get(sessionId);
  if (!session) return state;

  const displayNumber = state.nextEscalationNumber;
  const pendingEscalations = new Map(state.pendingEscalations);
  pendingEscalations.set(displayNumber, {
    sessionId,
    sessionDisplayNumber: session.displayNumber,
    request,
    displayNumber,
    receivedAt: new Date(),
  });

  return {
    ...state,
    pendingEscalations,
    nextEscalationNumber: displayNumber + 1,
  };
}

/** Resolves a pending escalation and moves it to history. */
export function resolveEscalation(
  state: ListenerState,
  displayNumber: number,
  decision: 'approved' | 'denied',
): ListenerState {
  const escalation = state.pendingEscalations.get(displayNumber);
  if (!escalation) return state;

  const pendingEscalations = new Map(state.pendingEscalations);
  pendingEscalations.delete(displayNumber);

  const resolved: ResolvedEscalation = {
    sessionId: escalation.sessionId,
    toolName: escalation.request.toolName,
    serverName: escalation.request.serverName,
    decision,
    resolvedAt: new Date(),
  };

  // Prepend to history and trim to MAX_HISTORY
  const history = [resolved, ...state.history].slice(0, MAX_HISTORY);

  return { ...state, pendingEscalations, history };
}

/** Removes a pending escalation that expired. */
export function expireEscalation(state: ListenerState, sessionId: string, escalationId: string): ListenerState {
  const pendingEscalations = new Map(state.pendingEscalations);

  for (const [num, esc] of pendingEscalations) {
    if (esc.sessionId === sessionId && esc.request.escalationId === escalationId) {
      pendingEscalations.delete(num);

      // Add to history as expired
      const resolved: ResolvedEscalation = {
        sessionId: esc.sessionId,
        toolName: esc.request.toolName,
        serverName: esc.request.serverName,
        decision: 'denied',
        resolvedAt: new Date(),
      };
      const history = [resolved, ...state.history].slice(0, MAX_HISTORY);

      return { ...state, pendingEscalations, history };
    }
  }

  return state;
}
