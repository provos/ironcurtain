/**
 * Cron Mode types -- job definitions, run records, and budget overrides.
 *
 * These types are used by the job store, cron scheduler, daemon,
 * and CLI commands.
 */

/**
 * Stable, user-chosen identifier for a cron job.
 * Must be a valid slug: lowercase alphanumeric, hyphens, underscores.
 * Branded to prevent mixing with other string identifiers.
 */
export type JobId = string & { readonly __brand: 'JobId' };

/** Regex for valid job IDs: 1-63 chars, lowercase alphanumeric, hyphens, or underscores. */
export const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Validates and creates a JobId from a user-provided string. */
export function createJobId(raw: string): JobId {
  if (!JOB_ID_PATTERN.test(raw)) {
    throw new Error(
      `Invalid job ID "${raw}": must be 1-63 chars, ` +
        `lowercase alphanumeric, hyphens, or underscores, ` +
        `starting with a letter or digit`,
    );
  }
  return raw as JobId;
}

/**
 * Persisted job definition. Stored as JSON at
 * ~/.ironcurtain/jobs/{jobId}/job.json.
 *
 * Invariant: the `task` field is the "constitution" input for
 * per-job policy compilation. Changing it invalidates the
 * compiled policy (detected via content hash comparison).
 */
export interface JobDefinition {
  /** Stable user-chosen slug. Matches the directory name. */
  readonly id: JobId;

  /** Human-friendly display name. */
  readonly name: string;

  /** Standard cron expression (5 fields: min hour dom mon dow). */
  readonly schedule: string;

  /**
   * English task description sent to the agent as its work prompt.
   */
  readonly taskDescription: string;

  /**
   * English constitution text used as the policy compilation input.
   * Describes what the agent is and is not permitted to do.
   */
  readonly taskConstitution: string;

  /**
   * Working directory for this job. Persists across runs.
   * Default: ~/.ironcurtain/jobs/{jobId}/workspace/
   */
  readonly workspace?: string;

  /**
   * Optional git repository URI to clone into the workspace.
   * On first run, the repo is cloned. On subsequent runs,
   * tracked files are reset to remote HEAD (untracked files preserved).
   */
  readonly gitRepo?: string;

  /**
   * When true and Signal is configured, the daemon sends a Signal
   * message on escalation and waits for approval. When false or
   * Signal is not configured, escalations are auto-denied.
   */
  readonly notifyOnEscalation: boolean;

  /**
   * When true and Signal is configured, the daemon sends a Signal
   * message with the run summary on completion.
   */
  readonly notifyOnCompletion: boolean;

  /**
   * Per-job resource budget overrides. Null fields inherit from
   * the cron-specific defaults.
   */
  readonly budgetOverrides?: Partial<JobBudgetOverrides>;

  /** Whether this job is active. Disabled jobs are not scheduled. */
  readonly enabled: boolean;
}

/**
 * Budget fields that can be overridden per-job.
 * All fields are nullable: null means "disable this limit".
 */
export interface JobBudgetOverrides {
  readonly maxTotalTokens: number | null;
  readonly maxSteps: number | null;
  readonly maxSessionSeconds: number | null;
  readonly maxEstimatedCostUsd: number | null;
}

/**
 * Outcome status for a completed run.
 */
export type RunOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'budget_exhausted'; readonly dimension: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Persisted run record. Written to
 * ~/.ironcurtain/jobs/{jobId}/runs/{timestamp}.json
 * after each run completes.
 */
export interface RunRecord {
  /** ISO 8601 start time. Also used as the filename. */
  readonly startedAt: string;

  /** ISO 8601 end time. */
  readonly completedAt: string;

  /** How the run ended. */
  readonly outcome: RunOutcome;

  /** Resource consumption snapshot. */
  readonly budget: {
    readonly totalTokens: number;
    readonly stepCount: number;
    readonly elapsedSeconds: number;
    readonly estimatedCostUsd: number;
  };

  /**
   * Brief summary extracted from workspace/last-run.md, if it exists.
   * Truncated to 2000 chars. Null if the file was not written.
   */
  readonly summary: string | null;

  /** Whether any escalations were surfaced during this run. */
  readonly escalationsEncountered: number;

  /** Whether any escalations were approved (vs. denied or timed out). */
  readonly escalationsApproved: number;

  /** git diff --stat of tracked-file changes discarded during pre-run sync. */
  readonly discardedChanges: string | null;
}

/** Cron-specific budget defaults (differ from interactive defaults). */
export const CRON_BUDGET_DEFAULTS: Required<JobBudgetOverrides> = {
  maxTotalTokens: 500_000,
  maxSteps: 100,
  maxSessionSeconds: 3_600,
  maxEstimatedCostUsd: 2.0,
};
