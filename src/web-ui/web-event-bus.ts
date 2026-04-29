/**
 * Web UI event map and typed bus.
 *
 * The transport-neutral pub/sub mechanics live in
 * {@link ../event-bus/typed-event-bus.js | TypedEventBus}; this file owns
 * the web-flavored event map and the `WebEventBus` alias used by the
 * daemon, transports, and dispatch layer. The WebUiServer subscribes and
 * broadcasts to all connected WebSocket clients.
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
import { TypedEventBus, type EventHandler } from '../event-bus/typed-event-bus.js';

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
  'workflow.agent_started': {
    workflowId: string;
    stateId: string;
    persona: string;
    /**
     * Session ID of the agent session. The daemon always emits this;
     * the WS broadcast path delivers it to frontend clients, which
     * type it as required (see `event-handler.ts`'s `WebEvent` union).
     * Its primary consumer today is the daemon's bridge wiring, which
     * registers this mapping so token events produced by the
     * workflow-owned session reach `observe --all` subscribers.
     */
    sessionId: string;
  };
  'workflow.agent_completed': { workflowId: string; stateId: string; verdict?: string; confidence?: string };
  /**
   * Fires unconditionally in the orchestrator's agent-state finally
   * block, pairing 1:1 with 'workflow.agent_started'. The daemon's
   * bridge wiring uses this to tear down the per-session token-stream
   * mapping on both success and failure paths.
   */
  'workflow.agent_session_ended': {
    workflowId: string;
    stateId: string;
    sessionId: string;
  };

  // Token stream events (targeted delivery via bridge, not broadcast)
  'session.token_stream': { label: number; events: readonly TokenStreamEvent[] };
}

export type WebEventName = keyof WebEventMap;
export type WebEventHandler = EventHandler<WebEventMap>;

/**
 * Typed pub/sub bus for web UI events. Thin alias over the generic
 * {@link TypedEventBus} that fixes the event map to {@link WebEventMap}.
 * Producers call `emit()`; the WebUiServer subscribes and broadcasts to
 * WS clients.
 */
export class WebEventBus extends TypedEventBus<WebEventMap> {}
