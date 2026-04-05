/**
 * JSON-RPC method dispatch and parameter validation.
 *
 * Extracted from WebUiServer to keep the server class focused on
 * HTTP/WS lifecycle. This module handles method routing and Zod
 * validation for all JSON-RPC methods.
 */

import { z } from 'zod';

import type { SessionManager, ManagedSession } from '../session/session-manager.js';
import type { ControlRequestHandler } from '../daemon/control-socket.js';
import type { SessionMode } from '../session/types.js';
import type { WebEventBus } from './web-event-bus.js';
import {
  type MethodName,
  type SessionDto,
  type SessionDetailDto,
  type BudgetSummaryDto,
  type EscalationDto,
  type DaemonStatusDto,
  type JobListDto,
  RpcError,
  InvalidParamsError,
  SessionNotFoundError,
  MethodNotFoundError,
} from './web-ui-types.js';
import { WebSessionTransport } from './web-session-transport.js';
import { loadConfig } from '../config/index.js';
import { createSession } from '../session/index.js';
import { shouldAutoSaveMemory } from '../memory/auto-save.js';
import { BudgetExhaustedError } from '../session/errors.js';
import { loadRecentRuns } from '../cron/job-store.js';
import type { JobId } from '../cron/types.js';
import * as logger from '../logger.js';

// ---------------------------------------------------------------------------
// Param validation schemas
// ---------------------------------------------------------------------------

const labelSchema = z.object({ label: z.number().int().positive() });
const jobIdSchema = z.object({ jobId: z.string().min(1) });
const jobLogsSchema = z.object({ jobId: z.string().min(1), limit: z.number().int().positive().optional() });
const sessionCreateSchema = z.object({ persona: z.string().min(1).optional() });
const sessionSendSchema = z.object({ label: z.number().int().positive(), text: z.string().min(1) });
const escalationResolveSchema = z.object({
  escalationId: z.string().min(1),
  decision: z.enum(['approved', 'denied']),
  whitelistSelection: z.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Dispatch context
// ---------------------------------------------------------------------------

export interface DispatchContext {
  readonly handler: ControlRequestHandler;
  readonly sessionManager: SessionManager;
  readonly mode: SessionMode;
  readonly eventBus: WebEventBus;
  readonly maxConcurrentWebSessions: number;
  /** @internal Sequencing queues per session — managed by dispatch module. */
  readonly sessionQueues: Map<number, Promise<void>>;
}

/** Clean up session queue entry when session ends. */
function cleanupSessionQueue(ctx: DispatchContext, label: number): void {
  ctx.sessionQueues.delete(label);
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export async function dispatch(
  ctx: DispatchContext,
  method: MethodName,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'status':
      return buildStatusDto(ctx);

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

    case 'sessions.list':
      return listSessions(ctx);
    case 'sessions.get': {
      const { label } = validateParams(labelSchema, params);
      return getSession(ctx, label);
    }
    case 'sessions.create': {
      const { persona } = validateParams(sessionCreateSchema, params);
      return createWebSession(ctx, persona);
    }
    case 'sessions.end': {
      const { label } = validateParams(labelSchema, params);
      await ctx.sessionManager.end(label);
      cleanupSessionQueue(ctx, label);
      ctx.eventBus.emit('session.ended', { label, reason: 'user_ended' });
      return;
    }
    case 'sessions.send': {
      const { label, text } = validateParams(sessionSendSchema, params);
      return sendToSession(ctx, label, text);
    }
    case 'sessions.budget': {
      const { label } = validateParams(labelSchema, params);
      const managed = ctx.sessionManager.get(label);
      if (!managed) throw new SessionNotFoundError(label);
      return toBudgetDto(managed);
    }
    case 'sessions.history': {
      const { label } = validateParams(labelSchema, params);
      const managed = ctx.sessionManager.get(label);
      if (!managed) throw new SessionNotFoundError(label);
      return managed.session.getHistory();
    }
    case 'sessions.diagnostics': {
      const { label } = validateParams(labelSchema, params);
      const managed = ctx.sessionManager.get(label);
      if (!managed) throw new SessionNotFoundError(label);
      return managed.session.getDiagnosticLog();
    }

    case 'escalations.list':
      return listEscalations(ctx);
    case 'escalations.resolve': {
      const validated = validateParams(escalationResolveSchema, params);
      const result = await ctx.sessionManager.resolveSessionEscalation(
        validated.escalationId,
        validated.decision,
        validated.whitelistSelection != null ? { whitelistSelection: validated.whitelistSelection } : undefined,
      );
      if (!result.resolved) {
        throw new RpcError(
          result.reason === 'already_resolving' ? 'SESSION_BUSY' : 'ESCALATION_NOT_FOUND',
          result.reason ?? 'Failed to resolve escalation',
        );
      }
      return;
    }

    default:
      throw new MethodNotFoundError(method);
  }
}

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

function listSessions(ctx: DispatchContext): SessionDto[] {
  return ctx.sessionManager.all().map((m) => toSessionDto(m));
}

function getSession(ctx: DispatchContext, label: number): SessionDetailDto {
  const managed = ctx.sessionManager.get(label);
  if (!managed) throw new SessionNotFoundError(label);
  return {
    ...toSessionDto(managed),
    history: managed.session.getHistory(),
    diagnosticLog: managed.session.getDiagnosticLog(),
  };
}

async function createWebSession(ctx: DispatchContext, persona?: string): Promise<{ label: number }> {
  const webCount = ctx.sessionManager.byKind('web').length;
  if (webCount >= ctx.maxConcurrentWebSessions) {
    throw new RpcError('RATE_LIMITED', `Web session limit reached (max ${ctx.maxConcurrentWebSessions})`);
  }

  const config = loadConfig();
  const transport = new WebSessionTransport({
    eventBus: ctx.eventBus,
    sessionManager: ctx.sessionManager,
    autoSaveMemory: shouldAutoSaveMemory(config) && !!persona,
    dockerMode: ctx.mode.kind === 'docker',
  });

  const session = await createSession({
    config,
    mode: ctx.mode,
    persona,
    onEscalation: transport.createEscalationHandler(),
    onEscalationExpired: transport.createEscalationExpiredHandler(),
    onEscalationResolved: transport.createEscalationResolvedHandler(),
    onDiagnostic: transport.createDiagnosticHandler(),
  });

  const label = ctx.sessionManager.register(session, transport, { kind: 'web' });
  transport.sessionLabel = label;

  const runPromise = transport.run(session);
  const managed = ctx.sessionManager.get(label);
  if (managed) {
    managed.runPromise = runPromise;
  }

  runPromise
    .then(() => {
      const m = ctx.sessionManager.get(label);
      if (m) {
        ctx.sessionManager.end(label).catch((err: unknown) => {
          logger.error(`[WebUI] Failed to clean up session #${label}: ${String(err)}`);
        });
      }
    })
    .catch((err: unknown) => {
      logger.error(`[WebUI] Transport #${label} error: ${String(err)}`);
    })
    .finally(() => {
      cleanupSessionQueue(ctx, label);
    });

  if (managed) {
    ctx.eventBus.emit('session.created', toSessionDto(managed));
  }

  return { label };
}

function sendToSession(ctx: DispatchContext, label: number, text: string): { accepted: true } {
  const managed = ctx.sessionManager.get(label);
  if (!managed) throw new SessionNotFoundError(label);
  if (managed.source.kind !== 'web') {
    throw new RpcError('INVALID_PARAMS', `Session #${label} is not a web session`);
  }

  const transport = managed.transport as WebSessionTransport;
  const turnNumber = managed.session.getInfo().turnCount + 1;

  const prev = ctx.sessionQueues.get(label) ?? Promise.resolve();
  const current = prev.then(async () => {
    ctx.eventBus.emit('session.thinking', { label, turnNumber });
    try {
      const response = await transport.forwardMessage(text);
      ctx.eventBus.emit('session.output', { label, text: response, turnNumber });
      ctx.eventBus.emit('session.budget_update', { label, budget: toBudgetDto(managed) });
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        ctx.eventBus.emit('session.ended', { label, reason: `Budget exhausted: ${err.message}` });
        await ctx.sessionManager.end(label);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        ctx.eventBus.emit('session.output', { label, text: `Error: ${message}`, turnNumber });
      }
    }
  });
  ctx.sessionQueues.set(
    label,
    current.catch(() => {}),
  );

  return { accepted: true };
}

// ---------------------------------------------------------------------------
// Escalation & job helpers
// ---------------------------------------------------------------------------

function listEscalations(ctx: DispatchContext): EscalationDto[] {
  return ctx.sessionManager.withPendingEscalation().flatMap((m) => {
    const esc = m.pendingEscalation;
    if (!esc) return [];
    return [
      {
        ...esc,
        sessionSource: m.source,
      },
    ];
  });
}

function listJobs(ctx: DispatchContext): JobListDto[] {
  return ctx.handler.listJobs().map((j) => ({
    job: j.job,
    nextRun: j.nextRun?.toISOString() ?? null,
    lastRun: j.lastRun ?? null,
    isRunning: j.isRunning,
  }));
}

// ---------------------------------------------------------------------------
// DTO builders
// ---------------------------------------------------------------------------

export function toSessionDto(managed: ManagedSession): SessionDto {
  const info = managed.session.getInfo();
  return {
    label: managed.label,
    source: managed.source,
    status: info.status,
    turnCount: info.turnCount,
    createdAt: info.createdAt,
    hasPendingEscalation: managed.pendingEscalation !== null,
    messageInFlight: managed.messageInFlight,
    budget: toBudgetDto(managed),
  };
}

export function toBudgetDto(managed: ManagedSession): BudgetSummaryDto {
  const status = managed.session.getBudgetStatus();
  return {
    totalTokens: status.totalTokens,
    stepCount: status.stepCount,
    elapsedSeconds: status.elapsedSeconds,
    estimatedCostUsd: status.estimatedCostUsd,
    tokenTrackingAvailable: status.tokenTrackingAvailable,
    limits: {
      maxTotalTokens: status.limits.maxTotalTokens,
      maxSteps: status.limits.maxSteps,
      maxSessionSeconds: status.limits.maxSessionSeconds,
      maxEstimatedCostUsd: status.limits.maxEstimatedCostUsd,
    },
  };
}

export function buildStatusDto(ctx: DispatchContext): DaemonStatusDto {
  const status = ctx.handler.getStatus();
  return {
    uptimeSeconds: status.uptimeSeconds,
    jobs: status.jobs,
    signalConnected: status.signalConnected,
    webUiListening: true,
    activeSessions: ctx.sessionManager.size,
    nextFireTime: status.nextFireTime?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

function validateParams<T>(schema: z.ZodType<T>, params: Record<string, unknown>): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new InvalidParamsError(result.error.message);
  }
  return result.data;
}
