import {
  loadRequestedResourceBudgetConfig,
  USER_CONFIG_DEFAULTS,
  type ResolvedResourceBudgetConfig,
} from '../config/user-config.js';
import type { BudgetStatus } from '../session/types.js';
import type { WorkflowSettings } from './types.js';

export type ResourceBudgetSource = 'workflow' | 'global' | 'default';

/** Snapshot of the effective settings, including where each value came from. */
export interface WorkflowBudget {
  readonly limits: ResolvedResourceBudgetConfig;
  readonly sources: Record<keyof ResolvedResourceBudgetConfig, ResourceBudgetSource>;
  readonly recorded: boolean;
  /** Number of concurrent agent sessions; usage describes one session, never their sum. */
  readonly activeSessionCount?: number;
  /** Tokens, steps and cost are cumulative agent-session totals. Time follows the session's tracker. */
  readonly usage?: {
    readonly totalTokens: number;
    readonly stepCount: number;
    readonly elapsedSeconds: number;
    readonly estimatedCostUsd: number;
    readonly tokenTrackingAvailable: boolean;
  };
}

/** Shared by previews, orchestrated runs and the single-state CLI. */
export function resolveWorkflowResourceBudget(
  settings?: WorkflowSettings,
  global: Partial<ResolvedResourceBudgetConfig> = loadRequestedResourceBudgetConfig(),
): WorkflowBudget {
  const overrides = { ...settings?.resourceBudget };
  if (settings?.maxSessionSeconds !== undefined) overrides.maxSessionSeconds = settings.maxSessionSeconds;
  const limits = { ...USER_CONFIG_DEFAULTS.resourceBudget } as ResolvedResourceBudgetConfig;
  const sources = {} as WorkflowBudget['sources'];
  for (const key of Object.keys(limits) as (keyof ResolvedResourceBudgetConfig)[]) {
    const value = overrides[key] !== undefined ? overrides[key] : global[key];
    sources[key] = overrides[key] !== undefined ? 'workflow' : global[key] !== undefined ? 'global' : 'default';
    if (value !== undefined) Object.assign(limits, { [key]: value });
  }
  return { limits, sources, recorded: true };
}

export function workflowBudgetUsage(status: BudgetStatus): NonNullable<WorkflowBudget['usage']> {
  return {
    totalTokens: status.cumulative.totalTokens,
    stepCount: status.cumulative.stepCount,
    estimatedCostUsd: status.cumulative.estimatedCostUsd,
    elapsedSeconds: status.elapsedSeconds,
    tokenTrackingAvailable: status.tokenTrackingAvailable,
  };
}

/** Historical limits must never be invented for a checkpoint without a snapshot. */
export function legacyWorkflowBudget(settings?: WorkflowSettings): WorkflowBudget {
  return { ...resolveWorkflowResourceBudget(settings), recorded: false };
}
