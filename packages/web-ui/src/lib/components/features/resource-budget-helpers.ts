import type { ResourceBudgetConfigDto, WorkflowBudgetDto } from '$lib/types.js';

export type LimitKey = Exclude<keyof ResourceBudgetConfigDto, 'warnThresholdPercent'>;
export const BUDGET_LIMITS: readonly { key: LimitKey; label: string; hint: string; unit: string; integer: boolean }[] =
  [
    { key: 'maxEstimatedCostUsd', label: 'Estimated cost', hint: 'Recovery threshold', unit: 'USD', integer: false },
    { key: 'maxTotalTokens', label: 'Tokens', hint: 'Turn / recovery threshold', unit: 'tokens', integer: true },
    { key: 'maxSteps', label: 'Steps', hint: 'Turn / recovery threshold', unit: 'steps', integer: true },
    { key: 'maxSessionSeconds', label: 'Turn timeout', hint: 'Per agent turn', unit: 'seconds', integer: false },
  ];

export function formatLimit(key: LimitKey, value: number): string {
  if (key === 'maxEstimatedCostUsd') return `$${value.toFixed(2)}`;
  if (key === 'maxSessionSeconds') return `${value.toLocaleString()}s`;
  return value.toLocaleString();
}

export function budgetUsage(budget: WorkflowBudgetDto, key: LimitKey): number | undefined {
  const usage = budget.usage;
  if (!usage) return undefined;
  if (key === 'maxTotalTokens' && !usage.tokenTrackingAvailable) return undefined;
  if (key === 'maxEstimatedCostUsd') {
    // Container adapters can report cost independently of token tracking.
    // Without either signal, zero is an unknown lower bound, not zero spend.
    return !usage.tokenTrackingAvailable && usage.estimatedCostUsd === 0 ? undefined : usage.estimatedCostUsd;
  }
  if (key === 'maxTotalTokens') return usage.totalTokens;
  if (key === 'maxSteps') return usage.stepCount;
  // Session age cannot be compared with a timeout that restarts each turn.
  return undefined;
}

export function limitProgress(usage: number | undefined, limit: number | null): number | undefined {
  return usage === undefined || limit === null || limit <= 0 ? undefined : (usage / limit) * 100;
}

export function parseResourceBudget(
  values: Record<LimitKey, string>,
  disabled: Record<LimitKey, boolean>,
  warning: string,
): ResourceBudgetConfigDto {
  const limits = {} as Record<LimitKey, number | null>;
  for (const { key, label, integer } of BUDGET_LIMITS) {
    if (disabled[key]) {
      limits[key] = null;
      continue;
    }
    const value = Number(values[key]);
    if (!values[key].trim() || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
      throw new Error(`${label} must be a positive ${integer ? 'whole number' : 'number'}, or disabled.`);
    }
    limits[key] = value;
  }
  const threshold = Number(warning);
  if (!warning.trim() || !Number.isFinite(threshold) || threshold < 1 || threshold > 99) {
    throw new Error('Warning threshold must be between 1 and 99%.');
  }
  return { ...limits, warnThresholdPercent: threshold };
}
