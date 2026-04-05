/**
 * Frontend type definitions mirroring daemon DTO types.
 * Kept in sync manually -- a shared package could be added later.
 */

export interface SessionSource {
  readonly kind: 'signal' | 'cron' | 'web';
  readonly jobId?: string;
  readonly jobName?: string;
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

export interface SessionDto {
  readonly label: number;
  readonly source: SessionSource;
  readonly status: string;
  readonly turnCount: number;
  readonly createdAt: string;
  readonly hasPendingEscalation: boolean;
  readonly messageInFlight: boolean;
  readonly budget: BudgetSummaryDto;
  readonly persona?: string;
}

export interface ConversationTurn {
  readonly turnNumber: number;
  readonly userMessage: string;
  readonly assistantResponse: string;
  readonly timestamp: string;
  readonly usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

export interface SessionDetailDto extends SessionDto {
  readonly history: readonly ConversationTurn[];
  readonly diagnosticLog: readonly DiagnosticEvent[];
}

export interface EscalationDto {
  readonly escalationId: string;
  readonly sessionLabel: number;
  readonly sessionSource: SessionSource;
  readonly toolName: string;
  readonly serverName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
  readonly context?: Record<string, string>;
  readonly receivedAt: string;
}

export interface DaemonStatusDto {
  readonly uptimeSeconds: number;
  readonly jobs: { total: number; enabled: number; running: number };
  readonly signalConnected: boolean;
  readonly webUiListening: boolean;
  readonly activeSessions: number;
  readonly nextFireTime: string | null;
}

export interface JobDefinition {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly taskDescription: string;
  readonly enabled: boolean;
}

export interface RunRecord {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: { kind: string; message?: string; dimension?: string };
  readonly budget: {
    totalTokens: number;
    stepCount: number;
    elapsedSeconds: number;
    estimatedCostUsd: number;
  };
  readonly summary: string | null;
}

export interface JobListDto {
  readonly job: JobDefinition;
  readonly nextRun: string | null;
  readonly lastRun: RunRecord | null;
  readonly isRunning: boolean;
}

export type DiagnosticEvent =
  | { readonly kind: 'tool_call'; readonly toolName: string; readonly preview: string }
  | { readonly kind: 'agent_text'; readonly preview: string }
  | { readonly kind: 'step_finish'; readonly stepIndex: number }
  | {
      readonly kind: 'budget_warning';
      readonly dimension: string;
      readonly percentUsed: number;
      readonly message: string;
    }
  | { readonly kind: 'budget_exhausted'; readonly dimension: string; readonly message: string }
  | { readonly kind: string; [key: string]: unknown };

/** JSON-RPC response frame. */
export type ResponseFrame =
  | { readonly id: string; readonly ok: true; readonly payload?: unknown }
  | { readonly id: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** JSON-RPC event frame. */
export interface EventFrame {
  readonly event: string;
  readonly payload: unknown;
  readonly seq: number;
}

/** Available persona for session creation. */
export interface PersonaListItem {
  readonly name: string;
  readonly description: string;
  readonly compiled: boolean;
}

/** Output line for the session console. */
export interface OutputLine {
  readonly kind: 'user' | 'assistant' | 'tool_call' | 'thinking' | 'error' | 'system';
  readonly text: string;
  readonly timestamp: string;
}
