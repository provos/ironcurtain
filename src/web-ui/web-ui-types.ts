/**
 * Shared types for the daemon web UI: JSON-RPC frame protocol, DTOs, and events.
 */

import type { SessionSource } from '../session/session-manager.js';
import type { SessionStatus, DiagnosticEvent, ConversationTurn } from '../session/types.js';
import type { JobDefinition, RunRecord } from '../cron/types.js';
import type { WhitelistCandidateIpc } from '../trusted-process/approval-whitelist.js';
import type { HumanGateRequest } from '../workflow/types.js';

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
  | { readonly id: string; readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } };

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
  | 'WORKFLOW_NOT_AT_GATE'
  | 'ARTIFACT_NOT_FOUND'
  | 'PERSONA_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'INVALID_PARAMS'
  | 'RATE_LIMITED'
  | 'METHOD_NOT_FOUND'
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

/** Slim summary returned by `workflows.list`. */
export interface WorkflowSummaryDto {
  readonly workflowId: string;
  readonly name: string;
  readonly phase: 'running' | 'waiting_human' | 'completed' | 'failed' | 'aborted';
  readonly currentState: string;
  readonly startedAt: string;
}

/** Full detail returned by `workflows.get`. */
export interface WorkflowDetailDto extends WorkflowSummaryDto {
  readonly description: string;
  readonly stateGraph: StateGraphDto;
  readonly transitionHistory: readonly TransitionRecordDto[];
  readonly context: WorkflowContextDto;
  readonly gate?: HumanGateRequestDto;
  readonly workspacePath: string;
}

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

export interface HumanGateRequestDto {
  readonly gateId: string;
  readonly workflowId: string;
  readonly stateName: string;
  readonly acceptedEvents: readonly string[];
  /** Artifact names only (not content). */
  readonly presentedArtifacts: readonly string[];
  readonly summary: string;
}

/**
 * Converts a domain HumanGateRequest to the JSON-serializable DTO.
 *
 * HumanGateRequest.presentedArtifacts is a ReadonlyMap<string, string>
 * which does not serialize to JSON. This converter extracts the keys
 * as a plain array.
 */
export function toHumanGateRequestDto(gate: HumanGateRequest): HumanGateRequestDto {
  return {
    gateId: gate.gateId,
    workflowId: gate.workflowId,
    stateName: gate.stateName,
    acceptedEvents: gate.acceptedEvents,
    presentedArtifacts: Array.from(gate.presentedArtifacts.keys()),
    summary: gate.summary,
  };
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

/** Resumable workflow returned by `workflows.listResumable`. */
export interface ResumableWorkflowDto {
  readonly workflowId: string;
  readonly lastState: string;
  readonly timestamp: string;
  readonly taskDescription: string;
  readonly workspacePath?: string;
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
