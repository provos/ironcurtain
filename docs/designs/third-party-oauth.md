# Third-Party OAuth Onboarding for MCP Servers

**Date:** 2026-03-15
**Status:** Design
**Author:** Feature Architect

## Problem Statement

IronCurtain currently supports two credential patterns for MCP servers:

1. **Static API keys/PATs** -- stored in `serverCredentials` within `~/.ironcurtain/config.json` (e.g., `GITHUB_PERSONAL_ACCESS_TOKEN`), injected into server process environments via `SERVER_CREDENTIALS` env var in `mcp-proxy-server.ts` (line 435).

2. **Anthropic-specific OAuth** -- detected from `~/.claude/.credentials.json` or macOS Keychain (`oauth-credentials.ts`), managed by `OAuthTokenManager` (`oauth-token-manager.ts`), swapped in the MITM proxy via the `ProviderKeyMapping.tokenManager` pattern (`mitm-proxy.ts` line 77).

Neither pattern works for MCP servers that require browser-based OAuth login with third-party identity providers. Google Workspace MCP servers (the `gemini-cli-extensions/workspace` server identified in `docs/brainstorm/google-workspace-mcp-servers.md`) require Google OAuth 2.0 with browser consent, refresh token persistence, and incremental scope requests. Similar patterns apply to Microsoft Graph and other OAuth-protected APIs.

The gap: there is no mechanism to (a) run a local OAuth flow, (b) store third-party refresh tokens durably, (c) inject access tokens into MCP server processes with automatic refresh, or (d) expose third-party tokens through the MITM proxy for Docker Agent Mode.

## Design Constraints

1. **Two execution modes** -- Code Mode (MCP servers are local child processes of `mcp-proxy-server.ts`) and Docker Agent Mode (MCP servers run on the host, agent in a network-isolated container communicating through the MITM proxy).

2. **Tokens must never enter containers** -- consistent with the existing security model where real credentials stay on the host side (`docker-infrastructure.ts` line 139, `ANTHROPIC_HOSTS` pattern).

3. **MCP servers expect specific env vars** -- the Google Workspace server expects `GOOGLE_ACCESS_TOKEN` (or reads from its own token file). We must inject tokens through the existing `env` mechanism in `MCPServerConfig` (`config/types.ts` line 59).

4. **No persistent HTTP server** -- IronCurtain is a CLI tool. The OAuth callback server must be ephemeral (start for auth, stop immediately after).

5. **Existing credential storage patterns** -- `config.json` uses `0o600` permissions (`user-config.ts` line 300). The Anthropic OAuth credentials file also uses `0o600` (`oauth-credentials.ts` line 236). We must match these patterns.

6. **Provider-specific differences** -- Google uses `authorization_code` grant with PKCE, Microsoft uses similar but different scopes/endpoints, GitHub OAuth uses different token formats. The abstraction must accommodate all three without over-engineering for day-one.

## Architecture Overview

### Component Diagram

```
CLI Command                          Runtime (Session)

ironcurtain auth google-workspace    Code Mode:
    |                                  mcp-proxy-server.ts
    v                                    |
OAuthFlowRunner                          v
    |                                  OAuthTokenProvider
    |--- starts localhost:PORT           |--- reads token store
    |--- opens browser                   |--- refreshes if expired
    |--- receives callback               |--- injects into server env
    |--- exchanges code for tokens
    v                                  Docker Agent Mode:
OAuthTokenStore                          docker-infrastructure.ts
    |--- writes to                           |
    |    ~/.ironcurtain/oauth/               v
    |    {provider}.json                 ProviderKeyMapping
    v                                        |--- OAuthTokenManager
OAuthProviderRegistry                        |    (extended for third-party)
    |--- Google config                       |--- fake-key swap in MITM
    |--- Microsoft config
    |--- GitHub config
```

### Request Flow: Code Mode

```
Agent calls google-workspace tool
    |
    v
mcp-proxy-server.ts: handleCallTool()
    |
    v
prepareToolArgs() -> policy evaluation -> ALLOW
    |
    v
Forward to google-workspace MCP server process
    |--- server env includes GOOGLE_ACCESS_TOKEN
    |    (injected by OAuthTokenProvider at server spawn time)
    |
    v
If server returns 401:
    |--- OAuthTokenProvider.refresh() called
    |--- server process restarted with new token
    |--- (or: token injected via IPC if server supports it)
```

### Request Flow: Docker Agent Mode

```
Agent (in container) -> MCP proxy (in container) -> host MCP proxy
    |
    v
Host mcp-proxy-server.ts -> google-workspace MCP server (host process)
    |--- Server env has real GOOGLE_ACCESS_TOKEN
    |--- (token never enters the container; proxy is on the host)
    |
    v
If google-workspace server needs to call Google APIs directly
(not through MITM proxy):
    |--- Token is in server env, server uses it directly
    |--- Refresh handled by OAuthTokenProvider in proxy process
```

**Key insight**: In Docker Agent Mode, the MCP proxy (`mcp-proxy-server.ts`) runs on the host side, not in the container. The MCP servers are spawned by the proxy as child processes on the host. This means OAuth token injection into MCP server environments works identically in both modes -- the token is injected into the server's `env` at spawn time on the host, never crossing the container boundary.

The MITM proxy pattern (fake-key swap for the LLM provider) is a separate concern. Third-party OAuth tokens for MCP servers do not flow through the MITM proxy at all -- they flow through the MCP proxy to the MCP server process.

## OAuth Provider Registry

### Interface Design

```typescript
// src/auth/oauth-provider.ts

/**
 * Identifies a registered OAuth provider.
 * Used as the key in token storage and CLI commands.
 */
export type OAuthProviderId = 'google' | 'microsoft' | 'github-oauth';

/**
 * Configuration for a third-party OAuth 2.0 provider.
 *
 * Each provider defines the endpoints, scope requirements, and env var
 * mappings for its OAuth flow. Providers are registered statically
 * (not user-configurable) but client credentials come from user-provided
 * files, not hardcoded values.
 *
 * Google (and most providers) require users to create their own Cloud
 * project and OAuth client -- see "Google Cloud Project Setup" section.
 */
export interface OAuthProviderConfig {
  /** Unique identifier used in CLI commands and token storage. */
  readonly id: OAuthProviderId;

  /** Human-readable name for display in CLI prompts. */
  readonly displayName: string;

  /** OAuth 2.0 authorization endpoint URL. */
  readonly authorizationUrl: string;

  /** OAuth 2.0 token exchange endpoint URL. */
  readonly tokenUrl: string;

  /**
   * Default scopes requested on first authorization.
   * Additional scopes can be added via incremental consent.
   */
  readonly defaultScopes: readonly string[];

  /**
   * Path component of the redirect URI (e.g., '/callback').
   * The callback server uses dynamic port allocation (port 0) -- the OS
   * assigns an available port. Google, Microsoft, and GitHub all support
   * any loopback port for native/CLI OAuth applications, so a fixed port
   * is unnecessary and risks conflicts with other local services.
   *
   * The full redirect URI is constructed at runtime as:
   *   `http://127.0.0.1:${assignedPort}${callbackPath}`
   */
  readonly callbackPath: string;

  /**
   * Whether the provider supports PKCE (Proof Key for Code Exchange).
   * All modern providers do; this exists for completeness.
   */
  readonly usePkce: boolean;

  /**
   * Maps this OAuth provider to the MCP server names that use its tokens.
   * When an MCP server in this list is spawned, the proxy injects the
   * provider's access token into the server's environment.
   */
  readonly serverNames: readonly string[];

  /**
   * Environment variable name used to inject the access token into
   * the MCP server process. Provider-specific because different servers
   * expect different env var names.
   */
  readonly tokenEnvVar: string;

  /**
   * Environment variable name for the refresh token.
   * Injected alongside the access token so servers that support
   * internal token refresh can renew tokens without proxy involvement.
   */
  readonly refreshTokenEnvVar: string;

  /**
   * Environment variable name for the client ID.
   * Needed by servers that perform their own token refresh.
   */
  readonly clientIdEnvVar: string;

  /**
   * Environment variable name for the client secret.
   * Google Desktop app credentials include a client_secret that is
   * needed for token exchange and refresh.
   */
  readonly clientSecretEnvVar: string;

  /**
   * Path to the user's OAuth credentials file, relative to
   * ~/.ironcurtain/oauth/. This file contains client_id and
   * client_secret from the provider's developer console.
   *
   * For Google, this is the downloaded `credentials.json` file
   * which has the structure: { "installed": { "client_id": "...", ... } }
   */
  readonly credentialsFilename: string;

  /**
   * Optional: additional env vars derived from the token response.
   * For example, Google provides `id_token` alongside `access_token`.
   */
  readonly additionalEnvVars?: Readonly<Record<string, (token: StoredOAuthToken) => string>>;

  /**
   * Optional: URL to display after successful authorization,
   * guiding the user to any additional setup steps.
   */
  readonly postAuthUrl?: string;

  /**
   * Optional: provider-specific token revocation endpoint.
   * Used by `ironcurtain auth revoke <provider>`.
   */
  readonly revocationUrl?: string;
}

/**
 * Client credentials loaded from the user's credentials file.
 * These are NOT hardcoded -- users must create their own OAuth
 * application with the provider and download the credentials.
 */
export interface OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Loads client credentials from the user's credentials file.
 * For Google, parses the { "installed": { ... } } format.
 * Returns null if the file doesn't exist (user hasn't set up credentials yet).
 * Throws if the file exists but has an invalid format.
 */
export function loadClientCredentials(provider: OAuthProviderConfig): OAuthClientCredentials | null;
```

### Built-in Provider Definitions

```typescript
// src/auth/providers/google.ts

export const googleOAuthProvider: OAuthProviderConfig = {
  id: 'google',
  displayName: 'Google Workspace',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  defaultScopes: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
  ],
  callbackPath: '/callback',
  usePkce: true,
  serverNames: ['google-workspace'],
  tokenEnvVar: 'GOOGLE_ACCESS_TOKEN',
  refreshTokenEnvVar: 'GOOGLE_REFRESH_TOKEN',
  clientIdEnvVar: 'GOOGLE_CLIENT_ID',
  clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET',
  credentialsFilename: 'google-credentials.json',
  revocationUrl: 'https://oauth2.googleapis.com/revoke',
};
```

### Provider Registry

```typescript
// src/auth/oauth-registry.ts

import type { OAuthProviderConfig, OAuthProviderId } from './oauth-provider.js';

const providers = new Map<OAuthProviderId, OAuthProviderConfig>();

/**
 * Returns the provider config for the given ID.
 * Throws if the provider is not registered.
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderConfig;

/**
 * Returns all registered provider configs.
 */
export function getAllOAuthProviders(): readonly OAuthProviderConfig[];

/**
 * Looks up which OAuth provider (if any) is needed for a given MCP server name.
 * Used by the proxy to decide whether to inject an OAuth token.
 */
export function getProviderForServer(serverName: string): OAuthProviderConfig | undefined;
```

## Token Storage Schema

### File Layout

```
~/.ironcurtain/
  oauth/
    google.json          # Google OAuth tokens (mode 0600)
    microsoft.json       # Microsoft OAuth tokens (mode 0600)
    github-oauth.json    # GitHub OAuth tokens (mode 0600)
```

### Token File Schema

```typescript
// src/auth/oauth-token-store.ts

/**
 * Persisted OAuth token for a third-party provider.
 * Stored as JSON in ~/.ironcurtain/oauth/{provider}.json.
 *
 * The file uses 0o600 permissions, matching the pattern in
 * oauth-credentials.ts (line 236) and user-config.ts (line 300).
 */
export interface StoredOAuthToken {
  /** OAuth access token (short-lived, ~1 hour). */
  readonly accessToken: string;

  /** OAuth refresh token (long-lived, used to obtain new access tokens). */
  readonly refreshToken: string;

  /** Unix timestamp (ms) when the access token expires. */
  readonly expiresAt: number;

  /**
   * Scopes that were granted during authorization.
   * Tracked for incremental consent: new scope requests check
   * whether the existing grant already covers them.
   */
  readonly scopes: readonly string[];
}
```

### Token Store Operations

```typescript
/**
 * Loads the stored token for a provider, or null if not authorized.
 * Validates the file structure but does NOT check expiry.
 */
export function loadOAuthToken(providerId: string): StoredOAuthToken | null;

/**
 * Saves an OAuth token to disk with 0o600 permissions.
 * Uses write-then-chmod pattern from oauth-credentials.ts (line 236-239).
 */
export function saveOAuthToken(providerId: string, token: StoredOAuthToken): void;

/**
 * Deletes the stored token for a provider (revocation).
 */
export function deleteOAuthToken(providerId: OAuthProviderId): void;

/**
 * Returns the file path for a provider's token file.
 * Added to src/config/paths.ts alongside existing path helpers.
 */
export function getOAuthTokenPath(providerId: OAuthProviderId): string;
// Implementation: resolve(getIronCurtainHome(), 'oauth', `${providerId}.json`)
```

## OAuth Flow Runner

### Interface

```typescript
// src/auth/oauth-flow.ts

/**
 * Result of a completed OAuth authorization flow.
 */
export interface OAuthFlowResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly scope: string;
  readonly tokenType: string;
}

/**
 * Runs the OAuth 2.0 authorization code flow with PKCE.
 *
 * 1. Loads client credentials from the user's credentials file
 * 2. Generates PKCE code verifier and challenge
 * 3. Starts an ephemeral HTTP server on localhost (port 0, OS-assigned)
 * 4. Opens the authorization URL in the user's default browser
 * 5. Waits for the callback with the authorization code
 * 6. Exchanges the code for tokens (using client_id + client_secret)
 * 7. Stops the callback server
 *
 * @param provider - The OAuth provider configuration
 * @param clientCredentials - Client credentials loaded from user's credentials file
 * @param scopes - Scopes to request (defaults to provider.defaultScopes)
 * @param timeoutMs - How long to wait for the callback (default: 120000)
 * @throws OAuthFlowError on timeout, user denial, or exchange failure
 */
export function runOAuthFlow(
  provider: OAuthProviderConfig,
  clientCredentials: OAuthClientCredentials,
  scopes?: readonly string[],
  timeoutMs?: number,
): Promise<OAuthFlowResult>;
```

### Implementation Notes

The flow runner is a standalone module with no dependencies on the session layer. It uses:

- `node:http` for the ephemeral callback server (similar to the MITM proxy's `http.createServer` pattern in `mitm-proxy.ts`)
- `node:crypto` for PKCE code verifier/challenge (SHA-256, base64url encoding)
- `open` (npm package) or `node:child_process` `exec` for launching the browser
- `node:fetch` for the token exchange POST

The callback server listens only on `127.0.0.1` (not `0.0.0.0`) to prevent network-adjacent attacks. It serves a simple HTML page on successful callback that tells the user to return to the terminal.

## Token Provider (Runtime Integration)

### Interface

```typescript
// src/auth/oauth-token-provider.ts

/**
 * Provides valid OAuth access tokens at runtime, handling refresh transparently.
 *
 * Follows the same deduplication pattern as OAuthTokenManager
 * (oauth-token-manager.ts lines 125-135): concurrent callers share
 * a single in-flight refresh promise.
 *
 * Unlike OAuthTokenManager (which is Anthropic-specific and coordinates
 * with an external process that may also refresh), this provider owns
 * the refresh lifecycle entirely.
 */
export class OAuthTokenProvider {
  constructor(providerId: OAuthProviderId);

  /**
   * Returns a valid access token, refreshing if necessary.
   * Throws OAuthTokenExpiredError if refresh fails (refresh token revoked).
   */
  getValidAccessToken(): Promise<string>;

  /**
   * Returns the currently granted scopes.
   */
  getGrantedScopes(): readonly string[];

  /**
   * Returns true if the provider has a stored token (may be expired).
   */
  isAuthorized(): boolean;
}
```

### Code Mode Integration

Token injection happens during session initialization, where per-server credentials are assembled before MCP server processes are spawned. In Code Mode, `Sandbox.initialize()` (`src/sandbox/index.ts`, lines 371-381) already scopes credentials per-server: each proxy receives only its own credentials via `config.userConfig.serverCredentials[serverName]`. OAuth tokens must be resolved and injected into this per-server credential map **before** proxy spawn, not inside the proxy's `main()`.

The injection point is the session setup code that populates `serverCredentials`:

```typescript
// In session initialization, before Sandbox.initialize() or proxy spawn:

for (const serverName of Object.keys(config.mcpServers)) {
  const oauthProvider = getProviderForServer(serverName);
  if (oauthProvider) {
    // Load user's client credentials (from their Cloud Console download)
    const clientCreds = loadClientCredentials(oauthProvider);
    if (!clientCreds) {
      log.warn(
        `Skipping MCP server "${serverName}": OAuth credentials not configured. ` +
          `Run 'ironcurtain auth import ${oauthProvider.id} <credentials-file>' to import your credentials.`,
      );
      continue;
    }
    const tokenProvider = new OAuthTokenProvider(oauthProvider.id);
    if (!tokenProvider.isAuthorized()) {
      log.warn(
        `Skipping MCP server "${serverName}": OAuth not authorized. ` +
          `Run 'ironcurtain auth ${oauthProvider.id}' to authorize.`,
      );
      continue;
    }
    try {
      const token = await tokenProvider.getValidAccessToken();
      const stored = loadOAuthToken(oauthProvider.id)!;
      // Inject into per-server credentials (scoped, not shared).
      // Each server only receives its own credentials -- never leaked to others.
      config.userConfig.serverCredentials[serverName] ??= {};
      const creds = config.userConfig.serverCredentials[serverName];
      creds[oauthProvider.tokenEnvVar] = token;
      creds[oauthProvider.refreshTokenEnvVar] = stored.refreshToken;
      creds[oauthProvider.clientIdEnvVar] = clientCreds.clientId;
      creds[oauthProvider.clientSecretEnvVar] = clientCreds.clientSecret;
    } catch {
      log.warn(
        `Skipping MCP server "${serverName}": OAuth token refresh failed. ` +
          `Run 'ironcurtain auth ${oauthProvider.id}' to re-authorize.`,
      );
      continue;
    }
  }
}

// Sandbox.initialize() then passes per-server credentials to each proxy:
//   serverCreds = config.userConfig.serverCredentials[serverName]
//   env: { SERVER_CREDENTIALS: JSON.stringify(serverCreds) }
```

This pattern is intentionally simple. The token is injected once at session start, scoped to the specific server that needs it. If the token expires during a long session, the server process will receive 401s from the third-party API. See the "Token Expiry and Refresh Strategy" section below for how this is addressed. A more sophisticated approach (token refresh IPC to running server processes) is deferred to a future iteration.

### Docker Agent Mode Integration

In Docker Agent Mode, MCP servers are spawned by the host-side proxy, not inside the container. The token injection path is identical to Code Mode -- OAuth tokens are resolved and injected into per-server credentials during `prepareDockerInfrastructure()`, before MCP proxy processes are started. The `CodeModeProxy` passes `SERVER_CREDENTIALS` per-server, just as `Sandbox.initialize()` does in Code Mode. No MITM proxy changes are needed because:

1. The MCP server (e.g., `google-workspace`) runs on the host as a child of `mcp-proxy-server.ts`
2. The server calls Google APIs directly using the access token in its environment
3. Google API calls go out from the host, not from the container
4. The container only communicates with the MCP proxy over the UDS/TCP bridge

The MITM proxy only handles LLM provider traffic (Anthropic, OpenAI, Google Gemini). MCP server-to-API traffic is a separate path.

**Exception**: If a future MCP server routes its API calls through the container agent (unlikely but possible), we would need to add a `ProviderKeyMapping` for the third-party OAuth provider. This is deferred.

## CLI UX

### `ironcurtain auth import` Subcommand (Credential Import)

```
ironcurtain auth import google /path/to/credentials.json  # Import Google OAuth client credentials
```

### `ironcurtain auth` Command (Authorization & Management)

```
ironcurtain auth                     # List all OAuth providers and their status
ironcurtain auth import google /path/to/credentials.json  # Import credentials
ironcurtain auth google              # Authorize Google Workspace (opens browser)
ironcurtain auth google --scopes gmail.send  # Add incremental scopes
ironcurtain auth revoke google       # Revoke and delete stored token
ironcurtain auth status              # Show token status for all providers
```

### Credential Import Flow UX

```
$ ironcurtain auth import google ~/Downloads/client_secret_XXXX.json

  Google Workspace — Import OAuth Credentials

  Validating credentials file...
  ✓ Found client_id: XXXX.apps.googleusercontent.com
  ✓ Found client_secret: GOCSPX-XXXX (Desktop app)
  ✓ Project: ironcurtain-12345

  Credentials saved to ~/.ironcurtain/oauth/google-credentials.json

  Next step: run 'ironcurtain auth google' to authorize your Google account.
```

### Authorization Flow UX

```
$ ironcurtain auth google

  Google Workspace OAuth

  Using credentials from ~/.ironcurtain/oauth/google-credentials.json
  Client: XXXX.apps.googleusercontent.com

  IronCurtain will request the following permissions:
    - Read your email (gmail.readonly)
    - Read your calendar (calendar.readonly)
    - Read your Google Drive files (drive.readonly)

  These permissions let the Google Workspace MCP server read your
  data on behalf of the AI agent. The agent can only access this
  data through tools mediated by IronCurtain's policy engine.

  Note: In Testing mode, refresh tokens expire after 7 days.
  You will need to re-authorize weekly.

  ? Continue with authorization? (Y/n) y

  Opening browser for Google sign-in...
  Waiting for authorization (timeout: 2 minutes)...

  Authorization successful!

  Token stored at ~/.ironcurtain/oauth/google.json
  Granted scopes: gmail.readonly, calendar.readonly, drive.readonly

  The Google Workspace server will be available in your next session.
  Run 'ironcurtain start' to begin.
```

### Status Display in `ironcurtain config`

The existing `handleServerCredentials` function (`config-command.ts` line 576) shows server credential status. We add an "OAuth Providers" section to the top-level config menu:

```
  Select a category to configure
    Models (Claude Sonnet 4.6, Claude Sonnet 4.6)
    Security (timeout: 5m, auto-approve: off)
    ...
    Server Credentials (github)
  > OAuth Providers (google: authorized, microsoft: not configured)
    Save & Exit (no changes)
```

### Incremental Consent

When a user needs additional scopes (e.g., adding `gmail.send` to an existing `gmail.readonly` grant):

```
$ ironcurtain auth google --scopes gmail.send,calendar.events

  Google Workspace OAuth — Incremental Consent

  You already have the following scopes:
    - gmail.readonly
    - calendar.readonly
    - drive.readonly

  Requesting additional scopes:
    + gmail.send
    + calendar.events

  ? Continue? (Y/n) y

  Opening browser...
```

The flow uses Google's `include_granted_scopes=true` authorization parameter (set via `extraAuthParams` in the provider config) combined with local scope merging to preserve existing scopes while adding new ones.

## Multi-Provider Abstraction

The design uses a simple registry pattern rather than an abstract factory because:

1. Provider endpoint configs are static (shipped with IronCurtain); only client credentials are user-provided
2. The OAuth 2.0 flow is identical across providers (only endpoints/scopes differ)
3. Token storage and refresh use the same logic for all providers
4. We avoid the "interface that mirrors a single implementation 1:1" anti-pattern

The `OAuthProviderConfig` interface captures all provider-specific variation declaratively. The flow runner, token store, and token provider are provider-agnostic. Client credentials are loaded at runtime from user-provided files via `loadClientCredentials()`.

**Extension point**: Adding a new OAuth provider requires:

1. Create `src/auth/providers/{provider}.ts` with the `OAuthProviderConfig`
2. Register it in `src/auth/oauth-registry.ts`
3. Add the `OAuthProviderId` union member
4. Add the MCP server entry to `mcp-servers.json`
5. Document the provider-specific credential setup steps (Cloud Console, Azure AD, etc.)

No changes to the flow runner, token store, or proxy integration code.

## Security Analysis

### Token Storage

- **File permissions**: `0o600` (owner-only), matching `user-config.ts` and `oauth-credentials.ts` patterns
- **Location**: `~/.ironcurtain/oauth/`, separate from `config.json` to allow different backup/sync policies
- **Refresh tokens**: Long-lived, equivalent to full account access. Stored locally, never transmitted except to the provider's token endpoint
- **Access tokens**: Short-lived (~1 hour), injected into server process environments. Visible to the MCP server process but not to the container in Docker mode

### Container Isolation

- Real tokens never enter Docker containers (same guarantee as Anthropic OAuth)
- MCP servers run on the host side of the proxy, not in the container
- The MITM proxy does not handle third-party OAuth traffic (only LLM provider traffic)

### OAuth Flow Security

- **PKCE**: Required for all providers (prevents authorization code interception)
- **Loopback redirect**: `http://127.0.0.1:{dynamically-assigned-port}/callback` (not `localhost` to avoid DNS rebinding; port 0 allocation avoids conflicts)
- **Ephemeral server**: Callback server starts, handles one request, stops
- **State parameter**: Random nonce validated on callback (prevents CSRF)
- **Client credentials**: Stored in `~/.ironcurtain/oauth/` with `0o600` permissions. Google Desktop app client secrets are not truly secret (documented by Google for installed apps), but still protected on disk

### Audit Trail

- Token authorization events logged to session audit log
- Token refresh events logged (when/which provider)
- Token injection into server env logged (server name + provider, not the token value)
- Token revocation logged

### Risk: Token Scope Overprivilege

The default scopes are read-only. Write scopes (e.g., `gmail.send`) require explicit `--scopes` flag with incremental consent. This aligns with IronCurtain's "least privilege" constitution principle.

The policy engine provides a second layer: even with a `gmail.send` scope granted at the OAuth level, the compiled policy rules determine whether the agent can actually call the `gmail.send` tool. OAuth scopes are a ceiling, not a floor.

### Risk: Refresh Token Rotation

Google rotates refresh tokens on use. If IronCurtain and another application share the same OAuth client credentials, they could invalidate each other's refresh tokens. Mitigation: each user creates a dedicated OAuth client for IronCurtain in their Google Cloud project, separate from any other tool's credentials.

### Risk: Testing Mode Token Expiry

For users whose Google Cloud project is in "Testing" mode (the default), refresh tokens expire after **7 days**. This means:

- Users must re-run `ironcurtain auth google` weekly
- Long-running sessions that span the 7-day boundary will fail
- The `OAuthTokenProvider` surfaces a clear `OAuthTokenExpiredError` with instructions to re-authorize

Organizations that need persistent tokens should publish their OAuth app to "Production" and complete Google's verification process. For restricted scopes (gmail.readonly, drive.readonly), this requires the annual CASA security assessment.

## Google Cloud Project Setup

### Why Users Must Create Their Own Credentials

Unlike tools like `gcloud` or `gh` (which are published by the platform owner), IronCurtain cannot ship a default Google OAuth client ID for two reasons:

1. **Restricted scopes**: `gmail.readonly` and `drive.readonly` are classified by Google as **restricted scopes**, not merely sensitive. Restricted scopes require an **annual third-party security assessment** (CASA framework via the App Defense Alliance) resulting in a Letter of Assessment (LOA). This is an expensive, recurring operational burden unsuitable for an open-source project.

2. **Scope verification tiers**:
   - **Non-sensitive** (e.g., `calendar.freebusy`, `drive.file`): brand verification only (2-3 business days)
   - **Sensitive** (e.g., `gmail.send`, `calendar.readonly`): brand verification + scope justification + demo video (3-5 business days)
   - **Restricted** (e.g., `gmail.readonly`, `gmail.compose`, `drive`, `drive.readonly`): all of the above + annual CASA security assessment

3. **Testing mode limitations**: Without verification, an OAuth client is limited to 100 explicitly-added test users, and **refresh tokens expire after 7 days**. This makes testing mode impractical for ongoing use.

Instead, each user (or organization) creates their own Google Cloud project. Since users add only themselves as a test user, the unverified "Testing" mode works fine for personal use -- though the 7-day refresh token expiry means users must re-authorize weekly. Organizations can publish their app to "Production" and complete verification to remove this limitation.

### Step-by-Step Setup Guide

IronCurtain's `ironcurtain auth import google` command displays these instructions and validates the result:

#### Step 1: Create a Google Cloud Project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/projectcreate)
2. Enter a **Project Name** (e.g., "IronCurtain")
3. Click **Create**

#### Step 2: Enable Google Workspace APIs

1. Navigate to **APIs & Services > Library**
2. Search for and enable each API you need:
   - **Gmail API** (`gmail.googleapis.com`)
   - **Google Calendar API** (`calendar-json.googleapis.com`)
   - **Google Drive API** (`drive.googleapis.com`)

Alternatively, via `gcloud` CLI:

```bash
gcloud services enable gmail.googleapis.com calendar-json.googleapis.com drive.googleapis.com
```

#### Step 3: Configure the OAuth Consent Screen

1. Navigate to **Google Auth platform > Branding** (or **APIs & Services > OAuth consent screen**)
2. Click **Get Started** (or **Configure Consent Screen**)
3. Set **User type** to **External** (unless you have a Google Workspace org, in which case **Internal** avoids all verification requirements)
4. Fill in:
   - **App name**: e.g., "IronCurtain"
   - **User support email**: your email
   - **Developer contact email**: your email
5. Add the scopes you need. Read-only scopes (`gmail.readonly`, `calendar.readonly`, `drive.readonly`) are requested by default. For write access, also add `gmail.send`, `calendar.events`, and/or `drive.file` — these are optional and can be added later via `ironcurtain auth google --scopes gmail.send,calendar.events`
6. Under **Audience** (or **Test users**), add your Google account email as a test user

> **Note**: For "External" apps in "Testing" mode, only explicitly-listed test users can authorize, and refresh tokens expire after 7 days. For personal use this is acceptable -- just re-run `ironcurtain auth google` weekly. For organization use, publish to "Production" and complete Google's verification process to remove these limitations.

#### Step 4: Create OAuth Client Credentials

1. Navigate to **Google Auth platform > Clients** (or **APIs & Services > Credentials**)
2. Click **Create Client** (or **Create Credentials > OAuth client ID**)
3. Select **Application type: Desktop app**
4. Enter a **Name** (e.g., "IronCurtain CLI")
5. Click **Create**
6. Click **Download JSON** to download the credentials file

The downloaded file has this structure:

```json
{
  "installed": {
    "client_id": "XXXX.apps.googleusercontent.com",
    "project_id": "your-project-id",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_secret": "GOCSPX-XXXXXXXXXXXX",
    "redirect_uris": ["http://localhost"]
  }
}
```

> **Important**: The `client_secret` in a Desktop app credential is not truly secret (Google documents this for native/installed apps). However, do not commit this file to source control.

#### Step 5: Import into IronCurtain

```bash
ironcurtain auth import google /path/to/downloaded-credentials.json
```

This command:

1. Validates the JSON structure (checks for `"installed"` key with `client_id` and `client_secret`)
2. Copies the file to `~/.ironcurtain/oauth/google-credentials.json` with `0o600` permissions
3. Confirms the setup and prompts to run `ironcurtain auth google` to complete authorization

### Credential File Storage

```
~/.ironcurtain/
  oauth/
    google-credentials.json   # Client credentials from Cloud Console (0o600)
    google.json               # OAuth tokens after authorization (0o600)
```

The credentials file is read at authorization time and at token refresh time. The `loadClientCredentials()` function parses the `"installed"` key format and extracts `client_id` and `client_secret`.

### Scope Verification Reference

| Scope               | Classification | Verification Required           |
| ------------------- | -------------- | ------------------------------- |
| `calendar.readonly` | Sensitive      | Brand + justification + demo    |
| `calendar.events`   | Sensitive      | Brand + justification + demo    |
| `gmail.readonly`    | **Restricted** | Annual CASA security assessment |
| `gmail.send`        | **Restricted** | Annual CASA security assessment |
| `gmail.compose`     | **Restricted** | Annual CASA security assessment |
| `drive.readonly`    | **Restricted** | Annual CASA security assessment |
| `drive` (full)      | **Restricted** | Annual CASA security assessment |
| `drive.file`        | Non-sensitive  | Brand verification only         |
| `calendar.freebusy` | Non-sensitive  | Brand verification only         |

For personal use in Testing mode, verification is not required -- but refresh tokens expire after 7 days and only listed test users can authorize.

### Microsoft and GitHub

- **Microsoft**: Requires Azure AD app registration. Similar user-creates-own-project model. Supports "personal Microsoft accounts" and "organizational accounts" with different consent flows. No equivalent of Google's restricted scope CASA assessment.
- **GitHub**: OAuth app registration is straightforward (no scope verification process). GitHub Apps are an alternative with more granular permissions. Could potentially ship a default client ID since GitHub has no verification burden.

## Token Expiry and Refresh Strategy

Access tokens from providers like Google are short-lived (~1 hour). MCP servers cannot perform browser-based OAuth from within IronCurtain's architecture (there is no user-facing browser in the runtime context). Tools like `auth.refreshToken` exposed by some MCP servers are agent-callable tools, not background refresh -- the agent must explicitly invoke them, and they require the refresh token and client credentials to be available.

Three options were evaluated:

**Option A: Inject refresh token + client credentials (Recommended for Phase 1)**

Inject the access token, refresh token, client ID, and (if applicable) client secret into the MCP server's environment at spawn time. Servers that support programmatic token refresh can call the provider's token endpoint directly using the refresh token, without any browser interaction.

- **Env vars**: `GOOGLE_ACCESS_TOKEN`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (Google Desktop app credentials include a client secret needed for token exchange)
- **Security trade-off**: The refresh token is long-lived and grants ongoing access. However, it is already stored on disk and is scoped to a single server process via per-server credential isolation.
- **Advantage**: Simplest approach. Servers that handle refresh internally work transparently. No proxy-side complexity.

**Option B: Proxy-side refresh (Phase 2)**

The session monitors token expiry timestamps. When a token is near expiry, the proxy refreshes it by calling the provider's token endpoint, then restarts the MCP server process with the new access token injected into its environment.

- **Advantage**: Works with servers that only accept a short-lived access token and have no internal refresh capability.
- **Disadvantage**: Restarting the server process mid-session may lose server-side state. Requires careful coordination to avoid dropping in-flight tool calls.
- **Deferred**: Only needed if we encounter MCP servers that cannot handle refresh internally.

**Option C: Time-limited sessions**

Accept the ~1 hour token lifetime as a session limit. Document the limitation and surface a clear error when the token expires.

- **Advantage**: Zero complexity.
- **Disadvantage**: Impractical for longer tasks. Poor user experience.
- **Not recommended** as a standalone strategy, but the token expiry error handling from this option should be implemented regardless.

**Recommendation**: Implement Option A for Phase 1. Add Option B as Phase 2 (Phase 5 of the overall implementation plan) for servers that need it.

### Cross-Process Refresh Coordination

When multiple IronCurtain sessions run concurrently (or a session coexists with other tools using the same OAuth client), refresh token rotation can cause races: one process refreshes the token, invalidating the refresh token held by another process.

The `OAuthTokenProvider` must re-read the token file from disk before attempting a refresh, to pick up tokens that may have been refreshed by another process. This follows the same re-read-before-refresh pattern used in `OAuthTokenManager` (lines 139, 179 in `oauth-token-manager.ts`):

```typescript
async getValidAccessToken(): Promise<string> {
  // Re-read from disk to pick up tokens refreshed by another process
  const stored = loadOAuthToken(this.providerId);
  if (!stored) throw new OAuthTokenExpiredError(this.providerId);

  if (stored.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return stored.accessToken;
  }

  // Deduplicate concurrent refresh calls (same pattern as OAuthTokenManager)
  if (!this.refreshPromise) {
    this.refreshPromise = this.doRefresh(stored).finally(() => {
      this.refreshPromise = undefined;
    });
  }
  return this.refreshPromise;
}
```

## Implementation Plan

### Phase 1: Core OAuth Infrastructure (1-2 PRs)

**New files:**

- `src/auth/oauth-provider.ts` -- `OAuthProviderConfig`, `OAuthProviderId`, `OAuthClientCredentials` types, `loadClientCredentials()`
- `src/auth/oauth-registry.ts` -- provider registry
- `src/auth/oauth-token-store.ts` -- `StoredOAuthToken`, load/save/delete
- `src/auth/oauth-flow.ts` -- `runOAuthFlow()` (PKCE, callback server, token exchange)
- `src/auth/oauth-token-provider.ts` -- `OAuthTokenProvider` (runtime refresh)
- `src/auth/providers/google.ts` -- Google Workspace provider config

**Modified files:**

- `src/config/paths.ts` -- add `getOAuthDir()`, `getOAuthTokenPath()`, `getOAuthCredentialsPath()`

**Tests:**

- Unit tests for `loadClientCredentials()` (valid Google format, missing file, invalid format)
- Unit tests for token store (read/write/delete, permissions)
- Unit tests for PKCE generation
- Unit tests for token provider (refresh logic, deduplication)
- Integration test for the full OAuth flow (using a mock HTTP server as the provider)

### Phase 2: CLI Commands (1 PR)

**New files:**

- `src/auth/auth-command.ts` -- `ironcurtain auth` CLI command implementation (includes `auth import <provider> <file>` subcommand for credential import)

**Modified files:**

- `src/cli.ts` -- register `auth` subcommand
- `src/config/config-command.ts` -- add "OAuth Providers" menu item
- `src/config/first-start.ts` -- mention `ironcurtain auth import` in the customization note

### Phase 3: Code Mode Integration (1 PR)

**Modified files:**

- `src/trusted-process/mcp-proxy-server.ts` -- token injection in server spawn loop
- `src/config/mcp-servers.json` -- add `google-workspace` server entry

**New files:**

- `src/config/constitution-google-workspace.md` (or additions to constitution-user-base.md) -- policy principles for Workspace tools

**Tests:**

- Integration test: proxy spawns a mock MCP server with OAuth token in env
- Policy engine tests for Google Workspace tool annotations

### Phase 4: Additional Providers (1 PR each, as needed)

- `src/auth/providers/microsoft.ts` -- Microsoft Graph OAuth config
- `src/auth/providers/github-oauth.ts` -- GitHub OAuth (as alternative to PAT)

### Phase 5: Proxy-Side Token Refresh (future, deferred)

For long-running sessions where access tokens expire mid-session:

- Monitor token expiry timestamps; when a token is near expiry, refresh it and restart the MCP server process with the new token injected into its environment
- Alternatively: protocol for the proxy to signal running MCP servers to reload credentials via IPC

This is deferred to Phase 2 of the token expiry strategy (see "Token Expiry and Refresh Strategy" below). Phase 1 injects both access and refresh tokens so servers that support internal refresh can handle it themselves.

## Key Decisions and Trade-offs

### Decision 1: No MITM Proxy Changes for Third-Party OAuth

**Chosen**: Third-party OAuth tokens are injected into MCP server process environments on the host side. The MITM proxy is not involved.

**Rationale**: MCP servers call third-party APIs directly from the host. The MITM proxy sits between the container agent and LLM providers -- a completely different data path. Adding third-party providers to the MITM proxy would be architecturally wrong: it would mean the container agent is calling Google APIs directly (bypassing the MCP server), which violates the mediation model.

**Trade-off**: If a future MCP server design requires the container agent to authenticate directly with a third-party API (not through an MCP tool), we would need to revisit this. This seems unlikely given the MCP architecture.

### Decision 2: User-Provided OAuth Credentials (Not Shipped)

**Chosen**: Users create their own Google Cloud project and download OAuth Desktop app credentials. IronCurtain reads `client_id` and `client_secret` from the user's downloaded `credentials.json`.

**Alternative A**: Ship a default client ID (like `gcloud`, `gh`).

**Alternative B**: Use PKCE-only public clients with no client secret.

**Rationale**: Google classifies `gmail.readonly` and `drive.readonly` as **restricted scopes** requiring an annual CASA security assessment for verified apps. This is an expensive recurring burden unsuitable for an open-source project. User-created credentials in "Testing" mode work for personal use without verification. The client secret in a Google Desktop app credential is not truly secret (Google documents this), but Google's token endpoint requires it for the authorization code exchange.

### Decision 3: Separate Token Storage from config.json

**Chosen**: OAuth tokens stored in `~/.ironcurtain/oauth/{provider}.json`, separate from `config.json`.

**Alternative**: Add an `oauthTokens` field to `config.json`.

**Rationale**: (a) Token files are updated frequently (every refresh), while `config.json` is rarely modified. Separate files avoid write contention and reduce risk of corrupting config on a failed token write. (b) Different backup/sync semantics: users may sync `config.json` across machines but should NOT sync OAuth tokens (they are device-specific). (c) Matches the precedent of `~/.claude/.credentials.json` being separate from Claude Code's config.

### Decision 4: Inject Both Access and Refresh Tokens (Phase 1)

**Chosen**: Inject the access token, refresh token, and client credentials into the MCP server's environment at spawn time. Servers that support internal token refresh (using the refresh token and client ID to call the provider's token endpoint directly) can handle expiry transparently.

**Alternative A**: Inject only the access token and limit sessions to ~1 hour (the typical access token lifetime). Simple but impractical for longer tasks.

**Alternative B**: Build proxy-side refresh -- monitor token expiry, call the provider's token endpoint, and restart the MCP server process with a fresh access token. More robust but adds complexity.

**Rationale**: Option A (inject refresh token + client credentials) is the simplest path that supports long-running sessions. Many MCP servers already accept refresh tokens and handle renewal internally. The security trade-off is that the refresh token is long-lived and provides ongoing access, but it is already stored on disk in `~/.ironcurtain/oauth/` and only exposed to the specific MCP server process that needs it (per-server credential scoping). Option B (proxy-side refresh) is deferred to Phase 2 for servers that only accept short-lived access tokens. See "Token Expiry and Refresh Strategy" for details.

### Decision 5: Static Provider Registry with User-Provided Credentials

**Chosen**: OAuth provider configurations (endpoints, scopes, env var mappings) are registered in code. Client credentials (`client_id`, `client_secret`) come from user-provided files downloaded from each provider's developer console.

**Alternative**: Let users define entire custom OAuth providers in config.

**Rationale**: Provider endpoints, scope formats, and token exchange protocols are standardized and shouldn't vary per user. Only the client credentials are user-specific. The registry pattern (similar to `provider-config.ts` built-in providers) defines the static parts; `loadClientCredentials()` reads the user-specific parts from `~/.ironcurtain/oauth/{provider}-credentials.json`.

### Decision 6: Read-Only Default Scopes

**Chosen**: Default scopes are read-only. Write scopes require explicit `--scopes` flag.

**Rationale**: Aligns with IronCurtain's "least privilege" constitution principle. A user who runs `ironcurtain auth google` gets read access. Sending email or creating calendar events requires a deliberate additional authorization step. The policy engine provides a second defense layer regardless of granted scopes.
