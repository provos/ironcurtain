/**
 * Runtime OAuth token provider with transparent refresh.
 *
 * Provides valid access tokens for a specific OAuth provider, handling
 * token expiry detection and refresh with deduplication. Follows the
 * re-read-before-refresh pattern from OAuthTokenManager to coordinate
 * with other processes that may refresh concurrently.
 */

import { existsSync } from 'node:fs';
import { getOAuthTokenPath } from '../config/paths.js';
import type { OAuthProviderConfig, OAuthClientCredentials, StoredOAuthToken } from './oauth-provider.js';
import { loadOAuthToken, saveOAuthToken, isTokenExpired } from './oauth-token-store.js';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class OAuthTokenExpiredError extends Error {
  constructor(
    public readonly providerId: string,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(
      message ??
        `OAuth token for "${providerId}" has expired and could not be refreshed. Run 'ironcurtain auth ${providerId}' to re-authorize.`,
      options,
    );
    this.name = 'OAuthTokenExpiredError';
  }
}

// ---------------------------------------------------------------------------
// Token refresh HTTP call
// ---------------------------------------------------------------------------

interface RefreshTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/**
 * Exchanges a refresh token for a new access token.
 * Returns the updated StoredOAuthToken, preserving the original refresh token
 * if the provider does not issue a new one.
 */
async function refreshAccessToken(
  provider: OAuthProviderConfig,
  clientCredentials: OAuthClientCredentials,
  currentToken: StoredOAuthToken,
): Promise<StoredOAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientCredentials.clientId,
    client_secret: clientCredentials.clientSecret,
    refresh_token: currentToken.refreshToken,
  });

  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new OAuthTokenExpiredError(
      provider.id,
      `Token refresh failed for "${provider.id}" (${response.status}): ${text}. Run 'ironcurtain auth ${provider.id}' to re-authorize.`,
    );
  }

  const data = (await response.json()) as RefreshTokenResponse;

  if (!data.access_token) {
    throw new OAuthTokenExpiredError(
      provider.id,
      `Token refresh response missing access_token for "${provider.id}". Run 'ironcurtain auth ${provider.id}' to re-authorize.`,
    );
  }

  const expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : 0;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? currentToken.refreshToken,
    expiresAt,
    scopes: data.scope ? data.scope.split(' ') : [...currentToken.scopes],
  };
}

// ---------------------------------------------------------------------------
// OAuthTokenProvider
// ---------------------------------------------------------------------------

/**
 * Provides valid access tokens for a specific OAuth provider at runtime.
 * Handles transparent refresh with deduplication (single in-flight refresh).
 */
export class OAuthTokenProvider {
  private readonly provider: OAuthProviderConfig;
  private readonly clientCredentials: OAuthClientCredentials;
  private inflightRefresh: Promise<string> | null = null;

  constructor(provider: OAuthProviderConfig, clientCredentials: OAuthClientCredentials) {
    this.provider = provider;
    this.clientCredentials = clientCredentials;
  }

  /**
   * Returns a valid access token, refreshing if near expiry.
   * Uses the re-read-before-refresh pattern: checks if another process
   * already refreshed the token before attempting our own refresh.
   */
  async getValidAccessToken(): Promise<string> {
    const token = loadOAuthToken(this.provider.id);
    if (!token) {
      throw new OAuthTokenExpiredError(
        this.provider.id,
        `No stored token for "${this.provider.id}". Run 'ironcurtain auth ${this.provider.id}' to authorize.`,
      );
    }

    if (!isTokenExpired(token)) {
      return token.accessToken;
    }

    return this.doRefresh();
  }

  /** Returns true if a token file exists for this provider. */
  isAuthorized(): boolean {
    return existsSync(getOAuthTokenPath(this.provider.id));
  }

  /**
   * Core refresh with deduplication. Concurrent callers share a single
   * in-flight refresh promise.
   */
  private doRefresh(): Promise<string> {
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }

    this.inflightRefresh = this.executeRefresh().finally(() => {
      this.inflightRefresh = null;
    });

    return this.inflightRefresh;
  }

  /**
   * Re-read-before-refresh pattern: another process may have already
   * refreshed the token since our initial check.
   */
  private async executeRefresh(): Promise<string> {
    // Re-read from disk -- another process may have refreshed already
    const reread = loadOAuthToken(this.provider.id);
    if (reread && !isTokenExpired(reread)) {
      return reread.accessToken;
    }

    // Use the freshest token we have for the refresh request
    const tokenForRefresh = reread ?? loadOAuthToken(this.provider.id);
    if (!tokenForRefresh) {
      throw new OAuthTokenExpiredError(this.provider.id);
    }

    const refreshed = await refreshAccessToken(this.provider, this.clientCredentials, tokenForRefresh);
    saveOAuthToken(this.provider.id, refreshed);
    return refreshed.accessToken;
  }
}
