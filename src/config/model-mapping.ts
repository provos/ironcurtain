/** Provider-independent ordered model mapping. */
const REGEX_METACHARS = /[.+?^${}()|[\]\\]/g;
const GLOB_REGEX_CACHE = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = GLOB_REGEX_CACHE.get(glob);
  if (cached) return cached;
  const pattern = new RegExp(`^${glob.replace(REGEX_METACHARS, '\\$&').replace(/\*/g, '.*')}$`, 'i');
  GLOB_REGEX_CACHE.set(glob, pattern);
  return pattern;
}

export function resolveMappedModel(
  requestedModel: string,
  rules: readonly { readonly match: string; readonly model: string }[],
): string | undefined {
  return rules.find((rule) => globToRegExp(rule.match).test(requestedModel))?.model;
}
