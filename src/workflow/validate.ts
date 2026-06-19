import { posix as pathPosix, resolve } from 'node:path';
import { z } from 'zod';
import { validateSkillName } from '../skills/staging.js';
import { discoverSkills } from '../skills/discovery.js';
import { errorMessage } from '../utils/error-message.js';
import type {
  WorkflowDefinition,
  WorkflowStateDefinition,
  HumanGateStateDefinition,
  AgentOutput,
  AgentTransitionDefinition,
  HumanGateTransitionDefinition,
} from './types.js';
import { AGENT_OUTPUT_FIELDS, CONFIDENCE_VALUES, SKILLS_NONE } from './types.js';
import { REGISTERED_GUARDS } from './guards.js';
import { looseModelId } from '../config/user-config.js';
import { isPlainObject } from '../utils/is-plain-object.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const whenValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// See WorkflowTransitionAction in types.ts for the scaffold rationale.
const transitionActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('resetVisitCounts'),
    stateIds: z.array(z.string()).min(1),
  }),
]);

const agentTransitionSchema = z.object({
  to: z.string(),
  guard: z.string().optional(),
  when: z.record(z.string(), whenValueSchema).optional(),
  actions: z.array(transitionActionSchema).optional(),
});

const humanGateTransitionSchema = z.object({
  to: z.string(),
  event: z.enum(['APPROVE', 'FORCE_REVISION', 'REPLAN', 'ABORT']),
  actions: z.array(transitionActionSchema).optional(),
});

/**
 * Charset for `containerScope` values. Path-safe identifier shape —
 * scope strings never appear in filesystem paths today, but keeping the
 * charset narrow rules out accidental injection into Docker labels,
 * diagnostics, or future path composition.
 */
const CONTAINER_SCOPE_PATTERN = /^[a-zA-Z0-9_-]+$/;

const fanOutSchema = z.object({
  count: z.union([z.literal('workers'), z.number().int().positive()]),
  // Literal, not z.string(): only barrier joins are supported, and the
  // literal makes a non-barrier join a parse-time rejection (matching the
  // FanOutDefinition.join type). Async joins are a future, reviewed extension.
  join: z.literal('barrier'),
});

const laneResourceRequestSchema = z.object({
  cpu: z.number().positive().optional(),
  mem: z.string().min(1).optional(),
  gpu: z.number().int().min(0).optional(),
});

const scheduleSchema = z.object({
  pool: z.enum(['eval', 'agent']),
  resources: laneResourceRequestSchema.optional(),
});

const agentStateSchema = z.object({
  type: z.literal('agent'),
  description: z.string().min(1),
  persona: z.string(),
  prompt: z.string().min(1),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  transitions: z.array(agentTransitionSchema).min(1),
  worktree: z.boolean().optional(),
  fanOutMember: z.boolean().optional(),
  fanOut: fanOutSchema.optional(),
  segment: z.array(z.string()).min(1).optional(),
  schedule: scheduleSchema.optional(),
  freshSession: z.boolean().optional(),
  model: looseModelId.optional(),
  maxVisits: z.number().int().positive().optional(),
  containerScope: z.string().regex(CONTAINER_SCOPE_PATTERN).optional(),
  skills: z.union([z.array(z.string()), z.literal(SKILLS_NONE)]).optional(),
});

const humanGateStateSchema = z.object({
  type: z.literal('human_gate'),
  description: z.string().min(1),
  acceptedEvents: z.array(z.enum(['APPROVE', 'FORCE_REVISION', 'REPLAN', 'ABORT'])),
  present: z.array(z.string()).optional(),
  transitions: z.array(humanGateTransitionSchema),
});

const deterministicStateSchema = z.object({
  type: z.literal('deterministic'),
  description: z.string().min(1),
  run: z.array(z.array(z.string())),
  container: z.boolean().optional(),
  containerScope: z.string().regex(CONTAINER_SCOPE_PATTERN).optional(),
  timeoutMs: z.number().int().positive().optional(),
  resultFile: z.string().min(1).optional(),
  fanOut: fanOutSchema.optional(),
  segment: z.array(z.string()).min(1).optional(),
  fanOutMember: z.boolean().optional(),
  schedule: scheduleSchema.optional(),
  transitions: z.array(agentTransitionSchema).min(1),
});

const terminalStateSchema = z.object({
  type: z.literal('terminal'),
  description: z.string().min(1),
  outputs: z.array(z.string()).optional(),
  cleanup: z.array(z.array(z.string())).optional(),
});

const stateDefinitionSchema = z.discriminatedUnion('type', [
  agentStateSchema,
  humanGateStateSchema,
  deterministicStateSchema,
  terminalStateSchema,
]);

const workflowSettingsSchema = z
  .object({
    mode: z.enum(['docker', 'builtin']).optional(),
    dockerAgent: z.string().optional(),
    maxRounds: z.number().int().positive().optional(),
    gitRepoPath: z.string().optional(),
    workers: z.number().int().positive().optional(),
    systemPrompt: z.string().optional(),
    maxSessionSeconds: z.number().positive().optional(),
    unversionedArtifacts: z.array(z.string()).optional(),
    model: looseModelId.optional(),
    sharedContainer: z.boolean().optional(),
    snapshotOnStop: z.boolean().optional(),
  })
  .optional();

const workflowDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  hidden: z.boolean().optional(),
  initial: z.string(),
  states: z.record(z.string(), stateDefinitionSchema),
  settings: workflowSettingsSchema,
});

// ---------------------------------------------------------------------------
// Raw-input checks (run before Zod so they catch fields Zod would strip)
// ---------------------------------------------------------------------------

/** State IDs must be valid identifiers so they don't collide with XState's
 * dotted-path state-node semantics (e.g., `xstate.done.actor.<stateId>`). */
const STATE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const AGENT_ONLY_STATE_FIELDS = ['maxVisits'] as const;

/**
 * Validates raw-level invariants that would otherwise be lost by Zod's default
 * `strip()` behavior or produce less helpful errors inside a discriminated-union
 * parse failure. Accumulates issues rather than throwing on the first one so
 * users see all problems at once.
 *
 * Note: this runs before Zod parsing, so `raw` is of unknown shape. We only
 * inspect fields we recognize; anything malformed is left for Zod to catch
 * with its own error messages.
 */
function validateRawInput(raw: unknown): string[] {
  const issues: string[] = [];
  if (!isPlainObject(raw)) return issues;
  if (isPlainObject(raw.settings) && 'maxParallelism' in raw.settings) {
    issues.push('settings.maxParallelism is retired; use settings.workers instead.');
  }
  if (!isPlainObject(raw.states)) return issues;

  for (const [stateId, stateValue] of Object.entries(raw.states)) {
    if (!STATE_ID_PATTERN.test(stateId)) {
      issues.push(
        `State ID "${stateId}" is not a valid identifier — must match ${STATE_ID_PATTERN.source} ` +
          `(letters, digits, and underscores only; cannot start with a digit). ` +
          `Dots, spaces, and hyphens can collide with XState's nested-state path semantics.`,
      );
    }

    if (!isPlainObject(stateValue)) continue;
    const stateType = stateValue.type;
    if (typeof stateType !== 'string') continue;

    if ('resultFile' in stateValue && stateType !== 'deterministic') {
      issues.push(
        `State "${stateId}" (type: ${stateType}) has "resultFile" but that field is only valid on deterministic states.`,
      );
    }

    if (stateType === 'agent') continue;

    for (const field of AGENT_ONLY_STATE_FIELDS) {
      if (field in stateValue) {
        issues.push(
          `State "${stateId}" (type: ${stateType}) has "${field}" but that field is only valid on agent states.`,
        );
      }
    }

    if ('containerScope' in stateValue && stateType !== 'deterministic') {
      issues.push(
        `State "${stateId}" (type: ${stateType}) has "containerScope" but that field is only valid on agent states and containerized deterministic states.`,
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

export class WorkflowValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Workflow validation failed:\n  - ${issues.join('\n  - ')}`);
    this.name = 'WorkflowValidationError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Semantic validation
// ---------------------------------------------------------------------------

/**
 * The two state types that run an ordered `transitions` list with
 * agent-style `guard`/`when` routing (agent + deterministic). Human-gate
 * transitions use a different (event-keyed) shape, so they are excluded.
 */
export type ExecutableState = Extract<WorkflowStateDefinition, { readonly type: 'agent' | 'deterministic' }>;

/**
 * True for {@link ExecutableState}s. Narrows the union so call sites can
 * read `state.transitions` / `state.segment` without re-spelling the
 * `Extract<...>` longhand.
 */
export function isExecutableState(state: WorkflowStateDefinition): state is ExecutableState {
  return state.type === 'agent' || state.type === 'deterministic';
}

export function collectTransitionTargets(state: WorkflowStateDefinition): string[] {
  switch (state.type) {
    case 'agent':
    case 'deterministic':
      return state.transitions.map((t) => t.to);
    case 'human_gate':
      return state.transitions.map((t) => t.to);
    case 'terminal':
      return [];
  }
}

/**
 * True if any transition routes on a `when: { verdict: ... }` clause. Shared by
 * the container-only validation rule (`validateContainerScopes`) and the WF012
 * lint (which requires such states to declare a `resultFile`).
 */
export function usesVerdictEdges(transitions: readonly AgentTransitionDefinition[]): boolean {
  return transitions.some((t) => t.when !== undefined && 'verdict' in t.when);
}

/**
 * Parses a workflow input artifact reference. A trailing `?` marks the
 * input as optional — the consumer may skip it if the artifact isn't
 * produced.
 */
export function parseArtifactRef(ref: string): { readonly name: string; readonly isOptional: boolean } {
  const isOptional = ref.endsWith('?');
  return { name: isOptional ? ref.slice(0, -1) : ref, isOptional };
}

function collectGuardNames(state: WorkflowStateDefinition): string[] {
  if (isExecutableState(state)) {
    return state.transitions.filter((t): t is typeof t & { guard: string } => t.guard != null).map((t) => t.guard);
  }
  return [];
}

export function collectOutputArtifacts(states: Record<string, WorkflowStateDefinition>): Set<string> {
  const outputs = new Set<string>();
  for (const state of Object.values(states)) {
    if (state.type === 'agent' || state.type === 'terminal') {
      for (const o of state.outputs ?? []) {
        outputs.add(o);
      }
    }
  }
  return outputs;
}

export function findReachableStates(initial: string, states: Record<string, WorkflowStateDefinition>): Set<string> {
  const reachable = new Set<string>();
  const queue = [initial];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    if (reachable.has(current)) continue;
    reachable.add(current);
    const state = states[current] as WorkflowStateDefinition | undefined;
    if (!state) continue;
    for (const target of collectTransitionTargets(state)) {
      if (!reachable.has(target)) {
        queue.push(target);
      }
    }
    if (isExecutableState(state) && state.segment !== undefined) {
      for (const target of state.segment) {
        if (!reachable.has(target)) {
          queue.push(target);
        }
      }
    }
  }
  return reachable;
}

const AGENT_OUTPUT_FIELD_SET: ReadonlySet<string> = new Set(AGENT_OUTPUT_FIELDS);
const CONFIDENCE_VALUE_SET: ReadonlySet<string> = new Set(CONFIDENCE_VALUES);

export function isSafeWorkspaceRelativePath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.includes('\0')) return false;
  if (path.startsWith('/')) return false;
  if (path === '.') return false;
  if (path.split('/').some((part) => part === '..')) return false;
  return pathPosix.normalize(path) === path;
}

/**
 * Expected runtime type for each AgentOutput field used in `when` clauses.
 * `expected` is the human-readable error label; `check` is the runtime test.
 */
const WHEN_KEY_TYPES: {
  readonly [K in keyof AgentOutput]: { readonly expected: string; readonly check: (v: unknown) => boolean };
} = {
  completed: { expected: 'boolean', check: (v) => typeof v === 'boolean' },
  verdict: { expected: 'string', check: (v) => typeof v === 'string' },
  confidence: { expected: 'string', check: (v) => typeof v === 'string' },
  escalation: { expected: 'string or null', check: (v) => typeof v === 'string' || v === null },
  testCount: { expected: 'number or null', check: (v) => typeof v === 'number' || v === null },
  notes: { expected: 'string or null', check: (v) => typeof v === 'string' || v === null },
};

function describeRuntimeType(value: unknown): string {
  if (value === null) return 'null';
  return typeof value;
}

/**
 * Returns all transitions on a state that may carry an `actions` array,
 * regardless of transition type. The validator only reads `to` and
 * `actions`, so narrowing the element type to the common fields lets us
 * treat agent, deterministic, and human-gate transitions uniformly.
 */
function collectTransitionsWithActions(
  state: WorkflowStateDefinition,
): readonly (AgentTransitionDefinition | HumanGateTransitionDefinition)[] {
  if (isExecutableState(state)) {
    return state.transitions;
  }
  if (state.type === 'human_gate') {
    return state.transitions;
  }
  return [];
}

function validateTransitionActions(
  stateId: string,
  state: WorkflowStateDefinition,
  stateNames: ReadonlySet<string>,
  issues: string[],
): void {
  // Per-action semantic checks. Today only `resetVisitCounts` needs one
  // (its `stateIds` must reference existing states). When a new action
  // type is added to the discriminated union, TS will flag the accesses
  // below as soon as `action.stateIds` is no longer unconditionally present.
  for (const t of collectTransitionsWithActions(state)) {
    if (!t.actions) continue;
    for (const action of t.actions) {
      for (const targetId of action.stateIds) {
        if (!stateNames.has(targetId)) {
          issues.push(
            `State "${stateId}" transition to "${t.to}" has resetVisitCounts referencing unknown state "${targetId}"`,
          );
        }
      }
    }
  }
}

function validateWhenClauses(stateId: string, state: WorkflowStateDefinition, issues: string[]): void {
  if (state.type === 'terminal' || state.type === 'human_gate') return;

  for (const t of state.transitions) {
    // Mutual exclusivity: guard + when on same transition
    if (t.guard && t.when) {
      issues.push(
        `State "${stateId}" has transition to "${t.to}" with both "guard" and "when" — they are mutually exclusive`,
      );
    }

    if (!t.when) continue;

    // Empty when rejected
    if (Object.keys(t.when).length === 0) {
      issues.push(
        `State "${stateId}" transition to "${t.to}" has empty "when" — use no guard for unconditional transitions`,
      );
    }

    // Only "verdict" is currently supported for when-clause routing.
    // The condensed status instructions only communicate verdict values
    // to agents, so routing on other fields would silently break.
    const nonVerdictKeys = Object.keys(t.when).filter((k) => k !== 'verdict');
    if (nonVerdictKeys.length > 0) {
      for (const k of nonVerdictKeys) {
        issues.push(
          `State "${stateId}" transition to "${t.to}" uses when clause key "${k}" — only "verdict" is currently supported for when-clause routing. Multi-field when conditions are a planned future feature.`,
        );
      }
    }

    // Key and value validation
    for (const [key, value] of Object.entries(t.when)) {
      if (!AGENT_OUTPUT_FIELD_SET.has(key)) {
        issues.push(
          `State "${stateId}" transition to "${t.to}" has "when" key "${key}" — not a valid AgentOutput field`,
        );
        continue;
      }

      // Per-key runtime type check (runs before enum value checks so that a
      // wrong-type value reports "wrong type" instead of "invalid value").
      const typeSpec = WHEN_KEY_TYPES[key as keyof AgentOutput];
      if (!typeSpec.check(value)) {
        issues.push(
          `State "${stateId}" transition to "${t.to}" has 'when' key '${key}' with wrong type: expected ${typeSpec.expected}, got ${describeRuntimeType(value)}`,
        );
        continue;
      }

      // Enum value checks run only when the type is already correct.
      // Verdict accepts any string (custom verdicts for direct routing).
      if (key === 'confidence' && typeof value === 'string' && !CONFIDENCE_VALUE_SET.has(value)) {
        issues.push(`State "${stateId}" transition to "${t.to}" has invalid confidence value "${value}"`);
      }
    }
  }
}

function validateFanOutScaffolding(definition: WorkflowDefinition, issues: string[]): void {
  const workers = definition.settings?.workers ?? 1;
  const stateNames = new Set(Object.keys(definition.states));

  for (const [stateId, state] of Object.entries(definition.states)) {
    if (isExecutableState(state) && state.fanOut !== undefined) {
      validateFanOutState(definition, stateId, state, stateNames, issues);
    }

    if (isExecutableState(state) && state.schedule?.pool === 'eval' && state.fanOutMember !== true) {
      issues.push(`State "${stateId}" declares schedule.pool: eval but is not fanOutMember: true.`);
    }

    if (
      workers > 1 &&
      state.type === 'deterministic' &&
      state.fanOutMember === true &&
      state.resultFile !== undefined &&
      !isLaneScopedResultFile(state.resultFile)
    ) {
      issues.push(
        `State "${stateId}" is a fanOutMember with resultFile "${state.resultFile}" under settings.workers=${workers}; ` +
          `resultFile must be lane-scoped under a lane_\${laneId}/ segment (the pump substitutes lane_<digits> per lane, ` +
          `for example current/lane_\${laneId}/result.json).`,
      );
    }
  }

  if (workers > 1 && workflowDeclaresGreedySampler(definition)) {
    issues.push(
      `settings.workers=${workers} cannot be used with greedy sampling; multi-lane evolve runs must declare a stochastic sampler.`,
    );
  }
}

function validateFanOutState(
  definition: WorkflowDefinition,
  stateId: string,
  state: ExecutableState,
  stateNames: ReadonlySet<string>,
  issues: string[],
): void {
  const segment = state.segment ?? [];
  if (segment.length === 0) {
    issues.push(`State "${stateId}" declares fanOut but has no non-empty segment list.`);
    return;
  }

  for (const memberId of segment) {
    if (!stateNames.has(memberId)) {
      issues.push(`State "${stateId}" fanOut segment references unknown state "${memberId}".`);
      continue;
    }
    const member = definition.states[memberId];
    if (member.type === 'human_gate') {
      issues.push(
        `State "${stateId}" fanOut segment includes human gate "${memberId}", but gates inside a fan-out segment are unreachable; aggregate to a gate outside the segment instead.`,
      );
      continue;
    }
    if ((member.type !== 'agent' && member.type !== 'deterministic') || member.fanOutMember !== true) {
      issues.push(`State "${stateId}" fanOut segment member "${memberId}" must declare fanOutMember: true.`);
    }
  }
}

// Canonical lane-scoped form the pump emits at runtime: a `lane_<digits>`
// path segment (e.g. current/lane_0/result.json). The `${laneId}` form is
// the manifest-author placeholder the pump substitutes per lane. No other
// spellings are accepted — the error message in validateFanOutScaffolding
// advertises exactly these two.
const LANE_SCOPED_RESULT_FILE_RE = /(?:^|\/)lane_(?:\$\{laneId\}|[0-9]+)(?:\/|$)/;

/**
 * Whether a fanOutMember's resultFile is lane-scoped (so concurrent lanes
 * don't clobber a shared file). This checks lane-scoping ONLY — path
 * containment safety (no leading `/`, no `..`) is enforced separately and
 * unconditionally for every deterministic resultFile by
 * `isSafeWorkspaceRelativePath` in `validateContainerScopes`, so there is
 * no need to re-check traversal here.
 */
function isLaneScopedResultFile(resultFile: string): boolean {
  return LANE_SCOPED_RESULT_FILE_RE.test(pathPosix.normalize(resultFile));
}

/**
 * Heuristic detection of a greedy sampler declared anywhere in the manifest.
 * This encodes the inverse of the Python source of truth `STOCHASTIC_SAMPLERS`
 * (`scripts/evolve_result.py`) across the language boundary: greedy is the one
 * non-stochastic sampler, so a `workers>1` run that declares it is rejected.
 *
 * The detection is deliberately fragile: it scrapes manifest prompt/argv text
 * for `--sampling-algorithm greedy`-style flags because the host validator runs
 * at lint time, before any run-spec exists on disk — there is no authoritative
 * `sampling.algorithm` field to read. A future move of the sampler decision into
 * a manifest field would let this be exact; until then this is a best-effort guard.
 */
function workflowDeclaresGreedySampler(definition: WorkflowDefinition): boolean {
  for (const state of Object.values(definition.states)) {
    if (state.type === 'agent' && declaresGreedySamplerText(state.prompt)) {
      return true;
    }
    if (state.type !== 'deterministic') continue;
    for (const argv of state.run) {
      if (declaresGreedySamplerArgv(argv)) return true;
    }
  }
  return false;
}

function declaresGreedySamplerText(text: string): boolean {
  return (
    /--sampling-algorithm(?:=|\s+)["']?greedy\b/i.test(text) ||
    /\bsampling[_\-. ]algorithm\s*[:=]\s*["']?greedy\b/i.test(text)
  );
}

function declaresGreedySamplerArgv(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (/^--sampling-algorithm=greedy$/i.test(arg)) return true;
    if (arg === '--sampling-algorithm' && /^greedy$/i.test(argv[i + 1] ?? '')) return true;
  }
  return false;
}

function validateSemantics(definition: WorkflowDefinition): void {
  const issues: string[] = [];
  const stateNames = new Set(Object.keys(definition.states));

  // Initial state must exist
  if (!stateNames.has(definition.initial)) {
    issues.push(`Initial state "${definition.initial}" does not exist`);
  }

  // At least one terminal state
  const hasTerminal = Object.values(definition.states).some((s) => s.type === 'terminal');
  if (!hasTerminal) {
    issues.push('At least one terminal state is required');
  }

  // Validate each state
  for (const [stateId, state] of Object.entries(definition.states)) {
    // Transition targets must reference existing states
    for (const target of collectTransitionTargets(state)) {
      if (!stateNames.has(target)) {
        issues.push(`State "${stateId}" has transition to unknown state "${target}"`);
      }
    }

    // Guard names must be registered
    for (const guard of collectGuardNames(state)) {
      if (!REGISTERED_GUARDS.has(guard)) {
        issues.push(`State "${stateId}" references unregistered guard "${guard}"`);
      }
    }

    // Transition action validation (currently: resetVisitCounts.stateIds
    // must reference existing states).
    validateTransitionActions(stateId, state, stateNames, issues);

    // When clause validation (mutual exclusivity, agent-only, keys, values, empty)
    validateWhenClauses(stateId, state, issues);

    // Human gate-specific checks
    if (state.type === 'human_gate') {
      validateHumanGate(stateId, state, issues);
    }
  }

  // Unreachable states
  const reachable = findReachableStates(definition.initial, definition.states);
  for (const stateId of stateNames) {
    if (!reachable.has(stateId)) {
      issues.push(`State "${stateId}" is unreachable from initial state`);
    }
  }

  // Artifact input references
  validateArtifactInputs(definition, issues);

  // containerScope usage: gated on sharedContainer + charset.
  validateContainerScopes(definition, issues);

  // Fan-out scaffold usage: schema-only fields are parsed now so later phases
  // can consume them without silent stripping.
  validateFanOutScaffolding(definition, issues);

  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }
}

/**
 * Validates `containerScope` usage across a workflow definition.
 *
 * `containerScope` is meaningful only when a shared container is
 * actually active — i.e. `sharedContainer: true` AND `mode: docker`.
 * Builtin mode ignores `sharedContainer` (see the orchestrator's
 * `shouldUseSharedContainer`), so a scope declared under
 * `mode: builtin` is a silent no-op. Either condition missing is a
 * hard error (silent no-ops are footguns). For deterministic states
 * this is reached transitively (`containerScope` requires
 * `container: true`, which requires `mode: docker`); agent states are
 * checked directly. The charset check runs at the Zod layer (see
 * `CONTAINER_SCOPE_PATTERN`).
 *
 * Note: scope governs container lifecycle (which bundle a state runs
 * in); persona governs the active policy. They are orthogonal —
 * `cyclePolicy` hot-swaps the coordinator's active policy on each
 * agent-state entry, so states sharing a scope may use different
 * personas without issue.
 */
function validateContainerScopes(definition: WorkflowDefinition, issues: string[]): void {
  const sharedContainer = definition.settings?.sharedContainer === true;
  const mode = definition.settings?.mode ?? 'docker';

  for (const [stateId, state] of Object.entries(definition.states)) {
    if (state.type === 'agent') {
      if (state.containerScope !== undefined && !sharedContainer) {
        issues.push(
          `State "${stateId}" declares containerScope "${state.containerScope}" but the workflow does not have sharedContainer: true. ` +
            `containerScope is only valid when sharedContainer is true.`,
        );
      }
      if (state.containerScope !== undefined && mode !== 'docker') {
        issues.push(
          `State "${stateId}" declares containerScope "${state.containerScope}" but settings.mode is "${mode}", not "docker". ` +
            `Builtin mode ignores sharedContainer, so the scope would be a silent no-op.`,
        );
      }
      continue;
    }

    if (state.type !== 'deterministic') continue;

    if (state.containerScope !== undefined && state.container !== true) {
      issues.push(`State "${stateId}" declares containerScope but is not container: true`);
    }
    if ((state.resultFile !== undefined || usesVerdictEdges(state.transitions)) && state.container !== true) {
      issues.push(
        `State "${stateId}" uses resultFile / when:{verdict} routing but is not container: true. ` +
          `Structured deterministic result routing is container-only.`,
      );
    }
    if (state.resultFile !== undefined && !isSafeWorkspaceRelativePath(state.resultFile)) {
      issues.push(
        `State "${stateId}" has resultFile "${state.resultFile}" — must be a workspace-relative path (no leading "/", no "..").`,
      );
    }
    if (state.container === true && !sharedContainer) {
      issues.push(`State "${stateId}" has container: true but the workflow does not have sharedContainer: true.`);
    }
    if (state.container === true && mode !== 'docker') {
      issues.push(`State "${stateId}" has container: true but settings.mode is not "docker".`);
    }
  }
}

function validateHumanGate(stateId: string, state: HumanGateStateDefinition, issues: string[]): void {
  if (state.transitions.length === 0) {
    issues.push(`Human gate "${stateId}" must have at least one transition`);
  }

  const acceptedSet = new Set(state.acceptedEvents);
  for (const t of state.transitions) {
    if (!acceptedSet.has(t.event)) {
      issues.push(`Human gate "${stateId}" transition uses event "${t.event}" not in acceptedEvents`);
    }
  }
}

function validateArtifactInputs(definition: WorkflowDefinition, issues: string[]): void {
  const availableOutputs = collectOutputArtifacts(definition.states);

  for (const [stateId, state] of Object.entries(definition.states)) {
    if (state.type !== 'agent') continue;
    const agentState = state;
    for (const input of agentState.inputs) {
      const { name, isOptional } = parseArtifactRef(input);
      if (!isOptional && !availableOutputs.has(name)) {
        issues.push(`State "${stateId}" requires input artifact "${name}" not produced by any state`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * One issue produced by {@link iterateSkillRefIssues}. Surface code
 * (validate vs lint) formats the user-facing wording.
 */
export type SkillRefIssue =
  | { kind: 'invalid-name'; stateId: string; name: string; detail: string }
  | { kind: 'unknown-name'; stateId: string; name: string };

/**
 * Walks every agent state's `skills[]` and yields a structured issue
 * per offending entry, classifying shape failures (`invalid-name`)
 * separately from membership failures (`unknown-name`). Shape-first:
 * an entry that fails the shape check is yielded as such and not
 * checked for membership, which would otherwise emit a confusing
 * "skill not found" message for inputs that were never valid names.
 */
export function* iterateSkillRefIssues(
  definition: WorkflowDefinition,
  discoveredNames: ReadonlySet<string>,
): Generator<SkillRefIssue> {
  for (const [stateId, state] of Object.entries(definition.states)) {
    if (state.type !== 'agent' || state.skills === undefined) continue;
    if (state.skills === SKILLS_NONE) continue;
    for (const name of state.skills) {
      try {
        validateSkillName(name);
      } catch (err) {
        yield { kind: 'invalid-name', stateId, name, detail: errorMessage(err) };
        continue;
      }
      if (!discoveredNames.has(name)) {
        yield { kind: 'unknown-name', stateId, name };
      }
    }
  }
}

/**
 * Verifies every `skills[]` entry on an agent state matches a SKILL.md
 * frontmatter `name:` under `<packageDir>/skills/`. Membership is
 * keyed on the frontmatter name (also what `workflowSkillFilter` in
 * `src/skills/discovery.ts` matches), not the directory name —
 * `existsSync` on the dir would miss dir-vs-frontmatter mismatches.
 * Called from orchestrator `start()` only.
 *
 * @throws {WorkflowValidationError} when any entry is invalid or unknown
 */
export function validateWorkflowSkillReferences(definition: WorkflowDefinition, packageDir: string): void {
  const skillsRoot = resolve(packageDir, 'skills');
  const discoveredNames = new Set(discoverSkills(skillsRoot, 'workflow').map((s) => s.name));
  const available = [...discoveredNames].sort();
  const availableHint = available.length > 0 ? available.join(', ') : '(none)';

  const issues: string[] = [];
  for (const issue of iterateSkillRefIssues(definition, discoveredNames)) {
    if (issue.kind === 'invalid-name') {
      issues.push(`State "${issue.stateId}" has invalid skill name "${issue.name}": ${issue.detail}.`);
    } else {
      issues.push(
        `State "${issue.stateId}" references skill "${issue.name}" but no skill with that frontmatter name was found under ${skillsRoot}. Available: ${availableHint}.`,
      );
    }
  }

  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }
}

/**
 * Validates a parsed object as a WorkflowDefinition.
 * Performs structural parsing (Zod) then semantic checks.
 * The input can come from JSON.parse() or YAML.parse().
 *
 * @throws {WorkflowValidationError} with structured list of issues
 */
export function validateDefinition(raw: unknown): WorkflowDefinition {
  // Raw-level checks run first so that fields Zod would strip (e.g.,
  // `maxVisits` on non-agent states) and malformed state IDs produce
  // clear, targeted errors instead of being silently dropped.
  const rawIssues = validateRawInput(raw);
  if (rawIssues.length > 0) {
    throw new WorkflowValidationError(rawIssues);
  }

  let parsed: WorkflowDefinition;
  try {
    parsed = workflowDefinitionSchema.parse(raw) as WorkflowDefinition;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      throw new WorkflowValidationError(issues);
    }
    throw err;
  }
  validateSemantics(parsed);
  return parsed;
}
