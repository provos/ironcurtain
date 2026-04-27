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

/**
 * Thrown when the agent adapter reports upstream quota exhaustion for a
 * state's turn. Distinct from a generic `Error` so M4's paused-phase
 * handling (follow-up work) can intercept it cleanly and drive a
 * `paused` terminal instead of the current `aborted` terminal.
 *
 * `resetAt` is the provider-advertised reset time when the adapter
 * could parse one; `rawMessage` is the original provider/CLI text.
 */
export interface WorkflowQuotaExhaustedOptions {
  readonly stateId: string;
  readonly resetAt?: Date;
  readonly rawMessage: string;
}

export class WorkflowQuotaExhaustedError extends Error {
  readonly stateId: string;
  readonly resetAt?: Date;
  readonly rawMessage: string;

  constructor(options: WorkflowQuotaExhaustedOptions) {
    const resetHint = options.resetAt ? ` (resets at ${options.resetAt.toISOString()})` : '';
    super(`Agent turn aborted: upstream quota exhausted${resetHint}`);
    this.name = 'WorkflowQuotaExhaustedError';
    this.stateId = options.stateId;
    this.resetAt = options.resetAt;
    this.rawMessage = options.rawMessage;
  }
}

export function isWorkflowQuotaExhaustedError(err: unknown): err is WorkflowQuotaExhaustedError {
  return err instanceof WorkflowQuotaExhaustedError;
}

/**
 * Thrown when the agent adapter reports a transient upstream failure
 * (a degenerate response envelope with no usable content — e.g. a
 * sustained upstream stall) for a state's turn. Sibling of
 * `WorkflowQuotaExhaustedError`: both signal terminal-but-resumable
 * conditions where retrying is hopeless.
 *
 * Consumers MUST NOT remove the on-disk checkpoint and MUST surface the
 * run as resumable — `workflow resume <id>` re-enters the failing agent
 * state once the upstream is healthy. The orchestrator forces
 * `phase: 'aborted'` when this fires so `isCheckpointResumable` returns
 * true regardless of which terminal `findErrorTarget` resolved to.
 *
 * `kind` is the discriminator from `AgentResponse.transientFailure`
 * (today only `'degenerate_response'`); `rawMessage` is the original
 * envelope/stdout, preserved for diagnostics.
 */
export interface WorkflowTransientFailureOptions {
  readonly stateId: string;
  readonly kind: 'degenerate_response';
  readonly rawMessage: string;
}

export class WorkflowTransientFailureError extends Error {
  readonly stateId: string;
  readonly kind: 'degenerate_response';
  readonly rawMessage: string;

  constructor(options: WorkflowTransientFailureOptions) {
    super(`Agent turn aborted: upstream stall (kind=${options.kind})`);
    this.name = 'WorkflowTransientFailureError';
    this.stateId = options.stateId;
    this.kind = options.kind;
    this.rawMessage = options.rawMessage;
  }
}

export function isWorkflowTransientFailureError(err: unknown): err is WorkflowTransientFailureError {
  return err instanceof WorkflowTransientFailureError;
}
