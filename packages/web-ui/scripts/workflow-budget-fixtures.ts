import type { ResourceBudgetConfigDto, WorkflowBudgetDto } from '../src/lib/types.js';

export type ResourceBudgetFixture = ResourceBudgetConfigDto;
export type WorkflowBudgetFixture = WorkflowBudgetDto;

export type WorkflowBudgetScenario = 'normal' | 'no-usage' | 'legacy';

export const DEFAULT_RESOURCE_BUDGET: ResourceBudgetFixture = {
  maxTotalTokens: 1_000_000,
  maxSteps: 200,
  maxSessionSeconds: 1800,
  maxEstimatedCostUsd: 5,
  warnThresholdPercent: 80,
};

export function validateResourceBudget(value: Record<string, unknown>): boolean {
  const keys = Object.keys(DEFAULT_RESOURCE_BUDGET) as (keyof ResourceBudgetFixture)[];
  if (Object.keys(value).some((key) => !keys.includes(key as keyof ResourceBudgetFixture))) return false;
  return keys.every((key) => {
    const field = value[key];
    if (key === 'warnThresholdPercent') {
      return typeof field === 'number' && Number.isFinite(field) && field >= 1 && field <= 99;
    }
    if (field === null) return true;
    if (typeof field !== 'number' || !Number.isFinite(field) || field <= 0) return false;
    return key !== 'maxTotalTokens' && key !== 'maxSteps' ? true : Number.isSafeInteger(field);
  });
}

/** Simulate two bundled YAML overrides, plus inheritance for custom definitions. */
export function buildBudgetPreview(
  definitionPath: string,
  globalLimits: ResourceBudgetFixture,
  globalConfigured: boolean,
): WorkflowBudgetFixture {
  const limits = { ...globalLimits };
  const sources = Object.fromEntries(
    Object.keys(limits).map((key) => [key, globalConfigured ? 'global' : 'default']),
  ) as WorkflowBudgetFixture['sources'];
  if (definitionPath.includes('design-and-code')) {
    limits.maxEstimatedCostUsd = 20;
    limits.maxSessionSeconds = 21_600;
    sources.maxEstimatedCostUsd = 'workflow';
    sources.maxSessionSeconds = 'workflow';
  } else if (definitionPath.includes('code-review')) {
    for (const key of ['maxTotalTokens', 'maxSteps', 'maxSessionSeconds', 'maxEstimatedCostUsd'] as const) {
      limits[key] = null;
      sources[key] = 'workflow';
    }
  }
  return { limits, sources, recorded: true };
}

export function buildRunBudget(
  name: string,
  globalLimits: ResourceBudgetFixture,
  globalConfigured: boolean,
  scenario: WorkflowBudgetScenario = 'normal',
): WorkflowBudgetFixture {
  const budget = buildBudgetPreview(name, globalLimits, globalConfigured);
  if (scenario === 'legacy') return { ...budget, recorded: false };
  if (scenario === 'no-usage' || name.includes('code-review')) return budget;
  return {
    ...budget,
    usage: {
      totalTokens: 850_000,
      stepCount: 170,
      elapsedSeconds: 1200,
      estimatedCostUsd: 17,
      tokenTrackingAvailable: true,
    },
  };
}
