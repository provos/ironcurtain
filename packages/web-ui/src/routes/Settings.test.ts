import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import type { GetModelProvidersDto, SetModelProvidersDto } from '$lib/types.js';

// ---------------------------------------------------------------------------
// Mock the store — declared before importing the component (mirrors
// Personas.test.ts). The component reads `appState.daemonStatus.allowPolicyMutation`
// plus two generation counters, and drives its data through
// getModelProviders() / setModelProviders().
// ---------------------------------------------------------------------------

const mockGet = vi.fn<() => Promise<GetModelProvidersDto>>();
const mockSet = vi.fn<(input: SetModelProvidersDto) => Promise<GetModelProvidersDto>>();

const appStateMock: { daemonStatus: { allowPolicyMutation: boolean } | null } = {
  daemonStatus: { allowPolicyMutation: true },
};
const connectionGenerationMock = { value: 0 };
const configChangedGenerationMock = { value: 0 };

vi.mock('$lib/stores.svelte.js', () => ({
  getModelProviders: (...args: unknown[]) => mockGet(...(args as [])),
  setModelProviders: (...args: unknown[]) => mockSet(...(args as [SetModelProvidersDto])),
  get appState() {
    return appStateMock;
  },
  get connectionGeneration() {
    return connectionGenerationMock;
  },
  get configChangedGeneration() {
    return configChangedGenerationMock;
  },
}));

import Settings from './Settings.svelte';

const MASK = 'sk-...xyz';

function makeRegistry(overrides?: Partial<GetModelProvidersDto>): GetModelProvidersDto {
  return {
    default: 'glm',
    profiles: {
      native: { type: 'native' },
      glm: {
        type: 'openrouter',
        apiKey: MASK,
        modelMap: [{ match: '*sonnet*', model: 'z-ai/glm-5.2' }],
        perAgent: { 'claude-code': undefined, goose: 'z-ai/glm-5.2', codex: undefined },
        providerPreference: { order: ['z-ai'], allowFallbacks: false },
        sessionAffinity: true,
      },
    },
    ...overrides,
  };
}

describe('Settings', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSet.mockReset();
    appStateMock.daemonStatus = { allowPolicyMutation: true };
    connectionGenerationMock.value = 0;
    configChangedGenerationMock.value = 0;
    mockGet.mockResolvedValue(makeRegistry());
    mockSet.mockImplementation((input) => Promise.resolve(makeRegistry({ default: input.default ?? 'native' })));
  });

  it('renders the profile list with native first and non-deletable', async () => {
    render(Settings);
    await vi.waitFor(() => {
      expect(screen.getByTestId('profile-row-native')).toBeTruthy();
      expect(screen.getByTestId('profile-row-glm')).toBeTruthy();
    });
    // native has no edit/delete controls (built-in).
    expect(screen.queryByTestId('edit-profile-native')).toBeNull();
    expect(screen.queryByTestId('delete-profile-native')).toBeNull();
    // glm (openrouter) does.
    expect(screen.getByTestId('edit-profile-glm')).toBeTruthy();
    expect(screen.getByTestId('delete-profile-glm')).toBeTruthy();
  });

  it('shows the default badge on the default profile', async () => {
    render(Settings);
    await vi.waitFor(() => {
      expect(screen.getByTestId('default-badge-glm')).toBeTruthy();
    });
    // native offers a "set default" affordance (it is not the default here).
    expect(screen.getByTestId('set-default-native')).toBeTruthy();
  });

  it('hides all mutation controls on a read-only daemon', async () => {
    appStateMock.daemonStatus = { allowPolicyMutation: false };
    render(Settings);
    await vi.waitFor(() => {
      expect(screen.getByTestId('profile-row-glm')).toBeTruthy();
    });
    expect(screen.queryByTestId('add-profile-button')).toBeNull();
    expect(screen.queryByTestId('edit-profile-glm')).toBeNull();
    expect(screen.queryByTestId('delete-profile-glm')).toBeNull();
    expect(screen.queryByTestId('set-default-native')).toBeNull();
  });

  it('opens the editor pre-filled with every field of the selected profile', async () => {
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('edit-profile-glm')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('edit-profile-glm'));

    const name = screen.getByTestId('profile-name') as HTMLInputElement;
    const apikey = screen.getByTestId('profile-apikey') as HTMLInputElement;
    expect(name.value).toBe('glm');
    expect(apikey.value).toBe(MASK); // masked key shown; leaving it = unchanged
    expect((screen.getByTestId('map-match-0') as HTMLInputElement).value).toBe('*sonnet*');
    expect((screen.getByTestId('map-model-0') as HTMLInputElement).value).toBe('z-ai/glm-5.2');
    expect((screen.getByTestId('peragent-goose') as HTMLInputElement).value).toBe('z-ai/glm-5.2');
    expect((screen.getByTestId('provider-order') as HTMLInputElement).value).toBe('z-ai');
    expect((screen.getByTestId('provider-allow-fallbacks') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('session-affinity') as HTMLInputElement).checked).toBe(true);
  });

  it('save sends the whole record with the masked key preserved for an unedited profile', async () => {
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('edit-profile-glm')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('edit-profile-glm'));
    await fireEvent.click(screen.getByTestId('save-profile-button'));

    await vi.waitFor(() => expect(mockSet).toHaveBeenCalledOnce());
    const arg = mockSet.mock.calls[0][0];
    // Whole record sent; glm present.
    expect(Object.keys(arg.profiles)).toContain('glm');
    const glm = arg.profiles.glm;
    expect(glm.type).toBe('openrouter');
    if (glm.type !== 'openrouter') throw new Error('unreachable');
    // Masked key sent back verbatim (unedited) => backend keeps the stored key.
    expect(glm.apiKey).toBe(MASK);
    // Every field survived the get→edit→save cycle.
    expect(glm.modelMap).toEqual([{ match: '*sonnet*', model: 'z-ai/glm-5.2' }]);
    expect(glm.perAgent).toEqual({ goose: 'z-ai/glm-5.2' });
    expect(glm.providerPreference).toEqual({ order: ['z-ai'], allowFallbacks: false });
    expect(glm.sessionAffinity).toBe(true);
  });

  it('save sends the new key when the apiKey field is edited', async () => {
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('edit-profile-glm')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('edit-profile-glm'));
    await fireEvent.input(screen.getByTestId('profile-apikey'), { target: { value: 'sk-or-v1-NEW' } });
    await fireEvent.click(screen.getByTestId('save-profile-button'));

    await vi.waitFor(() => expect(mockSet).toHaveBeenCalledOnce());
    const glm = mockSet.mock.calls[0][0].profiles.glm;
    if (glm.type !== 'openrouter') throw new Error('unreachable');
    expect(glm.apiKey).toBe('sk-or-v1-NEW');
  });

  it('setting a different default resends the whole record with the new default', async () => {
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('set-default-native')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('set-default-native'));

    await vi.waitFor(() => expect(mockSet).toHaveBeenCalledOnce());
    const arg = mockSet.mock.calls[0][0];
    expect(arg.default).toBe('native');
    // glm preserved in the whole-record send.
    expect(Object.keys(arg.profiles)).toContain('glm');
  });

  it('delete resends the record without the deleted profile', async () => {
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('delete-profile-glm')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('delete-profile-glm'));
    await vi.waitFor(() => expect(screen.getByTestId('confirm-delete-profile')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('confirm-delete-profile'));

    await vi.waitFor(() => expect(mockSet).toHaveBeenCalledOnce());
    const arg = mockSet.mock.calls[0][0];
    expect(Object.keys(arg.profiles)).not.toContain('glm');
    // default sent as-is; backend re-points to native (F10) if needed.
    expect(arg.default).toBe('glm');
  });

  it('adds a new profile with a fresh name', async () => {
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('add-profile-button')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('add-profile-button'));
    await fireEvent.input(screen.getByTestId('profile-name'), { target: { value: 'kimi' } });
    await fireEvent.input(screen.getByTestId('profile-apikey'), { target: { value: 'sk-or-v1-KIMI' } });
    await fireEvent.click(screen.getByTestId('save-profile-button'));

    await vi.waitFor(() => expect(mockSet).toHaveBeenCalledOnce());
    const arg = mockSet.mock.calls[0][0];
    // Whole record: existing glm carried + the new kimi.
    expect(Object.keys(arg.profiles).sort()).toEqual(['glm', 'kimi']);
    const kimi = arg.profiles.kimi;
    if (kimi.type !== 'openrouter') throw new Error('unreachable');
    expect(kimi.apiKey).toBe('sk-or-v1-KIMI');
  });

  it('rejects the reserved native name in the add flow', async () => {
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('add-profile-button')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('add-profile-button'));
    await fireEvent.input(screen.getByTestId('profile-name'), { target: { value: 'native' } });
    await fireEvent.click(screen.getByTestId('save-profile-button'));

    // No RPC issued; an inline error is shown.
    expect(mockSet).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(screen.getByTestId('editor-error')).toBeTruthy());
  });
});
