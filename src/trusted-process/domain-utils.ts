/**
 * Domain and URL utilities for policy evaluation.
 *
 * Domain matching (domainMatchesAllowlist, isIpAddress) shared by the
 * PolicyEngine and the list type registry (dynamic-list-types.ts).
 *
 * URL normalization and domain extraction (normalizeUrl, extractDomain,
 * normalizeGitUrl, extractGitDomain, resolveGitRemote) used by the
 * policy engine's domain check pipeline and the auto-approver.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Domain matching
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// URL normalization and domain extraction
// ---------------------------------------------------------------------------

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

/** Extracts the hostname from an HTTP(S) URL. Returns value as-is on parse failure. */
export function extractDomain(value: string): string {
  try {
    return new URL(value).hostname;
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

/**
 * Extracts the domain from a URL value, dispatching to the correct
 * extractor based on role. Use this instead of calling extractDomain
 * or extractGitDomain directly when the role is available.
 */
export function extractDomainForRole(value: string, role: string): string {
  return role === 'git-remote-url' ? extractGitDomain(value) : extractDomain(value);
}

/** Extracts the domain from a git URL (HTTP or SSH format). */
export function extractGitDomain(value: string): string {
  // SSH format: git@host:path
  const sshMatch = value.match(/^(?:[\w.+-]+@)?([^:]+):/);
  if (sshMatch && !value.includes('://')) return sshMatch[1];
  return extractDomain(value);
}

/**
 * Resolves a git remote value to a URL for policy evaluation.
 *
 * If the value is already a URL (contains :// or matches SSH pattern),
 * returns it as-is. Otherwise, treats it as a named remote and runs
 * `git remote get-url <name>` in the repository directory (found via
 * the `path` sibling argument).
 *
 * Uses execFileSync (not execSync) to avoid command injection --
 * the value comes from agent-controlled tool call arguments.
 *
 * When resolution fails (repo doesn't exist, remote not found, git
 * not installed), returns the original value. This causes the domain
 * check to escalate (the value won't match any allowed domain),
 * which is the correct behavior -- escalate when we can't verify.
 */
export function resolveGitRemote(value: string, allArgs: Record<string, unknown>): string {
  // Already a URL -- return as-is
  if (value.includes('://') || /^[\w.+-]+@[^:]+:/.test(value)) {
    return value;
  }

  // Named remote -- resolve via git (no shell, no injection risk)
  const rawPath = typeof allArgs.path === 'string' ? allArgs.path : '.';
  const repoPath = resolve(rawPath);
  try {
    return execFileSync('git', ['remote', 'get-url', value], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return value; // Resolution failed -- escalation will catch it
  }
}
