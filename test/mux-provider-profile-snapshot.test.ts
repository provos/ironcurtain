/**
 * Unit tests for the mux `/new` provider-profile snapshot builder (G13 / §9.7 F5).
 *
 * The mux carries no ResolvedUserConfig, so the picker renders from a flat
 * snapshot derived here from `modelProviders`. These tests pin the label
 * formulas, native-first ordering, default marking, and the skip predicate.
 */

import { describe, it, expect } from 'vitest';
import { buildProviderProfileSnapshots, hasSelectableProfiles } from '../src/mux/provider-profile-snapshot.js';
import { DEFAULT_GLM_SLUG, DEFAULT_MODEL_MAP } from '../src/config/user-config.js';
import type {
  DockerAgent,
  ResolvedModelProvidersConfig,
  ResolvedOpenRouterProfile,
} from '../src/config/user-config.js';

function openrouterProfile(overrides: Partial<ResolvedOpenRouterProfile> = {}): ResolvedOpenRouterProfile {
  const { perAgent: perAgentOverride, ...rest } = overrides;
  const perAgent: Record<DockerAgent, string | undefined> = {
    'claude-code': undefined,
    goose: undefined,
    codex: undefined,
    ...perAgentOverride,
  };
  return {
    type: 'openrouter',
    apiKey: 'sk-or-v1-test',
    modelMap: DEFAULT_MODEL_MAP,
    usesDefaultMap: true,
    providerPreference: undefined,
    sessionAffinity: true,
    ...rest,
    perAgent,
  };
}

describe('buildProviderProfileSnapshots', () => {
  it('native-only registry produces a single native entry (marked default)', () => {
    const registry: ResolvedModelProvidersConfig = { default: 'native', profiles: { native: { type: 'native' } } };
    const snaps = buildProviderProfileSnapshots(registry);
    expect(snaps).toEqual([
      { name: 'native', type: 'native', primaryModelLabel: 'Anthropic / OpenAI / ChatGPT', isDefault: true },
    ]);
  });

  it('lists native first, then configured profiles, marking the default', () => {
    const registry: ResolvedModelProvidersConfig = {
      default: 'glm-5.2',
      profiles: {
        native: { type: 'native' },
        'glm-5.2': openrouterProfile(),
        kimi: openrouterProfile({ perAgent: { 'claude-code': 'moonshot/kimi-k3' } }),
      },
    };
    const snaps = buildProviderProfileSnapshots(registry);
    expect(snaps.map((s) => s.name)).toEqual(['native', 'glm-5.2', 'kimi']);
    expect(snaps.find((s) => s.name === 'glm-5.2')?.isDefault).toBe(true);
    expect(snaps.find((s) => s.name === 'native')?.isDefault).toBe(false);
  });

  it('openrouter primaryModelLabel uses the Sonnet probe → GLM slug for the default map', () => {
    const registry: ResolvedModelProvidersConfig = {
      default: 'glm-5.2',
      profiles: { native: { type: 'native' }, 'glm-5.2': openrouterProfile() },
    };
    const label = buildProviderProfileSnapshots(registry).find((s) => s.name === 'glm-5.2')?.primaryModelLabel;
    expect(label).toBe(`${DEFAULT_GLM_SLUG} (OpenRouter)`);
  });

  it('perAgent[claude-code] WINS over the model map for the label', () => {
    const registry: ResolvedModelProvidersConfig = {
      default: 'native',
      profiles: {
        native: { type: 'native' },
        kimi: openrouterProfile({ perAgent: { 'claude-code': 'moonshot/kimi-k3' } }),
      },
    };
    const label = buildProviderProfileSnapshots(registry).find((s) => s.name === 'kimi')?.primaryModelLabel;
    expect(label).toBe('moonshot/kimi-k3 (OpenRouter)');
  });

  it('falls back to DEFAULT_GLM_SLUG when neither perAgent nor a map rule resolves', () => {
    const registry: ResolvedModelProvidersConfig = {
      default: 'native',
      profiles: { native: { type: 'native' }, empty: openrouterProfile({ modelMap: [] }) },
    };
    const label = buildProviderProfileSnapshots(registry).find((s) => s.name === 'empty')?.primaryModelLabel;
    expect(label).toBe(`${DEFAULT_GLM_SLUG} (OpenRouter)`);
  });
});

describe('hasSelectableProfiles', () => {
  it('false when only native is present', () => {
    const registry: ResolvedModelProvidersConfig = { default: 'native', profiles: { native: { type: 'native' } } };
    expect(hasSelectableProfiles(buildProviderProfileSnapshots(registry))).toBe(false);
  });

  it('true when a configured (non-native) profile exists', () => {
    const registry: ResolvedModelProvidersConfig = {
      default: 'glm',
      profiles: { native: { type: 'native' }, glm: openrouterProfile() },
    };
    expect(hasSelectableProfiles(buildProviderProfileSnapshots(registry))).toBe(true);
  });
});
