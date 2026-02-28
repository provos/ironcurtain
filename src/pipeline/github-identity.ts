/**
 * GitHub identity discovery via the REST API.
 *
 * Discovers the authenticated user's login and organization memberships
 * from a personal access token. Zero coupling to AI SDK, MCP, or the
 * policy engine -- takes a token string and returns data.
 */

const GITHUB_API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Discovered GitHub identity: the authenticated user and their organizations.
 */
export interface GitHubIdentity {
  /** The authenticated user's login (e.g., "provos"). */
  readonly login: string;
  /** Organization logins the user belongs to (e.g., ["my-org", "acme-corp"]). */
  readonly orgs: readonly string[];
}

/**
 * Discovers the GitHub identity associated with a personal access token.
 *
 * Calls GET /user and GET /user/orgs against the GitHub REST API.
 * Returns null on any failure (expired token, network error, rate limit,
 * non-200 status). Callers should treat null as "GitHub context unavailable"
 * and proceed without it -- this is an enhancement, not a requirement.
 *
 * @param token - GitHub personal access token
 * @returns The discovered identity, or null if discovery failed
 */
export async function discoverGitHubIdentity(token: string): Promise<GitHubIdentity | null> {
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ironcurtain-policy-customizer',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    const [userRes, orgsRes] = await Promise.all([
      fetch(`${GITHUB_API_BASE}/user`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      fetch(`${GITHUB_API_BASE}/user/orgs`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    ]);

    if (!userRes.ok || !orgsRes.ok) return null;

    const user = (await userRes.json()) as { login?: string };
    const orgs = (await orgsRes.json()) as Array<{ login?: string }>;

    if (typeof user.login !== 'string') return null;

    return {
      login: user.login,
      orgs: orgs.flatMap((o) => (typeof o.login === 'string' ? [o.login] : [])),
    };
  } catch {
    return null; // Network error, timeout, JSON parse failure, etc.
  }
}

/**
 * Resolves a GitHub token from environment or user config.
 *
 * Resolution order:
 * 1. process.env.GITHUB_PERSONAL_ACCESS_TOKEN
 * 2. serverCredentials.github?.GITHUB_PERSONAL_ACCESS_TOKEN
 *
 * @returns The token string, or null if not configured
 */
export function resolveGitHubToken(
  serverCredentials: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
): string | null {
  const envToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (envToken) return envToken;

  const configToken = serverCredentials.github?.GITHUB_PERSONAL_ACCESS_TOKEN;
  return configToken ?? null;
}
