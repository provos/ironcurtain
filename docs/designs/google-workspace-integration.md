# Google Workspace MCP Server Integration Design

**Date:** 2026-03-16
**Status:** Design
**Depends on:** [Third-Party OAuth Onboarding](third-party-oauth.md) (Phases 1-3)

## Overview

This document designs the integration of `@alanse/mcp-server-google-workspace` (141 tools across Gmail, Calendar, Drive, Docs, Sheets, Slides) into IronCurtain's secure agent runtime. The integration must solve three hard problems simultaneously: (1) preventing the MCP server from independently refreshing tokens (which would cause refresh token rotation races), (2) keeping the server tightly sandboxed with no direct network access, and (3) providing fresh access tokens when they expire mid-session.

The central architectural decision is to use a **credential-file rendezvous** pattern: IronCurtain writes a credential file to a controlled directory, the MCP server reads it at startup and on each tool call, and IronCurtain refreshes the file contents proactively. The server's own background refresh is disabled by not providing a refresh token, making IronCurtain the exclusive token authority.

## Architecture Overview

```
                                  IronCurtain Host Process
                                  ========================

  Session Layer                   MCP Proxy Process              MCP Server Process
  (agent-session.ts)              (mcp-proxy-server.ts)          (@alanse/mcp-server-google-workspace)

  +-----------------------+       +------------------------+     +---------------------------+
  | OAuthTokenProvider    |       | TokenFileRefresher     |     | auth.ts                   |
  |   - reads google.json |       |   - polls token expiry |     |   - loadCredentialsQuietly|
  |   - re-read-before-   |       |   - calls              |     |     reads .gworkspace-    |
  |     refresh            |       |     getValidAccessToken|     |     credentials.json      |
  |   - saves refreshed   |       |   - writes credential  |     |   - setupTokenRefresh     |
  |     token to disk     |       |     file atomically    |     |     DISABLED (no refresh  |
  +-----------+-----------+       +----------+-------------+     |     token provided)        |
              |                              |                   |   - OAuth2Client with      |
              |  disk file                   |  tmpfs/session    |     access_token only      |
              |  ~/.ironcurtain/             |  dir write        +---------------------------+
              |  oauth/google.json           |                            |
              v                              v                            |  googleapis
                                   /tmp/.../gws-creds/                   |  HTTP calls
                                   .gworkspace-credentials.json          |
                                                                         v
                                                               *.googleapis.com
                                                               (through sandbox
                                                                network allowlist)
```

### Key Insight: Access Token Only, No Refresh Token

The `google-auth-library` OAuth2Client behaves differently depending on what credentials it receives:

- **With refresh_token**: `google.auth.OAuth2` automatically refreshes the access token when it receives a 401, persisting the new token back to disk. This is exactly what we must prevent -- in a multi-session environment, the MCP server's refresh would rotate the refresh token and invalidate IronCurtain's copy.
- **Without refresh_token**: The client uses the access token as-is. When it expires, API calls fail with 401. No automatic refresh occurs, no disk writes happen.

By omitting the `refresh_token` from the credential file written to the MCP server, we make the server a pure consumer of access tokens. IronCurtain's `OAuthTokenProvider` remains the sole entity that holds and uses the refresh token.

## Component Design

### 1. Token Lifecycle

```
                    Token Flow
                    ==========

Session Start:
  OAuthTokenProvider.getValidAccessToken()
    |--- re-read google.json from disk
    |--- if expired: refresh via Google token endpoint
    |--- save refreshed token to disk (google.json)
    |--- return access_token
    v
  writeGWorkspaceCredentialFile(accessToken, expiresAt)
    |--- write to {sessionCredsDir}/.gworkspace-credentials.json
    |--- format: { access_token, expiry_date, token_type: "Bearer" }
    |--- NOTE: no refresh_token field
    v
  Spawn MCP server with env:
    GWORKSPACE_CREDS_DIR={sessionCredsDir}
    CLIENT_ID={clientId}
    CLIENT_SECRET={clientSecret}
    v
  MCP server starts:
    loadCredentialsQuietly()
    |--- reads .gworkspace-credentials.json
    |--- creates OAuth2Client with access_token
    |--- no refresh_token -> no background refresh capability
    |--- setupTokenRefresh() interval starts but:
    |    loadCredentialsQuietly() re-reads from disk each time
    |    if IronCurtain has written a fresh token, server picks it up

During Session:
  TokenFileRefresher (runs in proxy process, 5-min interval):
    |--- check token expiry from in-memory state
    |--- if within 10 min of expiry:
    |    OAuthTokenProvider.getValidAccessToken()
    |    |--- re-read-before-refresh (handles concurrent sessions)
    |    |--- refresh via Google token endpoint
    |    |--- save to google.json
    |    writeGWorkspaceCredentialFile(newAccessToken, newExpiresAt)
    |    |--- atomic write to .gworkspace-credentials.json
    |
    v
  Next tool call:
    ensureAuth() / ensureAuthQuietly()
    |--- loadCredentialsQuietly() re-reads credential file
    |--- picks up fresh access_token written by refresher
    |--- google.options({ auth: updatedClient })
```

### 2. TokenFileRefresher

A new component in the proxy process that proactively refreshes the credential file before the access token expires.

```typescript
// src/trusted-process/token-file-refresher.ts

/**
 * Proactively refreshes OAuth credential files for MCP servers.
 *
 * Runs in the proxy process. Periodically checks token expiry and
 * writes fresh credential files before the access token expires.
 * The MCP server's own loadCredentialsQuietly() re-reads the file
 * on each tool call, picking up the refreshed token transparently.
 *
 * Why this lives in the proxy process (not session):
 * - The proxy process spawns and owns the MCP server child processes
 * - The proxy process has direct access to the credential file directory
 * - The proxy process lifetime matches the MCP server lifetime
 * - In Code Mode, each proxy process handles one server (SERVER_FILTER),
 *   so each refresher manages exactly one credential file
 */

/** Configuration for a single server's token refresh. */
export interface TokenRefreshConfig {
  /** OAuth provider ID (e.g., 'google'). */
  readonly providerId: string;
  /** Path to the credential file the MCP server reads. */
  readonly credentialFilePath: string;
  /** Function to obtain a fresh access token (calls OAuthTokenProvider). */
  readonly getAccessToken: () => Promise<{ accessToken: string; expiresAt: number }>;
  /** Function to write the credential file in the format the MCP server expects. */
  readonly writeCredentialFile: (accessToken: string, expiresAt: number) => void;
}

/**
 * Manages proactive token refresh for a single MCP server.
 *
 * The refresh interval defaults to 5 minutes. This is much shorter than
 * the MCP server's own 45-minute interval, ensuring we always refresh
 * well before the ~60-minute access token lifetime expires (with a
 * 10-minute-before-expiry threshold, the worst case is 5 + 10 = 15
 * minutes before expiry — comfortably within the token lifetime).
 */
export class TokenFileRefresher {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private currentExpiresAt: number;

  constructor(
    private readonly config: TokenRefreshConfig,
    initialExpiresAt: number,
  ) {
    this.currentExpiresAt = initialExpiresAt;
  }

  /** Starts the periodic refresh check. */
  start(intervalMs?: number): void;

  /** Stops the periodic refresh and cleans up. */
  stop(): void;

  /**
   * Performs a single refresh check.
   * Public for testing; normally called by the interval.
   */
  async refreshIfNeeded(): Promise<void>;
}
```

### 3. Credential File Format

The MCP server's `auth.ts` reads `.gworkspace-credentials.json` with this shape:

```json
{
  "access_token": "ya29.a0AfH6SM...",
  "expiry_date": 1710000000000,
  "token_type": "Bearer",
  "scope": "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly ..."
}
```

Critically, we **omit** the `refresh_token` field. The MCP server's `loadCredentialsQuietly()` checks `savedCreds.refresh_token` before attempting a refresh (auth.ts line 125). Without it, the refresh branch is skipped entirely.

```typescript
// src/trusted-process/gworkspace-credentials.ts

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Writes a Google Workspace credential file in the format expected
 * by @alanse/mcp-server-google-workspace's auth.ts.
 *
 * SECURITY: The refresh_token field is intentionally omitted.
 * This prevents the MCP server from independently refreshing tokens,
 * which would cause refresh token rotation races in multi-session
 * environments. IronCurtain's OAuthTokenProvider is the sole token
 * authority.
 *
 * The file is written atomically (write to .tmp, rename) to prevent
 * the MCP server from reading a partial file during a refresh cycle.
 */
export function writeGWorkspaceCredentialFile(
  credsDir: string,
  accessToken: string,
  expiresAt: number,
  scopes: readonly string[],
): void {
  mkdirSync(credsDir, { recursive: true });

  const credential = {
    access_token: accessToken,
    expiry_date: expiresAt,
    token_type: 'Bearer',
    scope: scopes.join(' '),
    // NOTE: refresh_token intentionally omitted.
    // See design doc: docs/designs/google-workspace-integration.md
  };

  const filePath = join(credsDir, '.gworkspace-credentials.json');
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(credential, null, 2), { mode: 0o600 });
  renameSync(tmpPath, filePath);
}
```

### 4. Concurrency Model

Multiple IronCurtain sessions may run simultaneously. Each session spawns its own `google-workspace` MCP server process. The concurrency challenges are:

**Problem**: Two sessions refresh the token at the same time. Google rotates the refresh token on each refresh. Session A refreshes, gets new refresh token R2 (replacing R1). Session B still has R1 in memory, tries to refresh with R1, gets an error because Google already invalidated R1.

**Solution**: The `OAuthTokenProvider` already implements re-read-before-refresh (oauth-token-provider.ts lines 199-213). Before calling the token endpoint, it re-reads `google.json` from disk. If another process already refreshed (the on-disk token is not expired), it uses that token instead of refreshing again.

```
Session A                          Session B
=========                          =========
check: token expired               check: token expired
re-read google.json: still expired
call token endpoint                re-read google.json: still expired
  |                                  (A hasn't written yet)
receive new token                  call token endpoint
write google.json                    |
  (access_token_A,                 IF Google already rotated:
   refresh_token_R2)                 Session B's refresh_token_R1
                                     may fail with invalid_grant

                                   FALLBACK: re-read google.json again
                                   Session A already wrote a fresh token
                                   Use that instead.
```

The re-read-before-refresh pattern handles the common case. For the rare race where both processes call the token endpoint nearly simultaneously:

- Google's refresh token rotation has a grace period (the old refresh token continues to work for a short window after a new one is issued).
- If the grace period expires, the `OAuthTokenProvider` throws `OAuthTokenExpiredError`, and the user must re-authorize.
- This is the same behavior as any other Google API client sharing a refresh token across processes. The risk is low in practice because token refresh is infrequent (once per hour) and the grace period is generous.

**Per-session credential files** ensure MCP server processes never contend on the same file:

```
~/.ironcurtain/sessions/{sessionA}/gws-creds/.gworkspace-credentials.json
~/.ironcurtain/sessions/{sessionB}/gws-creds/.gworkspace-credentials.json
```

Each proxy writes only its own credential file. The shared resource is `~/.ironcurtain/oauth/google.json` (the canonical token store), protected by the re-read-before-refresh pattern.

### 5. Sandbox Confinement

The MCP server needs network access to `*.googleapis.com` but should be restricted from everything else.

```json
// In mcp-servers.json
"google-workspace": {
  "description": "Google Workspace tools (Gmail, Calendar, Drive, Docs, Sheets, Slides)",
  "command": "npx",
  "args": ["-y", "@alanse/mcp-server-google-workspace"],
  "sandbox": {
    "filesystem": {
      "allowWrite": [],
      "denyRead": ["~/.ssh", "~/.gnupg", "~/.aws", "~/.ironcurtain/oauth"]
    },
    "network": {
      "allowedDomains": [
        "googleapis.com",
        "*.googleapis.com",
        "accounts.google.com",
        "oauth2.googleapis.com",
        "registry.npmjs.org",
        "*.npmjs.org"
      ]
    }
  }
}
```

Key sandbox decisions:

**Network**: The server must reach `*.googleapis.com` for API calls. We also allow `accounts.google.com` and `oauth2.googleapis.com` because the `googleapis` library may make discovery requests. The `npmjs.org` domains are needed for the `npx -y` install step (first run only); after installation, they are not used.

**Filesystem**: The server needs read access to its credential file (in the per-session creds directory, which is within the session sandbox and thus implicitly allowed). Write access is restricted to the session sandbox directory (automatically injected by `resolveSandboxConfig`). The server's `writeFileSync` call to save refreshed credentials (auth.ts line 131) will silently fail or throw EPERM -- but since we never provide a refresh token, this code path is never reached.

**Token store isolation**: `~/.ironcurtain/oauth` is explicitly in `denyRead`. Even if the server somehow tried to read the canonical token store (which contains the refresh token), the sandbox blocks it.

**npx caching**: The `npx -y` command downloads and caches the package. The npm cache directory needs write access during the first invocation. The srt sandbox allows writes to the session sandbox dir. For npm cache, we rely on npm's `--cache` flag or `npm_config_cache` env var to redirect the cache to a writable location within the session directory.

```typescript
// In mcp-proxy-server.ts, when spawning google-workspace:
const npmCacheDir = join(sessionCredsDir, '.npm-cache');
env.npm_config_cache = npmCacheDir;
```

### 6. MCP Server Configuration

```json
// src/config/mcp-servers.json (addition)
"google-workspace": {
  "description": "Google Workspace tools (Gmail, Calendar, Drive, Docs, Sheets, Slides)",
  "command": "npx",
  "args": ["-y", "@alanse/mcp-server-google-workspace"],
  "env": {},
  "sandbox": {
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.gnupg", "~/.aws", "~/.ironcurtain/oauth"]
    },
    "network": {
      "allowedDomains": [
        "googleapis.com",
        "*.googleapis.com",
        "accounts.google.com",
        "oauth2.googleapis.com",
        "registry.npmjs.org",
        "*.npmjs.org"
      ]
    }
  }
}
```

The `env` block is populated at runtime by the proxy's OAuth token injection logic. Static env vars are not needed because all credential values are dynamic.

### 7. Token Refresh During Long Sessions

Access tokens expire after approximately 1 hour. The `TokenFileRefresher` handles this proactively:

```
Time 0:00  - Session starts, token written with 1h expiry
Time 0:05  - TokenFileRefresher fires (5-min interval)
             Token still valid (55 min remaining) -> no-op
Time 0:10  - TokenFileRefresher fires again -> no-op
...
Time 0:45  - MCP server's own setupTokenRefresh() fires
             loadCredentialsQuietly() re-reads file
             Token still valid (15 min remaining) -> no-op
Time 0:50  - TokenFileRefresher fires, token within 10 min of expiry
             OAuthTokenProvider.getValidAccessToken()
             -> re-read google.json (may pick up another session's refresh)
             -> if still expired: call token endpoint, save to google.json
             writeGWorkspaceCredentialFile(newToken, newExpiry)
             -> atomic write to per-session credential file
Time 0:55  - TokenFileRefresher fires, token freshly refreshed -> no-op
             Next tool call: ensureAuth()/ensureAuthQuietly()
             loadCredentialsQuietly() re-reads file
             -> picks up fresh token from Time 0:50
Time 1:30  - MCP server's setupTokenRefresh() fires again
             loadCredentialsQuietly() re-reads file
             Token valid (refreshed at 0:50, expires ~1:50) -> no-op
```

The 5-minute `TokenFileRefresher` interval ensures the credential file is refreshed well before the ~60-minute access token lifetime expires. With a 10-minute-before-expiry threshold, the worst-case delay is 15 minutes before expiry — comfortably within the token lifetime.

The MCP server's own 45-minute refresh interval (`setupTokenRefresh`) becomes a no-op: it calls `loadCredentialsQuietly()`, which re-reads the file, finds a valid token (because `TokenFileRefresher` already wrote one), and sets it on the OAuth2Client. No token endpoint call is made because there is no refresh_token.

### 8. Proxy-Side Integration

The token injection happens in `mcp-proxy-server.ts` during server connection setup. The existing pattern passes `serverCredentials` as env vars. For OAuth-backed servers, we add credential file preparation.

```typescript
// In mcp-proxy-server.ts, connectToServer() or the server spawn loop:

// Check if this server needs OAuth token injection
const oauthProvider = getProviderForServer(serverName);
if (oauthProvider && oauthProvider.id === 'google') {
  const clientCreds = loadClientCredentials(oauthProvider);
  if (!clientCreds) {
    logToSessionFile(sessionLogPath,
      `[proxy] Skipping ${serverName}: no OAuth credentials. Run 'ironcurtain auth import google <file>'`);
    continue;
  }

  const tokenProvider = new OAuthTokenProvider(oauthProvider, clientCreds);
  if (!tokenProvider.isAuthorized()) {
    logToSessionFile(sessionLogPath,
      `[proxy] Skipping ${serverName}: not authorized. Run 'ironcurtain auth google'`);
    continue;
  }

  try {
    const accessToken = await tokenProvider.getValidAccessToken();
    const storedToken = loadOAuthToken(oauthProvider.id)!;

    // Create per-session credential directory
    const credsDir = join(settingsDir, `${serverName}-creds`);
    writeGWorkspaceCredentialFile(credsDir, accessToken, storedToken.expiresAt, storedToken.scopes);

    // Inject env vars for the MCP server
    serverEnv.GWORKSPACE_CREDS_DIR = credsDir;
    serverEnv.CLIENT_ID = clientCreds.clientId;
    serverEnv.CLIENT_SECRET = clientCreds.clientSecret;

    // Start proactive token refresh
    const refresher = new TokenFileRefresher({
      providerId: oauthProvider.id,
      credentialFilePath: join(credsDir, '.gworkspace-credentials.json'),
      getAccessToken: async () => {
        const token = await tokenProvider.getValidAccessToken();
        const stored = loadOAuthToken(oauthProvider.id)!;
        return { accessToken: token, expiresAt: stored.expiresAt };
      },
      writeCredentialFile: (token, expiry) => {
        writeGWorkspaceCredentialFile(credsDir, token, expiry, storedToken.scopes);
      },
    }, storedToken.expiresAt);
    refresher.start();
    // Store refresher handle for cleanup on proxy shutdown
    tokenRefreshers.set(serverName, refresher);
  } catch (err) {
    logToSessionFile(sessionLogPath,
      `[proxy] Skipping ${serverName}: token refresh failed. Run 'ironcurtain auth google'`);
    continue;
  }
}
```

### 9. Failure Modes

| Failure | Detection | Behavior | User Action |
|---------|-----------|----------|-------------|
| No OAuth credentials file | `loadClientCredentials()` returns null | Server skipped with warning | `ironcurtain auth import google <file>` |
| Not authorized (no token) | `tokenProvider.isAuthorized()` false | Server skipped with warning | `ironcurtain auth google` |
| Token expired, refresh fails | `OAuthTokenExpiredError` thrown | Server skipped with warning | `ironcurtain auth google` |
| Access token expires mid-session, refresher works | `TokenFileRefresher` refreshes proactively | Transparent to user | None |
| Access token expires mid-session, refresher fails | MCP server gets 401 from Google | Tool call returns error | Check token status; may need `ironcurtain auth google` |
| Credential file corrupt/deleted mid-session | `loadCredentialsQuietly()` fails or returns stale data | MCP server crashes or tool calls fail with auth error; `TokenFileRefresher` rewrites on next interval (≤5 min) | Automatic recovery on next refresher tick; if server crashed, session restart needed |
| Testing mode: refresh token expired (7-day limit) | Refresh returns `invalid_grant` | `OAuthTokenExpiredError` | `ironcurtain auth google` (weekly) |
| Two sessions refresh simultaneously | Re-read-before-refresh pattern | Usually transparent; rare case: one session fails | Retry or re-authorize |
| Sandbox blocks credential file write | EPERM on the write path | Never reached (no refresh_token = no write attempt) | N/A |
| npm cache write blocked by sandbox | `npx -y` fails on first run | Server fails to start | Pre-install the package, or run without sandbox once |

### 10. `npx` First-Run Problem

The `npx -y` command needs to download the package on first use. This requires both network access (to npmjs.org) and filesystem write access (to the npm cache). In a sandbox, the npm cache must be redirected to a writable directory.

**Option A (Recommended): Use `npm_config_cache` env var**

Redirect the npm cache to a directory within the session sandbox:

```typescript
const npmCacheDir = join(credsDir, '.npm-cache');
serverEnv.npm_config_cache = npmCacheDir;
```

This lets `npx` download and cache the package within the sandbox-writable area. Subsequent runs in the same session use the cache. Different sessions re-download (acceptable for a ~2MB package).

**Option B: Pre-install during `ironcurtain auth import`**

Run `npm install -g @alanse/mcp-server-google-workspace` during credential import, outside the sandbox. Then use the installed binary path instead of `npx -y`.

**Option C: Bundle as a dependency**

Add `@alanse/mcp-server-google-workspace` to IronCurtain's `package.json` dependencies. This eliminates the `npx` step entirely but couples IronCurtain's release to the server package version.

Option A is recommended for Phase 1 because it works without global installs and requires no packaging changes.

## Sequence Diagram: Full Tool Call Flow

```
Agent                 Proxy                  TokenFileRefresher       MCP Server            Google API
  |                     |                         |                       |                     |
  |-- tool call ------->|                         |                       |                     |
  |                     |-- policy evaluate ----->|                       |                     |
  |                     |   (allow/escalate)      |                       |                     |
  |                     |                         |                       |                     |
  |                     |-- forward tool call --->|                       |                     |
  |                     |                         |   ensureAuth()        |                     |
  |                     |                         |   loadCredsQuietly()  |                     |
  |                     |                         |   <- read cred file   |                     |
  |                     |                         |   (no refresh_token)  |                     |
  |                     |                         |                       |-- API call -------->|
  |                     |                         |                       |<-- response --------|
  |                     |<-- tool result ---------|                       |                     |
  |<-- tool result -----|                         |                       |                     |
  |                     |                         |                       |                     |
  ...time passes...     |                         |                       |                     |
  |                     |                         |-- timer fires ------->|                     |
  |                     |                         |   check expiry        |                     |
  |                     |                         |   if near expiry:     |                     |
  |                     |                         |     refresh token     |                     |
  |                     |                         |     write cred file   |                     |
  |                     |                         |                       |                     |
  |-- next tool call -->|                         |                       |                     |
  |                     |-- forward ------------>||                       |                     |
  |                     |                         |   ensureAuth()        |                     |
  |                     |                         |   loadCredsQuietly()  |                     |
  |                     |                         |   <- picks up fresh   |                     |
  |                     |                         |      token from file  |                     |
  |                     |                         |                       |-- API call -------->|
  |                     |                         |                       |<-- response --------|
  |                     |<-- tool result ---------|                       |                     |
  |<-- tool result -----|                         |                       |                     |
```

## Security Analysis

### Threat: Refresh Token Exfiltration

The refresh token is the crown jewel -- it provides ongoing access to the user's Google account. Our defenses:

1. **Never in the credential file**: The `.gworkspace-credentials.json` written for the MCP server contains only the access token (short-lived, ~1 hour). The refresh token stays in `~/.ironcurtain/oauth/google.json`, which is in `denyRead` for the sandbox.

2. **Never in env vars**: Unlike the earlier third-party-oauth.md design (which proposed injecting `GOOGLE_REFRESH_TOKEN` as an env var), this design does NOT pass the refresh token to the MCP server process at all. The `OAuthTokenProvider` runs in the proxy process, which is trusted.

3. **Sandbox filesystem isolation**: `~/.ironcurtain/oauth/` is in `denyRead`. Even if the MCP server code tried to read the canonical token store, the sandbox blocks it.

4. **CLIENT_SECRET exposure**: The `CLIENT_ID` and `CLIENT_SECRET` are passed as env vars because the MCP server's `auth.ts` creates `new google.auth.OAuth2(process.env.CLIENT_ID, process.env.CLIENT_SECRET)`. However, Google Desktop app client secrets are not truly confidential (Google documents this). They are needed for the OAuth2Client constructor but cannot be used to refresh tokens without the refresh token. This is an acceptable exposure.

### Threat: Access Token Exfiltration

The MCP server necessarily has the access token (it needs it to call Google APIs). An access token is short-lived (~1 hour) and scoped to the granted permissions. If exfiltrated, the blast radius is limited:

- Time-limited: expires in ~1 hour
- Scope-limited: only the scopes granted during `ironcurtain auth google`
- Default scopes are read-only

The sandbox network allowlist prevents the MCP server from sending the token to arbitrary external hosts. It can only communicate with `*.googleapis.com`.

### Threat: MCP Server Code Tampering

The `npx -y` command downloads the server from npm. A supply chain attack on the npm package could introduce malicious code. Mitigations:

- **Sandbox containment**: Even compromised code cannot access the refresh token (denyRead), cannot write outside the session directory, and can only reach `*.googleapis.com` (network allowlist).
- **Policy engine**: All tool calls are mediated by the policy engine. Malicious tools would need to be annotated and have rules that allow them.
- **Version pinning** (recommended): Pin the package version in the `args`: `["npx", "-y", "@alanse/mcp-server-google-workspace@0.2.2"]`.

### Threat: Concurrent Refresh Token Rotation Race

Detailed in Section 4 (Concurrency Model). The re-read-before-refresh pattern in `OAuthTokenProvider` handles the common case. The rare simultaneous-refresh race is mitigated by Google's refresh token grace period.

### Threat: Token File TOCTOU

Between the MCP server reading the credential file and using the token, the `TokenFileRefresher` might overwrite it. This is benign: the server holds the token in memory (on the `OAuth2Client` object) after reading. The file write and read are not contending on the same in-memory state.

The atomic write pattern (write to `.tmp`, rename) prevents partial reads.

## Trade-offs and Alternatives Considered

### Alternative A: Inject Refresh Token (rejected)

The third-party-oauth.md design (Decision 4) proposed injecting the refresh token and client credentials into the MCP server's env, letting the server handle its own refresh. This was rejected for the Google Workspace integration because:

1. **Refresh token rotation race**: Google rotates refresh tokens on each refresh. Multiple sessions sharing one OAuth grant would invalidate each other's refresh tokens.
2. **Loss of authority**: If the MCP server refreshes independently, IronCurtain's token store becomes stale. The next session start would use an outdated refresh token.
3. **Sandbox write requirement**: The MCP server writes refreshed tokens to disk (auth.ts line 131). In a sandbox, this write would be blocked, causing the server to lose refreshed credentials.

The credential-file-rendezvous pattern (this design) avoids all three problems by making the MCP server a pure access token consumer.

### Alternative B: Proxy-Side HTTP Interception (rejected)

Route all MCP server HTTP traffic through a local proxy that injects fresh Bearer tokens. This would make the server fully network-isolated (no direct Google API access).

Rejected because:
- The `googleapis` library uses HTTP/2 by default; proxying HTTP/2 adds significant complexity
- The server uses the Google SDK's built-in HTTP client, which would need to be configured to use a proxy (env var `HTTPS_PROXY`)
- SSL certificate verification would need custom CA injection
- Overkill for the problem: the credential-file-rendezvous pattern is simpler and sufficient

### Alternative C: Fork/Patch the MCP Server (rejected)

Modify `auth.ts` to accept access tokens from env vars directly, bypassing the credential file mechanism entirely.

Rejected because:
- Maintenance burden: must track upstream changes
- The credential-file-rendezvous pattern works without modifications to the server
- The `loadCredentialsQuietly()` function already supports the file-based pattern

### Alternative D: Server Process Restart on Token Expiry (considered, deferred)

When the token expires, kill the MCP server process and restart it with a fresh token in the env. This is the simplest approach but has drawbacks:

- Loss of server-side state (e.g., cached Drive file listings)
- Requires reconnecting the MCP client, re-listing tools
- Risk of dropping in-flight tool calls

Kept as a fallback if the credential-file-rendezvous pattern proves insufficient, but not recommended for Phase 1.

## File Changes Required

### New Files

| File | Purpose |
|------|---------|
| `src/trusted-process/gworkspace-credentials.ts` | `writeGWorkspaceCredentialFile()` -- writes credential file in MCP server's expected format |
| `src/trusted-process/token-file-refresher.ts` | `TokenFileRefresher` class -- proactive credential file refresh |
| `test/token-file-refresher.test.ts` | Unit tests for TokenFileRefresher |
| `test/gworkspace-credentials.test.ts` | Unit tests for credential file writing |

### Modified Files

| File | Change |
|------|--------|
| `src/config/mcp-servers.json` | Add `google-workspace` server entry |
| `src/trusted-process/mcp-proxy-server.ts` | OAuth token injection in server spawn loop; TokenFileRefresher lifecycle |
| `src/config/constitution.md` (or `constitution-user-base.md`) | Add principles for Google Workspace tools |
| `src/pipeline/handwritten-scenarios.ts` | Ground-truth policy scenarios for Workspace tools |
| `test/fixtures/test-policy.ts` | Test tool annotations and rules for Workspace tools |
| `test/policy-engine.test.ts` | Policy engine tests for Workspace tool decisions |

### Depends On (from third-party-oauth.md)

These files must exist before this integration can be built:

| File | Source |
|------|--------|
| `src/auth/oauth-provider.ts` | Phase 1 of third-party-oauth.md (already implemented) |
| `src/auth/oauth-token-provider.ts` | Phase 1 (already implemented) |
| `src/auth/oauth-token-store.ts` | Phase 1 (already implemented) |
| `src/auth/providers/google.ts` | Phase 1 (already implemented) |
| `src/auth/oauth-registry.ts` | Phase 1 (already implemented) |
| `src/auth/oauth-flow.ts` | Phase 1 (already implemented) |
| `src/auth/auth-command.ts` | Phase 2 (CLI: `ironcurtain auth import/google`) |

## Required OAuth Scopes

The MCP server's 141 tools span six Google Workspace services. The scope picker in `google-scopes.ts` must offer all scopes the server may need. The default scopes (read-only for Gmail, Calendar, Drive) are sufficient for basic read operations. For full tool coverage, the user must grant additional scopes:

| Service | Required Scope | Short Name | Default? |
|---------|---------------|------------|----------|
| Gmail | `gmail.readonly` | `gmail.readonly` | Yes |
| Gmail | `gmail.modify` | `gmail.modify` | No |
| Gmail | `gmail.send` | `gmail.send` | No |
| Gmail | `gmail.compose` | `gmail.compose` | No |
| Gmail | `gmail.labels` | `gmail.labels` | No |
| Calendar | `calendar.readonly` | `calendar.readonly` | Yes |
| Calendar | `calendar.events` | `calendar.events` | No |
| Drive | `drive.readonly` | `drive.readonly` | Yes |
| Drive | `drive.file` | `drive.file` | No |
| Docs | `documents` | `documents` | No |
| Sheets | `spreadsheets` | `spreadsheets` | No |
| Slides | `presentations` | `presentations` | No |

When the agent attempts a tool that requires a scope not yet granted, the MCP server will receive a 403 from Google. The user can then run `ironcurtain auth google --scopes` to grant the additional scope via incremental consent (Google's `include_granted_scopes=true` parameter preserves previously granted scopes).

**Note on per-server env injection (B2 dismissed):** The existing `serverCredentials` mechanism in `config.json` already supports per-server credential injection via `SERVER_FILTER` in Code Mode. No new infrastructure is needed for this — the proxy's OAuth token injection code (Section 8) uses the standard pattern.

## Constitution Updates

Add to `constitution-user-base.md` (or a separate Google Workspace section):

```markdown
## Google Workspace

### Principle: Read-First, Write-with-Approval
- Reading emails, calendar events, drive files, docs, and sheets is generally safe.
- Sending emails, creating/modifying calendar events, and editing documents require human approval.
- Deleting emails, calendar events, or Drive files is a destructive operation requiring explicit approval.

### Principle: No Bulk Operations Without Oversight
- Batch operations (e.g., batch_modify_labels, batch email operations) affect many items simultaneously.
- These should be escalated regardless of the individual operation's safety level.

### Principle: Respect Privacy Boundaries
- The agent should not read private calendar details or email content without clear task relevance.
- Sharing permissions on Drive files (drive_share_file) must always be escalated.
```

## Argument Roles

New argument roles may be needed for Google Workspace tool arguments:

| Role | Category | Example Tools | Normalization |
|------|----------|---------------|---------------|
| `google-resource-id` | `opaque` | `gmail_get_message(messageId)`, `drive_read_file(fileId)` | None (opaque identifier) |
| `email-address` | `opaque` | `gmail_send_message(to)`, `drive_share_file(email)` | Lowercase, trim |
| `email-body` | `opaque` | `gmail_send_message(body)`, `gmail_draft_message(body)` | None |
| `calendar-datetime` | `opaque` | `calendar_create_event(start, end)` | None |

These are all `opaque` category because they are not filesystem paths or URLs -- they are Google-specific identifiers. The policy engine's structural invariants (path containment, domain allowlist) do not apply. Policy decisions rely entirely on compiled declarative rules matching tool names and roles.

## Implementation Plan

### Phase 1: Credential File Management (1 PR)

- `src/trusted-process/gworkspace-credentials.ts`
- `src/trusted-process/token-file-refresher.ts`
- Unit tests for both

### Phase 2: Proxy Integration (1 PR)

- Modify `mcp-proxy-server.ts` for OAuth token injection
- Add `google-workspace` to `mcp-servers.json`
- Add npm cache redirection for `npx`
- Integration test: proxy spawns mock server with credential file

### Phase 3: Policy and Constitution (1 PR)

- Constitution updates for Google Workspace principles
- Handwritten scenarios for critical policy decisions
- Policy engine test fixtures and tests
- Run `npm run annotate-tools` and `npm run compile-policy`

### Phase 4: Argument Roles (1 PR, may combine with Phase 3)

- Add `google-resource-id`, `email-address` roles to argument-roles.ts
- Update annotation prompt guidance
- Re-run annotation pipeline
