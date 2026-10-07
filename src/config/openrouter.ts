import type { ResolvedOpenRouterProfile } from './user-config.js';
import type { GatewayProfile, GatewayRequestFields } from './provider-definitions.js';

/** Shared host/proxy fields; configured constraints replace the default affinity hint. */
export function openRouterRequestFields(
  profile: Pick<GatewayProfile, 'providerPreference'>,
  model: string,
): GatewayRequestFields | undefined {
  const preference =
    profile.providerPreference !== undefined
      ? providerPreferenceToWire(profile.providerPreference)
      : model.startsWith('z-ai/')
        ? { order: ['z-ai'] }
        : undefined;
  return preference === undefined
    ? undefined
    : {
        body: { provider: preference },
        auditLabels: { provider: profile.providerPreference === undefined ? 'provider:default-z-ai' : 'provider:pin' },
      };
}

/** Shared host/container serialization for OpenRouter routing constraints. */
export function providerPreferenceToWire(
  pref: NonNullable<ResolvedOpenRouterProfile['providerPreference']>,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  if (pref.order !== undefined) wire.order = [...pref.order];
  if (pref.only !== undefined) wire.only = [...pref.only];
  if (pref.allowFallbacks !== undefined) wire.allow_fallbacks = pref.allowFallbacks;
  return wire;
}
