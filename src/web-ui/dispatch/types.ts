/**
 * Shared types and utilities for dispatch sub-modules.
 *
 * The DispatchContext and validation helpers are used by all
 * domain-specific dispatch modules (session, job, escalation, etc.).
 */

import { z } from 'zod';

import type { SessionManager, ManagedSession } from '../../session/session-manager.js';
import type { ControlRequestHandler } from '../../daemon/control-socket.js';
import type { SessionMode } from '../../session/types.js';
import type { WebEventBus } from '../web-event-bus.js';
import { type SessionDto, type BudgetSummaryDto, type DaemonStatusDto, InvalidParamsError } from '../web-ui-types.js';

// ---------------------------------------------------------------------------
// Dispatch context
// ---------------------------------------------------------------------------

export interface DispatchContext {
  readonly handler: ControlRequestHandler;
  readonly sessionManager: SessionManager;
  readonly mode: SessionMode;
  readonly eventBus: WebEventBus;
  readonly maxConcurrentWebSessions: number;
  /** @internal Sequencing queues per session -- managed by dispatch module. */
  readonly sessionQueues: Map<number, Promise<void>>;
}

// ---------------------------------------------------------------------------
// Param validation
// ---------------------------------------------------------------------------

export function validateParams<T>(schema: z.ZodType<T>, params: Record<string, unknown>): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new InvalidParamsError(result.error.message);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// DTO builders
// ---------------------------------------------------------------------------

export function toSessionDto(managed: ManagedSession): SessionDto {
  const info = managed.session.getInfo();
  const persona = managed.source.kind === 'web' ? managed.source.persona : undefined;
  return {
    label: managed.label,
    source: managed.source,
    status: info.status,
    turnCount: info.turnCount,
    createdAt: info.createdAt,
    hasPendingEscalation: managed.pendingEscalation !== null,
    messageInFlight: managed.messageInFlight,
    budget: toBudgetDto(managed),
    ...(persona ? { persona } : {}),
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
