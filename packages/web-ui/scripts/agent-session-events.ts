/**
 * Helper for constructing `workflow.agent_session_ended` payloads.
 *
 * Used by the scenario runner, the mock WS server, and their tests so
 * the payload shape stays in lock-step with the daemon contract in
 * `src/web-ui/web-event-bus.ts`. If the wire format gains a field,
 * extend this helper and every emitter picks it up.
 */

export interface AgentSessionEndedPayload {
  readonly workflowId: string;
  readonly stateId: string;
  readonly sessionId: string;
}

export function makeAgentSessionEndedPayload(
  workflowId: string,
  stateId: string,
  sessionId: string,
): AgentSessionEndedPayload {
  return { workflowId, stateId, sessionId };
}
