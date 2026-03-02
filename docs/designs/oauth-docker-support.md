# Design: OAuth Support for Docker Agent Sessions

**Status:** Proposed
**Date:** 2026-02-28

## 1. Problem Statement

IronCurtain's Docker agent mode currently only supports API key authentication. Most Claude Code users authenticate via OAuth (Pro/Max/Teams/Enterprise subscriptions), not API keys. These users cannot use Docker agent mode today.

We need to:
1. Detect whether the host user has OAuth credentials
2. Prefer OAuth over API keys when both are available
3. Maintain the security invariant: real credentials never enter the container

## 2. Key Discovery: `CLAUDE_CODE_OAUTH_TOKEN`

Claude Code natively supports a `CLAUDE_CODE_OAUTH_TOKEN` environment variable as its **highest-priority** auth source. When set, Claude Code uses it as a bearer token directly — no credentials files needed.

**Auth priority order in Claude Code:**
1. `CLAUDE_CODE_OAUTH_TOKEN` env var (highest)
2. `ANTHROPIC_API_KEY` env var
3. `~/.claude/.credentials.json` file
4. macOS Keychain

Users can generate a long-lived OAuth token (~1 year validity) via:
```bash
claude setup-token
```

The only additional requirement is `{"hasCompletedOnboarding": true}` in `~/.claude.json`, which our entrypoint already provides.

**Related env vars:**
| Variable | Purpose |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Pre-configured OAuth access token |
| `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | Refresh token for auto-renewal |
| `CLAUDE_CODE_OAUTH_SCOPES` | Required when using refresh token |

## 3. Current State: API Key Flow

```
Host                          Container                    Upstream
----                          ---------                    --------
1. resolveRealApiKey()
   reads ANTHROPIC_API_KEY

2. generateFakeKey()

3. buildEnv() sets
   IRONCURTAIN_API_KEY=<fake>

4. entrypoint writes
   apiKeyHelper in settings.json
                                5. Claude Code calls
                                   apiKeyHelper, gets fake key

                                6. Request with
                                   x-api-key: <fake>

                                7. MITM proxy swaps
                                   x-api-key: <real>
                                                             8. api.anthropic.com
                                                                sees real key
```

## 4. Proposed Design

### 4.1 OAuth credential detection

A new module `src/docker/oauth-credentials.ts` detects and loads OAuth credentials from the host:

```typescript
interface OAuthCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

type AuthMethod =
  | { readonly kind: 'oauth'; readonly credentials: OAuthCredentials }
  | { readonly kind: 'apikey'; readonly key: string }
  | { readonly kind: 'none' };

function detectAuthMethod(config: IronCurtainConfig): AuthMethod;
```

**Detection order (prefer OAuth):**
1. Read `~/.claude/.credentials.json` → parse `claudeAiOauth` → if valid and not expired, return `oauth`
2. On macOS, if credentials file is missing, try extracting from Keychain (see 4.5)
3. Fall back to `ANTHROPIC_API_KEY` / `config.userConfig.anthropicApiKey` → return `apikey`
4. Return `none`

**Override:** `IRONCURTAIN_DOCKER_AUTH=apikey` forces API key mode.

### 4.2 OAuth credential structure on host

**Linux** — `~/.claude/.credentials.json` (mode 0600):
```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1772351780468,
    "scopes": ["user:inference", "user:profile"],
    "subscriptionType": "max",
    "rateLimitTier": "default_..."
  }
}
```

**macOS** — stored in Keychain under:
- Service: `"Claude Code-credentials"` (write path) / `"Claude Code"` (read path)
- Account: `$USER`
- Value: same JSON structure as above

Extraction command:
```bash
security find-generic-password -s "Claude Code-credentials" -w
# or
security find-generic-password -s "Claude Code" -w
```

**Sensitive fields:** Only `accessToken` and `refreshToken` are sensitive. Everything else (expiry, scopes, subscription type) is metadata.

### 4.3 End-to-end OAuth flow

The design reuses the exact same fake-key-swap pattern as API keys, with one key simplification: `CLAUDE_CODE_OAUTH_TOKEN` means we just pass the fake token as an env var. No fake credentials files needed.

```
Host                           Container                   Upstream
----                           ---------                   --------
1. detectAuthMethod()
   reads ~/.claude/.credentials.json
   (or macOS Keychain)
   returns { kind: 'oauth', credentials }

2. generateFakeKey('sk-ant-oat01-ironcurtain-')

3. anthropicOAuthProvider config
   keyInjection: { type: 'bearer' }

4. ProviderKeyMapping
   fakeKey = fake token
   realKey = real accessToken

5. buildEnv() sets
   CLAUDE_CODE_OAUTH_TOKEN=<fake>
   (no IRONCURTAIN_API_KEY)

6. entrypoint detects OAuth mode
   (CLAUDE_CODE_OAUTH_TOKEN is set)
   → omits apiKeyHelper from settings.json

                                7. Claude Code reads
                                   CLAUDE_CODE_OAUTH_TOKEN
                                   (highest priority auth)

                                8. Request to api.anthropic.com
                                   Authorization: Bearer <fake>
                                   anthropic-beta: oauth-...

                                9. MITM proxy intercepts
                                   validates Bearer <fake>
                                   swaps → Bearer <real>
                                   passes anthropic-beta through
                                                              10. api.anthropic.com
                                                                  sees real OAuth token
```

### 4.4 Provider config for OAuth

A new provider config switches Anthropic from header-based to bearer-based auth:

```typescript
export const anthropicOAuthProvider: ProviderConfig = {
  host: 'api.anthropic.com',
  displayName: 'Anthropic (OAuth)',
  allowedEndpoints: anthropicProvider.allowedEndpoints,
  keyInjection: { type: 'bearer' },
  fakeKeyPrefix: 'sk-ant-oat01-ironcurtain-',
  requestRewriter: stripServerSideTools,
  rewriteEndpoints: ['/v1/messages'],
};

export const claudePlatformOAuthProvider: ProviderConfig = {
  host: 'platform.claude.com',
  displayName: 'Claude Platform (OAuth)',
  allowedEndpoints: claudePlatformProvider.allowedEndpoints,
  keyInjection: { type: 'bearer' },
  fakeKeyPrefix: 'sk-ant-oat01-ironcurtain-',
};
```

The MITM proxy's bearer swap logic already exists (used by OpenAI) — no proxy code changes needed.

### 4.5 macOS Keychain extraction

On macOS, if `~/.claude/.credentials.json` doesn't exist, attempt Keychain extraction:

```typescript
function extractFromKeychain(): OAuthCredentials | null {
  // Try both service names (Claude Code has a known bug where write/read use different names)
  for (const service of ['Claude Code-credentials', 'Claude Code']) {
    try {
      const result = execSync(
        `security find-generic-password -s "${service}" -w`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const parsed = JSON.parse(result.trim());
      if (parsed.claudeAiOauth?.accessToken) {
        return parsed.claudeAiOauth;
      }
    } catch {
      continue; // Not found or keychain locked
    }
  }
  return null;
}
```

**Keychain access caveats:**
- Prompts the user for Keychain password if locked (acceptable UX for a one-time session start)
- SSH sessions may need `security unlock-keychain` first
- If Keychain access fails, fall back to API key with a helpful message

### 4.6 Token refresh at session start

OAuth access tokens are short-lived (~8-12 hours). At session start:

1. Check `expiresAt` — if token is valid for >5 minutes, use it directly
2. If expired but refresh token exists, attempt host-side refresh
3. If refresh fails, fall back to API key or error with "run `claude login`"

```typescript
async function refreshOAuthToken(credentials: OAuthCredentials): Promise<OAuthCredentials | null> {
  // POST to Anthropic's token endpoint with grant_type=refresh_token
  // On success: write new credentials back to ~/.claude/.credentials.json
  // On failure: return null
}
```

**Why not refresh mid-session?** Anthropic uses refresh token rotation — each refresh invalidates the old token. If host-side Claude Code also refreshes concurrently, one loses. Keeping refresh to session-start-only avoids this race. Most sessions are <30 minutes, well within token lifetime.

### 4.7 Adapter changes

`buildEnv()` in `claude-code.ts` becomes auth-method-aware:

```typescript
buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_DISABLE_UPDATE_CHECK: '1',
    NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/ironcurtain-ca.crt',
  };

  if (config.dockerAuth?.kind === 'oauth') {
    // OAuth mode: pass fake token via Claude Code's native env var
    env.CLAUDE_CODE_OAUTH_TOKEN = fakeKeys.get('api.anthropic.com') ?? '';
  } else {
    // API key mode: existing behavior
    env.IRONCURTAIN_API_KEY = fakeKeys.get('api.anthropic.com') ?? '';
  }

  return env;
}
```

### 4.8 Entrypoint changes

The entrypoint detects auth mode by checking which env var is set:

```bash
if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
  # OAuth mode: Claude Code reads the token from this env var directly.
  # No apiKeyHelper needed.
  cat > "$HOME/.claude/settings.json" <<'EOSETTINGS'
{
  "permissions": {
    "allow": [],
    "deny": [],
    "additionalDirectories": [],
    "defaultMode": "bypassPermissions"
  },
  "skipDangerousModePermissionPrompt": true
}
EOSETTINGS
else
  # API key mode: existing behavior with apiKeyHelper
  cat > "$HOME/.claude/settings.json" <<'EOSETTINGS'
{
  "permissions": { ... },
  "apiKeyHelper": "echo $IRONCURTAIN_API_KEY",
  "skipDangerousModePermissionPrompt": true
}
EOSETTINGS
fi
```

### 4.9 `getProviders()` becomes auth-aware

The adapter's `getProviders()` needs to return different provider configs based on auth method:

```typescript
getProviders(authKind?: 'oauth' | 'apikey'): readonly ProviderConfig[] {
  if (authKind === 'oauth') {
    return [anthropicOAuthProvider, claudePlatformOAuthProvider];
  }
  return [anthropicProvider, claudePlatformProvider];
}
```

This ensures the MITM proxy uses `bearer` injection for OAuth and `x-api-key` header injection for API keys.

## 5. Key Design Decisions

### 5.1 Why `CLAUDE_CODE_OAUTH_TOKEN` instead of fake credentials files?

`CLAUDE_CODE_OAUTH_TOKEN` is Claude Code's highest-priority auth source. Setting this single env var is all Claude Code needs — no fake `~/.claude/.credentials.json`, no `oauthAccount` metadata, no complex entrypoint logic. The entrypoint already provides `hasCompletedOnboarding: true`.

### 5.2 Why prefer OAuth over API keys?

Most Claude Code users authenticate via OAuth (Pro/Max subscriptions). If a user has logged in, that's their natural auth method. API keys are a fallback for Console/API-only users. `IRONCURTAIN_DOCKER_AUTH=apikey` overrides for users who want explicit control.

### 5.3 Why not pass real tokens into the container?

Same security invariant as API keys — real credentials never enter the container. A compromised agent could exfiltrate tokens via MCP tool calls. The fake-token-swap pattern prevents this.

### 5.4 Why not refresh mid-session?

Refresh token rotation means concurrent refreshes (IronCurtain + host Claude Code) would race, invalidating one party's tokens. Session-start refresh is safe and sufficient for typical session durations.

## 6. Edge Cases

| Scenario | Behavior |
|---|---|
| Expired access token, valid refresh token | Refresh at session start; proceed with new token |
| Expired access + expired refresh token | Fall back to API key; if none, error with "run `claude login`" |
| Both OAuth and API key available | OAuth wins; override with `IRONCURTAIN_DOCKER_AUTH=apikey` |
| macOS Keychain locked | Prompt user for password; fall back to API key on failure |
| `~/.claude/.credentials.json` missing (macOS) | Try Keychain extraction |
| `~/.claude/.credentials.json` missing (Linux) | Fall back to API key |
| Token expires mid-session (401 from upstream) | Session errors; user restarts (future: host-side refresh on 401) |
| Corrupt credentials file | JSON parse error caught; fall back to API key |

## 7. Implementation Plan

### Phase 1: OAuth credential detection and provider config

**New file:** `src/docker/oauth-credentials.ts`
- `loadOAuthCredentials(): OAuthCredentials | null` — reads `~/.claude/.credentials.json`
- `extractFromKeychain(): OAuthCredentials | null` — macOS Keychain extraction
- `detectAuthMethod(config: IronCurtainConfig): AuthMethod` — preference logic
- `isTokenExpired(credentials: OAuthCredentials): boolean`
- Types: `OAuthCredentials`, `AuthMethod`

**Modified:** `src/docker/provider-config.ts`
- Add `anthropicOAuthProvider` and `claudePlatformOAuthProvider`

**New tests:** `test/oauth-credentials.test.ts`

### Phase 2: Integration (adapter, infrastructure, entrypoint)

**Modified:** `src/docker/docker-infrastructure.ts`
- `prepareDockerInfrastructure()` calls `detectAuthMethod()` early
- Uses OAuth providers when `kind === 'oauth'`; real key = `credentials.accessToken`
- Stores auth kind on `DockerInfrastructure` for adapter to use

**Modified:** `src/docker/adapters/claude-code.ts`
- `getProviders()` accepts auth kind parameter
- `buildEnv()` sets `CLAUDE_CODE_OAUTH_TOKEN` in OAuth mode, `IRONCURTAIN_API_KEY` in API key mode

**Modified:** `docker/entrypoint-claude-code.sh`
- Conditional `apiKeyHelper` (omitted in OAuth mode)

**Modified:** `src/docker/agent-adapter.ts`
- `getProviders()` signature gains optional `authKind` parameter

### Phase 3: Token refresh at session start

**Added to:** `src/docker/oauth-credentials.ts`
- `refreshOAuthToken(credentials: OAuthCredentials): Promise<OAuthCredentials | null>`
- Writes new credentials back to `~/.claude/.credentials.json`

**Modified:** `src/docker/docker-infrastructure.ts`
- Refresh before generating fake key if token is expired

### Phase 4: UX polish

- Log which auth method was detected and used
- Warn when token expires within 1 hour
- `IRONCURTAIN_DOCKER_AUTH` override support
- Suggest `claude setup-token` for long-lived tokens in logged output

## 8. Files Changed Summary

| File | Change |
|------|--------|
| `src/docker/oauth-credentials.ts` | **New** — credential detection, Keychain extraction, refresh |
| `src/docker/provider-config.ts` | Add `anthropicOAuthProvider`, `claudePlatformOAuthProvider` |
| `src/docker/docker-infrastructure.ts` | Auth method detection, conditional provider selection |
| `src/docker/adapters/claude-code.ts` | Auth-aware `buildEnv()` and `getProviders()` |
| `src/docker/agent-adapter.ts` | Optional `authKind` on `getProviders()` |
| `docker/entrypoint-claude-code.sh` | Conditional `apiKeyHelper` |
| `src/config/types.ts` | Optional `dockerAuth` on config |
| `test/oauth-credentials.test.ts` | **New** — unit tests |

## 9. Security Considerations

1. **Real tokens never enter the container.** Same invariant as API keys.
2. **Fake tokens have 192 bits of entropy.** Generated by `generateFakeKey()`.
3. **Refresh tokens used only on host side.** Container gets a fake refresh token that cannot mint real tokens.
4. **Credentials file permissions preserved.** Read-only access to `~/.claude/.credentials.json`; refresh writes back with mode 0600.
5. **Keychain access is user-visible.** macOS prompts for Keychain password — no silent credential theft.
6. **No new network endpoints.** Token refresh is a standard HTTPS call from the host. Container isolation unchanged.
