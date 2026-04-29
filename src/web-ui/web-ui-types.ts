/**
 * Shared types for the daemon web UI: JSON-RPC frame protocol, DTOs, and events.
 */

import type { SessionSource } from '../session/session-manager.js';
import type { SessionStatus, DiagnosticEvent, ConversationTurn } from '../session/types.js';
import type { JobDefinition, RunRecord } from '../cron/types.js';
import type { WhitelistCandidateIpc } from '../trusted-process/approval-whitelist.js';
import type { WorkflowId, HumanGateRequestDto } from '../workflow/types.js';
import type { MessageLogEntry } from '../workflow/message-log.js';

// Re-export MessageLogEntry so frontends can import it from the wire-types
// module without reaching into the workflow domain package directly.
export type { MessageLogEntry } from '../workflow/message-log.js';

// ---------------------------------------------------------------------------
// JSON-RPC Frame Protocol
// ---------------------------------------------------------------------------

/** Literal union of all valid JSON-RPC method names. */
export type MethodName =
  | 'status'
  | 'jobs.list'
  | 'jobs.remove'
  | 'jobs.enable'
  | 'jobs.disable'
  | 'jobs.recompile'
  | 'jobs.reload'
  | 'jobs.run'
  | 'jobs.logs'
  | 'sessions.list'
  | 'sessions.get'
  | 'sessions.create'
  | 'sessions.end'
  | 'sessions.send'
  | 'sessions.budget'
  | 'sessions.history'
  | 'sessions.diagnostics'
  | 'sessions.subscribeTokenStream'
  | 'sessions.unsubscribeTokenStream'
  | 'sessions.subscribeAllTokenStreams'
  | 'sessions.unsubscribeAllTokenStreams'
  | 'escalations.list'
  | 'escalations.resolve'
  | 'personas.list'
  | 'workflows.list'
  | 'workflows.get'
  | 'workflows.start'
  | 'workflows.import'
  | 'workflows.resume'
  | 'workflows.abort'
  | 'workflows.resolveGate'
  | 'workflows.inspect'
  | 'workflows.fileTree'
  | 'workflows.fileContent'
  | 'workflows.artifacts'
  | 'workflows.listDefinitions'
  | 'workflows.listResumable'
  | 'workflows.messageLog'
  | 'personas.get'
  | 'personas.compile';

/** Browser -> Daemon request frame. */
export interface RequestFrame {
  readonly id: string;
  readonly method: MethodName;
  readonly params?: Record<string, unknown>;
}

/** Daemon -> Browser response to a specific request. */
export type ResponseFrame =
  | { readonly id: string; readonly ok: true; readonly payload?: unknown }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error: { readonly code: ErrorCode; readonly message: string; readonly data?: unknown };
    };

/** Daemon -> Browser unsolicited push event. */
export interface EventFrame {
  readonly event: string;
  readonly payload: unknown;
  readonly seq: number;
}

/** Error codes for ResponseFrame errors. */
export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'SESSION_NOT_FOUND'
  | 'JOB_NOT_FOUND'
  | 'ESCALATION_NOT_FOUND'
  | 'ESCALATION_EXPIRED'
  | 'SESSION_BUSY'
  | 'WORKFLOW_NOT_FOUND'
  | 'WORKFLOW_CORRUPTED'
  | 'WORKFLOW_NOT_AT_GATE'
  | 'ARTIFACT_NOT_FOUND'
  | 'PERSONA_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'INVALID_PARAMS'
  | 'RATE_LIMITED'
  | 'METHOD_NOT_FOUND'
  | 'LINT_FAILED'
  | 'INTERNAL_ERROR';

// ---------------------------------------------------------------------------
// DTO Types
// ---------------------------------------------------------------------------

/** Session snapshot for the sessions list. */
export interface SessionDto {
  readonly label: number;
  readonly source: SessionSource;
  readonly status: SessionStatus;
  readonly turnCount: number;
  readonly createdAt: string;
  readonly hasPendingEscalation: boolean;
  readonly messageInFlight: boolean;
  readonly budget: BudgetSummaryDto;
  readonly persona?: string;
}

export interface BudgetSummaryDto {
  readonly totalTokens: number;
  readonly stepCount: number;
  readonly elapsedSeconds: number;
  readonly estimatedCostUsd: number;
  readonly tokenTrackingAvailable: boolean;
  readonly limits: {
    readonly maxTotalTokens: number | null;
    readonly maxSteps: number | null;
    readonly maxSessionSeconds: number | null;
    readonly maxEstimatedCostUsd: number | null;
  };
}

/** Detailed session info including conversation history. */
export interface SessionDetailDto extends SessionDto {
  readonly history: readonly ConversationTurn[];
  readonly diagnosticLog: readonly DiagnosticEvent[];
}

/** Pending escalation for the escalation dashboard. */
export interface EscalationDto {
  readonly escalationId: string;
  readonly sessionLabel: number;
  readonly sessionSource: SessionSource;
  readonly toolName: string;
  readonly serverName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
  readonly context?: Readonly<Record<string, string>>;
  readonly whitelistCandidates?: readonly WhitelistCandidateIpc[];
  readonly receivedAt: string;
}

/** Daemon status snapshot (JSON-serialized form). */
export interface DaemonStatusDto {
  readonly uptimeSeconds: number;
  readonly jobs: { total: number; enabled: number; running: number };
  readonly signalConnected: boolean;
  readonly webUiListening: boolean;
  readonly activeSessions: number;
  readonly nextFireTime: string | null;
}

/** Job list entry with scheduling and last-run info. */
export interface JobListDto {
  readonly job: JobDefinition;
  readonly nextRun: string | null;
  readonly lastRun: RunRecord | null;
  readonly isRunning: boolean;
}

// ---------------------------------------------------------------------------
// Workflow DTO Types
// ---------------------------------------------------------------------------

/** Phases that appear only on past-run records loaded from disk. */
export type PastRunPhase = 'completed' | 'failed' | 'aborted' | 'waiting_human' | 'interrupted';

/** Phases reported by the orchestrator for a workflow currently tracked in memory. */
export type LiveWorkflowPhase = 'running' | 'waiting_human' | 'completed' | 'failed' | 'aborted';

/**
 * Latest verdict observed for a workflow.
 *
 * On a completed/failed/aborted workflow this is the final verdict; on a live
 * workflow it is the most recently emitted one.
 */
export interface LatestVerdictDto {
  readonly stateId: string;
  readonly verdict: string;
  readonly confidence?: number;
}

/**
 * Shared fields for any workflow card-style record (live summaries and past runs).
 *
 * `phase` is typed as the wide union of live and past-run phases on the base.
 * Subtypes may tighten it (e.g. `WorkflowSummaryDto` keeps the live-only union,
 * `PastRunDto` narrows to `PastRunPhase`).
 */
export interface WorkflowCardDto {
  readonly workflowId: WorkflowId;
  readonly name: string;
  readonly phase: LiveWorkflowPhase | PastRunPhase;
  readonly currentState: string;
  readonly taskDescription: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly totalTokens: number;
  readonly latestVerdict?: LatestVerdictDto;
  readonly error?: string;
}

/** Slim summary returned by `workflows.list`. */
export type WorkflowSummaryDto = WorkflowCardDto & {
  readonly phase: LiveWorkflowPhase;
  readonly startedAt: string;
};

/**
 * Full detail returned by `workflows.get`.
 *
 * Extends {@link WorkflowCardDto} (not `WorkflowSummaryDto`) so that the wide
 * `phase` union — including the `'interrupted'` value synthesized for past runs
 * loaded from disk — is preserved here. Live-path responses still emit a
 * `LiveWorkflowPhase` value; only the disk-fallback path can emit `'interrupted'`.
 */
export type WorkflowDetailDto = WorkflowCardDto & {
  readonly startedAt: string;
  readonly description: string;
  readonly stateGraph: StateGraphDto;
  readonly transitionHistory: readonly TransitionRecordDto[];
  readonly context: WorkflowContextDto;
  readonly gate?: HumanGateRequestDto;
  readonly workspacePath: string;
};

/** Minimal representation of the state machine graph for frontend rendering. */
export interface StateGraphDto {
  readonly states: readonly StateNodeDto[];
  readonly transitions: readonly TransitionEdgeDto[];
}

export interface StateNodeDto {
  readonly id: string;
  readonly type: 'agent' | 'human_gate' | 'deterministic' | 'terminal';
  readonly persona?: string;
  readonly label: string;
  readonly description?: string;
}

export interface TransitionEdgeDto {
  readonly from: string;
  readonly to: string;
  readonly guard?: string;
  readonly event?: string;
  readonly label: string;
}

export interface TransitionRecordDto {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly timestamp: string;
  readonly durationMs: number;
  /** Summary of the agent output that produced this transition. */
  readonly agentMessage?: string;
}

export interface WorkflowContextDto {
  readonly taskDescription: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly totalTokens: number;
  readonly visitCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// File browser DTO Types
// ---------------------------------------------------------------------------

/** Entry in a directory listing returned by `workflows.fileTree`. */
export interface FileTreeEntryDto {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size?: number;
}

/** Response from `workflows.fileTree`. */
export interface FileTreeResponseDto {
  readonly entries: readonly FileTreeEntryDto[];
}

/** Response from `workflows.fileContent`. */
export interface FileContentResponseDto {
  readonly content?: string;
  readonly language?: string;
  readonly binary?: boolean;
  readonly error?: string;
}

/** A single file in an artifact. */
export interface ArtifactFileDto {
  readonly path: string;
  readonly content: string;
}

/** Response from `workflows.artifacts`. */
export interface ArtifactContentDto {
  readonly files: readonly ArtifactFileDto[];
}

// ---------------------------------------------------------------------------
// Workflow Definition DTO Types
// ---------------------------------------------------------------------------

/**
 * Past-run record returned by `workflows.listResumable`.
 *
 * Covers terminal runs (completed/failed/aborted), runs paused at a human gate
 * (`waiting_human`), and runs whose checkpoint exists on disk with no live
 * orchestrator instance and no recorded `finalStatus` (`interrupted` — typically
 * a daemon crash mid-run; the phase is synthesized at the DTO boundary).
 */
export type PastRunDto = WorkflowCardDto & {
  readonly phase: PastRunPhase;
  readonly timestamp: string;
  readonly lastState: string;
  readonly durationMs?: number;
  readonly workspacePath?: string;
};

/**
 * @deprecated Use {@link PastRunDto} instead. This alias is preserved for one
 * release to avoid an abrupt RPC return-type rename for `workflows.listResumable`.
 */
export type ResumableWorkflowDto = PastRunDto;

/**
 * Response from `workflows.messageLog`: a page of {@link MessageLogEntry}
 * records for a workflow, sorted newest-first by `ts`.
 *
 * Cursor pagination per design decision D5: callers fetch the next page by
 * passing the last entry's `ts` as the next request's `before` parameter.
 * `hasMore` is true iff the returned page is full *and* at least one strictly
 * older entry exists on disk; otherwise false.
 */
export interface MessageLogResponseDto {
  readonly entries: readonly MessageLogEntry[];
  readonly hasMore: boolean;
}

/** Available workflow definition returned by `workflows.listDefinitions`. */
export interface WorkflowDefinitionDto {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: 'bundled' | 'user' | 'custom';
}

// ---------------------------------------------------------------------------
// Persona DTO Types
// ---------------------------------------------------------------------------

/** Detail for a single persona returned by `personas.get`. */
export interface PersonaDetailDto {
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
  readonly constitution: string;
  readonly servers?: readonly string[];
  readonly hasPolicy: boolean;
  readonly policyRuleCount?: number;
}

/** Response from `personas.compile`. */
export interface PersonaCompileResultDto {
  readonly success: boolean;
  readonly ruleCount: number;
  readonly errors?: readonly string[];
}

// ---------------------------------------------------------------------------
// Error classes for method dispatch
// ---------------------------------------------------------------------------

export class RpcError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export class InvalidParamsError extends RpcError {
  constructor(message: string) {
    super('INVALID_PARAMS', message);
  }
}

export class SessionNotFoundError extends RpcError {
  constructor(label: number) {
    super('SESSION_NOT_FOUND', `Session #${label} not found`);
  }
}

export class MethodNotFoundError extends RpcError {
  constructor(method: string) {
    super('METHOD_NOT_FOUND', `Unknown method: ${method}`);
  }
}
