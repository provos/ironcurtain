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
import type { TokenStreamBridge } from '../token-stream-bridge.js';
import type { WebEventBus } from '../web-event-bus.js';
import { type SessionDto, type BudgetSummaryDto, type DaemonStatusDto, InvalidParamsError } from '../web-ui-types.js';

// ---------------------------------------------------------------------------
// Shared param schemas
// ---------------------------------------------------------------------------

export const labelSchema = z.object({ label: z.number().int().positive() });

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
  /** Bridge for per-client token stream subscriptions. */
  tokenStreamBridge?: TokenStreamBridge;
  /**
   * Daemon-process capture-traces default. Used by `sessions.create`
   * when the JSON-RPC payload does not include `captureTraces`. See
   * docs/designs/mitm-token-trajectory-capture.md §10.
   */
  readonly captureTracesDefault?: boolean;
  /**
   * Policy-mutation authz gate. When false (the DEFAULT), the policy-mutation
   * surface does not exist: every persona-mutation method
   * (`compileStream` / `create` / `editConstitution` / `setMemory` / `delete` /
   * `setBroadPolicyOptIn`) returns `POLICY_MUTATION_FORBIDDEN`. Read methods
   * (`list` / `get` / `getCompile` / `listCompiles`) stay ungated.
   *
   * Wired (Phase 1c) via the 4-hop `--allow-policy-mutation` daemon flag,
   * mirroring `captureTracesDefault`:
   *   daemon-command.ts (CommandSpec option + parseArgs + read + pass)
   *   -> IronCurtainDaemonOptions.allowPolicyMutation
   *   -> WebUiServerOptions.allowPolicyMutation
   *   -> dispatchCtx.allowPolicyMutation (web-ui-server.ts).
   * Surfaced to the UI via `DaemonStatusDto.allowPolicyMutation` so the UI
   * hides mutation controls. Off by default, CLI-only, not config-persisted.
   */
  readonly allowPolicyMutation?: boolean;
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
    // Phase 1c: surface the policy-mutation kill switch so the UI can hide
    // mutation controls. Defaults to false (off) when the daemon was not
    // launched with `--allow-policy-mutation`.
    allowPolicyMutation: ctx.allowPolicyMutation ?? false,
  };
}
