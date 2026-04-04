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
} from './types.js';
import { guardImplementations } from './guards.js';
import { validateDefinition } from './validate.js';

// ---------------------------------------------------------------------------
// Invoke input/result types
// ---------------------------------------------------------------------------

/** Input provided to each invoked agent service. */
export interface AgentInvokeInput {
  readonly stateId: string;
  readonly stateConfig: AgentStateDefinition;
  readonly context: WorkflowContext;
}

/** Result returned by an agent service promise. */
export interface AgentInvokeResult {
  readonly output: AgentOutput;
  readonly sessionId: string;
  readonly artifacts: Record<string, string>;
  /** SHA-256 of output artifacts, computed by the orchestrator. */
  readonly outputHash: string;
  /** Raw response text from session.sendMessage(). */
  readonly responseText: string;
}

/** Input provided to each invoked deterministic service. */
export interface DeterministicInvokeInput {
  readonly stateId: string;
  readonly commands: readonly (readonly string[])[];
  readonly context: WorkflowContext;
}

/** Result from a deterministic (test/lint) state. */
export interface DeterministicInvokeResult {
  readonly passed: boolean;
  readonly testCount?: number;
  readonly errors?: string;
}

// ---------------------------------------------------------------------------
// Build result
// ---------------------------------------------------------------------------

export interface BuildMachineResult {
  /** The XState machine (with placeholder actors). */
  readonly machine: AnyStateMachine;
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
 * Truncates agent response text to stay within the 32KB limit.
 * Exported for testing.
 */
export function truncateAgentOutput(text: string): string {
  if (Buffer.byteLength(text, 'utf-8') <= MAX_AGENT_OUTPUT_BYTES) {
    return text;
  }
  const budget = MAX_AGENT_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE, 'utf-8');
  let truncated = text;
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
    parallelResults: {},
    worktreeBranches: [],
    totalTokens: 0,
    flaggedForReview: false,
    lastError: null,
    sessionsByRole: {},
    previousAgentOutput: null,
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

  // Fall back to any terminal state
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

function buildAgentOnDoneTransitions(transitions: readonly AgentTransitionDefinition[]): readonly object[] {
  return transitions.map((t) => ({
    target: t.to,
    ...(t.guard ? { guard: t.guard } : {}),
    actions: ['updateContextFromAgentResult', ...(t.flag ? [{ type: 'setFlag', params: { flag: t.flag } }] : [])],
  }));
}

function buildAgentState(stateId: string, config: AgentStateDefinition, definition: WorkflowDefinition): object {
  return {
    invoke: {
      id: stateId,
      src: 'agentService',
      input: ({ context }: { context: WorkflowContext }) => ({
        stateId,
        stateConfig: config,
        context,
      }),
      onDone: buildAgentOnDoneTransitions(config.transitions),
      onError: {
        target: findErrorTarget(config, definition),
        actions: ['storeError'],
      },
    },
  };
}

function buildDeterministicState(
  stateId: string,
  config: DeterministicStateDefinition,
  definition: WorkflowDefinition,
): object {
  const onDoneTransitions = config.transitions.map((t) => ({
    target: t.to,
    ...(t.guard ? { guard: t.guard } : {}),
    actions: [
      'updateContextFromDeterministicResult',
      ...(t.flag ? [{ type: 'setFlag', params: { flag: t.flag } }] : []),
    ],
  }));

  return {
    invoke: {
      id: stateId,
      src: 'deterministicService',
      input: ({ context }: { context: WorkflowContext }) => ({
        stateId,
        commands: config.run,
        context,
      }),
      onDone: onDoneTransitions,
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
    on[eventName] = {
      target: t.to,
      actions: ['storeHumanPrompt', 'clearError'],
    };
  }

  return { on };
}

// ---------------------------------------------------------------------------
// Machine builder
// ---------------------------------------------------------------------------

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
export function buildWorkflowMachine(definition: WorkflowDefinition, taskDescription: string): BuildMachineResult {
  // Validate before building
  validateDefinition(definition);

  const states: Record<string, object> = {};
  const gateStateNames = new Set<string>();
  const terminalStateNames = new Set<string>();

  for (const [stateId, stateDef] of Object.entries(definition.states)) {
    switch (stateDef.type) {
      case 'agent':
        states[stateId] = buildAgentState(stateId, stateDef, definition);
        break;
      case 'deterministic':
        states[stateId] = buildDeterministicState(stateId, stateDef, definition);
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

  // Build XState guard implementations compatible with XState's guard API.
  // XState v5 guards receive ({ context, event }) but the event type
  // during onDone is the xstate done event, not our WorkflowEvent.
  // We need to adapt our guards to work with the done event's output.
  const xstateGuards: Record<string, (params: { context: WorkflowContext; event: unknown }) => boolean> = {};

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

  const machine = setup({
    types: {
      context: {} as WorkflowContext,
      events: {} as WorkflowEvent,
    },
    actors: {
      agentService: fromPromise<AgentInvokeResult, AgentInvokeInput>(() => {
        return Promise.reject(new Error('agentService must be provided via machine.provide()'));
      }),
      deterministicService: fromPromise<DeterministicInvokeResult, DeterministicInvokeInput>(() => {
        return Promise.reject(new Error('deterministicService must be provided via machine.provide()'));
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
          previousTestCount: output.testCount ?? context.previousTestCount,
          round: context.round + 1,
          flaggedForReview: context.flaggedForReview || (output.verdict === 'approved' && output.confidence === 'low'),
          reviewHistory:
            output.verdict === 'rejected' ? [...context.reviewHistory, output.notes ?? ''] : context.reviewHistory,
          sessionsByRole: {
            ...context.sessionsByRole,
            [stateId]: result.sessionId,
          },
          totalTokens: context.totalTokens,
          previousAgentOutput: truncateAgentOutput(result.responseText),
          previousStateName: stateId,
          visitCounts: {
            ...context.visitCounts,
            [stateId]: (context.visitCounts[stateId] ?? 0) + 1,
          },
          humanPrompt: null,
        };
      }),
      updateContextFromDeterministicResult: assign(({ context, event }) => {
        const doneEvent = event as unknown as { output?: DeterministicInvokeResult };
        const result = doneEvent.output;
        if (!result) return {};

        return {
          previousTestCount: result.testCount ?? context.previousTestCount,
        };
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
      setFlag: assign(() => ({
        flaggedForReview: true,
      })),
    },
  }).createMachine({
    id: definition.name,
    initial: definition.initial,
    context: (): WorkflowContext => ({
      ...createInitialContext(definition),
      taskDescription,
    }),
    states,
  });

  return {
    machine,
    gateStateNames,
    terminalStateNames,
  };
}
