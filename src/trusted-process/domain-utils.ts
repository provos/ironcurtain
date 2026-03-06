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
import type { ArgumentRole } from '../types/argument-roles.js';

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
 *
 * Supports hierarchical matching for git-remote-url domains that include
 * repository paths (e.g., `github.com/owner/repo`):
 * - `*` wildcard: matches any domain name (not IPs — SSRF structural invariant).
 * - `*.example.com` prefix wildcard: matches hostname portion only.
 * - Pattern without `/` (e.g., `github.com`): matches hostname portion
 *   (any repo on that host).
 * - Pattern with `/` (e.g., `github.com/owner/repo`): exact match only.
 *
 * For plain hostname domains (e.g., from `fetch-url`), behavior is unchanged.
 */
export function domainMatchesAllowlist(domain: string, allowedDomains: readonly string[]): boolean {
  const slashIdx = domain.indexOf('/');
  const hostname = slashIdx >= 0 ? domain.slice(0, slashIdx) : domain;

  return allowedDomains.some((pattern) => {
    if (pattern === '*') return !isIpAddress(hostname);
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".github.com"
      return hostname === pattern.slice(2) || hostname.endsWith(suffix);
    }
    // Pattern with path → exact match required
    if (pattern.includes('/')) return domain === pattern;
    // Pattern without path → match hostname portion
    return hostname === pattern;
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
export function extractDomainForRole(value: string, role: ArgumentRole): string {
  return role === 'git-remote-url' ? extractGitDomain(value) : extractDomain(value);
}

/**
 * Strips `.git` suffix and trailing slashes from a git repo path component.
 * Returns empty string for root-only paths (e.g., `/` or `/.git`).
 */
function normalizeGitRepoPath(pathname: string): string {
  let s = pathname;
  if (s.startsWith('/')) s = s.slice(1);
  if (s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('.git')) s = s.slice(0, -4);
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * Extracts domain information from a git URL (HTTP or SSH format).
 * Returns `hostname/owner/repo` when a meaningful path is present,
 * or just `hostname` otherwise.
 *
 * Examples:
 * - `https://github.com/provos/ironcurtain.git` → `github.com/provos/ironcurtain`
 * - `git@github.com:provos/ironcurtain.git` → `github.com/provos/ironcurtain`
 * - `https://github.com/` → `github.com`
 */
export function extractGitDomain(value: string): string {
  // SSH format: git@host:path
  const sshMatch = value.match(/^(?:[\w.+-]+@)?([^:]+):(.*)/);
  if (sshMatch && !value.includes('://')) {
    const host = sshMatch[1];
    const repoPath = normalizeGitRepoPath(sshMatch[2]);
    return repoPath ? `${host}/${repoPath}` : host;
  }
  try {
    const url = new URL(value);
    const repoPath = normalizeGitRepoPath(url.pathname);
    return repoPath ? `${url.hostname}/${repoPath}` : url.hostname;
  } catch {
    return value;
  }
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

/** Shared exec options type for all git sub-command calls. */
type GitExecOpts = Parameters<typeof execFileSync>[2] & { encoding: 'utf-8' };

/**
 * Returns the current branch name, or undefined on error or detached HEAD.
 */
function gitCurrentBranch(opts: GitExecOpts): string | undefined {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim();
    return branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the configured tracking remote name for a branch,
 * or undefined if none is configured or an error occurs.
 */
function gitBranchRemote(branch: string, opts: GitExecOpts): string | undefined {
  try {
    return execFileSync('git', ['config', '--get', `branch.${branch}.remote`], opts).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the fetch URL for a named remote, or undefined if not found or empty.
 */
function gitRemoteUrl(remoteName: string, opts: GitExecOpts): string | undefined {
  try {
    return execFileSync('git', ['remote', 'get-url', remoteName], opts).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the default remote URL for a git repository when no remote is
 * explicitly specified in the tool call arguments.
 *
 * Resolution order:
 *   1. The tracking remote for the current branch:
 *      reads `branch.<name>.remote` from git config, then resolves via
 *      `git remote get-url`.
 *   2. Fallback: `git remote get-url origin`.
 *
 * Returns undefined when resolution fails for any reason (not a git repo,
 * no remotes configured, git not installed, timeout). Callers treat undefined
 * as "no enrichment possible" and pass the original request through unchanged.
 *
 * Uses execFileSync (not execSync) throughout to avoid command injection.
 */
export function resolveDefaultGitRemote(repoPath: string): string | undefined {
  const resolved = resolve(repoPath);
  const execOpts: GitExecOpts = {
    cwd: resolved,
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  const branch = gitCurrentBranch(execOpts);
  if (branch) {
    const remoteName = gitBranchRemote(branch, execOpts);
    if (remoteName) {
      const url = gitRemoteUrl(remoteName, execOpts);
      if (url) return url;
    }
  }

  // Fallback to 'origin'.
  return gitRemoteUrl('origin', execOpts);
}
