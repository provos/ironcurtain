import { setup, assign, fromPromise, type AnyStateMachine } from 'xstate';
import type {
  WorkflowDefinition,
  WorkflowContext,
  WorkflowEvent,
  AgentStateDefinition,
  DeterministicStateDefinition,
  HumanGateStateDefinition,
  AgentOutput,
  AgentTransitionDefinition,
  WhenValue,
  WorkflowTransitionAction,
  WorkflowStateDefinition,
} from './types.js';
import type { AgentConversationId } from '../session/types.js';
import { guardImplementations } from './guards.js';
import { stripStatusBlock } from './status-parser.js';
import { isAgentInvocationError } from './errors.js';
import { laneScopeEvolveCurrentPath, templateLaneCommand } from './lane-template.js';

// ---------------------------------------------------------------------------
// Invoke input/result types
// ---------------------------------------------------------------------------

type ExecutableStateDefinition = AgentStateDefinition | DeterministicStateDefinition;

/** Input provided to each invoked agent service. */
export interface AgentInvokeInput {
  readonly stateId: string;
  readonly stateConfig: AgentStateDefinition;
  readonly context: WorkflowContext;
}

/** Result returned by an agent service promise. */
export interface AgentInvokeResult {
  readonly output: AgentOutput;
  /**
   * Agent CLI conversation id used for this invocation. Minted or reused
   * by the orchestrator before session construction (see
   * `executeAgentState` and `docs/designs/workflow-session-identity.md`
   * §3). Threaded through the result only so the
   * `updateContextFromAgentResult` XState action can write it into
   * `agentConversationsByState[stateId]`; not a read-back from the
   * session.
   */
  readonly agentConversationId: AgentConversationId;
  readonly artifacts: Record<string, string>;
  /** SHA-256 of output artifacts, computed by the orchestrator. */
  readonly outputHash: string;
  /** Raw response text from session.sendMessage(). */
  readonly responseText: string;
  /**
   * Cumulative workflow-level output-token count at the moment this
   * agent finished. Copied onto `ctx.totalTokens` by the XState
   * `updateContextFromAgentResult` assign action. Sourced from the
   * orchestrator's token-stream bus subscription, which sums every
   * `message_end.outputTokens` seen for sessions belonging to this
   * workflow run.
   */
  readonly totalTokens: number;
}

/** Input provided to each invoked deterministic service. */
export interface DeterministicInvokeInput {
  readonly stateId: string;
  readonly commands: readonly (readonly string[])[];
  readonly context: WorkflowContext;
  readonly container?: boolean;
  readonly containerScope?: string;
  readonly timeoutMs?: number;
  readonly resultFile?: string;
}

/** Result from a deterministic (test/lint) state. */
export interface DeterministicInvokeResult {
  readonly passed: boolean;
  readonly testCount?: number;
  readonly errors?: string;
  readonly verdict?: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * Input provided to a parent fan-out state invoke. `stateConfig` carries the
 * `fanOut`/`segment` markers the orchestrator reads to resolve the worker
 * count and the round sub-chain; `context` is the parent's context at fan-out
 * time, cloned into each lane's child actor.
 */
export interface FanOutInvokeInput {
  readonly stateId: string;
  readonly stateConfig: ExecutableStateDefinition;
  readonly context: WorkflowContext;
}

/**
 * The three synthetic terminal states every child round machine carries are
 * `recorded`/`blocked`/`errored` (see `buildRoundChildDefinition`). `drained`
 * is not a child terminal; it is the parent-side outcome synthesized for a
 * peer actor stopped by drain-on-escalation after another child blocked or
 * errored. Typed as a closed union so the join's branches are
 * exhaustive-checkable.
 */
export type RoundChildStatus = 'recorded' | 'blocked' | 'errored' | 'drained';

/**
 * The fully-resolved result of joining one child round actor: the terminal
 * it reached plus the context it carried there. `context` is read by the
 * parent to thread per-lane updates (e.g. the `evaluator_blocked` reason on
 * `previousAgentOutput`) back onto the parent FSM after the barrier.
 */
export interface RoundChildOutcome {
  readonly index: number;
  readonly status: RoundChildStatus;
  readonly context: WorkflowContext;
  readonly drainedBy?: { readonly index: number; readonly status: 'blocked' | 'errored'; readonly reason: string };
}

/** Per-lane summary surfaced on the fan-out result for observability. */
export interface RoundChildSummary {
  readonly index: number;
  readonly status: RoundChildStatus;
}

/**
 * Result returned by the fan-out pump after all children have joined. Shaped
 * as a `DeterministicInvokeResult` so the parent `workers` state's transitions
 * match on `verdict` exactly like a normal deterministic state. The verdict
 * space is `recorded` (batch advanced) | `escalate` (at least one lane blocked;
 * route to human review) | `result_file_error` (errored-only lane / segment
 * misconfiguration). `context` is the joined context promoted onto the parent
 * FSM; `children` is the per-lane status summary, for observability only.
 */
export interface FanOutInvokeResult extends DeterministicInvokeResult {
  readonly context: WorkflowContext;
  readonly children?: readonly RoundChildSummary[];
}

// ---------------------------------------------------------------------------
// Build result
// ---------------------------------------------------------------------------

export interface BuildMachineResult {
  /** The XState machine (with placeholder actors). */
  readonly machine: AnyStateMachine;
  /** Child round machines keyed by the parent fan-out state that invokes them. */
  readonly roundMachinesByState: ReadonlyMap<string, AnyStateMachine>;
  /** Set of state names that are human gates (for snapshot.matches()). */
  readonly gateStateNames: ReadonlySet<string>;
  /** Set of state names that are terminal (for completion detection). */
  readonly terminalStateNames: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Extraction helpers (used by guards and actions inside the machine)
// ---------------------------------------------------------------------------

/**
 * Extracts the invoke result from an xstate.done.actor.* event.
 * XState wraps the promise resolution in `event.output`.
 */
function extractInvokeResult(event: { output?: unknown }): AgentInvokeResult | undefined {
  const output = event.output as AgentInvokeResult | undefined;
  if (output && typeof output === 'object' && 'output' in output && 'outputHash' in output) {
    return output;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Agent output truncation
// ---------------------------------------------------------------------------

const MAX_AGENT_OUTPUT_BYTES = 32_768;
const TRUNCATION_NOTICE = '\n\n[Output truncated. Read the artifact directories for full details.]';

/**
 * Sanitizes agent response text for reuse in subsequent prompts: escapes any
 * literal NUL bytes and truncates to stay within the 32KB limit.
 *
 * NUL escaping is load-bearing, not cosmetic. Agent output flows back into
 * later prompts via `previousAgentOutput` / `previousAgentNotes`, which the
 * Docker adapter passes as an argv element to `child_process.spawn`. Node
 * refuses argv strings containing `\0` (`ERR_INVALID_ARG_VALUE`) and throws
 * synchronously before the container even starts — aborting the workflow. A
 * security-research agent describing a binary file format ("APP1 'Exif\\0\\0'")
 * is the natural way this happens. We escape rather than strip so the textual
 * description survives intact for downstream readers.
 *
 * Exported for testing.
 */
export function truncateAgentOutput(text: string): string {
  const sanitized = text.includes('\0') ? text.replaceAll('\0', '\\x00') : text;
  if (Buffer.byteLength(sanitized, 'utf-8') <= MAX_AGENT_OUTPUT_BYTES) {
    return sanitized;
  }
  const budget = MAX_AGENT_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE, 'utf-8');
  let truncated = sanitized;
  while (Buffer.byteLength(truncated, 'utf-8') > budget) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
  }
  return truncated + TRUNCATION_NOTICE;
}

// ---------------------------------------------------------------------------
// Initial context factory
// ---------------------------------------------------------------------------

/**
 * Creates the initial WorkflowContext for a given definition.
 * Exported for testing.
 */
export function createInitialContext(definition: WorkflowDefinition): Omit<WorkflowContext, 'taskDescription'> {
  return {
    artifacts: {},
    round: 0,
    maxRounds: definition.settings?.maxRounds ?? 4,
    previousOutputHashes: {},
    previousTestCount: null,
    humanPrompt: null,
    reviewHistory: [],
    totalTokens: 0,
    lastError: null,
    agentConversationsByState: {},
    previousAgentOutput: null,
    previousAgentNotes: null,
    previousStateName: null,
    visitCounts: {},
  };
}

// ---------------------------------------------------------------------------
// State builders
// ---------------------------------------------------------------------------

/**
 * Finds an appropriate error target for a state. Looks for a human_gate
 * in the definition's transitions, then falls back to any terminal state.
 */
function findErrorTarget(
  stateDef: AgentStateDefinition | DeterministicStateDefinition,
  definition: WorkflowDefinition,
): string {
  // Check if any transition leads to a human gate (good for error review)
  for (const t of stateDef.transitions) {
    const targetState = definition.states[t.to];
    if (targetState.type === 'human_gate') return t.to;
  }

  // Fall back: prefer terminal states named 'aborted' or 'failed'
  for (const [id, state] of Object.entries(definition.states)) {
    if (state.type === 'terminal' && (id === 'aborted' || id === 'failed')) return id;
  }
  // Then any terminal
  for (const [id, state] of Object.entries(definition.states)) {
    if (state.type === 'terminal') return id;
  }

  // Last resort: first transition target (machine will at least not crash)
  if (stateDef.transitions.length > 0) {
    return stateDef.transitions[0].to;
  }

  // Should not happen in a validated definition
  throw new Error('No valid error target found');
}

/**
 * XState-level action entry. Either a bare action name (for parameter-less
 * actions) or an object with `type` + `params` for parameterized actions.
 */
type XStateActionEntry = string | { readonly type: string; readonly params: Record<string, unknown> };

/**
 * Collects all transition actions for a given transition definition into
 * XState action entries, preserving order:
 *   1. the default context-update action (caller-provided),
 *   2. each entry from `actions[]` translated to XState form.
 */
function collectTransitionActions(
  t: AgentTransitionDefinition,
  defaultContextAction: string,
): readonly XStateActionEntry[] {
  const entries: XStateActionEntry[] = [defaultContextAction];
  for (const action of t.actions ?? []) {
    entries.push(compileAction(action));
  }
  return entries;
}

// Adding a new variant to WorkflowTransitionAction will make
// `action.stateIds` a compile error, forcing a switch here.
function compileAction(action: WorkflowTransitionAction): XStateActionEntry {
  return { type: 'resetVisitCounts', params: { stateIds: action.stateIds } };
}

// Shared onDone-transition builder for agent and deterministic states: both map a
// `when:` clause to the __matchesWhen guard, else a bare `guard:`, and run a
// per-state-type context-update action. Only the update action differs.
function buildOnDoneTransitions(
  transitions: readonly AgentTransitionDefinition[],
  updateAction: string,
  mapTarget: (transition: AgentTransitionDefinition) => string = (transition) => transition.to,
): readonly object[] {
  return transitions.map((t) => {
    let guard: string | { type: string; params: { when: Readonly<Record<string, WhenValue>> } } | undefined;
    if (t.when) {
      guard = { type: '__matchesWhen', params: { when: t.when } };
    } else if (t.guard) {
      guard = t.guard;
    }

    return {
      target: mapTarget(t),
      ...(guard ? { guard } : {}),
      actions: collectTransitionActions(t, updateAction),
    };
  });
}

interface ExecutableStateBuildOptions {
  readonly mapTransitionTarget?: (transition: AgentTransitionDefinition) => string;
  readonly onErrorTarget?: string;
}

function buildAgentState(
  stateId: string,
  config: AgentStateDefinition,
  definition: WorkflowDefinition,
  options: ExecutableStateBuildOptions = {},
): object {
  return {
    entry: [{ type: 'incrementVisitCount', params: { stateId } }],
    invoke: {
      id: stateId,
      src: 'agentService',
      input: ({ context }: { context: WorkflowContext }) => ({
        stateId,
        stateConfig: config,
        context,
      }),
      onDone: buildOnDoneTransitions(config.transitions, 'updateContextFromAgentResult', options.mapTransitionTarget),
      onError: {
        target: options.onErrorTarget ?? findErrorTarget(config, definition),
        actions: ['storeError', 'updateContextFromAgentInvocationError'],
      },
    },
  };
}

function buildDeterministicState(
  stateId: string,
  config: DeterministicStateDefinition,
  definition: WorkflowDefinition,
  options: ExecutableStateBuildOptions = {},
): object {
  const onDoneTransitions = buildOnDoneTransitions(
    config.transitions,
    'updateContextFromDeterministicResult',
    options.mapTransitionTarget,
  );

  return {
    invoke: {
      id: stateId,
      src: 'deterministicService',
      input: ({ context }: { context: WorkflowContext }) => ({
        stateId,
        commands: config.run.map((command) => templateLaneCommand(command, context)),
        context,
        container: config.container ?? false,
        containerScope: config.containerScope,
        timeoutMs: config.timeoutMs,
        resultFile: config.resultFile ? laneScopeEvolveCurrentPath(config.resultFile, context) : undefined,
      }),
      onDone: onDoneTransitions,
      onError: {
        target: options.onErrorTarget ?? findErrorTarget(config, definition),
        actions: ['storeError'],
      },
    },
  };
}

/**
 * Builds the parent `workers` state: a single XState invoke of `fanOutService`
 * (the orchestrator's `runFanOutSegment`). From the parent FSM's vantage the
 * whole batch is ONE invoke — the N child round actors live inside the invoke
 * body, not in the parent's state value, so the parent's `snapshot.value` stays
 * the string `"workers"` (single-active-state spine, §6.4). `onDone` runs
 * `updateContextFromFanOutResult` (promote the joined context) then follows the
 * verdict-matched edge; `onError` routes to the definition's error target.
 */
function buildFanOutState(stateId: string, config: ExecutableStateDefinition, definition: WorkflowDefinition): object {
  return {
    invoke: {
      id: stateId,
      src: 'fanOutService',
      input: ({ context }: { context: WorkflowContext }) => ({
        stateId,
        stateConfig: config,
        context,
      }),
      onDone: buildOnDoneTransitions(config.transitions, 'updateContextFromFanOutResult'),
      onError: {
        target: findErrorTarget(config, definition),
        actions: ['storeError'],
      },
    },
  };
}

function buildHumanGateState(_stateId: string, config: HumanGateStateDefinition): object {
  const on: Record<string, object> = {};

  for (const t of config.transitions) {
    const eventName = `HUMAN_${t.event}`;
    // Order: the hardcoded gate actions (storeHumanPrompt, clearError) run
    // first so they set up context (prompt, error state) before any
    // user-declared actions observe or modify it. User-declared actions
    // (e.g., resetVisitCounts) run afterward.
    const actions: XStateActionEntry[] = ['storeHumanPrompt', 'clearError'];
    for (const action of t.actions ?? []) {
      actions.push(compileAction(action));
    }
    on[eventName] = {
      target: t.to,
      actions,
    };
  }

  return { on };
}

/** The three synthetic terminal state names every child round machine carries. */
const ROUND_CHILD_RECORDED = 'recorded';
const ROUND_CHILD_BLOCKED = 'blocked';
const ROUND_CHILD_ERRORED = 'errored';

/**
 * Factors a fan-out segment (the round sub-chain
 * `sample -> researcher -> evaluate -> analysis_record`) into a standalone
 * child machine definition. Each member is copied verbatim except for two
 * rewrites: its out-of-segment transition targets are remapped to one of
 * three synthetic terminals via {@link mapRoundChildTarget}, and the
 * `fanOut`/`segment` markers are stripped so the recursive
 * `buildWorkflowMachine` does not try to re-factor the member into yet
 * another child.
 *
 * The three synthetic terminals (`recorded`, `blocked`, `errored`) are the
 * lane verdict surface — every lane finishes in exactly one, and the parent
 * barrier reads it to decide the batch verdict (§6.1). `initial: segment[0]`
 * starts the child at the first segment member. `settings` are inherited from
 * the parent so the child's per-lane `maxVisits` guard fires natively from the
 * member's own declared limits (§6.1).
 */
function buildRoundChildDefinition(
  definition: WorkflowDefinition,
  fanOutStateId: string,
  segment: readonly string[],
): WorkflowDefinition {
  const segmentSet = new Set(segment);
  const states: Record<string, WorkflowStateDefinition> = {};

  for (const memberId of segment) {
    const member = definition.states[memberId];
    if (member.type !== 'agent' && member.type !== 'deterministic') {
      throw new Error(`fan-out state "${fanOutStateId}" segment member "${memberId}" is not executable`);
    }

    const transitions = member.transitions.map((transition) => ({
      ...transition,
      to: mapRoundChildTarget(definition, transition, segmentSet),
    }));

    // The agent and deterministic arms produce byte-identical state objects
    // (strip the fan-out markers, override transitions); the only difference
    // is the discriminated-union narrowing of `member`, so one block covers
    // both once the `type` guard above has run. `_fanOut`/`_segment` are
    // destructured only to omit them from `rest`; `void` marks them used.
    const { fanOut: _fanOut, segment: _segment, ...rest } = member;
    void _fanOut;
    void _segment;
    states[memberId] = { ...rest, transitions };
  }

  states[ROUND_CHILD_RECORDED] = {
    type: 'terminal',
    description: `Fan-out segment "${fanOutStateId}" recorded successfully.`,
  };
  states[ROUND_CHILD_BLOCKED] = {
    type: 'terminal',
    description: `Fan-out segment "${fanOutStateId}" needs human review.`,
  };
  states[ROUND_CHILD_ERRORED] = {
    type: 'terminal',
    description: `Fan-out segment "${fanOutStateId}" failed.`,
  };

  return {
    name: `${definition.name}-${fanOutStateId}-round`,
    description: `Child round machine for ${definition.name}.${fanOutStateId}`,
    initial: segment[0],
    settings: definition.settings,
    states,
  };
}

/**
 * Maps a segment member's transition target onto a child round-machine
 * target. In-segment edges pass through unchanged; everything that would
 * leave the segment is collapsed onto one of the three synthetic terminals.
 *
 * The mapping table:
 *   - target is another segment member  -> passthrough (the target name)
 *   - `when.verdict === 'recorded'`      -> `recorded`  (round committed a node)
 *   - `when.verdict === 'evaluator_blocked'` -> `blocked` (needs human review)
 *   - any other named verdict            -> `errored`   (unexpected verdict)
 *   - target is a human_gate state       -> `blocked`   (escalation edge)
 *   - else (bare fallthrough / failed)   -> `errored`
 */
function mapRoundChildTarget(
  definition: WorkflowDefinition,
  transition: AgentTransitionDefinition,
  segment: ReadonlySet<string>,
): string {
  if (segment.has(transition.to)) return transition.to;

  const verdict = transition.when?.verdict;
  if (verdict === 'recorded') return ROUND_CHILD_RECORDED;
  if (verdict === 'evaluator_blocked') return ROUND_CHILD_BLOCKED;
  if (typeof verdict === 'string') return ROUND_CHILD_ERRORED;

  const targetState = definition.states[transition.to];
  if (targetState.type === 'human_gate') return ROUND_CHILD_BLOCKED;
  return ROUND_CHILD_ERRORED;
}

// ---------------------------------------------------------------------------
// Machine builder
// ---------------------------------------------------------------------------

interface BuildWorkflowMachineOptions {
  readonly contextFromInput?: boolean;
  readonly buildRoundMachines?: boolean;
  /**
   * When set, every executable state's `onError` routes here instead of the
   * `findErrorTarget` heuristic. Used by the child round-machine build: a
   * child definition has no gate / `failed` / `aborted` terminal, so
   * `findErrorTarget` would fall through to the first synthetic terminal
   * (`recorded`) and silently treat a crashed lane as a recorded round.
   * Forcing `onErrorTarget: 'errored'` makes a service rejection land in the
   * `errored` lane-verdict terminal, where the barrier maps it to a fail.
   */
  readonly onErrorTarget?: string;
}

/**
 * Builds an XState v5 machine from a validated WorkflowDefinition.
 *
 * The returned machine has placeholder actors (`agentService`,
 * `deterministicService`) that throw if invoked directly. Callers
 * must call `.provide({ actors: { ... } })` to inject real
 * implementations before passing to `createActor()`.
 *
 * Guards are registered with concrete implementations from the guards
 * module. Actions for context updates are defined inline via `assign`.
 */
export function buildWorkflowMachine(
  definition: WorkflowDefinition,
  taskDescription: string,
  options: BuildWorkflowMachineOptions = {},
): BuildMachineResult {
  const states: Record<string, object> = {};
  const roundMachinesByState = new Map<string, AnyStateMachine>();
  const gateStateNames = new Set<string>();
  const terminalStateNames = new Set<string>();

  // Per-state maxVisits map, built at machine-construction time and
  // closed over by the `isStateVisitLimitReached` guard below. Only
  // agent states can declare `maxVisits`; states without it are absent
  // from the map and the guard returns false for them.
  const maxVisitsByState = new Map<string, number>();

  // For child round machines, every executable member's error path is forced
  // to the synthetic `errored` terminal (see `onErrorTarget` doc above); the
  // parent machine leaves it undefined and falls back to `findErrorTarget`.
  const executableOptions: ExecutableStateBuildOptions = { onErrorTarget: options.onErrorTarget };

  for (const [stateId, stateDef] of Object.entries(definition.states)) {
    switch (stateDef.type) {
      case 'agent':
        states[stateId] =
          stateDef.fanOut !== undefined
            ? buildFanOutState(stateId, stateDef, definition)
            : buildAgentState(stateId, stateDef, definition, executableOptions);
        if (typeof stateDef.maxVisits === 'number') {
          maxVisitsByState.set(stateId, stateDef.maxVisits);
        }
        break;
      case 'deterministic':
        states[stateId] =
          stateDef.fanOut !== undefined
            ? buildFanOutState(stateId, stateDef, definition)
            : buildDeterministicState(stateId, stateDef, definition, executableOptions);
        break;
      case 'human_gate':
        states[stateId] = buildHumanGateState(stateId, stateDef);
        gateStateNames.add(stateId);
        break;
      case 'terminal':
        states[stateId] = { type: 'final' as const };
        terminalStateNames.add(stateId);
        break;
    }
  }

  if (options.buildRoundMachines !== false) {
    for (const [stateId, stateDef] of Object.entries(definition.states)) {
      if ((stateDef.type !== 'agent' && stateDef.type !== 'deterministic') || stateDef.fanOut === undefined) {
        continue;
      }
      const segment = stateDef.segment ?? [];
      if (segment.length === 0) continue;
      const childDefinition = buildRoundChildDefinition(definition, stateId, segment);
      const child = buildWorkflowMachine(childDefinition, taskDescription, {
        contextFromInput: true,
        buildRoundMachines: false,
        // A segment member's service rejection must land in the child's
        // `errored` terminal, not fall through `findErrorTarget` to the
        // first terminal (`recorded`). See `onErrorTarget` above.
        onErrorTarget: ROUND_CHILD_ERRORED,
      });
      roundMachinesByState.set(stateId, child.machine);
    }
  }

  // Build XState guard implementations compatible with XState's guard API.
  // XState v5 guards receive ({ context, event }) but the event type
  // during onDone is the xstate done event, not our WorkflowEvent.
  // We need to adapt our guards to work with the done event's output.
  // The second `params` argument is used by parameterized guards like __matchesWhen.
  const xstateGuards: Record<
    string,
    (args: { context: WorkflowContext; event: unknown }, params?: unknown) => boolean
  > = {};

  for (const [name, guardFn] of Object.entries(guardImplementations)) {
    xstateGuards[name] = ({ context, event }: { context: WorkflowContext; event: unknown }) => {
      // For xstate.done.actor.* events, extract the output and create
      // a synthetic WorkflowEvent for the guard
      const doneEvent = event as { type: string; output?: unknown };
      let workflowEvent: WorkflowEvent;

      if (doneEvent.type.startsWith('xstate.done.actor.')) {
        const result = extractInvokeResult(doneEvent as { output?: unknown });
        if (result) {
          // Special case: isStalled needs access to outputHash and stateId
          // which are not part of AgentOutput/WorkflowEvent.
          if (name === 'isStalled') {
            const stateId = doneEvent.type.replace('xstate.done.actor.', '');
            const prevHash = context.previousOutputHashes[stateId];
            return !!prevHash && result.outputHash === prevHash;
          }
          // Special case: isStateVisitLimitReached consults the per-state
          // maxVisits map (closed over from the definition) and compares it
          // to the visit count for the state that just completed.
          if (name === 'isStateVisitLimitReached') {
            const stateId = doneEvent.type.replace('xstate.done.actor.', '');
            const cap = maxVisitsByState.get(stateId);
            if (cap === undefined) return false;
            const visits = context.visitCounts[stateId] ?? 0;
            return visits >= cap;
          }
          // Agent service result -> AGENT_COMPLETED event
          workflowEvent = { type: 'AGENT_COMPLETED', output: result.output };
        } else {
          // Deterministic service result -> map to VALIDATION_PASSED/FAILED
          const detResult = doneEvent.output as DeterministicInvokeResult | undefined;
          if (detResult?.passed) {
            workflowEvent = { type: 'VALIDATION_PASSED', testCount: detResult.testCount ?? 0 };
          } else {
            workflowEvent = { type: 'VALIDATION_FAILED', errors: detResult?.errors ?? 'unknown' };
          }
        }
      } else {
        // For human gate events, pass through directly
        workflowEvent = event as WorkflowEvent;
      }

      return guardFn({ context, event: workflowEvent });
    };
  }

  // Register the __matchesWhen parameterized guard. This intentionally
  // bypasses the guard adapter loop above because it operates on AgentOutput
  // directly (via extractInvokeResult inline) rather than on WorkflowEvent.
  xstateGuards['__matchesWhen'] = ({ event }, params) => {
    const doneEvent = event as { type: string; output?: unknown };
    let matchSource: Readonly<Record<string, unknown>> | undefined;

    if (doneEvent.type.startsWith('xstate.done.actor.')) {
      const result = extractInvokeResult(doneEvent as { output?: unknown });
      if (result) {
        matchSource = result.output as unknown as Readonly<Record<string, unknown>>;
      } else {
        const detResult = doneEvent.output as DeterministicInvokeResult | undefined;
        if (typeof detResult?.verdict === 'string') {
          matchSource = { verdict: detResult.verdict };
        }
      }
    }

    if (!matchSource) return false;

    // Defensive: fail closed if params are missing or when is empty/missing.
    // Validation prevents these cases, but we don't want a silent unconditional
    // match if validation is bypassed.
    if (!params || typeof params !== 'object') return false;
    const whenMap = (params as { when?: unknown }).when;
    if (!whenMap || typeof whenMap !== 'object' || Object.keys(whenMap).length === 0) {
      return false;
    }
    const when = whenMap as Readonly<Record<string, WhenValue>>;

    for (const [key, expected] of Object.entries(when)) {
      const actual = matchSource[key];
      if (actual !== expected) return false;
    }
    return true;
  };

  const machine = setup({
    types: {
      context: {} as WorkflowContext,
      events: {} as WorkflowEvent,
      input: {} as { context?: WorkflowContext } | undefined,
    },
    actors: {
      agentService: fromPromise<AgentInvokeResult, AgentInvokeInput>(() => {
        return Promise.reject(new Error('agentService must be provided via machine.provide()'));
      }),
      deterministicService: fromPromise<DeterministicInvokeResult, DeterministicInvokeInput>(() => {
        return Promise.reject(new Error('deterministicService must be provided via machine.provide()'));
      }),
      fanOutService: fromPromise<FanOutInvokeResult, FanOutInvokeInput>(() => {
        return Promise.reject(new Error('fanOutService must be provided via machine.provide()'));
      }),
    },
    guards: xstateGuards,
    actions: {
      updateContextFromAgentResult: assign(({ context, event }) => {
        const doneEvent = event as unknown as { output?: unknown };
        const result = extractInvokeResult(doneEvent);
        if (!result) return {};

        const output = result.output;
        // Derive stateId from the event type: xstate.done.actor.<stateId>
        const stateId = (event as unknown as { type: string }).type.replace('xstate.done.actor.', '');

        return {
          artifacts: { ...context.artifacts, ...result.artifacts },
          previousOutputHashes: {
            ...context.previousOutputHashes,
            [stateId]: result.outputHash,
          },
          round: context.round + 1,
          reviewHistory:
            output.verdict === 'rejected' ? [...context.reviewHistory, output.notes ?? ''] : context.reviewHistory,
          agentConversationsByState: {
            ...context.agentConversationsByState,
            [stateId]: result.agentConversationId,
          },
          // Sourced from `instance.outputTokens` in the orchestrator,
          // which subscribes to the token-stream bus and accumulates
          // `message_end.outputTokens` across every session this workflow
          // has spawned. The orchestrator always supplies a numeric
          // cumulative value — the field is required on AgentInvokeResult.
          totalTokens: result.totalTokens,
          previousAgentOutput: truncateAgentOutput(stripStatusBlock(result.responseText)),
          previousAgentNotes: output.notes ? truncateAgentOutput(output.notes) : null,
          previousStateName: stateId,
          humanPrompt: null,
        };
      }),
      updateContextFromDeterministicResult: assign(({ context, event }) => {
        const doneEvent = event as unknown as { output?: DeterministicInvokeResult };
        const result = doneEvent.output;
        if (!result) return {};

        // Only attach lastDeterministicResult when the state actually produced a
        // verdict/payload (a result-file state). Guard-only deterministic states
        // leave context byte-identical to the legacy path (the field stays absent).
        const verdictUpdate =
          result.verdict !== undefined || result.payload !== undefined
            ? {
                lastDeterministicResult: {
                  ...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
                  ...(result.payload !== undefined ? { payload: result.payload } : {}),
                },
              }
            : {};
        const baseUpdate = {
          previousTestCount: result.testCount ?? context.previousTestCount,
          ...verdictUpdate,
        };
        if (result.passed) return baseUpdate;

        // Set previousStateName to the deterministic state's id (not the prior agent)
        // so prompt-builder's cross-state framing (buildScopingSection) renders the
        // failure as "Output from <det-state>" for the next agent.
        const stateId = (event as unknown as { type: string }).type.replace('xstate.done.actor.', '');
        return {
          ...baseUpdate,
          previousAgentOutput: truncateAgentOutput(result.errors ?? ''),
          previousAgentNotes: null,
          previousStateName: stateId,
        };
      }),
      // Promotes the batch's joined context onto the parent FSM after a
      // fan-out invoke resolves (the parent was frozen at `workers` for the
      // whole batch — see runFanOutSegment). The result already carries the
      // chosen lane's full WorkflowContext, so this replaces context wholesale.
      // `if (!result) return {}` keeps the existing context unchanged when the
      // invoke produced no output — never blanks the parent context on a
      // malformed/empty result.
      updateContextFromFanOutResult: assign(({ event }) => {
        const doneEvent = event as unknown as { output?: FanOutInvokeResult };
        const result = doneEvent.output;
        if (!result) return {};
        return result.context;
      }),
      storeHumanPrompt: assign(({ event }) => ({
        humanPrompt: (event as { prompt?: string }).prompt ?? null,
      })),
      clearError: assign(() => ({
        lastError: null,
      })),
      storeError: assign(({ event }) => {
        const errorEvent = event as { error?: unknown };
        const err = errorEvent.error;
        let message: string;
        if (err instanceof Error) {
          message = err.message;
        } else if (typeof err === 'object' && err !== null && 'message' in err) {
          message = String((err as { message: unknown }).message);
        } else if (typeof err === 'string') {
          message = err;
        } else {
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          message = err != null ? String(err) : 'Unknown error';
        }
        // Write directly to stderr to bypass any console hijacking
        // (logger.setup() redirects console.error to a log file).
        process.stderr.write(`[workflow] storeError action: ${message}\n`);
        return { lastError: message };
      }),
      /**
       * Mirrors `updateContextFromAgentResult` for the error path: when
       * the agent service rejects, recover the `agentConversationId` that
       * was minted for the invocation (wrapped in `AgentInvocationError`)
       * and persist it into `context.agentConversationsByState[stateId]`.
       *
       * Without this, `onError` drops the conversation id on the floor —
       * `onDone` stamps the id into context, but `onError` used to record
       * only `lastError`, which silently broke `freshSession: false`
       * resume on the next visit to an errored state.
       */
      updateContextFromAgentInvocationError: assign(({ context, event }) => {
        const errorEvent = event as { error?: unknown };
        const err = errorEvent.error;
        if (!isAgentInvocationError(err)) return {};
        return {
          agentConversationsByState: {
            ...context.agentConversationsByState,
            [err.stateId]: err.agentConversationId,
          },
        };
      }),
      incrementVisitCount: assign(({ context }, params: { stateId: string }) => ({
        visitCounts: {
          ...context.visitCounts,
          [params.stateId]: (context.visitCounts[params.stateId] ?? 0) + 1,
        },
      })),
      resetVisitCounts: assign(({ context }, params: { stateIds: readonly string[] }) => {
        // Clear only the named keys; leave all other visit counts intact.
        // Used on transitions that re-enter a bounded loop (e.g., when the
        // orchestrator sends a fresh hypothesis) to reset the cap without
        // losing counts for unrelated states.
        const next: Record<string, number> = { ...context.visitCounts };
        for (const stateId of params.stateIds) {
          next[stateId] = 0;
        }
        return { visitCounts: next };
      }),
    },
  }).createMachine({
    id: definition.name,
    initial: definition.initial,
    context: ({ input }: { input?: { context?: WorkflowContext } }): WorkflowContext => {
      if (options.contextFromInput) {
        if (!input?.context) {
          throw new Error(`machine "${definition.name}" requires input.context`);
        }
        return input.context;
      }
      return {
        ...createInitialContext(definition),
        taskDescription,
      };
    },
    states,
  });

  return {
    machine,
    roundMachinesByState,
    gateStateNames,
    terminalStateNames,
  };
}
