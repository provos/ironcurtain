import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import type { GetModelProvidersDto, SetModelProvidersDto, OpenrouterModelsDto } from '$lib/types.js';

// ---------------------------------------------------------------------------
// Mock the store — declared before importing the component (mirrors
// Personas.test.ts). The component reads `appState.daemonStatus.allowPolicyMutation`
// plus two generation counters, and drives its data through
// getModelProviders() / setModelProviders().
// ---------------------------------------------------------------------------

const mockGet = vi.fn<() => Promise<GetModelProvidersDto>>();
const mockSet = vi.fn<(input: SetModelProvidersDto) => Promise<GetModelProvidersDto>>();
const mockList = vi.fn<() => Promise<OpenrouterModelsDto>>();

// A realistic catalog covering every fixture slug (incl. z-ai/glm-5.2) plus a
// few glm variants for the filter/keyboard test. Used as the SAFE default so the
// pre-existing save tests never hard-block on an in-flight/known slug.
const CATALOG_SLUGS = [
  'anthropic/claude-3.7-sonnet',
  'moonshotai/kimi-k2',
  'openai/gpt-5',
  'z-ai/glm-4.6',
  'z-ai/glm-5.2',
];

const appStateMock: { daemonStatus: { allowPolicyMutation: boolean } | null } = {
  daemonStatus: { allowPolicyMutation: true },
};
const connectionGenerationMock = { value: 0 };
const configChangedGenerationMock = { value: 0 };

vi.mock('$lib/stores.svelte.js', () => ({
  getModelProviders: (...args: unknown[]) => mockGet(...(args as [])),
  setModelProviders: (...args: unknown[]) => mockSet(...(args as [SetModelProvidersDto])),
  listOpenrouterModels: (...args: unknown[]) => mockList(...(args as [])),
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
    mockList.mockReset();
    appStateMock.daemonStatus = { allowPolicyMutation: true };
    connectionGenerationMock.value = 0;
    configChangedGenerationMock.value = 0;
    mockGet.mockResolvedValue(makeRegistry());
    mockSet.mockImplementation((input) => Promise.resolve(makeRegistry({ default: input.default ?? 'native' })));
    // SAFE default: bundled (warn-only) AND a list covering every fixture slug —
    // so opening/saving existing profiles never spuriously hard-blocks.
    mockList.mockResolvedValue({ models: CATALOG_SLUGS, source: 'bundled' });
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
    // glm carries an explicit map, so the "use default map" toggle is OFF and the
    // custom-rules editor is shown.
    expect((screen.getByTestId('map-use-default') as HTMLInputElement).checked).toBe(false);
  });

  it('presents a default-tracking profile as "use default map", not an empty/per-agent map', async () => {
    // A profile that OMITS modelMap tracks IronCurtain's built-in defaults. The
    // editor must say so — never render a bare, empty rules list that reads as
    // "nothing configured" or the misleading "per-agent only" note.
    mockGet.mockResolvedValue({
      default: 'glm',
      profiles: {
        native: { type: 'native' },
        tracked: {
          type: 'openrouter',
          apiKey: MASK,
          // modelMap omitted → default-tracking
          perAgent: { 'claude-code': undefined, goose: undefined, codex: undefined },
          sessionAffinity: true,
        },
      },
    });
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('edit-profile-tracked')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('edit-profile-tracked'));

    // Toggle ON; the rules editor and its "per-agent only" note are hidden.
    const useDefault = screen.getByTestId('map-use-default') as HTMLInputElement;
    expect(useDefault.checked).toBe(true);
    expect(screen.queryByTestId('map-add')).toBeNull();
    expect(screen.queryByTestId('map-match-0')).toBeNull();

    // Unchecking enters custom mode and seeds an editable row (not silently empty).
    await fireEvent.click(useDefault);
    expect((screen.getByTestId('map-use-default') as HTMLInputElement).checked).toBe(false);
    await vi.waitFor(() => expect(screen.getByTestId('map-add')).toBeTruthy());
    expect(screen.getByTestId('map-match-0')).toBeTruthy();
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

  // ── Model autocomplete + save-time slug validation (Unit B) ───────────────

  it('opens the model dropdown on focus, filters as you type, and commits with the keyboard', async () => {
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('edit-profile-glm')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('edit-profile-glm'));

    const model0 = screen.getByTestId('map-model-0') as HTMLInputElement;
    await fireEvent.focus(model0);
    // Popover (portaled to <body>) opens with options.
    await vi.waitFor(() => expect(screen.getByTestId('model-combobox-listbox')).toBeTruthy());

    // Typing filters to glm slugs (case-insensitive substring).
    await fireEvent.input(model0, { target: { value: 'glm' } });
    await vi.waitFor(() => {
      const opts = screen.getAllByTestId(/^model-combobox-option-/);
      expect(opts.length).toBeGreaterThan(0);
      for (const o of opts) expect(o.textContent).toContain('glm');
    });

    // ArrowDown highlights the first option; Enter commits it into map-model-0.
    await fireEvent.keyDown(model0, { key: 'ArrowDown' });
    await fireEvent.keyDown(model0, { key: 'Enter' });
    expect(model0.value).toContain('glm');
    expect(CATALOG_SLUGS).toContain(model0.value);
    // Popover closed after commit.
    expect(screen.queryByTestId('model-combobox-listbox')).toBeNull();
  });

  it('hard-blocks an unknown slug under an authoritative (live) source', async () => {
    // Live catalog that EXCLUDES the garbage slug the user types.
    mockList.mockResolvedValue({ models: CATALOG_SLUGS, source: 'live' });
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('add-profile-button')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('add-profile-button'));
    await fireEvent.input(screen.getByTestId('profile-name'), { target: { value: 'kimi' } });

    // Wait for the live list to load: the "Partial list (offline)" badge (shown
    // only for the bundled default) disappears once source flips to live.
    await vi.waitFor(() => expect(screen.queryAllByTestId('model-combobox-source').length).toBe(0));

    await fireEvent.input(screen.getByTestId('peragent-goose'), { target: { value: 'garbage/model' } });
    await fireEvent.click(screen.getByTestId('save-profile-button'));

    // Save aborted: no RPC, error names the slug, and the field is marked invalid.
    expect(mockSet).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(screen.getByTestId('editor-error')).toBeTruthy());
    expect(screen.getByTestId('editor-error').textContent).toContain('garbage/model');
    expect(screen.getByTestId('peragent-goose').getAttribute('aria-invalid')).toBe('true');
  });

  it('warn-degrades (saves) an unknown slug under the bundled fallback', async () => {
    // Default mock is bundled; the garbage slug is unknown but only warns.
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('add-profile-button')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('add-profile-button'));
    await fireEvent.input(screen.getByTestId('profile-name'), { target: { value: 'kimi' } });
    await fireEvent.input(screen.getByTestId('peragent-goose'), { target: { value: 'garbage/model' } });
    await fireEvent.click(screen.getByTestId('save-profile-button'));

    // Persisted despite the unknown slug; a non-blocking warning note is shown.
    await vi.waitFor(() => expect(mockSet).toHaveBeenCalledOnce());
    const kimi = mockSet.mock.calls[0][0].profiles.kimi;
    if (kimi.type !== 'openrouter') throw new Error('unreachable');
    expect(kimi.perAgent).toEqual({ goose: 'garbage/model' });
    await vi.waitFor(() => expect(screen.getByTestId('slug-warning')).toBeTruthy());
    expect(screen.getByTestId('slug-warning').textContent).toContain('garbage/model');
  });

  it('saves a bundled-legit slug typed by hand with no warning', async () => {
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('add-profile-button')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('add-profile-button'));
    await fireEvent.input(screen.getByTestId('profile-name'), { target: { value: 'kimi' } });
    await fireEvent.input(screen.getByTestId('peragent-goose'), { target: { value: 'z-ai/glm-4.6' } });
    await fireEvent.click(screen.getByTestId('save-profile-button'));

    await vi.waitFor(() => expect(mockSet).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('slug-warning')).toBeNull();
  });

  it('grandfathers an untouched persisted slug even under a live source (key-rotation)', async () => {
    // glm's persisted slug z-ai/glm-5.2 is NOT in this live list, but it was
    // already saved — editing only the API key must not trap it.
    mockList.mockResolvedValue({ models: ['anthropic/claude-3.7-sonnet'], source: 'live' });
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('edit-profile-glm')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('edit-profile-glm'));
    await vi.waitFor(() => expect(screen.queryAllByTestId('model-combobox-source').length).toBe(0));
    // Rotate the key only; leave the (now-delisted) slug untouched.
    await fireEvent.input(screen.getByTestId('profile-apikey'), { target: { value: 'sk-or-v1-ROTATED' } });
    await fireEvent.click(screen.getByTestId('save-profile-button'));

    await vi.waitFor(() => expect(mockSet).toHaveBeenCalledOnce());
    const glm = mockSet.mock.calls[0][0].profiles.glm;
    if (glm.type !== 'openrouter') throw new Error('unreachable');
    expect(glm.apiKey).toBe('sk-or-v1-ROTATED');
    expect(glm.modelMap).toEqual([{ match: '*sonnet*', model: 'z-ai/glm-5.2' }]);
  });

  it('shows the "Partial list (offline)" badge for bundled and hides it for live', async () => {
    // Bundled (default) → badge present on the editor's slug fields.
    const { unmount } = render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('edit-profile-glm')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('edit-profile-glm'));
    await vi.waitFor(() => expect(screen.getAllByTestId('model-combobox-source').length).toBeGreaterThan(0));
    unmount();

    // Live → no bundled badge.
    mockList.mockResolvedValue({ models: CATALOG_SLUGS, source: 'live' });
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('edit-profile-glm')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('edit-profile-glm'));
    await vi.waitFor(() => expect(screen.queryAllByTestId('model-combobox-source').length).toBe(0));
  });

  it('the Refresh button forces a catalog re-fetch with forceRefresh=true', async () => {
    render(Settings);
    await vi.waitFor(() => expect(screen.getByTestId('edit-profile-glm')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('edit-profile-glm'));
    // Let the on-open load settle (the Refresh button re-enables once modelsLoading clears).
    await vi.waitFor(() => expect((screen.getByTestId('model-refresh') as HTMLButtonElement).disabled).toBe(false));
    mockList.mockClear();
    await fireEvent.click(screen.getByTestId('model-refresh'));
    // Re-fetches even though the catalog already loaded this session, and with force=true.
    await vi.waitFor(() => expect(mockList).toHaveBeenCalledWith(true));
  });
});
