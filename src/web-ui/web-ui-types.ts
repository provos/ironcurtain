/**
 * Shared types for the daemon web UI: JSON-RPC frame protocol, DTOs, and events.
 */

import type { SessionSource } from '../session/session-manager.js';
import type { SessionStatus, DiagnosticEvent, ConversationTurn } from '../session/types.js';
import type { JobDefinition, RunRecord } from '../cron/types.js';
import type { WhitelistCandidateIpc } from '../trusted-process/approval-whitelist.js';

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
  | 'escalations.list'
  | 'escalations.resolve';

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
