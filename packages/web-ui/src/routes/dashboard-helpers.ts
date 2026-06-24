/**
 * Pure helpers for the Dashboard's "Workflow Activity" section.
 *
 * Side-effect-free so the stat aggregation can be unit-tested without
 * rendering the Svelte component. The component is responsible for fetching
 * the live + past-run data and mapping phases to presentation (colors, icons).
 */

import type { PastRunDto, WorkflowPhase, WorkflowSummaryDto } from '$lib/types.js';
import { PHASE } from '$lib/types.js';

/** Live phases that count as "active" on the dashboard (running or paused at a gate). */
const ACTIVE_LIVE_PHASES: ReadonlySet<WorkflowPhase> = new Set<WorkflowPhase>([PHASE.RUNNING, PHASE.WAITING_HUMAN]);

/** Past-run phases that count as a problem outcome ("issues" KPI). */
const ISSUE_PHASES: ReadonlySet<WorkflowPhase> = new Set<WorkflowPhase>([
  PHASE.FAILED,
  PHASE.ABORTED,
  PHASE.INTERRUPTED,
]);

/**
 * Ordered phases for the distribution bar and its legend. Order is fixed so the
 * bar reads predictably (in-flight → success → problems) regardless of how the
 * underlying counts arrive.
 */
export const DISTRIBUTION_PHASES: readonly WorkflowPhase[] = [
  PHASE.RUNNING,
  PHASE.WAITING_HUMAN,
  PHASE.COMPLETED,
  PHASE.FAILED,
  PHASE.ABORTED,
  PHASE.INTERRUPTED,
];

/** Headline counts shown as the four KPI tiles. */
export interface WorkflowKpis {
  /** Live runs that are running or waiting at a gate. */
  readonly active: number;
  /** Human gates currently awaiting a decision (live). */
  readonly awaitingGate: number;
  /** Past runs that reached the completed phase. */
  readonly completed: number;
  /** Past runs that ended in failure / abort / interruption. */
  readonly issues: number;
}

/**
 * Compute the KPI tile values.
 *
 * `active` is filtered here (not assumed pre-filtered) so callers can pass the
 * full live workflow list. `awaitingGate` is supplied directly because the gate
 * set lives outside the workflow list (in `appState.pendingGates`).
 */
export function computeWorkflowKpis(
  liveWorkflows: readonly WorkflowSummaryDto[],
  pastRuns: readonly PastRunDto[],
  awaitingGate: number,
): WorkflowKpis {
  let completed = 0;
  let issues = 0;
  for (const run of pastRuns) {
    if (run.phase === PHASE.COMPLETED) completed += 1;
    else if (ISSUE_PHASES.has(run.phase)) issues += 1;
  }
  return {
    active: liveWorkflows.filter((wf) => ACTIVE_LIVE_PHASES.has(wf.phase)).length,
    awaitingGate,
    completed,
    issues,
  };
}

/** A single segment of the phase-distribution bar. */
export interface PhaseSegment {
  readonly phase: WorkflowPhase;
  readonly count: number;
  /** Width percentage 0..100; non-zero segments sum to ~100. */
  readonly pct: number;
}

export interface PhaseDistribution {
  readonly segments: readonly PhaseSegment[];
  readonly total: number;
}

/**
 * Tally every known workflow by phase and project it onto the ordered segment
 * list. Live workflows contribute their `running` / `waiting_human` phase; past
 * runs contribute their terminal (or paused) phase. Phases outside
 * {@link DISTRIBUTION_PHASES} are ignored.
 */
export function buildPhaseDistribution(
  liveWorkflows: readonly WorkflowSummaryDto[],
  pastRuns: readonly PastRunDto[],
): PhaseDistribution {
  const counts = new Map<WorkflowPhase, number>();
  const bump = (phase: WorkflowPhase): void => {
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  };

  for (const wf of liveWorkflows) {
    if (ACTIVE_LIVE_PHASES.has(wf.phase)) bump(wf.phase);
  }
  for (const run of pastRuns) bump(run.phase);

  let total = 0;
  for (const phase of DISTRIBUTION_PHASES) total += counts.get(phase) ?? 0;

  const segments: PhaseSegment[] = DISTRIBUTION_PHASES.map((phase) => {
    const count = counts.get(phase) ?? 0;
    return { phase, count, pct: total > 0 ? (count / total) * 100 : 0 };
  });

  return { segments, total };
}

/** Sum total tokens consumed across all live + past workflows (missing values coalesce to 0). */
export function sumWorkflowTokens(
  liveWorkflows: readonly WorkflowSummaryDto[],
  pastRuns: readonly PastRunDto[],
): number {
  let total = 0;
  for (const wf of liveWorkflows) total += wf.totalTokens ?? 0;
  for (const run of pastRuns) total += run.totalTokens ?? 0;
  return total;
}

/** Format a token count compactly: 942 → "942", 4 521 → "4.5k", 173 400 → "173k", 2 100 000 → "2.1M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}
