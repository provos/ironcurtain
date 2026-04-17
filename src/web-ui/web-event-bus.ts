/**
 * Typed pub/sub event bus for web UI events.
 *
 * Decouples event producers (daemon internals, transports) from
 * WebSocket consumers. The WebUiServer subscribes and broadcasts
 * to all connected clients.
 */

import type {
  SessionDto,
  BudgetSummaryDto,
  DaemonStatusDto,
  EscalationDto,
  HumanGateRequestDto,
} from './web-ui-types.js';
import type { DiagnosticEvent } from '../session/types.js';
import type { RunRecord } from '../cron/types.js';
import type { TokenStreamEvent } from '../docker/token-stream-types.js';

/**
 * Typed event map. Each key maps to a specific payload type.
 * Adding a new event requires updating this interface, ensuring
 * all producers and consumers agree on the payload shape at compile time.
 */
export interface WebEventMap {
  'session.created': SessionDto;
  'session.ended': { label: number; reason: string };
  'session.updated': SessionDto;
  'session.thinking': { label: number; turnNumber: number };
  'session.tool_call': { label: number; toolName: string; preview: string };
  'session.tool_result': { label: number; toolName: string; stepIndex: number };
  'session.text_delta': { label: number; preview: string };
  'session.output': { label: number; text: string; turnNumber: number };
  'session.diagnostic': { label: number; event: DiagnosticEvent };
  'session.budget_update': { label: number; budget: BudgetSummaryDto };
  'escalation.created': EscalationDto;
  'escalation.resolved': { escalationId: string; decision: 'approved' | 'denied' };
  'escalation.expired': { escalationId: string; sessionLabel: number };
  'job.started': { jobId: string; sessionLabel: number };
  'job.completed': { jobId: string; record: RunRecord };
  'job.failed': { jobId: string; error: string };
  'job.list_changed': Record<string, never>;
  'daemon.status': DaemonStatusDto;

  // Workflow events
  'workflow.started': { workflowId: string; name: string; taskDescription: string };
  'workflow.state_entered': { workflowId: string; state: string; previousState?: string };
  'workflow.completed': { workflowId: string };
  'workflow.failed': { workflowId: string; error: string };
  'workflow.gate_raised': { workflowId: string; gate: HumanGateRequestDto };
  'workflow.gate_dismissed': { workflowId: string; gateId: string };
  'workflow.agent_started': { workflowId: string; stateId: string; persona: string };
  'workflow.agent_completed': { workflowId: string; stateId: string; verdict?: string; confidence?: string };

  // Token stream events (targeted delivery via bridge, not broadcast)
  'session.token_stream': { label: number; events: readonly TokenStreamEvent[] };
}

export type WebEventName = keyof WebEventMap;
export type WebEventHandler = <K extends WebEventName>(event: K, payload: WebEventMap[K]) => void;

/**
 * Typed pub/sub bus for web UI events.
 * Producers call emit(); the WebUiServer subscribes and broadcasts to WS clients.
 */
export class WebEventBus {
  private handlers = new Set<WebEventHandler>();

  subscribe(handler: WebEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit<K extends WebEventName>(event: K, payload: WebEventMap[K]): void {
    for (const handler of this.handlers) {
      handler(event, payload);
    }
  }
}
