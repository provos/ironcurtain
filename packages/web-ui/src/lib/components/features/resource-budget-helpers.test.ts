import { describe, it, expect } from 'vitest';
import type { WorkflowBudgetDto } from '$lib/types.js';
import { budgetUsage, limitProgress, parseResourceBudget } from './resource-budget-helpers.js';

const values = { maxTotalTokens: '1000', maxSteps: '12', maxSessionSeconds: '120', maxEstimatedCostUsd: '5.5' };
const enabled = { maxTotalTokens: false, maxSteps: false, maxSessionSeconds: false, maxEstimatedCostUsd: false };

describe('resource budget values', () => {
  it('preserves explicit disabled limits and validates whole steps', () => {
    expect(parseResourceBudget(values, { ...enabled, maxEstimatedCostUsd: true }, '80').maxEstimatedCostUsd).toBeNull();
    expect(() => parseResourceBudget({ ...values, maxSteps: '1.5' }, enabled, '80')).toThrow('whole number');
    for (const invalid of ['', '0', 'Infinity', '-1', 'abc', '9007199254740992']) {
      expect(() => parseResourceBudget({ ...values, maxTotalTokens: invalid }, enabled, '80')).toThrow();
    }
    expect(() => parseResourceBudget(values, enabled, '100')).toThrow('1 and 99');
  });
  it('never invents usage or compares cumulative session age with turn timeout', () => {
    const budget = {
      usage: { totalTokens: 0, stepCount: 0, elapsedSeconds: 999, estimatedCostUsd: 2, tokenTrackingAvailable: false },
    } as WorkflowBudgetDto;
    expect(budgetUsage(budget, 'maxTotalTokens')).toBeUndefined();
    expect(budgetUsage(budget, 'maxEstimatedCostUsd')).toBe(2);
    expect(budgetUsage(budget, 'maxSteps')).toBe(0);
    expect(budgetUsage(budget, 'maxSessionSeconds')).toBeUndefined();
    expect(budgetUsage({} as WorkflowBudgetDto, 'maxEstimatedCostUsd')).toBeUndefined();
  });
  it('reports overshoot without imposing a progress value on disabled limits', () => {
    expect(limitProgress(7.12, 5)).toBeCloseTo(142.4);
    expect(limitProgress(7.12, null)).toBeUndefined();
    expect(limitProgress(undefined, 5)).toBeUndefined();
  });
});
