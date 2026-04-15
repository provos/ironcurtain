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

/** Whitelist candidate for display in the escalation UI. */
export interface WhitelistCandidate {
  readonly description: string;
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
  readonly whitelistCandidates?: readonly WhitelistCandidate[];
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

/** An escalation enriched with a monotonic display number for modal ordering. */
export interface PendingEscalation extends EscalationDto {
  readonly displayNumber: number;
}

/** Output line for the session console. */
export interface OutputLine {
  readonly kind: 'user' | 'assistant' | 'tool_call' | 'thinking' | 'error' | 'system' | 'escalation';
  readonly text: string;
  readonly timestamp: string;
  readonly escalationId?: string;
}

// ---------------------------------------------------------------------------
// Workflow types
// ---------------------------------------------------------------------------

/** Resumable workflow returned by `workflows.listResumable`. */
export interface ResumableWorkflowDto {
  readonly workflowId: string;
  readonly lastState: string;
  readonly timestamp: string;
  readonly taskDescription: string;
  readonly workspacePath?: string;
}

export type WorkflowPhase = 'running' | 'waiting_human' | 'completed' | 'failed' | 'aborted';

/** Constants for WorkflowPhase values — avoids magic strings in event handlers. */
export const PHASE = {
  RUNNING: 'running',
  WAITING_HUMAN: 'waiting_human',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
} as const satisfies Record<string, WorkflowPhase>;

export interface WorkflowSummaryDto {
  readonly workflowId: string;
  readonly name: string;
  readonly phase: WorkflowPhase;
  readonly currentState: string;
  readonly startedAt: string;
}

export interface HumanGateRequestDto {
  readonly gateId: string;
  readonly workflowId: string;
  readonly stateName: string;
  readonly acceptedEvents: readonly string[];
  readonly presentedArtifacts: readonly string[];
  readonly summary: string;
}

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

export interface WorkflowDetailDto extends WorkflowSummaryDto {
  readonly description: string;
  readonly stateGraph: StateGraphDto;
  readonly transitionHistory: readonly TransitionRecordDto[];
  readonly context: WorkflowContextDto;
  readonly gate?: HumanGateRequestDto;
  readonly workspacePath: string;
}

// ---------------------------------------------------------------------------
// File browser types
// ---------------------------------------------------------------------------

export interface FileTreeEntryDto {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size?: number;
}

export interface FileTreeResponseDto {
  readonly entries: readonly FileTreeEntryDto[];
}

export interface FileContentResponseDto {
  readonly content?: string;
  readonly language?: string;
  readonly binary?: boolean;
  readonly error?: string;
}

export interface ArtifactFileDto {
  readonly path: string;
  readonly content: string;
}

export interface ArtifactContentDto {
  readonly files: readonly ArtifactFileDto[];
}

// ---------------------------------------------------------------------------
// Workflow definition types
// ---------------------------------------------------------------------------

export type WorkflowSource = 'bundled' | 'user' | 'custom';

export interface WorkflowDefinitionDto {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: WorkflowSource;
}

// ---------------------------------------------------------------------------
// Persona types
// ---------------------------------------------------------------------------

export interface PersonaDetailDto {
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
  readonly constitution: string;
  readonly servers?: readonly string[];
  readonly hasPolicy: boolean;
  readonly policyRuleCount?: number;
}

export interface PersonaCompileResultDto {
  readonly success: boolean;
  readonly ruleCount: number;
  readonly errors?: readonly string[];
}
