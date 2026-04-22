import type { AgentConversationId } from '../session/types.js';

/**
 * Wraps an error thrown from within `executeAgentState()` so the XState
 * error handler can recover the `agentConversationId` that was minted for
 * the failing invocation and persist it into `context.agentConversationsByState`.
 *
 * Without this, states that error mid-invocation drop their conversation
 * id on the floor — the `onDone` path stamps the id into context, but
 * `onError` used to record only `lastError`. For states configured with
 * `freshSession: false`, that silently broke resume on the next visit.
 */
export interface AgentInvocationErrorOptions {
  readonly stateId: string;
  readonly agentConversationId: AgentConversationId;
  readonly cause: unknown;
}

export class AgentInvocationError extends Error {
  readonly stateId: string;
  readonly agentConversationId: AgentConversationId;
  override readonly cause: unknown;

  constructor(options: AgentInvocationErrorOptions) {
    const message = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(message);
    this.name = 'AgentInvocationError';
    this.stateId = options.stateId;
    this.agentConversationId = options.agentConversationId;
    this.cause = options.cause;
  }
}

export function isAgentInvocationError(err: unknown): err is AgentInvocationError {
  return err instanceof AgentInvocationError;
}
