/**
 * Helpers for the Workflows route view.
 *
 * Pure functions only -- kept side-effect-free so they can be unit-tested
 * without rendering the Svelte component.
 */

import type { PastRunDto, PastRunPhase, WorkflowSummaryDto, LiveWorkflowPhase } from '$lib/types.js';
import { PHASE } from '$lib/types.js';

const TERMINAL_LIVE_PHASES = new Set<LiveWorkflowPhase>([PHASE.COMPLETED, PHASE.FAILED, PHASE.ABORTED]);

/**
 * Build a `WorkflowSummaryDto` placeholder by merging caller-supplied fields
 * over zero-defaults. Used to seed `appState.workflows` on `start`/`resume`
 * before events arrive, and to synthesize summaries for past runs that aren't
 * in the live Map. `WorkflowDetail` re-fetches via `getWorkflowDetail(id)`
 * on mount, so only fields read at first paint must be populated correctly.
 */
export function buildSummaryPlaceholder(
  partial: Partial<WorkflowSummaryDto> & { workflowId: string },
): WorkflowSummaryDto {
  return {
    name: partial.workflowId,
    phase: 'running',
    currentState: '',
    startedAt: new Date().toISOString(),
    taskDescription: '',
    round: 0,
    maxRounds: 0,
    totalTokens: 0,
    ...partial,
  };
}

/**
 * Synthesize a `WorkflowSummaryDto` for a past-run row that isn't in the live
 * `appState.workflows` Map. The narrower `LiveWorkflowPhase` excludes
 * `'interrupted'`; coerce it to `'failed'` for the badge so the placeholder
 * type stays narrow until the real phase is re-fetched.
 */
export function synthesizeSummaryFromPastRun(row: PastRunDto): WorkflowSummaryDto {
  const livePhase: LiveWorkflowPhase = row.phase === 'interrupted' ? 'failed' : row.phase;
  return buildSummaryPlaceholder({
    workflowId: row.workflowId,
    name: row.name,
    phase: livePhase,
    currentState: row.lastState,
    startedAt: row.timestamp,
    taskDescription: row.taskDescription,
    round: row.round,
    maxRounds: row.maxRounds,
    totalTokens: row.totalTokens,
    latestVerdict: row.latestVerdict,
    error: row.error,
  });
}

/** Bare-id placeholder for past runs not present in either source (deep-link). */
export function synthesizeSummaryFromId(workflowId: string): WorkflowSummaryDto {
  return buildSummaryPlaceholder({ workflowId, phase: 'completed' });
}

/**
 * Project an in-memory `WorkflowSummaryDto` (terminal phase) onto the
 * `PastRunDto` shape so it can be merged into the past-runs table.
 *
 * Mapping rules (per F4 design notes):
 * - `phase`: pass through (already a `PastRunPhase`-compatible value because
 *   the caller filters to terminal live phases).
 * - `timestamp`: use `startedAt` (in-memory has no separate timestamp).
 * - `lastState`: use `currentState`.
 * - `durationMs` / `workspacePath`: undefined (not on the live summary).
 */
export function summaryToPastRun(summary: WorkflowSummaryDto): PastRunDto {
  return {
    workflowId: summary.workflowId,
    name: summary.name,
    phase: summary.phase as PastRunPhase,
    currentState: summary.currentState,
    taskDescription: summary.taskDescription,
    round: summary.round,
    maxRounds: summary.maxRounds,
    totalTokens: summary.totalTokens,
    latestVerdict: summary.latestVerdict,
    error: summary.error,
    timestamp: summary.startedAt,
    lastState: summary.currentState,
  };
}

/**
 * Filter the in-memory workflow map down to the terminal-phase entries,
 * projected onto the `PastRunDto` shape.
 */
export function terminalSummariesAsPastRuns(workflows: Iterable<WorkflowSummaryDto>): PastRunDto[] {
  const out: PastRunDto[] = [];
  for (const wf of workflows) {
    if (TERMINAL_LIVE_PHASES.has(wf.phase)) {
      out.push(summaryToPastRun(wf));
    }
  }
  return out;
}

/**
 * Merge on-disk past-run rows with in-memory terminal entries.
 *
 * Dedup is by `workflowId`. When the same id appears in both lists, the
 * in-memory entry wins because it reflects the most recent observation
 * (verdict, error, phase). The result is sorted newest-first by `timestamp`.
 */
export function mergePastRuns(diskList: readonly PastRunDto[], inMemoryTerminal: readonly PastRunDto[]): PastRunDto[] {
  const merged = new Map<string, PastRunDto>();
  for (const row of diskList) {
    merged.set(row.workflowId, row);
  }
  for (const row of inMemoryTerminal) {
    merged.set(row.workflowId, row);
  }
  return [...merged.values()].sort((a, b) => {
    // Newest first; missing/invalid timestamps sort last.
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });
}

/** Truncate `text` to ~`max` characters, appending an ellipsis when cut. */
export function truncate(text: string, max = 80): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

/**
 * Phases that allow a Resume action from the Past-runs table.
 *
 * Mirrors the engine's `isCheckpointResumable` (`src/workflow/checkpoint.ts`):
 * any past-run phase except `'completed'` carries a checkpoint that
 * `WorkflowOrchestrator.resume()` will accept. `'aborted'` is included
 * because both the quota-exhaustion and transient-failure paths
 * deliberately stamp `phase: 'aborted'` to keep the run resumable;
 * `'failed'` is included because the engine permits resume of error
 * targets so the user can pick the run back up after fixing the
 * underlying cause.
 */
const RESUMABLE_PHASES = new Set<PastRunPhase>([PHASE.WAITING_HUMAN, PHASE.INTERRUPTED, PHASE.ABORTED, PHASE.FAILED]);

export function isResumablePhase(phase: PastRunPhase): boolean {
  return RESUMABLE_PHASES.has(phase);
}

/** Filter pill identifiers used by the Past-runs section. */
export type PastRunFilter = 'all' | 'completed' | 'failed' | 'aborted' | 'interrupted' | 'waiting_human';

export const PAST_RUN_FILTERS: readonly { id: PastRunFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'aborted', label: 'Aborted' },
  { id: 'interrupted', label: 'Interrupted' },
  { id: 'waiting_human', label: 'Waiting-human' },
];

export function filterPastRuns(rows: readonly PastRunDto[], filter: PastRunFilter): PastRunDto[] {
  if (filter === 'all') return [...rows];
  return rows.filter((r) => r.phase === filter);
}

/** Per-pill counts for the filter row, including the "All" total. */
export function countByPhase(rows: readonly PastRunDto[]): Record<PastRunFilter, number> {
  const counts: Record<PastRunFilter, number> = {
    all: rows.length,
    completed: 0,
    failed: 0,
    aborted: 0,
    interrupted: 0,
    waiting_human: 0,
  };
  for (const r of rows) {
    if (r.phase in counts) counts[r.phase] += 1;
  }
  return counts;
}

/** Format a verdict's confidence (0..1) as a percentage label, or empty. */
export function formatConfidence(confidence: number | undefined): string {
  if (confidence === undefined || Number.isNaN(confidence)) return '';
  const pct = Math.round(confidence * 100);
  return `${pct}%`;
}

/** Format a duration in milliseconds as a short human string ("12s", "3m 04s", "1h 02m"). */
export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}
