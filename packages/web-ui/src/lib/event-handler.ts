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
  TokenStreamEvent,
  WorkflowSummaryDto,
  HumanGateRequestDto,
} from './types.js';
import { PHASE } from './types.js';
import { tokenStreamStore } from './token-stream-store-singleton.js';

/** Minimal state surface that handleEvent needs to read and write. */
export interface AppStateLike {
  daemonStatus: DaemonStatusDto | null;
  sessions: Map<number, SessionDto>;
  selectedSessionLabel: number | null;
  pendingEscalations: Map<string, PendingEscalation>;
  jobs: JobListDto[];
  workflows: Map<string, WorkflowSummaryDto>;
  pendingGates: Map<string, HumanGateRequestDto>;
  addOutput(label: number, line: OutputLine): void;
  removeOutput(label: number): void;
  filterOutput(label: number, predicate: (line: OutputLine) => boolean): void;
}

/** Side effects that handleEvent may request. */
export interface EventSideEffects {
  refreshJobs(): void;
  assignDisplayNumber(escalationId: string): number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if any gate in the map belongs to the given workflow. */
function hasGateForWorkflow(gates: ReadonlyMap<string, HumanGateRequestDto>, workflowId: string): boolean {
  for (const gate of gates.values()) {
    if (gate.workflowId === workflowId) return true;
  }
  return false;
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
  | { event: 'session.token_stream'; payload: { label: number; events: ReadonlyArray<TokenStreamEvent> } }
  | { event: 'escalation.created'; payload: EscalationDto }
  | { event: 'escalation.resolved'; payload: { escalationId: string; decision: string } }
  | { event: 'escalation.expired'; payload: { escalationId: string; sessionLabel: number } }
  | { event: 'job.list_changed'; payload: Record<string, unknown> }
  | { event: 'job.completed'; payload: Record<string, unknown> }
  | { event: 'job.failed'; payload: Record<string, unknown> }
  | { event: 'job.started'; payload: Record<string, unknown> }
  | {
      event: 'workflow.started';
      payload: { workflowId: string; name: string; taskDescription: string };
    }
  | {
      event: 'workflow.state_entered';
      payload: { workflowId: string; state: string; previousState?: string };
    }
  | { event: 'workflow.agent_started'; payload: { workflowId: string; stateId: string; persona: string } }
  | {
      event: 'workflow.agent_completed';
      // `notes` is required because the workflow visualization's payload-handoff
      // tile renders it on every transition. Mirror the daemon contract in
      // src/web-ui/web-event-bus.ts.
      payload: { workflowId: string; stateId: string; verdict?: string; confidence?: string; notes: string };
    }
  | { event: 'workflow.completed'; payload: { workflowId: string } }
  | { event: 'workflow.failed'; payload: { workflowId: string; error: string } }
  | { event: 'workflow.gate_raised'; payload: { workflowId: string; gate: HumanGateRequestDto } }
  | { event: 'workflow.gate_dismissed'; payload: { workflowId: string; gateId: string } };

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
    case 'session.token_stream':
      return {
        event,
        payload: data as { label: number; events: ReadonlyArray<TokenStreamEvent> },
      };
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
    case 'workflow.started':
      return {
        event,
        payload: data as { workflowId: string; name: string; taskDescription: string },
      };
    case 'workflow.state_entered':
      return {
        event,
        payload: data as { workflowId: string; state: string; previousState?: string },
      };
    case 'workflow.agent_started':
      return {
        event,
        payload: data as { workflowId: string; stateId: string; persona: string },
      };
    case 'workflow.agent_completed':
      return {
        event,
        payload: data as {
          workflowId: string;
          stateId: string;
          verdict?: string;
          confidence?: string;
          notes: string;
        },
      };
    case 'workflow.completed':
      return { event, payload: data as { workflowId: string } };
    case 'workflow.failed':
      return { event, payload: data as { workflowId: string; error: string } };
    case 'workflow.gate_raised':
      return {
        event,
        payload: data as { workflowId: string; gate: HumanGateRequestDto },
      };
    case 'workflow.gate_dismissed':
      return { event, payload: data as { workflowId: string; gateId: string } };
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

    case 'session.token_stream': {
      // Deliberately bypasses AppStateLike — the theater consumes this
      // stream imperatively via the singleton (see §B.1). Running 20+
      // events/50ms through Svelte's reactive graph would dominate the
      // frame budget.
      const { label, events } = parsed.payload;
      tokenStreamStore.publish(label, events);
      return true;
    }

    case 'escalation.created': {
      const esc = parsed.payload;
      const displayNumber = effects.assignDisplayNumber(esc.escalationId);
      const pending: PendingEscalation = { ...esc, displayNumber };
      state.pendingEscalations = new Map(state.pendingEscalations).set(esc.escalationId, pending);
      state.addOutput(esc.sessionLabel, {
        kind: 'escalation',
        text: `Pending escalation: ${esc.serverName}/${esc.toolName}`,
        timestamp: esc.receivedAt,
        escalationId: esc.escalationId,
      });
      return true;
    }

    case 'escalation.resolved':
    case 'escalation.expired': {
      const { escalationId } = parsed.payload;
      const esc = state.pendingEscalations.get(escalationId);
      if (esc) {
        const next = new Map(state.pendingEscalations);
        next.delete(escalationId);
        state.pendingEscalations = next;
        state.filterOutput(esc.sessionLabel, (line) => line.escalationId !== escalationId);
      }
      return true;
    }

    case 'job.list_changed':
    case 'job.completed':
    case 'job.failed':
    case 'job.started':
      effects.refreshJobs();
      return true;

    // Workflow events
    case 'workflow.started': {
      const { workflowId, name } = parsed.payload;
      const entry: WorkflowSummaryDto = {
        workflowId,
        name,
        phase: PHASE.RUNNING,
        currentState: 'starting...',
        startedAt: new Date().toISOString(),
      };
      state.workflows = new Map(state.workflows).set(workflowId, entry);
      return true;
    }

    case 'workflow.state_entered': {
      const { workflowId, state: stateName } = parsed.payload;
      const existing = state.workflows.get(workflowId);
      if (!existing) return true;
      // Preserve 'waiting_human' only if there is still an active gate for this workflow.
      // Without this check, the phase would stay sticky after the gate is resolved.
      const phase = hasGateForWorkflow(state.pendingGates, workflowId) ? PHASE.WAITING_HUMAN : PHASE.RUNNING;
      const updated: WorkflowSummaryDto = { ...existing, currentState: stateName, phase };
      state.workflows = new Map(state.workflows).set(workflowId, updated);
      return true;
    }

    case 'workflow.agent_started':
    case 'workflow.agent_completed':
      // Informational events -- no state mutation needed for the basic dashboard
      return true;

    case 'workflow.completed': {
      const { workflowId } = parsed.payload;
      const wf = state.workflows.get(workflowId);
      if (!wf) return true;
      state.workflows = new Map(state.workflows).set(workflowId, {
        ...wf,
        phase: PHASE.COMPLETED,
      });
      const nextGates = new Map(state.pendingGates);
      for (const [gateId, gate] of nextGates) {
        if (gate.workflowId === workflowId) nextGates.delete(gateId);
      }
      state.pendingGates = nextGates;
      return true;
    }

    case 'workflow.failed': {
      const { workflowId } = parsed.payload;
      const wf = state.workflows.get(workflowId);
      if (!wf) return true;
      state.workflows = new Map(state.workflows).set(workflowId, {
        ...wf,
        phase: PHASE.FAILED,
      });
      return true;
    }

    case 'workflow.gate_raised': {
      const { workflowId, gate } = parsed.payload;
      state.pendingGates = new Map(state.pendingGates).set(gate.gateId, gate);
      const wf = state.workflows.get(workflowId);
      if (wf) {
        state.workflows = new Map(state.workflows).set(workflowId, {
          ...wf,
          phase: PHASE.WAITING_HUMAN,
          currentState: gate.stateName,
        });
      }
      return true;
    }

    case 'workflow.gate_dismissed': {
      const { workflowId, gateId } = parsed.payload;
      const nextGates = new Map(state.pendingGates);
      nextGates.delete(gateId);
      state.pendingGates = nextGates;
      const wf = state.workflows.get(workflowId);
      if (wf && wf.phase === PHASE.WAITING_HUMAN && !hasGateForWorkflow(nextGates, workflowId)) {
        state.workflows = new Map(state.workflows).set(workflowId, {
          ...wf,
          phase: PHASE.RUNNING,
        });
      }
      return true;
    }

    default:
      return false;
  }
}
