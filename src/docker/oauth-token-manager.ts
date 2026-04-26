/**
 * OAuth token lifecycle manager for Docker agent sessions.
 *
 * Handles proactive refresh (before token expiry) and reactive refresh
 * (on upstream 401). Coordinates with the host Claude Code process that
 * may also refresh tokens concurrently — re-reads the credentials file
 * before attempting a refresh to avoid using a stale refresh token.
 *
 * For file-sourced credentials, refreshed tokens are saved back to the
 * credentials file. For Keychain-sourced credentials (macOS), refreshed
 * tokens are written back to the Keychain via the writeToKeychain dep.
 *
 * A single in-flight refresh promise is shared across concurrent callers
 * to prevent duplicate refresh requests.
 */

import type { OAuthCredentials } from './oauth-credentials.js';
import {
  isTokenExpired,
  loadCredentialsFromFile,
  refreshOAuthToken,
  refreshResultToCreds,
  saveOAuthCredentials,
  getCredentialsFilePath,
  extractFromKeychain,
} from './oauth-credentials.js';
import * as logger from '../logger.js';

/** Injectable dependencies for testability. */
export interface TokenManagerDeps {
  loadCredentials: (filePath: string) => OAuthCredentials | null;
  loadFromKeychain: () => OAuthCredentials | null;
  refreshToken: (refreshToken: string) => Promise<OAuthCredentials | null>;
  saveCredentials: (credentials: OAuthCredentials, filePath?: string) => void;
  credentialsFilePath: string;
  /** When set, refreshed credentials are written to the Keychain instead of the file. */
  writeToKeychain?: (credentials: OAuthCredentials, serviceName: string) => void;
  /** The Keychain service name to use with writeToKeychain. */
  keychainServiceName?: string;
  /** @deprecated No longer used internally. Kept for backward compatibility with tests. */
  now?: () => number;
}

const defaultDeps: TokenManagerDeps = {
  loadCredentials: loadCredentialsFromFile,
  loadFromKeychain: extractFromKeychain,
  refreshToken: async (rt) => refreshResultToCreds(await refreshOAuthToken(rt)),
  saveCredentials: saveOAuthCredentials,
  credentialsFilePath: getCredentialsFilePath(),
};

export interface OAuthTokenManagerOptions {
  /**
   * Whether the manager may perform its own refresh_token grant.
   *
   * When false, the manager only re-reads credentials from the file and
   * Keychain — it never POSTs to the token endpoint itself.
   *
   * Defaults to true. For Keychain-sourced credentials, set writeToKeychain
   * and keychainServiceName in deps so refreshed tokens are persisted to
   * the Keychain rather than the credentials file.
   */
  canRefresh?: boolean;
}

export class OAuthTokenManager {
  private credentials: OAuthCredentials;
  private inflightRefresh: Promise<string | null> | null = null;
  private readonly deps: TokenManagerDeps;
  private readonly canRefresh: boolean;

  constructor(
    initialCredentials: OAuthCredentials,
    options?: OAuthTokenManagerOptions,
    deps?: Partial<TokenManagerDeps>,
  ) {
    this.credentials = initialCredentials;
    this.canRefresh = options?.canRefresh ?? true;
    this.deps = { ...defaultDeps, ...deps };
  }

  /**
   * Returns the current access token. This is always the latest known-good
   * token, whether from the initial credentials, a file re-read, or a refresh.
   */
  get accessToken(): string {
    return this.credentials.accessToken;
  }

  /**
   * Returns a valid access token, refreshing proactively if near expiry.
   *
   * Called before every upstream request to ensure the token is fresh.
   * If the token has more than 5 minutes of validity, returns immediately.
   */
  async getValidAccessToken(): Promise<string> {
    if (!isTokenExpired(this.credentials)) {
      return this.credentials.accessToken;
    }

    logger.info('[oauth-token-manager] Token near expiry, attempting proactive refresh');
    const newToken = await this.doRefresh();
    return newToken ?? this.credentials.accessToken;
  }

  /**
   * Called on upstream 401 — forces a refresh attempt.
   *
   * Returns the new access token on success, or null if refresh is
   * unrecoverable (both our refresh and file re-read failed).
   */
  async handleAuthFailure(): Promise<string | null> {
    logger.info('[oauth-token-manager] Handling auth failure (401), attempting refresh');
    return this.doRefresh();
  }

  /**
   * Core refresh logic with deduplication. Concurrent callers share a single
   * in-flight refresh promise.
   *
   * Re-read file -> for Keychain-sourced creds, also re-read Keychain ->
   * if still expired and canRefresh is true, POST refresh grant ->
   * on failure, re-read file once more (host process may have won the race).
   */
  private doRefresh(): Promise<string | null> {
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }

    this.inflightRefresh = this.executeRefresh().finally(() => {
      this.inflightRefresh = null;
    });

    return this.inflightRefresh;
  }

  private async executeRefresh(): Promise<string | null> {
    // Re-read credentials file -- another process may have refreshed already
    const fileCreds = this.deps.loadCredentials(this.deps.credentialsFilePath);
    if (fileCreds && !isTokenExpired(fileCreds)) {
      logger.info('[oauth-token-manager] Found valid token in credentials file (refreshed by another process)');
      this.credentials = fileCreds;
      return this.credentials.accessToken;
    }

    // For Keychain-sourced creds, check if the host process already refreshed.
    // Capture the Keychain's refresh token in case it's newer than our startup copy.
    let keychainRefreshToken: string | undefined;
    if (this.deps.keychainServiceName) {
      const keychainCreds = this.deps.loadFromKeychain();
      if (keychainCreds && !isTokenExpired(keychainCreds)) {
        logger.info('[oauth-token-manager] Found valid token in Keychain (refreshed by host process)');
        this.credentials = keychainCreds;
        return this.credentials.accessToken;
      }
      keychainRefreshToken = keychainCreds?.refreshToken;
    }

    // Hard guard: when canRefresh is false, never POST a refresh grant
    if (!this.canRefresh) {
      logger.warn('[oauth-token-manager] Token expired and self-refresh is disabled');
      return null;
    }

    // Pick the best available refresh token: file > keychain > initial credentials
    const refreshToken = fileCreds?.refreshToken ?? keychainRefreshToken ?? this.credentials.refreshToken;
    const newCreds = await this.deps.refreshToken(refreshToken);

    if (newCreds) {
      logger.info('[oauth-token-manager] Token refresh successful');
      try {
        if (this.deps.keychainServiceName && this.deps.writeToKeychain) {
          this.deps.writeToKeychain(newCreds, this.deps.keychainServiceName);
        } else {
          this.deps.saveCredentials(newCreds, this.deps.credentialsFilePath);
        }
      } catch (err) {
        logger.warn(
          `[oauth-token-manager] Failed to save refreshed credentials: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.credentials = newCreds;
      return this.credentials.accessToken;
    }

    // Refresh failed -- re-read file one more time (host may have won the race)
    logger.info('[oauth-token-manager] Refresh failed, re-reading credentials file as fallback');
    const fallbackCreds = this.deps.loadCredentials(this.deps.credentialsFilePath);
    if (fallbackCreds && !isTokenExpired(fallbackCreds)) {
      logger.info('[oauth-token-manager] Found valid token in credentials file on fallback re-read');
      this.credentials = fallbackCreds;
      return this.credentials.accessToken;
    }

    logger.warn('[oauth-token-manager] Token refresh failed and no valid credentials available');
    return null;
  }
}
