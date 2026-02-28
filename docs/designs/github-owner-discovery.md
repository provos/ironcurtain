# Design: GitHub Owner Discovery for Policy Customization

**Status:** Proposed
**Date:** 2026-02-27
**Author:** IronCurtain Engineering
**Depends on:** Constitution Customizer (`constitution-customizer.md`), GitHub MCP server configuration

## 1. Problem Statement

The `customize-policy` command helps users write security policy statements in natural language. When GitHub-related tasks come up ("manage issues on my repos", "review PRs in my org"), the LLM needs to generate policy statements with concrete GitHub owner names (e.g., "The agent may interact with GitHub repositories owned by provos or my-org"). Without knowing the authenticated user's identity and organizations, the LLM must ask the user to spell them out -- friction that is unnecessary when a valid GitHub token already exists in the config.

## 2. Design

### 2.1 New Module: `src/pipeline/github-identity.ts`

A small, self-contained module that calls the GitHub REST API to discover the authenticated user's login and organization memberships. No dependency on MCP servers, the AI SDK, or the policy engine.

```typescript
// src/pipeline/github-identity.ts

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
export async function discoverGitHubIdentity(token: string): Promise<GitHubIdentity | null>;

/**
 * Resolves a GitHub token from user config or environment.
 *
 * Resolution order:
 * 1. process.env.GITHUB_PERSONAL_ACCESS_TOKEN
 * 2. resolvedConfig.serverCredentials.github?.GITHUB_PERSONAL_ACCESS_TOKEN
 *
 * @returns The token string, or null if not configured
 */
export function resolveGitHubToken(
  serverCredentials: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string | null;
```

### 2.2 Implementation Notes

The module uses Node's built-in `fetch` (available since Node 18, project targets ES2022). No new dependencies.

```typescript
const GITHUB_API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;

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
      orgs: orgs.filter((o) => typeof o.login === 'string').map((o) => o.login as string),
    };
  } catch {
    return null; // Network error, timeout, JSON parse failure, etc.
  }
}

export function resolveGitHubToken(
  serverCredentials: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string | null {
  const envToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (envToken) return envToken;

  const configToken = serverCredentials.github?.GITHUB_PERSONAL_ACCESS_TOKEN;
  return configToken ?? null;
}
```

### 2.3 Integration with `constitution-customizer.ts`

Discovery runs once at startup, between loading tool annotations and building the system prompt. The result is injected into `buildSystemPrompt()` as an optional parameter -- it adds a new section to the prompt only when identity is available.

**Changes to `constitution-customizer.ts` `main()`:**

```typescript
// After loading annotations, before building system prompt:
const ghToken = resolveGitHubToken(userConfig.serverCredentials);
let ghIdentity: GitHubIdentity | null = null;
if (ghToken) {
  const spinner = p.spinner();
  spinner.start('Discovering GitHub identity...');
  ghIdentity = await discoverGitHubIdentity(ghToken);
  if (ghIdentity) {
    const owners = [ghIdentity.login, ...ghIdentity.orgs].join(', ');
    spinner.stop(`GitHub identity: ${owners}`);
  } else {
    spinner.stop('GitHub identity discovery failed (continuing without it)');
  }
}

// Pass to system prompt builder:
const rawSystemPrompt = buildSystemPrompt(baseConstitution, annotations, ghIdentity);
```

**Changes to `buildSystemPrompt()`:**

Add an optional third parameter. When present, append a new section to the system prompt:

```typescript
export function buildSystemPrompt(
  baseConstitution: string,
  toolAnnotations: ToolAnnotation[],
  githubIdentity?: GitHubIdentity | null,
): string {
  let prompt = `You are helping a user customize...`; // existing content unchanged

  if (githubIdentity) {
    prompt += `\n\n## GitHub Identity Context\n`;
    prompt += `The user is authenticated as **${githubIdentity.login}** on GitHub.`;
    if (githubIdentity.orgs.length > 0) {
      prompt += `\nThey belong to these organizations: ${githubIdentity.orgs.map((o) => `**${o}**`).join(', ')}.`;
    }
    prompt += `\n\nWhen the user's request involves GitHub operations, use this context to:`;
    prompt += `\n- Suggest policy rules scoped to their username and/or organizations`;
    prompt += `\n- Ask which of their organizations (if any) the agent should have access to`;
    prompt += `\n- Generate precise owner names in policy statements (e.g., "The agent may `;
    prompt += `interact with GitHub repositories owned by ${githubIdentity.login}")`;
    prompt += `\n- Do NOT automatically grant access to all organizations -- ask the user `;
    prompt += `which ones are relevant to their task`;
  }

  return prompt;
}
```

## 3. Key Design Decisions

1. **Separate module, not inline.** `github-identity.ts` has zero coupling to the customizer, the AI SDK, or the policy engine. It takes a token string and returns data. This makes it trivially testable and reusable if other commands need GitHub identity context in the future.

2. **Null return on all errors.** Discovery is best-effort enrichment. The customizer works fine without it -- the LLM just asks the user to name their GitHub owners manually. No error is surfaced to the user beyond the spinner message.

3. **Injected into system prompt, not user-facing.** The LLM sees the identity context and uses it to make better suggestions. The user sees the spinner confirmation ("GitHub identity: provos, my-org") but is never forced through a separate "select your orgs" step. The LLM handles the conversational flow naturally -- it can ask "Should I include your org acme-corp as an authorized owner?" as part of the normal policy dialogue.

4. **LLM told not to auto-include all orgs.** The prompt explicitly instructs the LLM to ask which organizations are relevant rather than granting blanket access. This preserves least-privilege: a user with 10 org memberships probably only wants 1-2 authorized for their current task.

5. **Token resolution mirrors existing pattern.** Env var takes precedence over config file, matching the same resolution order used by `mcp-servers.json` (the Docker `-e GITHUB_PERSONAL_ACCESS_TOKEN` flag passes through the env var).

6. **Parallel API calls.** `/user` and `/user/orgs` are independent, so they run concurrently via `Promise.all`. The 10-second timeout per request keeps startup snappy even if GitHub is slow.

## 4. Error Handling

| Failure mode | Behavior |
|---|---|
| No token configured | Skip discovery entirely (no spinner, no log message) |
| Token expired / invalid (401) | `discoverGitHubIdentity` returns null; spinner shows "failed" |
| Network unreachable | Same as above (fetch throws, caught) |
| Rate limited (403/429) | Same as above (non-200 status) |
| `/user/orgs` returns empty | Valid result with `orgs: []` (user has no org memberships) |
| Malformed JSON response | Caught by type checks, returns null |

## 5. Testing Strategy

**Unit tests** (`test/github-identity.test.ts`):

- `resolveGitHubToken()`: env var precedence over config, null when neither set
- `discoverGitHubIdentity()`: mock `fetch` globally (or via dependency injection of a fetch function if preferred)
  - Happy path: returns login + orgs
  - 401 response: returns null
  - Network error: returns null
  - Malformed JSON (missing `login` field): returns null
  - Empty orgs array: returns `{ login: '...', orgs: [] }`

**`buildSystemPrompt()` tests** (added to existing customizer tests):

- Without identity: prompt does not contain "GitHub Identity Context" section
- With identity: prompt contains login and org names
- With identity but no orgs: prompt mentions user but not organizations

## 6. Files Changed

| File | Change |
|---|---|
| `src/pipeline/github-identity.ts` | **New.** `discoverGitHubIdentity()`, `resolveGitHubToken()`, `GitHubIdentity` type. |
| `src/pipeline/constitution-customizer.ts` | Import discovery functions. Call at startup. Pass identity to `buildSystemPrompt()`. |
| `test/github-identity.test.ts` | **New.** Unit tests for discovery and token resolution. |
| `test/constitution-customizer.test.ts` | Add tests for `buildSystemPrompt()` with/without GitHub identity. |
