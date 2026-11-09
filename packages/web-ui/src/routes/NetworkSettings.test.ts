import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { testConnectionGeneration, testConfigChangedGeneration } from './__test_state__.svelte.js';
import type { NetworkSettingsDto } from '$lib/types.js';

const { getNetwork, setNetwork, state } = vi.hoisted(() => ({
  getNetwork: vi.fn<() => Promise<NetworkSettingsDto>>(),
  setNetwork: vi.fn<(value: NetworkSettingsDto) => Promise<NetworkSettingsDto>>(),
  state: { daemonStatus: { allowPolicyMutation: true } },
}));
vi.mock('$lib/stores.svelte.js', async () => {
  const { testConnectionGeneration, testConfigChangedGeneration } = await import('./__test_state__.svelte.js');
  return {
    getNetworkSettings: () => getNetwork(),
    setNetworkSettings: (value: NetworkSettingsDto) => setNetwork(value),
    appState: state,
    connectionGeneration: testConnectionGeneration,
    configChangedGeneration: testConfigChangedGeneration,
  };
});
import NetworkSettings from './NetworkSettings.svelte';

beforeEach(() => {
  vi.clearAllMocks();
  testConnectionGeneration.value = 0;
  testConfigChangedGeneration.value = 0;
  state.daemonStatus.allowPolicyMutation = true;
  getNetwork.mockResolvedValue({ allowPrivateNetworkAccess: false });
  setNetwork.mockImplementation(async (value) => value);
});

async function loaded(): Promise<HTMLInputElement> {
  await vi.waitFor(() => expect(screen.getByTestId('allow-private-network-access')).toBeTruthy());
  return screen.getByTestId('allow-private-network-access') as HTMLInputElement;
}

describe('NetworkSettings', () => {
  it('starts disabled, saves the toggle, and permits disabling it again', async () => {
    render(NetworkSettings);
    const checkbox = await loaded();
    expect(checkbox.checked).toBe(false);
    await fireEvent.click(checkbox);
    await fireEvent.click(screen.getByTestId('save-network-settings'));
    await vi.waitFor(() => expect(screen.getByRole('status').textContent).toContain('saved'));
    expect(setNetwork).toHaveBeenLastCalledWith({ allowPrivateNetworkAccess: true });
    await fireEvent.click(checkbox);
    await fireEvent.click(screen.getByTestId('save-network-settings'));
    await vi.waitFor(() => expect(setNetwork).toHaveBeenLastCalledWith({ allowPrivateNetworkAccess: false }));
  });

  it('refreshes on config events without replacing unsaved edits', async () => {
    render(NetworkSettings);
    const checkbox = await loaded();
    await fireEvent.click(checkbox);
    testConfigChangedGeneration.value++;
    await tick();
    expect(getNetwork).toHaveBeenCalledTimes(1);
    expect(checkbox.checked).toBe(true);
    await fireEvent.click(checkbox);
    getNetwork.mockResolvedValue({ allowPrivateNetworkAccess: true });
    testConfigChangedGeneration.value++;
    await vi.waitFor(() => expect(checkbox.checked).toBe(true));
  });

  it('honors the mutation gate', async () => {
    state.daemonStatus.allowPolicyMutation = false;
    render(NetworkSettings);
    expect((await loaded()).disabled).toBe(true);
    expect(screen.queryByTestId('save-network-settings')).toBeNull();
  });

  it('supports retry after a failed read and preserves edits after a failed write', async () => {
    getNetwork.mockRejectedValueOnce(new Error('Read failed'));
    render(NetworkSettings);
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Read failed'));
    expect(screen.queryByTestId('save-network-settings')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry loading network settings' }));
    const checkbox = await loaded();
    await fireEvent.click(checkbox);
    setNetwork.mockRejectedValueOnce(new Error('Write failed'));
    await fireEvent.click(screen.getByTestId('save-network-settings'));
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Write failed'));
    expect(checkbox.checked).toBe(true);
  });
});
