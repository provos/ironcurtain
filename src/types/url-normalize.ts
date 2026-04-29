/**
 * URL canonicalizers used by the ArgumentRole registry.
 *
 * These pure functions normalize HTTP(S) and git URLs to a canonical form
 * for security-critical role canonicalization. They live in `src/types/`
 * (a sink layer) so the registry in `argument-roles.ts` can import them
 * without creating a runtime cycle through `src/trusted-process/`.
 *
 * Domain matching, IP detection, domain extraction, and git remote
 * resolution remain in `src/trusted-process/domain-utils.ts` because they
 * are consumed by the policy engine's domain check pipeline.
 */

/** Normalizes an HTTP(S) URL to a canonical form. Returns value as-is on parse failure. */
export function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.pathname === '/') url.pathname = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

/** Normalizes a git URL (HTTP or SSH format). SSH URLs are returned as-is. */
export function normalizeGitUrl(value: string): string {
  // SSH format: git@host:path -- no further normalization needed
  const sshMatch = value.match(/^(?:[\w.+-]+@)?([^:]+):/);
  if (sshMatch && !value.includes('://')) return value;
  return normalizeUrl(value);
}
