/**
 * Frontend type definitions mirroring daemon DTO types.
 * Kept in sync manually -- a shared package could be added later.
 */

export interface SessionSource {
  /**
   * `web-pty` is a live container PTY session streamed to the web UI as an
   * xterm terminal (never registered in the daemon's SessionManager). It is
   * rendered with `TerminalConsole`.
   */
  readonly kind: 'signal' | 'cron' | 'web' | 'web-pty';
  readonly jobId?: string;
  readonly jobName?: string;
  /** Persona name for `web` / `web-pty` sessions. */
  readonly persona?: string;
}

export interface BudgetSummaryDto {
  readonly totalTokens: number;
  readonly stepCount: number;
  readonly elapsedSeconds: number;
  readonly estimatedCostUsd: number;
  readonly tokenTrackingAvailable: boolean;
  readonly tokenTrackingStatus?: 'complete' | 'partial' | 'unavailable';
  readonly observedExchanges?: number;
  readonly incompleteExchanges?: number;
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
  /**
   * ISO 8601 timestamp of the most recent browser attach. Populated only for
   * `web-pty` sessions so the operator can spot an abandoned-but-alive terminal;
   * absent for all other kinds.
   */
  readonly lastAttachedAt?: string;
}

/** Persisted Docker-agent session available to resume as a live terminal. */
export interface ResumableSessionDto {
  readonly sessionId: string;
  readonly displayName: string;
  readonly agent: string;
  readonly status: 'completed' | 'crashed' | 'auth-failure' | 'user-exit';
  readonly lastActivity: string;
  readonly workspaceLabel?: string;
  readonly persona?: string;
  readonly providerProfileName?: string;
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
    /** Null when the provider did not expose a thinking/reasoning split. */
    thinkingTokens?: number | null;
    usageCompleteness?: 'complete' | 'partial' | 'unavailable';
    observedExchanges?: number;
    incompleteExchanges?: number;
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
  /**
   * The daemon's process-global session mode. `container` → new sessions are
   * `web-pty` live terminals (launch options + trusted-input bar); `builtin` →
   * legacy daemon-managed sessions. Optional in the mirror so a pre-existing
   * daemon that omits it deserializes cleanly.
   */
  readonly sessionMode?: 'builtin' | 'container';
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

// ---------------------------------------------------------------------------
// Read-only LLM statistics DTOs. Mirror src/llm-metrics query contracts.
// ---------------------------------------------------------------------------

export type LlmStatisticsDimension =
  | 'agent'
  | 'logicalProvider'
  | 'gateway'
  | 'protocol'
  | 'providerProfile'
  | 'requestedModel'
  | 'forwardedModel'
  | 'responseModel'
  | 'servedModel'
  | 'servedProvider'
  | 'reasoningMode'
  | 'requestedServiceTier'
  | 'actualServiceTier'
  | 'inputMeasurementProvenance'
  | 'outputMeasurementProvenance'
  | 'thinkingMeasurementProvenance'
  | 'nonThinkingMeasurementProvenance'
  | 'speedMode'
  | 'streaming'
  | 'outcome'
  | 'refusal'
  | 'usageCompleteness'
  | 'attributionQuality'
  | 'sessionId'
  | 'workflowRunId'
  | 'stateId'
  | 'personaId'
  | 'bundleId';

export type LlmStatisticsMeasure =
  | 'requestCount'
  | 'refusalCount'
  | 'refusalRate'
  | 'errorCount'
  | 'errorRate'
  | 'inputTokens'
  | 'uncachedInputTokens'
  | 'cacheReadInputTokens'
  | 'cacheWriteInputTokens'
  | 'toolUseInputTokens'
  | 'thinkingTokens'
  | 'nonThinkingOutputTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'costUsd'
  | 'ttftMs'
  | 'upstreamLatencyMs'
  | 'clientLatencyMs'
  | 'observableOutputTokensPerSecond'
  | 'effectiveOutputTokensPerSecond';

export type LlmStatisticsDistributionMeasure = Exclude<
  LlmStatisticsMeasure,
  'requestCount' | 'refusalCount' | 'refusalRate' | 'errorCount' | 'errorRate'
>;

export type StatisticsIdentitySource =
  | 'request'
  | 'forwarded_request'
  | 'protocol_response'
  | 'protocol_response_direct'
  | 'router_metadata'
  | 'trusted_gateway_header'
  | 'configured_route'
  | 'not_exposed';

export interface LlmExchangeFilters {
  readonly agent?: readonly string[];
  readonly logicalProvider?: readonly string[];
  readonly gateway?: readonly string[];
  readonly protocol?: readonly string[];
  readonly providerProfile?: readonly string[];
  readonly requestedModel?: readonly string[];
  readonly forwardedModel?: readonly string[];
  readonly responseModel?: readonly string[];
  readonly servedModel?: readonly string[];
  readonly servedProvider?: readonly string[];
  readonly reasoningMode?: readonly string[];
  readonly requestedServiceTier?: readonly string[];
  readonly actualServiceTier?: readonly string[];
  readonly inputMeasurementProvenance?: readonly string[];
  readonly outputMeasurementProvenance?: readonly string[];
  readonly thinkingMeasurementProvenance?: readonly string[];
  readonly nonThinkingMeasurementProvenance?: readonly string[];
  readonly speedMode?: readonly string[];
  readonly streaming?: readonly boolean[];
  readonly outcome?: readonly string[];
  readonly refusal?: readonly boolean[];
  readonly usageCompleteness?: readonly string[];
  readonly attributionQuality?: readonly string[];
  readonly sessionId?: readonly string[];
  readonly workflowRunId?: readonly string[];
  readonly stateId?: readonly string[];
  readonly personaId?: readonly string[];
  readonly bundleId?: readonly string[];
}

export interface StatisticsRangeQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly filters?: LlmExchangeFilters;
}

export interface StatisticsSummaryQuery extends StatisticsRangeQuery {
  readonly measures: readonly LlmStatisticsMeasure[];
  readonly groupBy?: readonly LlmStatisticsDimension[];
  readonly topGroups?: number;
}

export type StatisticsSeriesQuery = StatisticsSummaryQuery &
  (
    | { readonly bucketMs: number; readonly calendarBucket?: never }
    | {
        readonly bucketMs?: never;
        readonly calendarBucket: {
          readonly unit: 'day';
          readonly timeZone: string;
        };
      }
  );

export interface StatisticsDistributionQuery extends StatisticsRangeQuery {
  readonly measure: LlmStatisticsDistributionMeasure;
  readonly maxBins?: number;
}

export interface StatisticsExchangeQuery extends StatisticsRangeQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface StatisticsDimensionQuery extends StatisticsRangeQuery {
  readonly dimension: LlmStatisticsDimension;
  readonly limit?: number;
}

export interface StatisticsMetricSummaryDto {
  readonly dimensions: Readonly<Record<string, string | boolean | null>>;
  readonly measure: LlmStatisticsMeasure;
  readonly value: number | null;
  readonly sampleCount: number;
  readonly sampleSessionCount: number;
  readonly eligibleCount: number;
  readonly coverage: number;
  readonly median: number | null;
  readonly lowerQuartile: number | null;
  readonly upperQuartile: number | null;
  readonly formulaVersion: number;
}

export interface StatisticsTimeBucketDto {
  readonly fromMs: number;
  readonly toMs: number;
  readonly summaries: readonly StatisticsMetricSummaryDto[];
}

export interface StatisticsDimensionValueDto {
  readonly value: string | boolean | null;
  readonly count: number;
}

export interface StatisticsDistributionBinDto {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
}

export interface StatisticsMetricDistributionDto {
  readonly measure: LlmStatisticsDistributionMeasure;
  readonly bins: readonly StatisticsDistributionBinDto[];
  readonly sampleCount: number;
  readonly eligibleCount: number;
  readonly coverage: number;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly formulaVersion: number;
}

export interface StatisticsRepositoryHealthDto {
  readonly state: 'starting' | 'ready' | 'degraded' | 'disabled' | 'closed';
  readonly schemaVersion: number | null;
  readonly observed: number;
  readonly finalized: number;
  readonly enqueued: number;
  readonly persisted: number;
  readonly duplicates: number;
  readonly dropped: number;
  readonly queuedRecords: number;
  readonly queuedBytes: number;
  readonly lastError: string | null;
  readonly readerState: 'idle' | 'starting' | 'ready' | 'unavailable' | 'closed';
  readonly readerLastError: string | null;
}

export interface StatisticsCapabilitiesDto {
  readonly available: boolean;
  readonly dtoVersion: number;
  readonly formulaVersion: number;
  readonly schemaVersion: number | null;
  readonly maxPageSize: number;
  readonly maxScannedRows: number;
  readonly maxGroups: number;
  readonly allowedBucketSizesMs: readonly number[];
  readonly allowedCalendarBucketUnits: readonly 'day'[];
  readonly health: StatisticsRepositoryHealthDto;
}

/** Content-free flattened exchange returned by statistics.exchanges. */
export interface StatisticsExchangeDto {
  readonly exchangeId: string;
  readonly schemaVersion: number;
  readonly completedAtMs: number;
  readonly requestReceivedAtMs: number;
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly agentConversationId: string | null;
  readonly bundleId: string | null;
  readonly workflowRunId: string | null;
  readonly stateId: string | null;
  readonly personaId: string | null;
  readonly attributionQuality: string;
  readonly agent: string | null;
  readonly logicalProvider: string;
  readonly providerProfile: string | null;
  readonly protocol: string;
  readonly gateway: string;
  readonly clientRouteId: string | null;
  readonly upstreamRouteId: string | null;
  readonly requestedModel: string | null;
  readonly forwardedModel: string | null;
  readonly responseModel: string | null;
  readonly servedModel: string | null;
  readonly servedModelSource: StatisticsIdentitySource;
  readonly servedProvider: string | null;
  readonly servedProviderSource: StatisticsIdentitySource;
  readonly providerRequestId: string | null;
  readonly providerResponseId: string | null;
  readonly gatewayGenerationId: string | null;
  readonly streaming: boolean | null;
  readonly requestedServiceTier: string | null;
  readonly actualServiceTier: string | null;
  readonly reasoningMode: string;
  readonly reasoningEffort: string | null;
  readonly thinkingBudgetTokens: number | null;
  readonly speedMode: string | null;
  readonly responseStatus: number | null;
  readonly outcome: string;
  readonly providerStopReason: string;
  readonly refusal: boolean | null;
  readonly refusalCategory: string | null;
  readonly inputTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly toolUseInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly thinkingTokens: number | null;
  readonly nonThinkingOutputTokens: number | null;
  readonly providerTotalTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly usageCompleteness: string;
  readonly usageSemanticsVersion: number;
  readonly inputMeasurementProvenance: string;
  readonly outputMeasurementProvenance: string;
  readonly thinkingMeasurementProvenance: string;
  readonly nonThinkingMeasurementProvenance: string;
  readonly requestBodyCompleteOffsetMs: number | null;
  readonly responseHeadersOffsetMs: number | null;
  readonly firstUpstreamBodyByteOffsetMs: number | null;
  readonly firstProtocolEventOffsetMs: number | null;
  readonly firstReasoningOffsetMs: number | null;
  readonly lastReasoningOffsetMs: number | null;
  readonly firstOutputOffsetMs: number | null;
  readonly lastOutputOffsetMs: number | null;
  readonly protocolTerminalOffsetMs: number | null;
  readonly upstreamResponseEndOffsetMs: number | null;
  readonly clientDeliveryEndOffsetMs: number | null;
  readonly clientAborted: boolean;
  readonly qualityFlags: readonly string[];
}

export interface StatisticsExchangePageDto {
  readonly items: readonly StatisticsExchangeDto[];
  readonly nextCursor: string | null;
  readonly snapshotMaxSequence: number;
}

// ---------------------------------------------------------------------------
// PTY terminal streaming (web-pty session kind)
//
// Client -> server RPC methods: `sessions.ptyAttach`, `sessions.ptyDetach`,
// `sessions.ptyInput` ({ label, data }), `sessions.ptyResize`
// ({ label, cols, rows }). Server -> client events below. Every `data` /
// `snapshot` field is base64 of the UTF-8 bytes of a terminal string.
// ---------------------------------------------------------------------------

/** Incremental terminal delta pushed to subscribed clients. */
export interface PtyOutputEvent {
  readonly label: number;
  /** base64 of UTF-8 bytes. */
  readonly data: string;
}

/** One-shot full-screen snapshot sent to a single client on attach/resync. */
export interface PtyReplayEvent {
  readonly label: number;
  /** base64 of UTF-8 bytes. */
  readonly snapshot: string;
}

/**
 * Imperative terminal sink the Sessions route installs (keyed by label) so the
 * pure event handler can route incoming `session.pty_*` events to the bound
 * `TerminalConsole` without importing Svelte or the DOM. Both payloads are the
 * raw base64 strings off the wire; the component decodes at the xterm boundary.
 */
export interface PtySink {
  /** Apply an incremental delta (`PtyOutputEvent.data`). */
  write(dataB64: string): void;
  /** Clear and repaint from a full snapshot (`PtyReplayEvent.snapshot`). */
  reset(snapshotB64: string): void;
}

/** Available persona for session creation. */
export interface PersonaListItem {
  readonly name: string;
  readonly description: string;
  readonly compiled: boolean;
}

/**
 * Launch options for `sessions.create`. `persona` applies to every session mode;
 * `workspacePath` / `providerProfileName` / `model` are container web-pty launch
 * options (mux `/new` parity).
 */
export interface CreateSessionOptions {
  readonly persona?: string;
  readonly workspacePath?: string;
  readonly providerProfileName?: string;
  readonly model?: string;
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

export interface StatisticsConfigDto {
  readonly enabled: boolean;
  readonly retentionDays: number | null;
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

/** Narrow runtime settings exposed by the web UI. */
export type DockerWorkloadNetworkAccess = 'offline' | 'images' | 'packages';

export interface DockerWorkloadSettingsDto {
  readonly enabled: boolean;
  readonly networkAccess: DockerWorkloadNetworkAccess;
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
