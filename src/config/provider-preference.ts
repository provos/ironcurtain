/**
 * Deep-clones a provider preference into a fresh mutable object, copying the
 * `order`/`only` arrays so callers can't alias the source. Shared by the config
 * editor and the web-ui dispatch, which convert between the resolved, DTO, and
 * input shapes with an identical field copy.
 */
export function cloneProviderPreference(pref: {
  readonly order?: readonly string[];
  readonly only?: readonly string[];
  readonly allowFallbacks?: boolean;
}): { order?: string[]; only?: string[]; allowFallbacks?: boolean } {
  return {
    order: pref.order ? [...pref.order] : undefined,
    only: pref.only ? [...pref.only] : undefined,
    allowFallbacks: pref.allowFallbacks,
  };
}
