import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { testConnectionGeneration, testConfigChangedGeneration } from '../../../routes/__test_state__.svelte.js';
import type { ResourceBudgetConfigDto } from '$lib/types.js';

const { getBudget, setBudget, state } = vi.hoisted(() => ({
  getBudget: vi.fn<() => Promise<ResourceBudgetConfigDto>>(),
  setBudget: vi.fn<(value: ResourceBudgetConfigDto) => Promise<ResourceBudgetConfigDto>>(),
  state: { daemonStatus: { allowPolicyMutation: true } },
}));
vi.mock('$lib/stores.svelte.js', async () => {
  const { testConnectionGeneration, testConfigChangedGeneration } =
    await import('../../../routes/__test_state__.svelte.js');
  return {
    getResourceBudget: () => getBudget(),
    setResourceBudget: (value: ResourceBudgetConfigDto) => setBudget(value),
    appState: state,
    connectionGeneration: testConnectionGeneration,
    configChangedGeneration: testConfigChangedGeneration,
  };
});
import ResourceLimitsSettings from './resource-limits-settings.svelte';

const defaults: ResourceBudgetConfigDto = {
  maxTotalTokens: 1000000,
  maxSteps: 200,
  maxSessionSeconds: 1800,
  maxEstimatedCostUsd: 5,
  warnThresholdPercent: 80,
};

beforeEach(() => {
  vi.clearAllMocks();
  testConnectionGeneration.value = 0;
  testConfigChangedGeneration.value = 0;
  state.daemonStatus.allowPolicyMutation = true;
  getBudget.mockResolvedValue(defaults);
  setBudget.mockImplementation(async (value) => value);
});

async function loaded(): Promise<void> {
  await vi.waitFor(() => expect(screen.getByTestId('budget-input-maxEstimatedCostUsd')).toBeTruthy());
}

describe('ResourceLimitsSettings', () => {
  it('reads once when mounted after connecting and refreshes without clobbering edits', async () => {
    testConnectionGeneration.value = 1;
    render(ResourceLimitsSettings);
    await loaded();
    expect(getBudget).toHaveBeenCalledTimes(1);
    getBudget.mockResolvedValue({ ...defaults, maxSteps: 500 });
    testConfigChangedGeneration.value++;
    await vi.waitFor(() => expect((screen.getByTestId('budget-input-maxSteps') as HTMLInputElement).value).toBe('500'));
    expect(getBudget).toHaveBeenCalledTimes(2);
    await fireEvent.input(screen.getByTestId('budget-input-maxSteps'), { target: { value: '12' } });
    testConnectionGeneration.value++;
    await tick();
    expect(getBudget).toHaveBeenCalledTimes(2);
    expect((screen.getByTestId('budget-input-maxSteps') as HTMLInputElement).value).toBe('12');
  });
  it('saves explicit null, keeps existing limits and permits discarding unsaved edits', async () => {
    render(ResourceLimitsSettings);
    await loaded();
    await fireEvent.click(screen.getByTestId('budget-disable-maxEstimatedCostUsd'));
    expect((screen.getByTestId('budget-input-maxEstimatedCostUsd') as HTMLInputElement).disabled).toBe(true);
    await fireEvent.click(screen.getByTestId('budget-save'));
    await vi.waitFor(() => expect(setBudget).toHaveBeenCalledWith({ ...defaults, maxEstimatedCostUsd: null }));
    await vi.waitFor(() => expect(screen.getByRole('status').textContent).toContain('saved'));
    await fireEvent.input(screen.getByTestId('budget-input-maxSteps'), { target: { value: '12' } });
    await fireEvent.click(screen.getByTestId('budget-reset'));
    expect((screen.getByTestId('budget-input-maxSteps') as HTMLInputElement).value).toBe('200');
    expect(getBudget).toHaveBeenCalledTimes(1);
  });
  it('validates invalid enabled limits and retains unsaved edits after RPC failure', async () => {
    render(ResourceLimitsSettings);
    await loaded();
    await fireEvent.input(screen.getByTestId('budget-input-maxSteps'), { target: { value: '1.2' } });
    expect(screen.getByRole('alert').textContent).toContain('whole number');
    expect((screen.getByTestId('budget-save') as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(screen.getByTestId('budget-input-maxSteps'), { target: { value: '12' } });
    setBudget.mockRejectedValue(new Error('Write failed'));
    await fireEvent.click(screen.getByTestId('budget-save'));
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Write failed'));
    expect((screen.getByTestId('budget-input-maxSteps') as HTMLInputElement).value).toBe('12');
  });
  it('honors configuration mutation permission and does not offer save controls', async () => {
    state.daemonStatus.allowPolicyMutation = false;
    render(ResourceLimitsSettings);
    await loaded();
    expect((screen.getByTestId('budget-disable-maxEstimatedCostUsd') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('budget-input-maxSteps') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('budget-save')).toBeNull();
    expect(setBudget).not.toHaveBeenCalled();
  });
  it('allows retrying the independent resource settings read after failure', async () => {
    getBudget.mockRejectedValueOnce(new Error('Read failed'));
    render(ResourceLimitsSettings);
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Read failed'));
    await fireEvent.click(screen.getByRole('button', { name: 'Retry loading resource limits' }));
    await loaded();
    expect(getBudget).toHaveBeenCalledTimes(2);
  });
});
