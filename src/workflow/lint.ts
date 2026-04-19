/**
 * Workflow semantic linter. Receives a `WorkflowDefinition` that has
 * already passed `validateDefinition()` and returns `Diagnostic`s for
 * higher-level smells (cross-cutting or requiring external context)
 * that structural validation deliberately leaves alone.
 *
 * See `docs/designs/workflow-semantic-linter-v2.md` for each check's
 * rationale.
 */
import type {
  WorkflowDefinition,
  WorkflowStateDefinition,
  AgentStateDefinition,
  AgentTransitionDefinition,
} from './types.js';
import { GLOBAL_PERSONA } from './types.js';
import { findReachableStates, parseArtifactRef } from './validate.js';

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
 */
export type DiagnosticCode = 'WF001' | 'WF002' | 'WF003' | 'WF004' | 'WF005' | 'WF006' | 'WF007' | 'WF008';
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
 * Kept minimal: only `personaExists` is declared. New methods should be
 * added only when a new check genuinely needs external context.
 */
export interface LintContext {
  /** Returns true iff the named persona is installed locally. */
  personaExists(name: string): boolean;
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
    ...checkWorktreeNeedsGitRepo(def),
    ...checkMaxRoundsHasGuard(def),
    ...checkPersonaExists(def, ctx),
    ...checkVisitCapTransitionOrder(def),
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
// WF005 — parallelKey + worktree without settings.gitRepoPath
// ---------------------------------------------------------------------------

function checkWorktreeNeedsGitRepo(def: WorkflowDefinition): Diagnostic[] {
  if (def.settings?.gitRepoPath) return [];

  const diagnostics: Diagnostic[] = [];
  for (const [stateId, state] of Object.entries(def.states)) {
    if (!isAgentState(state)) continue;
    if (state.parallelKey && state.worktree === true) {
      diagnostics.push({
        code: 'WF005',
        severity: 'error',
        stateId,
        message: `State "${stateId}" uses parallelKey + worktree:true but settings.gitRepoPath is not set — worktree creation will fail at runtime.`,
        hint: 'Set settings.gitRepoPath to the repository root, or drop worktree:true.',
      });
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
    if (state.type !== 'agent' && state.type !== 'deterministic') continue;
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
