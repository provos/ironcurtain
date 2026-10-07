import type { ResolvedOpenRouterProfile } from './user-config.js';

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
