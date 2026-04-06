/**
 * Job-related JSON-RPC method dispatch.
 *
 * Handles all `jobs.*` methods: list, remove, enable, disable,
 * recompile, reload, run, logs.
 */

import { z } from 'zod';

import { type DispatchContext, validateParams } from './types.js';
import { type JobListDto, MethodNotFoundError } from '../web-ui-types.js';
import { loadRecentRuns } from '../../cron/job-store.js';
import type { JobId } from '../../cron/types.js';

// ---------------------------------------------------------------------------
// Param validation schemas
// ---------------------------------------------------------------------------

const jobIdSchema = z.object({ jobId: z.string().min(1) });
const jobLogsSchema = z.object({ jobId: z.string().min(1), limit: z.number().int().positive().optional() });

// ---------------------------------------------------------------------------
// Job dispatch
// ---------------------------------------------------------------------------

export async function jobDispatch(
  ctx: DispatchContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'jobs.list':
      return listJobs(ctx);
    case 'jobs.remove': {
      const { jobId } = validateParams(jobIdSchema, params);
      await ctx.handler.removeJob(jobId);
      ctx.eventBus.emit('job.list_changed', {});
      return;
    }
    case 'jobs.enable': {
      const { jobId } = validateParams(jobIdSchema, params);
      await ctx.handler.enableJob(jobId);
      ctx.eventBus.emit('job.list_changed', {});
      return;
    }
    case 'jobs.disable': {
      const { jobId } = validateParams(jobIdSchema, params);
      await ctx.handler.disableJob(jobId);
      ctx.eventBus.emit('job.list_changed', {});
      return;
    }
    case 'jobs.recompile': {
      const { jobId } = validateParams(jobIdSchema, params);
      await ctx.handler.recompileJob(jobId);
      return;
    }
    case 'jobs.reload': {
      const { jobId } = validateParams(jobIdSchema, params);
      await ctx.handler.reloadJob(jobId);
      ctx.eventBus.emit('job.list_changed', {});
      return;
    }
    case 'jobs.run': {
      const { jobId } = validateParams(jobIdSchema, params);
      ctx.handler
        .runJobNow(jobId)
        .then((record) => ctx.eventBus.emit('job.completed', { jobId, record }))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          ctx.eventBus.emit('job.failed', { jobId, error: message });
        });
      ctx.eventBus.emit('job.started', { jobId, sessionLabel: 0 });
      return { accepted: true, jobId };
    }
    case 'jobs.logs': {
      const { jobId, limit } = validateParams(jobLogsSchema, params);
      return loadRecentRuns(jobId as JobId, limit ?? 20);
    }
    default:
      throw new MethodNotFoundError(method);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listJobs(ctx: DispatchContext): JobListDto[] {
  return ctx.handler.listJobs().map((j) => ({
    job: j.job,
    nextRun: j.nextRun?.toISOString() ?? null,
    lastRun: j.lastRun ?? null,
    isRunning: j.isRunning,
  }));
}
