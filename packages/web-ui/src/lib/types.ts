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
  /**
   * Whether the daemon was launched with `--allow-policy-mutation` (Phase 1c).
   * The UI hides all persona-mutation controls when this is false. Optional in
   * the mirror so pre-1c daemons (which omit it) deserialize cleanly; treat
   * `undefined` as `false` (no mutation controls).
   */
  readonly allowPolicyMutation?: boolean;
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

/** Phases reported by the orchestrator for a workflow currently tracked in memory. */
export type LiveWorkflowPhase = 'running' | 'waiting_human' | 'completed' | 'failed' | 'aborted';

/** Phases that appear on past-run records loaded from disk. */
export type PastRunPhase = 'completed' | 'failed' | 'aborted' | 'waiting_human' | 'interrupted';

/**
 * Wide phase union covering both live summaries and past-run records.
 * Retained for backwards compatibility with code that handles all phases uniformly
 * (e.g. badge styling). New code should prefer the narrower `LiveWorkflowPhase` /
 * `PastRunPhase` aliases where possible.
 */
export type WorkflowPhase = LiveWorkflowPhase | PastRunPhase;

/** Constants for WorkflowPhase values — avoids magic strings in event handlers. */
export const PHASE = {
  RUNNING: 'running',
  WAITING_HUMAN: 'waiting_human',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
  INTERRUPTED: 'interrupted',
} as const satisfies Record<string, WorkflowPhase>;

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
  readonly workflowId: string;
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
  /** True when the workflow's source package ships a `README.md` (fetch via `workflows.readme`). */
  readonly hasReadme: boolean;
};

// ---------------------------------------------------------------------------
// Workflow message log types
//
// Mirrors the discriminated union in `src/workflow/message-log.ts`. Kept in
// sync manually so the web-ui package stays self-contained and does not need
// to reach into `src/workflow/`.
// ---------------------------------------------------------------------------

interface MessageLogBaseEntry {
  readonly ts: string;
  readonly workflowId: string;
  readonly state: string;
}

export interface AgentSentEntry extends MessageLogBaseEntry {
  readonly type: 'agent_sent';
  readonly role: string;
  readonly message: string;
}

export interface AgentReceivedEntry extends MessageLogBaseEntry {
  readonly type: 'agent_received';
  readonly role: string;
  readonly message: string;
  readonly verdict: string | null;
  readonly confidence: string | null;
}

export type AgentRetryReason =
  | 'missing_status_block'
  | 'malformed_status_block'
  | 'missing_artifacts'
  | 'invalid_verdict'
  | 'upstream_stall';

export interface AgentRetryEntry extends MessageLogBaseEntry {
  readonly type: 'agent_retry';
  readonly role: string;
  readonly reason: AgentRetryReason;
  readonly details: string;
  readonly retryMessage: string;
}

export interface GateRaisedEntry extends MessageLogBaseEntry {
  readonly type: 'gate_raised';
  readonly acceptedEvents: readonly string[];
}

export interface GateResolvedEntry extends MessageLogBaseEntry {
  readonly type: 'gate_resolved';
  readonly event: string;
  readonly prompt: string | null;
}

export interface ErrorEntry extends MessageLogBaseEntry {
  readonly type: 'error';
  readonly error: string;
  readonly context?: string;
}

export interface StateTransitionEntry extends MessageLogBaseEntry {
  readonly type: 'state_transition';
  readonly from: string;
  readonly event: string;
}

export interface QuotaExhaustedEntry extends MessageLogBaseEntry {
  readonly type: 'quota_exhausted';
  readonly role: string;
  readonly resetAt?: string;
  readonly rawMessage: string;
}

/** Discriminated union of all message-log entry types. */
export type MessageLogEntry =
  | AgentSentEntry
  | AgentReceivedEntry
  | AgentRetryEntry
  | GateRaisedEntry
  | GateResolvedEntry
  | ErrorEntry
  | StateTransitionEntry
  | QuotaExhaustedEntry;

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
  /** True when the package ships a `README.md` (fetch with `workflows.readme`). */
  readonly hasReadme: boolean;
}

/** README markdown for a workflow, returned by `workflows.readme`. */
export interface WorkflowReadmeDto {
  /** Raw markdown source; the client renders + sanitizes it. */
  readonly content: string;
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
  /** Whether persistent memory is enabled (persona.memory?.enabled ?? true). */
  readonly memory?: boolean;
  /**
   * Whether this persona may compile a broad policy (persona.allowBroadPolicy
   * ?? false). Set only via the gated `personas.setBroadPolicyOptIn`. Drives
   * the broad-policy opt-in control + the BROAD_POLICY_REJECTED affordance.
   * Added in Phase 1c. Optional in the mirror for pre-1c back-compat.
   */
  readonly allowBroadPolicy?: boolean;
}

/** Slim list-row returned by `personas.list`. Mirrors backend PersonaListDto. */
export interface PersonaListDto {
  readonly name: string;
  readonly description: string;
  readonly compiled: boolean;
  readonly memory?: boolean;
}

/** Result of editing a persona constitution. Mirrors backend PersonaEditResultDto. */
export interface PersonaEditResultDto {
  readonly stale: boolean;
}

// ---------------------------------------------------------------------------
// Config (modelProviders) types — mirror src/web-ui/web-ui-types.ts.
// ---------------------------------------------------------------------------

/** One glob→slug rule for a modelMap. */
export interface ModelMapRuleDto {
  readonly match: string;
  readonly model: string;
}

/** Provider-preference passthrough (cache pinning). */
export interface ProviderPreferenceDto {
  readonly order?: readonly string[];
  readonly only?: readonly string[];
  readonly allowFallbacks?: boolean;
}

/** The native profile DTO — no fields beyond the discriminator. */
export interface NativeProfileDto {
  readonly type: 'native';
}

/**
 * The openrouter profile DTO. On the GET response `apiKey` is MASKED
 * (`sk-...xyz` / 'none'). On a SET request `apiKey` follows the M5
 * mask-unchanged contract: absent/null/mask-equal → keep, '' → clear, other → set.
 */
export interface OpenrouterProfileDto {
  readonly type: 'openrouter';
  readonly apiKey?: string | null;
  readonly modelMap?: readonly ModelMapRuleDto[];
  readonly perAgent?: Readonly<Record<string, string | undefined>>;
  readonly providerPreference?: ProviderPreferenceDto;
  readonly sessionAffinity?: boolean;
}

/** A single profile DTO (discriminated on `type`). */
export type ProfileDto = NativeProfileDto | OpenrouterProfileDto;

/** Response from `config.getModelProviders`. */
export interface GetModelProvidersDto {
  readonly default: string;
  readonly profiles: Readonly<Record<string, ProfileDto>>;
}

/** Request for `config.setModelProviders` (whole profiles record). */
export interface SetModelProvidersDto {
  readonly default?: string;
  readonly profiles: Readonly<Record<string, ProfileDto>>;
}

/**
 * Response from `config.listOpenrouterModels`. `source` drives validation
 * strictness: `live`/`cache` hard-block unknown slugs; `bundled` (the offline
 * floor) is warn-only.
 */
export interface OpenrouterModelsDto {
  readonly models: readonly string[];
  readonly source: 'live' | 'cache' | 'bundled';
}

// ---------------------------------------------------------------------------
// Persona streamed-compile types (Phase 1b). Mirror src/web-ui/web-ui-types.ts.
// ---------------------------------------------------------------------------

/**
 * 9-value per-server compilation phase. Mirrors the pipeline's CompilationPhase
 * union (type-only re-exported by the backend wire-types module).
 */
export type CompilationPhase =
  | 'cached'
  | 'compiling'
  | 'lists'
  | 'scenarios'
  | 'repair-scenarios'
  | 'verifying'
  | 'repair-compile'
  | 'repair-verify'
  | 'done';

/**
 * Phase-1b error codes mirrored for the frontend. The frontend's RPC error
 * `code` field is a plain string on the wire (ResponseFrame), so this alias is
 * documentation/typing for the affordances; it is not exhaustively enforced.
 */
export type PersonaCompileErrorCode =
  | 'COMPILE_IN_PROGRESS'
  | 'COMPILE_QUEUE_FULL'
  | 'CREDENTIALS_MISSING'
  | 'LIST_REQUIRES_MCP'
  | 'POLICY_MUTATION_FORBIDDEN'
  | 'PERSONA_NOT_FOUND'
  | 'INVALID_PARAMS'
  // Phase 1c persona-CRUD error codes (mirror src/web-ui/web-ui-types.ts).
  | 'PERSONA_EXISTS'
  | 'BROAD_POLICY_REJECTED';

/**
 * Compile-time rule diff vs the persona's previous compiled policy (Phase 1c).
 * Mirrors backend RuleDeltaDto. Shown on the `done` card.
 */
export interface RuleDeltaDto {
  readonly added: number;
  readonly loosened: number;
  readonly removed: number;
  readonly broadenedDomains: readonly string[];
  readonly outOfWorkspacePaths: readonly string[];
}

/** Success-only compile result carried by a `done` record/event. */
export interface PersonaCompileResultDto {
  readonly success: true;
  readonly ruleCount: number;
  /** Compile-time diff vs the previous policy (absent on first compile). */
  readonly ruleDelta?: RuleDeltaDto;
}

/** Snapshot of a streamed compile operation (getCompile / listCompiles). */
export interface PersonaCompileOperationDto {
  readonly operationId: string;
  readonly name: string;
  readonly phase: 'started' | 'running' | 'done' | 'failed';
  readonly serverProgress?: {
    readonly server: string;
    readonly compilationPhase: CompilationPhase;
    readonly detail?: string;
  };
  readonly queuePosition?: number;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly result?: PersonaCompileResultDto;
  readonly error?: { readonly code: string; readonly message: string };
  readonly actor: string;
}

/** Response from `personas.listCompiles`. */
export interface PersonaListCompilesDto {
  readonly active: readonly PersonaCompileOperationDto[];
  readonly recent: readonly PersonaCompileOperationDto[];
  readonly queueDepth: number;
}

/** Response from `personas.compileStream`. */
export interface PersonaCompileStreamAckDto {
  readonly accepted: true;
  readonly name: string;
  readonly operationId: string;
  readonly queued?: boolean;
}

// ---------------------------------------------------------------------------
// Persona streamed-compile event payloads (Phase 1b). Mirror WebEventMap.
// ---------------------------------------------------------------------------

export interface PersonaCompileStartedEvent {
  readonly name: string;
  readonly operationId: string;
  readonly actor: string;
}

export interface PersonaCompileProgressEvent {
  readonly name: string;
  readonly operationId: string;
  readonly serverName: string;
  readonly phase: CompilationPhase;
  readonly detail?: string;
}

export interface PersonaCompileDoneEvent {
  readonly name: string;
  readonly operationId: string;
  readonly result: PersonaCompileResultDto;
}

export interface PersonaCompileFailedEvent {
  readonly name: string;
  readonly operationId: string;
  readonly code: string;
  readonly error: string;
}

/**
 * Persona CRUD change notification (Phase 1c). Mirrors WebEventMap's
 * `personas.changed` (empty payload). Handled by refreshing the persona list,
 * mirroring `job.list_changed -> refreshJobs`.
 */
export type PersonaChangedEvent = Record<string, never>;
