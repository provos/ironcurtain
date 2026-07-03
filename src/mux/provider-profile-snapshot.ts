/**
 * Provider-profile snapshot for the mux `/new` picker.
 *
 * The mux does not carry a `ResolvedUserConfig`, so the picker has no profile
 * data to show. Following the persona-picker precedent (`scanPersonas()`), this
 * module derives a flat, render-ready snapshot from the resolved
 * `modelProviders` registry. The snapshot is what the profile-picker step
 * renders — mirroring how `scanPersonas()` produces the persona list.
 *
 * See docs/designs/openrouter-integration.md §9.7 (F5).
 */

import { DEFAULT_GLM_SLUG, NATIVE_PROFILE_NAME } from '../config/user-config.js';
import type { ResolvedModelProvidersConfig } from '../config/user-config.js';
import { resolveMappedModel } from '../docker/openrouter.js';

/** A single provider profile as rendered in the `/new` picker. */
export interface ProviderProfileSnapshot {
  /** Profile name (`'native'` or a configured profile key). */
  readonly name: string;
  /** Discriminant used to choose the render label style. */
  readonly type: 'native' | 'openrouter';
  /**
   * Human-readable primary-model label (e.g. `z-ai/glm-5.2 (OpenRouter)` or
   * `Anthropic / OpenAI / ChatGPT`), computed once when the snapshot is built.
   */
  readonly primaryModelLabel: string;
  /** True for the `modelProviders.default` entry. */
  readonly isDefault: boolean;
}

/** Static label for the implicit `native` profile. */
const NATIVE_LABEL = 'Anthropic / OpenAI / ChatGPT';

/**
 * Builds the render-ready profile snapshot for the `/new` picker.
 *
 * `native` is always listed first (it is the implicit, always-present
 * profile), followed by each configured profile in registry order. The
 * `isDefault` flag marks `modelProviders.default`.
 *
 * The openrouter `primaryModelLabel` uses the same Sonnet probe the buildEnv
 * hint uses: `perAgent['claude-code'] ?? resolveMappedModel('claude-sonnet',
 * modelMap) ?? DEFAULT_GLM_SLUG`.
 */
export function buildProviderProfileSnapshots(modelProviders: ResolvedModelProvidersConfig): ProviderProfileSnapshot[] {
  const snapshots: ProviderProfileSnapshot[] = [];
  for (const [name, profile] of Object.entries(modelProviders.profiles)) {
    const isDefault = name === modelProviders.default;
    if (profile.type === 'native') {
      snapshots.push({ name, type: 'native', primaryModelLabel: NATIVE_LABEL, isDefault });
      continue;
    }
    const slug =
      profile.perAgent['claude-code'] ?? resolveMappedModel('claude-sonnet', profile.modelMap) ?? DEFAULT_GLM_SLUG;
    snapshots.push({ name, type: 'openrouter', primaryModelLabel: `${slug} (OpenRouter)`, isDefault });
  }

  // Ensure `native` renders first regardless of record iteration order.
  snapshots.sort((a, b) => {
    if (a.name === NATIVE_PROFILE_NAME) return -1;
    if (b.name === NATIVE_PROFILE_NAME) return 1;
    return 0;
  });
  return snapshots;
}

/**
 * Whether the profile-picker step should be shown. When the only profile is
 * the implicit `native`, the step is skipped entirely for a zero-friction
 * default (§9.7 (3)).
 */
export function hasSelectableProfiles(snapshots: readonly ProviderProfileSnapshot[]): boolean {
  return snapshots.some((s) => s.name !== NATIVE_PROFILE_NAME);
}
