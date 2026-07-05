/**
 * Shared types for the daemon web UI: JSON-RPC frame protocol, DTOs, and events.
 */

import type { SessionSource } from '../session/session-manager.js';
import type { SessionStatus, DiagnosticEvent, ConversationTurn } from '../session/types.js';
import type { JobDefinition, RunRecord } from '../cron/types.js';
import type { WhitelistCandidateIpc } from '../trusted-process/approval-whitelist.js';
import type { WorkflowId, HumanGateRequestDto } from '../workflow/types.js';
import type { MessageLogEntry } from '../workflow/message-log.js';
// TYPE-ONLY import of the 9-value pipeline phase union. The import-boundary
// rule (test/pipeline-import-boundary.test.ts + ESLint no-restricted-imports)
// forbids VALUE imports from pipeline/* on the live path; `import type` is the
// sanctioned contract import and creates no runtime edge.
import type { CompilationPhase } from '../pipeline/pipeline-shared.js';

// Re-export the phase union so the frontend mirror and event consumers can name
// it without reaching into the pipeline package directly.
export type { CompilationPhase } from '../pipeline/pipeline-shared.js';

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
  // Docker-agent PTY terminal streaming (web-pty session kind). Attach/detach
  // manage per-client subscription to a session's terminal stream; input/resize
  // forward keystrokes and the browser xterm's size to the child PTY.
  | 'sessions.ptyAttach'
  | 'sessions.ptyDetach'
  | 'sessions.ptyInput'
  | 'sessions.ptyResize'
  | 'sessions.ptyPrompt'
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
  | 'workflows.readme'
  | 'personas.get'
  // Phase 1b: streamed long-running compile (fire-and-return) + its read methods.
  | 'personas.compileStream'
  | 'personas.getCompile'
  | 'personas.listCompiles'
  // Phase 1c: full persona CRUD (all mutation methods; require the
  // `--allow-policy-mutation` kill switch, else POLICY_MUTATION_FORBIDDEN).
  | 'personas.create'
  | 'personas.editConstitution'
  | 'personas.setMemory'
  | 'personas.delete'
  | 'personas.setBroadPolicyOptIn'
  // Config (modelProviders registry). Read is ungated; the mutation is gated
  // on the daemon's `--allow-policy-mutation` kill switch (POLICY_MUTATION_FORBIDDEN).
  | 'config.getModelProviders'
  | 'config.setModelProviders'
  // OpenRouter model-slug catalog for autocomplete/validation. Ungated read of
  // PUBLIC data (mirrors `config.getModelProviders`); no secret, no mutation.
  | 'config.listOpenrouterModels';

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
  | 'README_NOT_FOUND'
  | 'PERSONA_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'INVALID_PARAMS'
  | 'RATE_LIMITED'
  | 'METHOD_NOT_FOUND'
  | 'LINT_FAILED'
  | 'INTERNAL_ERROR'
  // Phase 1b persona-compile error codes.
  | 'COMPILE_IN_PROGRESS'
  | 'COMPILE_QUEUE_FULL'
  | 'CREDENTIALS_MISSING'
  | 'LIST_REQUIRES_MCP'
  | 'POLICY_MUTATION_FORBIDDEN'
  // Phase 1c persona-CRUD error codes.
  // PERSONA_EXISTS: `personas.create` against an existing persona dir (after branding).
  // BROAD_POLICY_REJECTED: the broad-policy validator rejected a compiled policy
  //   (`'*'` domain/list or out-of-workspace path) without `allowBroadPolicy`;
  //   surfaced terminally via the `persona.compile.failed` event.
  | 'PERSONA_EXISTS'
  | 'BROAD_POLICY_REJECTED';

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
  /**
   * ISO 8601 timestamp of the most recent browser attach. Populated only for
   * `web-pty` sessions (see `toPtySessionDto`) so the operator can spot an
   * abandoned-but-alive terminal in the session list; absent for all other
   * kinds. Additive/optional — existing consumers ignore it.
   */
  readonly lastAttachedAt?: string;
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
  /**
   * Whether the daemon was launched with `--allow-policy-mutation` (Phase 1c).
   * Populated by `buildStatusDto` from `ctx.allowPolicyMutation`. The frontend
   * uses this to HIDE all persona-mutation controls when the kill switch is
   * off — when off, every mutation method returns POLICY_MUTATION_FORBIDDEN.
   * Off by default, CLI-only, not config-persisted.
   */
  readonly allowPolicyMutation: boolean;
  /**
   * The daemon's process-global session mode. `container` → new sessions are
   * `web-pty` live terminals that accept launch options (workspace / provider
   * profile / model) and mediate trusted input; `builtin` → legacy
   * daemon-managed sessions. Populated by `buildStatusDto`, which maps the
   * internal Docker-agent discriminator to the public runtime-neutral label.
   */
  readonly sessionMode: 'builtin' | 'container';
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
  /** True when the workflow's source package ships a `README.md` (lazily fetched via `workflows.readme`). */
  readonly hasReadme: boolean;
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
  /** True when the package ships a `README.md` (fetch with `workflows.readme`). */
  readonly hasReadme: boolean;
}

/** README markdown for a workflow, returned by `workflows.readme`. */
export interface WorkflowReadmeDto {
  /** Raw markdown source; the client renders + sanitizes it. */
  readonly content: string;
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
  /**
   * Whether persistent memory is enabled for this persona
   * (persona.memory?.enabled ?? true). Added in Phase 1a; additive and
   * backward-compatible — existing callers ignore unknown fields.
   */
  readonly memory: boolean;
  /**
   * Whether this persona is authorized to compile a "broad" policy
   * (persona.allowBroadPolicy ?? false). When false, the broad-policy
   * validator rejects compiled policies containing a `'*'` domain/list or an
   * out-of-workspace `paths.within`. Set ONLY via the gated
   * `personas.setBroadPolicyOptIn` method — never inferred from the
   * constitution. Added in Phase 1c. (Source: src/persona/types.ts
   * PersonaDefinition.allowBroadPolicy.)
   */
  readonly allowBroadPolicy: boolean;
}

/**
 * Slim list-row returned by `personas.list` (canonical scanner output).
 *
 * Promoted from a local definition in persona-service.ts (Phase 1a follow-up)
 * so backend and frontend build against one declaration. `memory` is carried
 * per row per the design (§5).
 */
export interface PersonaListDto {
  readonly name: string;
  readonly description: string;
  readonly compiled: boolean;
  /**
   * Whether persistent memory is enabled for this persona
   * (persona.memory?.enabled ?? true). NOTE: the Phase-1a service does not yet
   * populate this; it is part of the locked contract and is filled in when the
   * scanner is extended. Additive and backward-compatible.
   */
  readonly memory?: boolean;
}

/** Result of editing a persona's constitution (`personas.editConstitution`). */
export interface PersonaEditResultDto {
  /** True when the compiled policy no longer matches the new constitution. */
  readonly stale: boolean;
}

/**
 * Compile-time diff vs the persona's previous `compiled-policy.json`,
 * carried on a successful compile result (Phase 1c). Surfaced by the
 * `done` event/card so prompt-injected broadening is reviewable after the
 * fact. `broadenedDomains` / `outOfWorkspacePaths` enumerate the specific
 * `'*'`-domain and out-of-workspace `paths.within` values introduced (these
 * are only ever non-empty for an `allowBroadPolicy` persona, since otherwise
 * the broad-policy validator would have rejected the compile).
 */
export interface RuleDeltaDto {
  readonly added: number;
  readonly loosened: number;
  readonly removed: number;
  readonly broadenedDomains: readonly string[];
  readonly outOfWorkspacePaths: readonly string[];
}

/**
 * Success-only compile result carried by a `done` operation record / event.
 *
 * A terminal `done` record never represents failure — failures route through
 * the `persona.compile.failed` event and `PersonaCompileOperationDto.error`.
 * Phase 1c adds the optional `ruleDelta` (absent when there was no previous
 * compiled policy to diff against).
 */
export interface PersonaCompileResultDto {
  readonly success: true;
  readonly ruleCount: number;
  readonly ruleDelta?: RuleDeltaDto;
}

/**
 * Snapshot of a streamed persona-compile operation, returned by
 * `personas.getCompile` and inside `personas.listCompiles`.
 *
 * Two distinct phase vocabularies:
 *  - `phase` is the OPERATION lifecycle (started/running/done/failed).
 *  - `serverProgress.compilationPhase` is the 9-value {@link CompilationPhase}
 *    from the pipeline (type-only import) for the server currently compiling.
 *
 * The active operation record is the source of truth (events are best-effort /
 * lossy), so a reconnecting client renders the live phase from a single
 * `personas.listCompiles` call.
 */
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
  readonly error?: { readonly code: ErrorCode; readonly message: string };
  readonly actor: string;
}

/** Response from `personas.listCompiles`. */
export interface PersonaListCompilesDto {
  readonly active: readonly PersonaCompileOperationDto[];
  readonly recent: readonly PersonaCompileOperationDto[];
  readonly queueDepth: number;
}

/** Response from `personas.compileStream` (fire-and-return; jobs.run shape). */
export interface PersonaCompileStreamAckDto {
  readonly accepted: true;
  readonly name: string;
  readonly operationId: string;
  /** True when the operation was enqueued behind the global concurrency gate. */
  readonly queued?: boolean;
}

// ---------------------------------------------------------------------------
// Config (modelProviders) DTO Types
// ---------------------------------------------------------------------------
//
// Wire contract for `config.getModelProviders` / `config.setModelProviders`,
// scoped to the `modelProviders` registry only (see
// docs/designs/openrouter-integration.md §12.6). The DTO carries the SAME
// per-profile fields as the resolved config, with every openrouter profile's
// `apiKey` MASKED (`sk-...xyz` / 'none'). The `native` profile is included in
// the get response (`{ type: 'native' }`) but is always implicit — the set
// path silently drops a verbatim `{ type: 'native' }` echo (F7).

/** One glob→slug rule (mirrors the resolved config's modelMap entry). */
export interface ModelMapRuleDto {
  readonly match: string;
  readonly model: string;
}

/** Provider-preference passthrough (cache pinning) — mirrors the resolved shape. */
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
 * The openrouter profile DTO. On the GET response `apiKey` is MASKED. On a SET
 * request `apiKey` follows the M5 mask-unchanged contract per profile:
 *   - absent / null / equal-to-the-returned-mask → keep the stored key
 *   - '' (empty string) → clear the stored key
 *   - any other string → set it
 */
export interface OpenrouterProfileDto {
  readonly type: 'openrouter';
  /** Masked on read; M5-interpreted on write. May be absent/null on write. */
  readonly apiKey?: string | null;
  readonly modelMap?: readonly ModelMapRuleDto[];
  readonly perAgent?: Readonly<Record<string, string | undefined>>;
  readonly providerPreference?: ProviderPreferenceDto;
  readonly sessionAffinity?: boolean;
}

/** A single profile DTO (discriminated on `type`). */
export type ProfileDto = NativeProfileDto | OpenrouterProfileDto;

/**
 * Response from `config.getModelProviders`. `default` is the resolved default
 * name ('native' when unset); `profiles` always includes the implicit `native`
 * entry and every openrouter profile with its `apiKey` masked.
 */
export interface GetModelProvidersDto {
  readonly default: string;
  readonly profiles: Readonly<Record<string, ProfileDto>>;
}

/**
 * Request for `config.setModelProviders`. Carries the WHOLE profiles record
 * (the shallow `deepMergeConfig` replaces `profiles` wholesale, so a partial
 * write would drop unmentioned profiles). `default` is optional; when it names
 * the profile being dropped in the same write, the backend re-points it to
 * 'native' (F10). A verbatim `{ type: 'native' }` under `profiles.native` is
 * accepted-and-dropped (F7); any other value under `native` is rejected.
 */
export interface SetModelProvidersDto {
  readonly default?: string;
  readonly profiles: Readonly<Record<string, ProfileDto>>;
}

/**
 * Response from `config.listOpenrouterModels`. `source` drives client-side
 * validation strictness: `live`/`cache` are authoritative (hard-block unknown
 * slugs), `bundled` is the known-incomplete offline floor (warn-only). See
 * `catalogEnforces` in `src/config/openrouter-catalog.ts`.
 */
export interface OpenrouterModelsDto {
  readonly models: readonly string[];
  readonly source: 'live' | 'cache' | 'bundled';
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
