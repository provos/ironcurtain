/**
 * Workflow semantic linter. Receives a `WorkflowDefinition` that has
 * already passed `validateDefinition()` and returns `Diagnostic`s for
 * higher-level smells (cross-cutting or requiring external context)
 * that structural validation deliberately leaves alone.
 *
 * See `docs/designs/workflow-semantic-linter-v2.md` for each check's
 * rationale.
 */
import { resolve } from 'node:path';
import type {
  WorkflowDefinition,
  WorkflowStateDefinition,
  AgentStateDefinition,
  AgentTransitionDefinition,
} from './types.js';
import { GLOBAL_PERSONA, DEFAULT_CONTAINER_SCOPE } from './types.js';
import {
  collectTransitionTargets,
  findReachableStates,
  isExecutableState,
  iterateSkillRefIssues,
  parseArtifactRef,
  usesVerdictEdges,
} from './validate.js';
import { getWorkflowPackageDir } from './discovery.js';
import { ACTIONABLE_DISCOVERY_REASONS, discoverSkillsWithErrors } from '../skills/discovery.js';
import type { ResolvedSkill, SkillDiscoveryError } from '../skills/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Diagnostic codes.
 *
 * WF008 occupies the slot previously used for a raw-YAML check that
 * `maxVisits` is only declared on agent states. That check now throws
 * `WorkflowValidationError` before lint runs, so it never emits a WF code;
 * the slot is reclaimed here for the visit-cap transition-ordering rule.
 * WF009 is retired for the same reason (state-ID regex is a validation
 * error) and must not be reused.
 *
 * WF005 (parallelKey + worktree needs gitRepoPath) is retired: the
 * `parallelKey` schema field was removed as unused, so the trigger
 * condition can no longer fire. Must not be reused.
 *
 * WF010 covers two related concerns under a single code:
 *   1. State-scoped: an agent state's `skills:` entry is invalid or
 *      doesn't match any discoverable skill in the package.
 *   2. Package-scoped: a `SKILL.md` under the workflow package's
 *      `skills/` tree is malformed, unreadable, or missing required
 *      frontmatter fields. These are surfaced even when no state
 *      references the broken skill, so authors get fast feedback on a
 *      typo in frontmatter rather than discovering it via a "skill not
 *      found" message at runtime.
 *
 * Both concerns are skipped cleanly when the lint caller did not
 * supply a `workflowFilePath` (the package dir is the only place skill
 * manifests can live).
 *
 * WF013 (fan-out maxRounds budget) and WF014 (fan-out child-bounds) are
 * sibling fan-out checks split apart so each carries one concern. WF014
 * previously flagged non-barrier fan-out joins; that is now a parse-time
 * rejection (`FanOutDefinition.join` is the literal `'barrier'`), so the
 * lint became unreachable and the number was reclaimed for child-bounds.
 */
export type DiagnosticCode =
  | 'WF001'
  | 'WF002'
  | 'WF003'
  | 'WF004'
  | 'WF006'
  | 'WF007'
  | 'WF008'
  | 'WF010'
  | 'WF011'
  | 'WF012'
  | 'WF013'
  | 'WF014';
export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly stateId?: string;
  readonly hint?: string;
}

/**
 * Injected facts the linter cannot derive from the definition alone.
 *
 * Kept minimal: methods/fields are added only when a new check
 * genuinely needs external context.
 */
export interface LintContext {
  /** Returns true iff the named persona is installed locally. */
  personaExists(name: string): boolean;
  /**
   * Absolute path to the workflow file being linted, when known. Used
   * by checks that resolve co-packaged resources off the manifest's
   * directory (currently WF010 — skill references). Lint callers that
   * do not have a path on hand (e.g., synthesized definitions in tests)
   * may omit this; rules that need it skip cleanly when absent.
   */
  readonly workflowFilePath?: string;
}

export type LintResult = readonly Diagnostic[];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Runs all registered checks against `def`. Pure: same input => same
 * output. Diagnostics come back in stable order (WF001 first, WF007 last).
 */
export function lintWorkflow(def: WorkflowDefinition, ctx: LintContext): LintResult {
  const reachable = findReachableStates(def.initial, def.states);
  const reachableAgentOutputs = collectReachableAgentOutputs(def, reachable);

  return [
    ...checkUnreachableTerminal(def, reachable),
    ...checkUnversionedArtifacts(def, reachableAgentOutputs),
    ...checkTerminalOutputs(def, reachable, reachableAgentOutputs),
    ...checkHumanGatePresent(def, reachable, reachableAgentOutputs),
    ...checkMaxRoundsHasGuard(def),
    ...checkPersonaExists(def, ctx),
    ...checkVisitCapTransitionOrder(def),
    ...checkContainerScopePopulatedByAgent(def),
    ...checkVerdictEdgesHaveResultFile(def),
    ...checkFanOutBudget(def),
    ...checkFanOutChildBounds(def),
    ...checkSkillReferencesAndManifests(def, ctx),
  ];
}

export function countBySeverity(diagnostics: readonly Diagnostic[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.severity === 'error') errors++;
    else warnings++;
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Output artifacts produced by reachable agent states. Terminal
 * `outputs:` are declarations of expected arrival state, not production
 * (no runtime code writes them), so they don't count: WF002/WF003/WF004
 * all ask "is this name actually produced?"
 */
function collectReachableAgentOutputs(def: WorkflowDefinition, reachable: ReadonlySet<string>): Set<string> {
  const outputs = new Set<string>();
  for (const [stateId, state] of Object.entries(def.states)) {
    if (!reachable.has(stateId)) continue;
    if (state.type === 'agent') {
      for (const o of state.outputs) outputs.add(o);
    }
  }
  return outputs;
}

function isAgentState(state: WorkflowStateDefinition): state is AgentStateDefinition {
  return state.type === 'agent';
}

// ---------------------------------------------------------------------------
// WF001 — State can't reach any terminal
// ---------------------------------------------------------------------------

function checkUnreachableTerminal(def: WorkflowDefinition, reachable: ReadonlySet<string>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const stateId of reachable) {
    const state = def.states[stateId];
    if (state.type === 'terminal') continue;

    const cone = findReachableStates(stateId, def.states);
    let touchesTerminal = false;
    for (const target of cone) {
      if (def.states[target].type === 'terminal') {
        touchesTerminal = true;
        break;
      }
    }

    if (!touchesTerminal) {
      diagnostics.push({
        code: 'WF001',
        severity: 'error',
        stateId,
        message: `State "${stateId}" cannot reach any terminal state — the workflow will loop forever if it enters this state.`,
        hint: 'Add a transition (guarded or unconditional) whose forward graph eventually reaches a terminal state.',
      });
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF002 — unversionedArtifacts entry not produced by any state
// ---------------------------------------------------------------------------

function checkUnversionedArtifacts(def: WorkflowDefinition, produced: ReadonlySet<string>): Diagnostic[] {
  const entries = def.settings?.unversionedArtifacts ?? [];
  if (entries.length === 0) return [];

  const diagnostics: Diagnostic[] = [];
  for (const name of entries) {
    if (!produced.has(name)) {
      diagnostics.push({
        code: 'WF002',
        severity: 'warning',
        message: `settings.unversionedArtifacts entry "${name}" is not produced by any state — it will be silently versioned.`,
        hint: "Remove the entry, or add the artifact to some agent state's outputs list.",
      });
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF003 — terminal.outputs entry not produced by any reachable state
// ---------------------------------------------------------------------------

function checkTerminalOutputs(
  def: WorkflowDefinition,
  reachable: ReadonlySet<string>,
  produced: ReadonlySet<string>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const [stateId, state] of Object.entries(def.states)) {
    if (state.type !== 'terminal') continue;
    if (!reachable.has(stateId)) continue;

    for (const name of state.outputs ?? []) {
      if (!produced.has(name)) {
        diagnostics.push({
          code: 'WF003',
          severity: 'warning',
          stateId,
          message: `Terminal "${stateId}" lists output "${name}" which is not produced by any reachable state.`,
          hint: 'Remove the output from the terminal, or ensure a reachable agent state produces it.',
        });
      }
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF004 — human_gate present entry not produced by any reachable state
// ---------------------------------------------------------------------------

function checkHumanGatePresent(
  def: WorkflowDefinition,
  reachable: ReadonlySet<string>,
  produced: ReadonlySet<string>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const [stateId, state] of Object.entries(def.states)) {
    if (state.type !== 'human_gate') continue;
    if (!reachable.has(stateId)) continue;

    for (const entry of state.present ?? []) {
      const { name } = parseArtifactRef(entry);
      if (!produced.has(name)) {
        diagnostics.push({
          code: 'WF004',
          severity: 'error',
          stateId,
          message: `Human gate "${stateId}" presents artifact "${name}" which is not produced by any reachable state — the human will approve without seeing it.`,
          hint: 'Fix the artifact name, or ensure a reachable agent state produces it.',
        });
      }
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF006 — maxRounds set without any isRoundLimitReached guard
// ---------------------------------------------------------------------------

const ROUND_LIMIT_GUARD = 'isRoundLimitReached';

function checkMaxRoundsHasGuard(def: WorkflowDefinition): Diagnostic[] {
  if (def.settings?.maxRounds === undefined) return [];

  for (const state of Object.values(def.states)) {
    if (!isExecutableState(state)) continue;
    for (const t of state.transitions) {
      if (t.guard === ROUND_LIMIT_GUARD) return [];
    }
  }

  return [
    {
      code: 'WF006',
      severity: 'warning',
      message: `settings.maxRounds=${def.settings.maxRounds} is set but no transition uses the "isRoundLimitReached" guard — the limit is silently ignored.`,
      hint: 'Add a transition with guard: isRoundLimitReached to an iterative state, or remove maxRounds.',
    },
  ];
}

// ---------------------------------------------------------------------------
// WF007 — agent persona not installed
// ---------------------------------------------------------------------------

/**
 * Flags any agent state whose `persona` is neither the reserved
 * `GLOBAL_PERSONA` alias nor an installed persona directory.
 *
 * Emitted as a warning (not error) because personas are user-local state:
 * a workflow author may legitimately ship a definition that depends on
 * a persona the user hasn't installed yet. `--strict-lint` promotes this
 * to a failure.
 */
function checkPersonaExists(def: WorkflowDefinition, ctx: LintContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [stateId, state] of Object.entries(def.states)) {
    if (!isAgentState(state)) continue;
    const persona = state.persona;
    if (persona === GLOBAL_PERSONA) continue;
    if (ctx.personaExists(persona)) continue;

    diagnostics.push({
      code: 'WF007',
      severity: 'warning',
      stateId,
      message: `Agent state "${stateId}" references persona "${persona}" which is not installed locally — session creation will fail at runtime.`,
      hint: `Install the persona with: ironcurtain persona create ${persona}, or change the state's persona to "${GLOBAL_PERSONA}".`,
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF008 — visit-cap guard must precede loop-continuing transitions
// ---------------------------------------------------------------------------

/**
 * Verdict values that indicate an approval-style exit from a bounded loop.
 * Transitions taken on these verdicts represent the success path out of the
 * loop, so a visit-cap guard is legitimately ordered AFTER them (on the cap
 * visit, if the agent still emits `approved`, we take the approval exit
 * rather than escalating).
 *
 * Any other `when` verdict (rejected, rejected_build, blocked, or any
 * workflow-specific loop-continuation verdict) must NOT precede the cap
 * guard: if it did, the cap would never fire and the loop is effectively
 * unbounded except for the workflow-wide `maxRounds`.
 */
const VISIT_CAP_GUARD = 'isStateVisitLimitReached';
const APPROVAL_EXIT_VERDICTS: ReadonlySet<string> = new Set(['approved', 'complete', 'done', 'success', 'passed']);

/**
 * Returns true if `t.when` represents an approval-style exit. Approval
 * exits are allowed to precede the visit-cap guard. Everything else is
 * considered loop-continuing for the purposes of WF008 — including:
 *   - no `when` clause at all (always matches)
 *   - empty `when: {}` (always matches; flagged separately by validation)
 *   - a verdict not in the approval allowlist
 *   - a `when` clause that sets fields other than `verdict` (future-
 *     proofing: those match something other than the approval verdict)
 */
function isApprovalExitTransition(t: AgentTransitionDefinition): boolean {
  if (!t.when) return false;
  const keys = Object.keys(t.when);
  if (keys.length === 0) return false;
  if (keys.length !== 1 || keys[0] !== 'verdict') return false;
  const verdict = t.when.verdict;
  return typeof verdict === 'string' && APPROVAL_EXIT_VERDICTS.has(verdict);
}

function checkVisitCapTransitionOrder(def: WorkflowDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const [stateId, state] of Object.entries(def.states)) {
    if (!isAgentState(state)) continue;
    if (state.maxVisits === undefined) continue;

    const transitions = state.transitions;
    const capIndex = transitions.findIndex((t) => t.guard === VISIT_CAP_GUARD);
    if (capIndex === -1) continue;

    // Find the first loop-continuing transition that precedes the cap.
    for (let i = 0; i < capIndex; i++) {
      const t = transitions[i];
      if (isApprovalExitTransition(t)) continue;

      // `t` is either unconditional, a non-approval `when`, or a different
      // guard — all of which can match before the cap guard is evaluated.
      const descriptor = describeTransition(t);
      diagnostics.push({
        code: 'WF008',
        severity: 'error',
        stateId,
        message:
          `State "${stateId}" has maxVisits=${state.maxVisits} with an "${VISIT_CAP_GUARD}" ` +
          `transition at position ${capIndex + 1}, but a loop-continuing transition (${descriptor}) ` +
          `at position ${i + 1} will match first on every iteration, so the visit cap is never ` +
          `reached and the loop is effectively unbounded except by settings.maxRounds.`,
        hint:
          `Move the "${VISIT_CAP_GUARD}" transition above any non-approval "when" clause ` +
          `(only ${Array.from(APPROVAL_EXIT_VERDICTS).join('/')} verdicts may precede the cap).`,
      });
      // One diagnostic per state is sufficient; multiple preceding loop-
      // continuing transitions all share the same fix.
      break;
    }
  }

  return diagnostics;
}

function describeTransition(t: AgentTransitionDefinition): string {
  if (t.guard) return `guard: ${t.guard} -> ${t.to}`;
  if (t.when) {
    const parts = Object.entries(t.when).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    return `when { ${parts.join(', ')} } -> ${t.to}`;
  }
  return `unconditional -> ${t.to}`;
}

// ---------------------------------------------------------------------------
// WF011 — container deterministic state may run before its scope is minted
// ---------------------------------------------------------------------------

/**
 * A `container: true` deterministic state execs into the shared-container
 * bundle for its `containerScope`. That bundle is minted lazily by the first
 * state that needs the scope, and on a fresh run only *agent* states populate
 * it (a deterministic state is a helper that runs after an agent has worked in
 * the scope — there is no valid FSM of only deterministic states; the runtime
 * exists to mediate agent runs). If such a state is reachable from `initial`
 * without first passing through an agent state in the same scope, then on a
 * fresh run it may exec against a scope whose `/workspace` was never populated
 * — a graph-ordering smell. Resume is unaffected (the bundle is re-minted with
 * the persisted workspace); the runtime keeps a soft-warning backstop, and this
 * surfaces the fresh-run case at author time.
 */
function checkContainerScopePopulatedByAgent(def: WorkflowDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [stateId, state] of Object.entries(def.states)) {
    if (state.type !== 'deterministic' || state.container !== true) continue;
    const scope = state.containerScope ?? DEFAULT_CONTAINER_SCOPE;
    if (!isReachableWithoutScopeAgent(def, stateId, scope)) continue;

    diagnostics.push({
      code: 'WF011',
      severity: 'warning',
      stateId,
      message:
        `Deterministic state "${stateId}" runs in container scope "${scope}" but is reachable from ` +
        `"${def.initial}" without first passing through an agent state in that scope — on a fresh run ` +
        `its container may not be minted yet.`,
      hint:
        `Place a "${scope}"-scope agent state before "${stateId}" (a deterministic state is a helper ` +
        `that runs after an agent populates the scope), or move it onto a path that such an agent ` +
        `state precedes.`,
    });
  }
  return diagnostics;
}

/**
 * BFS from `initial` over the transition graph, treating agent states in
 * `scope` as absorbing — their successors are not expanded, because reaching
 * one means the scope's container is minted on that path. Returns true iff
 * `target` is reachable via at least one path that never passes through such an
 * agent state, i.e. an unsafe fresh-run path exists.
 */
function isReachableWithoutScopeAgent(def: WorkflowDefinition, target: string, scope: string): boolean {
  const seen = new Set<string>();
  const queue: string[] = [def.initial];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (id === target) return true;
    const state = def.states[id] as WorkflowStateDefinition | undefined;
    if (!state) continue;
    // An agent state in the target scope populates it; any continuation is
    // safe, so stop expanding this path.
    if (state.type === 'agent' && (state.containerScope ?? DEFAULT_CONTAINER_SCOPE) === scope) continue;
    for (const next of collectTransitionTargets(state)) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// WF012 — deterministic verdict edges need a resultFile source
// ---------------------------------------------------------------------------

function checkVerdictEdgesHaveResultFile(def: WorkflowDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const [stateId, state] of Object.entries(def.states)) {
    if (state.type !== 'deterministic') continue;
    if (state.resultFile !== undefined) continue;

    if (!usesVerdictEdges(state.transitions)) continue;

    diagnostics.push({
      code: 'WF012',
      severity: 'warning',
      stateId,
      message:
        `Deterministic state "${stateId}" routes on when:{verdict} but declares no resultFile; ` +
        `the verdict will always be undefined and these edges are dead.`,
      hint: `Add resultFile: <path> and have the helper write { "verdict": ... } there.`,
    });
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF013 — fan-out re-scopes the maxRounds budget from candidates to batches
// ---------------------------------------------------------------------------

function checkFanOutBudget(def: WorkflowDefinition): Diagnostic[] {
  const workers = def.settings?.workers ?? 1;
  if (workers <= 1) return [];
  if (def.settings?.maxRounds === undefined) return [];
  const maxRounds = def.settings.maxRounds;

  const diagnostics: Diagnostic[] = [];
  for (const [stateId, state] of Object.entries(def.states)) {
    if (!isExecutableState(state) || state.fanOut === undefined) continue;
    diagnostics.push({
      code: 'WF013',
      severity: 'warning',
      stateId,
      message:
        `Fan-out state "${stateId}" runs with settings.workers=${workers}; settings.maxRounds=${maxRounds} ` +
        `now caps batches, so the candidate budget is maxRounds × workers = ${maxRounds * workers}.`,
      hint: 'If maxRounds is intended as a candidate budget, divide it by workers or set an explicit batch budget.',
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF014 — self-loopable fan-out segment child lacks a per-lane visit bound
// ---------------------------------------------------------------------------

function checkFanOutChildBounds(def: WorkflowDefinition): Diagnostic[] {
  const workers = def.settings?.workers ?? 1;
  if (workers <= 1) return [];

  const diagnostics: Diagnostic[] = [];
  for (const state of Object.values(def.states)) {
    if (!isExecutableState(state) || state.fanOut === undefined) continue;
    const segment = state.segment ?? [];

    const segmentSet = new Set(segment);
    for (const memberId of segment) {
      const member = def.states[memberId] as WorkflowStateDefinition | undefined;
      if (member === undefined) continue;
      if (!isSelfLoopableWithinSegment(def, memberId, segmentSet)) continue;
      if (member.type === 'agent' && member.maxVisits !== undefined) continue;
      diagnostics.push({
        code: 'WF014',
        severity: 'warning',
        stateId: memberId,
        message:
          `Fan-out segment member "${memberId}" can loop within the segment but has no per-lane maxVisits bound; ` +
          `the parent maxRounds guard is blind to lane-internal visits.`,
        hint: 'Add maxVisits to the child state, or add an explicit child-level round-limit guard when the fan-out pump is implemented.',
      });
    }
  }
  return diagnostics;
}

function isSelfLoopableWithinSegment(def: WorkflowDefinition, stateId: string, segment: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  const queue = collectTransitionTargets(def.states[stateId]).filter((target) => segment.has(target));
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    if (current === stateId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const state = def.states[current] as WorkflowStateDefinition | undefined;
    if (state === undefined) continue;
    for (const target of collectTransitionTargets(state)) {
      if (segment.has(target)) queue.push(target);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// WF010 — skill references and skill-manifest integrity
// ---------------------------------------------------------------------------

/**
 * Entry point for WF010. Skips cleanly when `ctx.workflowFilePath` is
 * absent (in-memory definitions have no package dir to scan).
 * `checkSkillManifests` runs independently of any state reference so
 * a typo'd frontmatter — which would silently disappear from
 * discovery — still surfaces.
 */
function checkSkillReferencesAndManifests(def: WorkflowDefinition, ctx: LintContext): Diagnostic[] {
  if (!ctx.workflowFilePath) return [];
  const skillsRoot = resolve(getWorkflowPackageDir(ctx.workflowFilePath), 'skills');
  const { skills, errors } = discoverSkillsWithErrors(skillsRoot, 'workflow');

  return [...checkSkillManifests(errors), ...checkSkillReferences(def, skills, skillsRoot)];
}

function checkSkillManifests(errors: readonly SkillDiscoveryError[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const err of errors) {
    if (!ACTIONABLE_DISCOVERY_REASONS.has(err.reason)) continue;
    diagnostics.push({
      code: 'WF010',
      severity: 'error',
      ...buildSkillManifestDiagnostic(err),
    });
  }
  return diagnostics;
}

function buildSkillManifestDiagnostic(err: SkillDiscoveryError): { message: string; hint: string } {
  const detail = err.detail ?? err.reason;
  // Switch is exhaustive over `SkillDiscoveryErrorReason`. No `default`:
  // a new union member must add a case here or TypeScript will flag the
  // missing return-type coverage at compile time.
  switch (err.reason) {
    case 'malformed-frontmatter':
      return {
        message: `Malformed SKILL.md frontmatter at ${err.skillDir}: ${detail}.`,
        hint: 'Fix the YAML frontmatter (the block fenced by `---` lines at the top of SKILL.md).',
      };
    case 'missing-required-fields':
      return {
        message: `SKILL.md at ${err.skillDir} is missing required frontmatter fields: ${detail}.`,
        hint: 'SKILL.md frontmatter must declare both `name:` and `description:` as strings.',
      };
    case 'unreadable':
      return {
        message: `Unreadable SKILL.md at ${err.skillDir}: ${detail}.`,
        hint: 'Check filesystem permissions or whether the path is a directory.',
      };
    case 'missing-manifest':
      return {
        message: `Missing SKILL.md at ${err.skillDir}: ${detail}.`,
        hint: 'Create a SKILL.md file with a `---`-fenced YAML frontmatter declaring `name:` and `description:`.',
      };
    case 'duplicate-name':
      return {
        message: `Duplicate skill at ${err.skillDir}: ${detail}.`,
        hint: 'Two skill directories under the same skills root cannot share the same frontmatter `name:`. Rename one in its SKILL.md frontmatter.',
      };
  }
}

/**
 * Walks every agent state's `skills?: string[]` and emits one
 * diagnostic per offending entry — either an invalid name (rejected by
 * `validateSkillName`) or a name that does not match any discovered
 * skill's frontmatter `name:` under `<packageDir>/skills/`. The
 * frontmatter name is the user-facing identifier (matched by
 * `workflowSkillFilter` in `src/skills/discovery.ts`), not the
 * directory name. The orchestrator's `validateWorkflowSkillReferences`
 * throws for the same conditions at start; surfacing them at lint time
 * gives authors fast feedback before they hit runtime.
 */
function checkSkillReferences(
  def: WorkflowDefinition,
  discovered: readonly ResolvedSkill[],
  skillsRoot: string,
): Diagnostic[] {
  const discoveredNames = new Set(discovered.map((s) => s.name));
  const available = [...discoveredNames].sort();
  const availableHint = available.length > 0 ? available.join(', ') : '(none)';
  const diagnostics: Diagnostic[] = [];

  for (const issue of iterateSkillRefIssues(def, discoveredNames)) {
    if (issue.kind === 'invalid-name') {
      diagnostics.push({
        code: 'WF010',
        severity: 'error',
        stateId: issue.stateId,
        message: `Invalid skill name "${issue.name}" in state "${issue.stateId}": ${issue.detail}.`,
        hint: 'Skill names must be a single non-empty path segment with no separators or "."/"..".',
      });
    } else {
      diagnostics.push({
        code: 'WF010',
        severity: 'error',
        stateId: issue.stateId,
        message: `State "${issue.stateId}" references skill "${issue.name}" but no skill with that frontmatter name was found under ${skillsRoot}. Available: ${availableHint}.`,
        hint: `Add a SKILL.md under <workflow-pkg>/skills/ whose frontmatter \`name:\` is "${issue.name}", or remove "${issue.name}" from the state's skills list.`,
      });
    }
  }

  return diagnostics;
}
