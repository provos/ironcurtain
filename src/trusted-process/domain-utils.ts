/**
 * Domain matching utilities for policy evaluation and list type matching.
 *
 * Extracted from policy-engine.ts so that both the PolicyEngine and the
 * list type registry (dynamic-list-types.ts) can share a single
 * implementation without circular imports.
 */

/**
 * Checks whether a hostname is an IP address (IPv4 or IPv6).
 * Used by the SSRF structural invariant to prevent `*` wildcards
 * from matching IP addresses.
 */
export function isIpAddress(domain: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(domain) || domain.includes(':');
}

/**
 * Checks whether a domain matches any pattern in an allowlist.
 * Supports exact match, `*` wildcard (matches all domain names but NOT
 * IP addresses -- SSRF structural invariant), and `*.example.com` prefix
 * wildcards (matches example.com and *.example.com).
 */
export function domainMatchesAllowlist(domain: string, allowedDomains: readonly string[]): boolean {
  return allowedDomains.some((pattern) => {
    if (pattern === '*') return !isIpAddress(domain);
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".github.com"
      return domain === pattern.slice(2) || domain.endsWith(suffix);
    }
    return domain === pattern;
  });
}
