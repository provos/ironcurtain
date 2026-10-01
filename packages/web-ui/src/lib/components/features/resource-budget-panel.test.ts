import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import type { WorkflowBudgetDto } from '$lib/types.js';
import ResourceBudgetPanel from './resource-budget-panel.svelte';

const budget: WorkflowBudgetDto = {
  limits: {
    maxEstimatedCostUsd: 5,
    maxTotalTokens: null,
    maxSteps: 200,
    maxSessionSeconds: 1800,
    warnThresholdPercent: 80,
  },
  sources: {
    maxEstimatedCostUsd: 'default',
    maxTotalTokens: 'workflow',
    maxSteps: 'global',
    maxSessionSeconds: 'default',
    warnThresholdPercent: 'default',
  },
  recorded: true,
  usage: {
    estimatedCostUsd: 7.12,
    totalTokens: 2000,
    stepCount: 2,
    elapsedSeconds: 8000,
    tokenTrackingAvailable: true,
  },
};

describe('ResourceBudgetPanel', () => {
  it('shows usage overshoot, limit provenance and explicit disabled state', () => {
    render(ResourceBudgetPanel, { budget });
    const cost = within(screen.getByTestId('budget-maxEstimatedCostUsd'));
    expect(cost.getByText('$5.00')).toBeTruthy();
    expect(cost.getByText('default')).toBeTruthy();
    expect(cost.getByText('$7.12 used · Limit reached')).toBeTruthy();
    expect(cost.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    expect(within(screen.getByTestId('budget-maxTotalTokens')).getByText('Disabled')).toBeTruthy();
    expect(within(screen.getByTestId('budget-maxSessionSeconds')).queryByRole('progressbar')).toBeNull();
  });
  it('identifies sampled usage when parallel sessions are active', () => {
    render(ResourceBudgetPanel, { budget: { ...budget, activeSessionCount: 3 } });
    expect(screen.getByText('1 of 3 active agent sessions')).toBeTruthy();
    expect(screen.getByTestId('budget-sampled-note').textContent).toContain('not aggregated');
    expect(screen.getByText('$7.12 used · Limit reached')).toBeTruthy();
  });
  it('does not imply zero spend or known historical limits for legacy runs', () => {
    render(ResourceBudgetPanel, { budget: { ...budget, recorded: false } });
    expect(screen.getByTestId('budget-legacy-note')).toBeTruthy();
    expect(screen.getAllByText('Usage unavailable')).toHaveLength(3);
    expect(screen.queryByText('$7.12 used · Limit reached')).toBeNull();
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  });
  it('preview shows effective settings without usage or historical caveats', () => {
    render(ResourceBudgetPanel, { budget: { ...budget, recorded: false }, preview: true });
    expect(screen.getByText('Effective settings for this run')).toBeTruthy();
    expect(screen.queryByTestId('budget-legacy-note')).toBeNull();
    expect(screen.queryByText('Usage unavailable')).toBeNull();
  });
});
