/**
 * CronScheduler -- manages cron schedules for all enabled jobs.
 *
 * Uses a polling approach with 60-second intervals to check
 * whether each job's cron expression matches the current time.
 * When node-cron is available, the implementation can be swapped
 * to use it for more efficient scheduling.
 */

import type { JobDefinition, JobId } from './types.js';
import * as logger from '../logger.js';

/**
 * Callback invoked when a scheduled job fires.
 * The daemon implements this to create a session.
 */
export type JobTriggerCallback = (job: JobDefinition) => Promise<void>;

/**
 * Manages cron schedules for all enabled jobs.
 *
 * Invariant: at most one schedule exists per jobId at any time.
 * Calling schedule() for an already-scheduled job replaces the
 * previous schedule.
 */
export interface CronScheduler {
  /**
   * Registers a job's schedule. The callback fires at each
   * scheduled time. Does not fire immediately.
   *
   * @throws InvalidCronExpressionError if the cron expression
   * is syntactically invalid.
   */
  schedule(job: JobDefinition, onTrigger: JobTriggerCallback): void;

  /** Removes a job's schedule. No-op if not scheduled. */
  unschedule(jobId: JobId): void;

  /** Removes all schedules. Called during shutdown. */
  unscheduleAll(): void;

  /**
   * Returns the next scheduled fire time for a job, or undefined
   * if the job is not scheduled.
   */
  getNextRun(jobId: JobId): Date | undefined;
}

/**
 * Thrown when a cron expression cannot be parsed.
 */
export class InvalidCronExpressionError extends Error {
  constructor(
    readonly expression: string,
    cause: unknown,
  ) {
    super(`Invalid cron expression "${expression}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'InvalidCronExpressionError';
  }
}

// ---------------------------------------------------------------------------
// Cron expression parsing (minimal 5-field parser)
// ---------------------------------------------------------------------------

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    if (stepMatch && (isNaN(step) || step < 1)) {
      throw new Error(`Invalid step "${stepMatch[2]}" in "${part}" (expected integer >= 1)`);
    }
    const range = stepMatch ? stepMatch[1] : part;

    if (range === '*') {
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (range.includes('-')) {
      const [startStr, endStr] = range.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
        throw new Error(`Invalid range "${range}" (expected ${min}-${max})`);
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else {
      const val = parseInt(range, 10);
      if (isNaN(val) || val < min || val > max) {
        throw new Error(`Invalid value "${range}" (expected ${min}-${max})`);
      }
      values.add(val);
    }
  }

  return values;
}

function parseCronExpression(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Expected 5 fields (min hour dom mon dow), got ${parts.length}`);
  }

  const daysOfWeek = parseField(parts[4], 0, 7); // 0 and 7 both mean Sunday
  if (daysOfWeek.has(7)) {
    daysOfWeek.add(0);
    daysOfWeek.delete(7);
  }

  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek,
  };
}

function cronMatchesTime(fields: CronFields, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // 0-indexed -> 1-indexed
  const dayOfWeek = date.getDay(); // 0 = Sunday

  if (!fields.minutes.has(minute)) return false;
  if (!fields.hours.has(hour)) return false;
  if (!fields.months.has(month)) return false;

  // Standard cron: if both dom and dow are restricted (not *), match either
  const domIsWildcard = fields.daysOfMonth.size === 31;
  const dowIsWildcard = fields.daysOfWeek.size === 7;

  if (domIsWildcard && dowIsWildcard) return true;
  if (domIsWildcard) return fields.daysOfWeek.has(dayOfWeek);
  if (dowIsWildcard) return fields.daysOfMonth.has(dayOfMonth);

  // Both restricted: OR logic (standard cron behavior)
  return fields.daysOfMonth.has(dayOfMonth) || fields.daysOfWeek.has(dayOfWeek);
}

/**
 * Calculates the next time a cron expression would fire after the given date.
 * Scans forward minute-by-minute (up to 366 days).
 */
function getNextFireTime(fields: CronFields, after: Date): Date {
  const candidate = new Date(after);
  // Start from the next minute
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxIterations = 366 * 24 * 60; // One year of minutes
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatchesTime(fields, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  // Should not happen for valid expressions, but return a far-future date
  return new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface ScheduledJob {
  job: JobDefinition;
  fields: CronFields;
  callback: JobTriggerCallback;
  lastFired: Date | null;
}

/** Creates a CronScheduler with built-in cron expression parsing. */
export function createCronScheduler(): CronScheduler {
  const jobs = new Map<string, ScheduledJob>();
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  function startPolling(): void {
    if (pollInterval) return;
    // Poll every 30 seconds (within the 60-second cron granularity)
    pollInterval = setInterval(() => tick(), 30_000);
    pollInterval.unref(); // Don't keep the process alive just for polling
  }

  function stopPolling(): void {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  function tick(): void {
    const now = new Date();
    // Truncate to the current minute for comparison
    now.setSeconds(0, 0);

    for (const [jobId, scheduled] of jobs.entries()) {
      if (scheduled.lastFired && scheduled.lastFired.getTime() === now.getTime()) {
        continue; // Already fired this minute
      }

      if (cronMatchesTime(scheduled.fields, now)) {
        scheduled.lastFired = now;
        logger.info(`[CronScheduler] Firing job ${jobId} at ${now.toISOString()}`);
        scheduled.callback(scheduled.job).catch((err: unknown) => {
          logger.warn(`[CronScheduler] Job ${jobId} callback failed: ${String(err)}`);
        });
      }
    }
  }

  return {
    schedule(job: JobDefinition, onTrigger: JobTriggerCallback): void {
      let fields: CronFields;
      try {
        fields = parseCronExpression(job.schedule);
      } catch (err) {
        throw new InvalidCronExpressionError(job.schedule, err);
      }

      // Replace any existing schedule for this job
      jobs.set(job.id, { job, fields, callback: onTrigger, lastFired: null });

      if (jobs.size === 1) {
        startPolling();
      }
    },

    unschedule(jobId: JobId): void {
      jobs.delete(jobId);
      if (jobs.size === 0) {
        stopPolling();
      }
    },

    unscheduleAll(): void {
      jobs.clear();
      stopPolling();
    },

    getNextRun(jobId: JobId): Date | undefined {
      const scheduled = jobs.get(jobId);
      if (!scheduled) return undefined;
      return getNextFireTime(scheduled.fields, new Date());
    },
  };
}

// Export for testing
export { parseCronExpression, cronMatchesTime, getNextFireTime };
export type { CronFields };
