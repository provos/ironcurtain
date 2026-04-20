import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Directory name for workflow artifacts inside the agent workspace.
 * All artifact subdirectories (plan/, code/, reviews/, etc.) live under this.
 */
export const WORKFLOW_ARTIFACT_DIR = '.workflow';

/**
 * Reserved persona alias meaning "use the global policy".
 * When a workflow state specifies this as its persona, the session
 * factory strips the persona field (same as undefined), so the
 * session uses the default global compiled policy and memory.
 *
 * Any other persona value is passed through to `createSession()`,
 * which resolves it to a per-persona policy, memory, and prompt.
 */
export const GLOBAL_PERSONA = 'global';

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

/**
 * Unique identifier for a workflow instance. Branded to prevent accidental
 * mixing with other string identifiers.
 */
export type WorkflowId = string & { readonly __brand: 'WorkflowId' };

/** Creates a new unique WorkflowId. */
export function createWorkflowId(): WorkflowId {
  return randomUUID() as WorkflowId;
}

// ---------------------------------------------------------------------------
// Workflow definition types
// ---------------------------------------------------------------------------

export interface WorkflowDefinition {
  readonly name: string;
  readonly description: string;
  readonly initial: string;
  readonly states: Record<string, WorkflowStateDefinition>;
  readonly settings?: WorkflowSettings;
}

export interface WorkflowSettings {
  /** Session mode. Default: 'docker'. */
  readonly mode?: 'docker' | 'builtin';
  /** Agent ID for Docker mode. Default: 'claude-code'. */
  readonly dockerAgent?: string;
  /** Default max rounds for iterative loops. Default: 4. */
  readonly maxRounds?: number;
  /** Git repository path for worktree management. */
  readonly gitRepoPath?: string;
  /** Max parallel agent sessions. Default: 3. */
  readonly maxParallelism?: number;
  /**
   * Optional system prompt text appended to the base system prompt
   * for ALL agent states in this workflow. Use for workspace
   * conventions, project-level context, or shared instructions.
   * Sent via --append-system-prompt.
   */
  readonly systemPrompt?: string;
  /**
   * Per-turn wall-clock timeout in seconds for agent sessions.
   * Overrides the global resourceBudget.maxSessionSeconds for this workflow.
   * Default: uses the global setting (1800s / 30 minutes).
   */
  readonly maxSessionSeconds?: number;
  /** Output artifact names excluded from versioning (e.g., append-only journals). */
  readonly unversionedArtifacts?: readonly string[];
  /**
   * Default model ID for all agent states in this workflow.
   * Format: "provider:model-name" (e.g., "anthropic:claude-sonnet-4-6").
   * Can be overridden per state via `states.<name>.model`.
   * Takes precedence over `agentModelId` from user config but is
   * overridden by the `--model` CLI flag.
   */
  readonly model?: string;
  /**
   * When true, the workflow runs in shared-container mode: the engine
   * creates one DockerInfrastructure bundle at workflow start and
   * reuses it across all states. When false (default), each state
   * gets a fresh container (today's behavior).
   *
   * Shared-container mode is the prerequisite for policy hot-swap at
   * state transitions. See docs/designs/workflow-container-lifecycle.md.
   *
   * Ignored for builtin workflows (no Docker infrastructure to share).
   */
  readonly sharedContainer?: boolean;
}

/**
 * State definition. Discriminated on `type`.
 */
export type WorkflowStateDefinition =
  | AgentStateDefinition
  | HumanGateStateDefinition
  | DeterministicStateDefinition
  | TerminalStateDefinition;

export interface AgentStateDefinition {
  readonly type: 'agent';
  readonly description: string;
  readonly persona: string;
  /**
   * Role instructions for the agent. Embedded in the full prompt assembled
   * by the orchestrator; see `buildFirstVisitPrompt` / `buildReVisitPrompt`
   * in prompt-builder.ts for the section layout. The role prompt is
   * positioned for recency bias on first visit; re-invocations reuse the
   * conversation history via `--continue`.
   */
  readonly prompt: string;
  /**
   * Input artifact names assembled into the agent's command.
   * Trailing `?` marks optional inputs (no error if absent).
   */
  readonly inputs: readonly string[];
  /** Output artifact names the agent is expected to produce. */
  readonly outputs: readonly string[];
  /** Transitions evaluated in order; first match wins. */
  readonly transitions: readonly AgentTransitionDefinition[];
  /**
   * Key path into an artifact for parallel instantiation.
   * E.g., "spec.modules" reads the modules array from the spec artifact.
   */
  readonly parallelKey?: string;
  /** When true, each parallel instance gets a dedicated git worktree. */
  readonly worktree?: boolean;
  /**
   * When false, re-invocations of this state resume the previous agent
   * session via --continue, receiving an abbreviated re-visit prompt.
   * Use this for iterative refinement loops where the agent benefits
   * from retaining its prior reasoning (e.g., harness design/build after
   * critique feedback).
   *
   * Default: true (each invocation starts a fresh session, bootstrapping
   * from artifacts on disk).
   */
  readonly freshSession?: boolean;
  /**
   * Per-state model override. Format: "provider:model-name".
   * Takes precedence over `settings.model` at the workflow level.
   * Overridden only by the `--model` CLI flag.
   */
  readonly model?: string;
  /**
   * Per-state visit cap. When set, the `isStateVisitLimitReached` guard
   * returns true once `context.visitCounts[stateId] >= maxVisits`. Use
   * this to bound an iterative loop (e.g., harness_design_review) and
   * route to a human gate once the cap is reached. Independent of the
   * workflow-level `maxRounds` setting.
   *
   * Because visit counts are incremented on state entry (before
   * `invoke`), the guard fires on the onDone transitions of the Nth
   * visit — i.e., after the Nth invocation completes.
   */
  readonly maxVisits?: number;
}

export interface HumanGateStateDefinition {
  readonly type: 'human_gate';
  readonly description: string;
  /** Event types this gate accepts. Each maps to a HUMAN_* WorkflowEvent. */
  readonly acceptedEvents: readonly HumanGateEventType[];
  /** Artifact names to present to the human for review. */
  readonly present?: readonly string[];
  /**
   * Transitions keyed by accepted event type.
   * Each transition specifies which event triggers it and where to go.
   */
  readonly transitions: readonly HumanGateTransitionDefinition[];
}

export interface DeterministicStateDefinition {
  readonly type: 'deterministic';
  readonly description: string;
  /**
   * Commands to execute. Each command is an array of [binary, ...args].
   * Never a shell string -- per CLAUDE.md safe coding rules.
   */
  readonly run: readonly (readonly string[])[];
  readonly transitions: readonly AgentTransitionDefinition[];
}

export interface TerminalStateDefinition {
  readonly type: 'terminal';
  readonly description: string;
  readonly outputs?: readonly string[];
  readonly cleanup?: readonly (readonly string[])[];
}

// ---------------------------------------------------------------------------
// Transition definitions
// ---------------------------------------------------------------------------

/** Allowed value types in a `when` clause. Matches AgentOutput field types. */
export type WhenValue = string | number | boolean | null;

/**
 * Per-key typed shape for `when` clauses. Using a mapped type here
 * enforces compile-time validation of both key names (must be in
 * AgentOutput) and value types (must match the field's type, e.g.
 * `completed` must be boolean, `verdict` must be a valid union member).
 *
 * Prefer this type over `Readonly<Record<string, WhenValue>>` when
 * writing workflow definitions in TypeScript.
 */
export type WhenClause = { readonly [K in keyof AgentOutput]?: AgentOutput[K] };

/**
 * Action executed on a transition, in addition to the default context
 * update actions (updateContextFromAgentResult / ...). Discriminated on
 * `type`. Implementations live in `machine-builder.ts` — this is a
 * closed set, not an open extension point.
 *
 * Today there is only a single variant, but the discriminated-union
 * shape is retained so new action types can be added without changing
 * the surrounding shape of transition definitions.
 */
export type WorkflowTransitionAction = {
  readonly type: 'resetVisitCounts';
  readonly stateIds: readonly string[];
};

export interface AgentTransitionDefinition {
  readonly to: string;
  /**
   * Guard name matching a registered XState guard. No translation
   * layer -- use names directly: isRoundLimitReached, isStalled, isPassed,
   * isStateVisitLimitReached. For verdict-based routing, prefer `when`
   * clauses instead. Mutually exclusive with `when`.
   */
  readonly guard?: string;
  /**
   * Declarative field-match condition on AgentOutput.
   * Keys must be valid AgentOutput field names and values must match
   * the field's type (enforced at compile time via the mapped type).
   * All entries must match (AND semantics).
   * Mutually exclusive with `guard`.
   */
  readonly when?: WhenClause;
  /**
   * Optional ordered list of actions to run on this transition, in
   * addition to the default context-update action. Actions execute
   * in the order listed.
   */
  readonly actions?: readonly WorkflowTransitionAction[];
}

export interface HumanGateTransitionDefinition {
  readonly to: string;
  /** The accepted event type that triggers this transition. */
  readonly event: HumanGateEventType;
}

export type HumanGateEventType = 'APPROVE' | 'FORCE_REVISION' | 'REPLAN' | 'ABORT';

// ---------------------------------------------------------------------------
// Agent output
// ---------------------------------------------------------------------------

export const CONFIDENCE_VALUES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_VALUES)[number];

/** Structured output parsed from the agent's response text. */
export interface AgentOutput {
  /**
   * @deprecated Maintained for backward compatibility. Defaults to `true`
   * at parse time. Workflows should use free-form `verdict` strings for
   * routing decisions instead of relying on this boolean.
   */
  readonly completed: boolean;
  /** Free-form verdict string. Well-known values: approved, rejected, blocked, spec_flaw. Workflows may define custom verdicts for direct routing. */
  readonly verdict: string;
  /**
   * @deprecated Maintained for backward compatibility. Defaults to `'high'`
   * at parse time. Should not be relied upon for routing decisions; use
   * `verdict` and `notes` instead.
   */
  readonly confidence: Confidence;
  /**
   * @deprecated Maintained for backward compatibility. Defaults to `null`
   * at parse time. Use `notes` for inter-agent context instead.
   */
  readonly escalation: string | null;
  /**
   * @deprecated Maintained for backward compatibility. Defaults to `null`
   * at parse time. Should not be relied upon for routing decisions.
   */
  readonly testCount: number | null;
  readonly notes: string | null;
}

/** Valid keys for `when` clauses. Must match AgentOutput field names. */
export const AGENT_OUTPUT_FIELDS = [
  'completed',
  'verdict',
  'confidence',
  'escalation',
  'testCount',
  'notes',
] as const satisfies readonly (keyof AgentOutput)[];

// ---------------------------------------------------------------------------
// Workflow events (XState event discriminated union)
// ---------------------------------------------------------------------------

export type WorkflowEvent =
  | { readonly type: 'AGENT_COMPLETED'; readonly output: AgentOutput }
  | { readonly type: 'VALIDATION_PASSED'; readonly testCount: number }
  | { readonly type: 'VALIDATION_FAILED'; readonly errors: string }
  | { readonly type: 'HUMAN_APPROVE'; readonly prompt?: string }
  | { readonly type: 'HUMAN_FORCE_REVISION'; readonly prompt?: string }
  | { readonly type: 'HUMAN_REPLAN'; readonly prompt?: string }
  | { readonly type: 'HUMAN_ABORT' }
  | { readonly type: 'PARALLEL_ALL_COMPLETED'; readonly results: readonly ParallelSlotResult[] }
  | { readonly type: 'PARALLEL_SLOT_FAILED'; readonly key: string; readonly error: string }
  | { readonly type: 'MERGE_SUCCEEDED' }
  | { readonly type: 'MERGE_CONFLICT'; readonly conflictDetails: string };

// ---------------------------------------------------------------------------
// Workflow context (XState context)
// ---------------------------------------------------------------------------

export interface WorkflowContext {
  readonly taskDescription: string;
  readonly artifacts: Record<string, string>;
  readonly round: number;
  readonly maxRounds: number;
  /** Per-role output hash for stall detection. */
  readonly previousOutputHashes: Record<string, string>;
  readonly previousTestCount: number | null;
  readonly humanPrompt: string | null;
  readonly reviewHistory: readonly string[];
  readonly parallelResults: Record<string, ParallelSlotResult>;
  readonly worktreeBranches: readonly string[];
  readonly totalTokens: number;
  readonly lastError: string | null;
  readonly sessionsByState: Record<string, string>;
  /**
   * Response text from the last completed agent state, with the trailing
   * `agent_status` YAML block stripped. Truncated at 32KB. Used as the
   * "body" portion of the "Scoping from the previous agent" section in the
   * next agent's prompt — carries the full directive, not just the summary.
   */
  readonly previousAgentOutput: string | null;
  /**
   * The `notes` field from the last agent's `agent_status` block. Rendered
   * as the "Notes" sub-section under "Scoping from the previous agent".
   * When the orchestrator writes a bare status block with no directive, this
   * is often the only surviving scoping signal.
   */
  readonly previousAgentNotes: string | null;
  /**
   * The state name that produced `previousAgentOutput`. Used to
   * label the output in the next agent's prompt.
   */
  readonly previousStateName: string | null;
  /**
   * Per-state visit counter. Maps state ID to the number of times
   * that state has been entered. Used for first-visit vs re-visit
   * prompt selection and per-state round limit checking.
   */
  readonly visitCounts: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Workflow status (exposed to TUI and tests)
// ---------------------------------------------------------------------------

export type WorkflowStatus =
  | { readonly phase: 'running'; readonly currentState: string; readonly activeAgents: readonly AgentSlot[] }
  | { readonly phase: 'waiting_human'; readonly gate: HumanGateRequest }
  | { readonly phase: 'completed'; readonly result: WorkflowResult }
  | { readonly phase: 'failed'; readonly error: string; readonly lastState: string }
  | { readonly phase: 'aborted'; readonly reason: string };

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface AgentSlot {
  readonly stateId: string;
  readonly persona: string;
  readonly parallelKey?: string;
}

export interface WorkflowResult {
  readonly finalArtifacts: Record<string, string>;
}

export interface ParallelSlotResult {
  readonly key: string;
  readonly status: 'success' | 'failed';
  readonly error?: string;
  readonly worktreeBranch?: string;
}

export interface HumanGateRequest {
  readonly gateId: string;
  readonly workflowId: string;
  readonly stateName: string;
  readonly acceptedEvents: readonly HumanGateEventType[];
  readonly presentedArtifacts: ReadonlyMap<string, string>;
  readonly summary: string;
}

export interface HumanGateEvent {
  readonly type: HumanGateEventType;
  readonly prompt?: string;
}

// ---------------------------------------------------------------------------
// Checkpoint and history
// ---------------------------------------------------------------------------

export interface WorkflowCheckpoint {
  /** Serialized XState snapshot.value (string or nested object). */
  readonly machineState: unknown;
  readonly context: WorkflowContext;
  readonly timestamp: string;
  readonly transitionHistory: readonly TransitionRecord[];
  readonly definitionPath: string;
  /** Workspace root directory. Used on resume to reconstruct artifactDir. */
  readonly workspacePath?: string;
}

export interface TransitionRecord {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly timestamp: string;
  readonly duration_ms: number;
  /** Summary of the agent's output that produced this transition (if any). */
  readonly agentMessage?: string;
}
