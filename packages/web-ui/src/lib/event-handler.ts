/**
 * Pure event handler extracted from stores.svelte.ts for testability.
 *
 * Applies server-push events to an AppStateLike object without
 * depending on Svelte runes or any other framework-specific API.
 */

import type { SessionDto, EscalationDto, DaemonStatusDto, BudgetSummaryDto, OutputLine, JobListDto } from './types.js';

/** Minimal state surface that handleEvent needs to read and write. */
export interface AppStateLike {
  daemonStatus: DaemonStatusDto | null;
  sessions: Map<number, SessionDto>;
  selectedSessionLabel: number | null;
  pendingEscalations: Map<string, EscalationDto>;
  jobs: JobListDto[];
  addOutput(label: number, line: OutputLine): void;
  removeOutput(label: number): void;
}

/** Side effects that handleEvent may request. */
export interface EventSideEffects {
  refreshJobs(): void;
}

/**
 * Pure event handler: applies a server-push event to the state object.
 * Returns true if the event was recognized, false otherwise.
 */
export function handleEvent(state: AppStateLike, effects: EventSideEffects, event: string, payload: unknown): boolean {
  const data = payload as Record<string, unknown>;

  switch (event) {
    case 'daemon.status':
      state.daemonStatus = data as unknown as DaemonStatusDto;
      return true;

    case 'session.created':
    case 'session.updated': {
      const session = data as unknown as SessionDto;
      state.sessions = new Map(state.sessions).set(session.label, session);
      return true;
    }

    case 'session.ended': {
      const label = data.label as number;
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
      const label = data.label as number;
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
      const label = data.label as number;
      state.addOutput(label, {
        kind: 'tool_call',
        text: `${data.toolName as string}: ${data.preview as string}`,
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    case 'session.output': {
      const label = data.label as number;
      state.addOutput(label, {
        kind: 'assistant',
        text: data.text as string,
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    case 'session.budget_update': {
      const label = data.label as number;
      const budget = data.budget as BudgetSummaryDto;
      const session = state.sessions.get(label);
      if (session) {
        state.sessions = new Map(state.sessions).set(label, { ...session, budget });
      }
      return true;
    }

    case 'escalation.created': {
      const esc = data as unknown as EscalationDto;
      state.pendingEscalations = new Map(state.pendingEscalations).set(esc.escalationId, esc);
      return true;
    }

    case 'escalation.resolved':
    case 'escalation.expired': {
      const id = data.escalationId as string;
      const next = new Map(state.pendingEscalations);
      next.delete(id);
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
