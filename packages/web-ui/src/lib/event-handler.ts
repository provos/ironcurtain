/**
 * Pure event handler extracted from stores.svelte.ts for testability.
 *
 * Applies server-push events to an AppStateLike object without
 * depending on Svelte runes or any other framework-specific API.
 */

import type {
  SessionDto,
  EscalationDto,
  DaemonStatusDto,
  BudgetSummaryDto,
  OutputLine,
  JobListDto,
  PendingEscalation,
} from './types.js';

/** Minimal state surface that handleEvent needs to read and write. */
export interface AppStateLike {
  daemonStatus: DaemonStatusDto | null;
  sessions: Map<number, SessionDto>;
  selectedSessionLabel: number | null;
  pendingEscalations: Map<string, PendingEscalation>;
  jobs: JobListDto[];
  addOutput(label: number, line: OutputLine): void;
  removeOutput(label: number): void;
}

/** Side effects that handleEvent may request. */
export interface EventSideEffects {
  refreshJobs(): void;
  assignDisplayNumber(escalationId: string): number;
}

// ---------------------------------------------------------------------------
// Discriminated union for server-push events
// ---------------------------------------------------------------------------

/** All recognized event types with their typed payloads. */
export type WebEvent =
  | { event: 'daemon.status'; payload: DaemonStatusDto }
  | { event: 'session.created'; payload: SessionDto }
  | { event: 'session.updated'; payload: SessionDto }
  | { event: 'session.ended'; payload: { label: number; reason?: string } }
  | { event: 'session.thinking'; payload: { label: number; turnNumber: number } }
  | { event: 'session.tool_call'; payload: { label: number; toolName: string; preview: string } }
  | { event: 'session.output'; payload: { label: number; text: string; turnNumber: number } }
  | { event: 'session.budget_update'; payload: { label: number; budget: BudgetSummaryDto } }
  | { event: 'escalation.created'; payload: EscalationDto }
  | { event: 'escalation.resolved'; payload: { escalationId: string; decision: string } }
  | { event: 'escalation.expired'; payload: { escalationId: string; sessionLabel: number } }
  | { event: 'job.list_changed'; payload: Record<string, unknown> }
  | { event: 'job.completed'; payload: Record<string, unknown> }
  | { event: 'job.failed'; payload: Record<string, unknown> }
  | { event: 'job.started'; payload: Record<string, unknown> };

/**
 * Parse a raw event name + payload into a typed WebEvent.
 * Returns undefined for unrecognized events.
 */
export function parseEvent(event: string, payload: unknown): WebEvent | undefined {
  const data = payload as Record<string, unknown>;
  switch (event) {
    case 'daemon.status':
      return { event, payload: data as unknown as DaemonStatusDto };
    case 'session.created':
    case 'session.updated':
      return { event, payload: data as unknown as SessionDto };
    case 'session.ended':
      return { event, payload: data as { label: number; reason?: string } };
    case 'session.thinking':
      return { event, payload: data as { label: number; turnNumber: number } };
    case 'session.tool_call':
      return { event, payload: data as { label: number; toolName: string; preview: string } };
    case 'session.output':
      return { event, payload: data as { label: number; text: string; turnNumber: number } };
    case 'session.budget_update':
      return { event, payload: data as { label: number; budget: BudgetSummaryDto } };
    case 'escalation.created':
      return { event, payload: data as unknown as EscalationDto };
    case 'escalation.resolved':
      return { event, payload: data as { escalationId: string; decision: string } };
    case 'escalation.expired':
      return { event, payload: data as { escalationId: string; sessionLabel: number } };
    case 'job.list_changed':
    case 'job.completed':
    case 'job.failed':
    case 'job.started':
      return { event, payload: data };
    default:
      return undefined;
  }
}

/**
 * Pure event handler: applies a server-push event to the state object.
 * Returns true if the event was recognized, false otherwise.
 */
export function handleEvent(state: AppStateLike, effects: EventSideEffects, event: string, payload: unknown): boolean {
  const parsed = parseEvent(event, payload);
  if (!parsed) return false;
  return applyEvent(state, effects, parsed);
}

/**
 * Apply a typed WebEvent to the state. The switch on `parsed.event`
 * narrows `parsed.payload` automatically.
 */
function applyEvent(state: AppStateLike, effects: EventSideEffects, parsed: WebEvent): boolean {
  switch (parsed.event) {
    case 'daemon.status':
      state.daemonStatus = parsed.payload;
      return true;

    case 'session.created':
    case 'session.updated': {
      const session = parsed.payload;
      state.sessions = new Map(state.sessions).set(session.label, session);
      return true;
    }

    case 'session.ended': {
      const { label } = parsed.payload;
      const next = new Map(state.sessions);
      next.delete(label);
      state.sessions = next;
      state.removeOutput(label);
      if (state.selectedSessionLabel === label) {
        state.selectedSessionLabel = null;
      }
      return true;
    }

    case 'session.thinking': {
      const { label } = parsed.payload;
      const existing = state.sessions.get(label);
      if (existing) {
        state.sessions = new Map(state.sessions).set(label, { ...existing, status: 'processing' });
      }
      state.addOutput(label, {
        kind: 'thinking',
        text: 'Thinking...',
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    case 'session.tool_call': {
      const { label, toolName, preview } = parsed.payload;
      state.addOutput(label, {
        kind: 'tool_call',
        text: `${toolName}: ${preview}`,
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    case 'session.output': {
      const { label, text } = parsed.payload;
      state.addOutput(label, {
        kind: 'assistant',
        text,
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    case 'session.budget_update': {
      const { label, budget } = parsed.payload;
      const session = state.sessions.get(label);
      if (session) {
        state.sessions = new Map(state.sessions).set(label, { ...session, budget });
      }
      return true;
    }

    case 'escalation.created': {
      const esc = parsed.payload;
      const displayNumber = effects.assignDisplayNumber(esc.escalationId);
      const pending: PendingEscalation = { ...esc, displayNumber };
      state.pendingEscalations = new Map(state.pendingEscalations).set(esc.escalationId, pending);
      return true;
    }

    case 'escalation.resolved':
    case 'escalation.expired': {
      const { escalationId } = parsed.payload;
      const next = new Map(state.pendingEscalations);
      next.delete(escalationId);
      state.pendingEscalations = next;
      return true;
    }

    case 'job.list_changed':
    case 'job.completed':
    case 'job.failed':
    case 'job.started':
      effects.refreshJobs();
      return true;

    default:
      return false;
  }
}
