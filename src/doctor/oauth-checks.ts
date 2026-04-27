/**
 * OAuth-specific diagnostic checks for `ironcurtain doctor`.
 *
 * Split from checks.ts so the OAuth refresh/persist machinery (which
 * touches the credentials file and macOS Keychain) lives next to
 * oauth-credentials.ts and stays out of the general-purpose check surface.
 */

import {
  detectAuthMethod,
  isTokenExpired,
  refreshOAuthToken,
  saveOAuthCredentials,
  writeToKeychain,
  readOnlyCredentialSources,
  type AuthMethod,
  type OAuthCredentials,
  type RefreshResult,
} from '../docker/oauth-credentials.js';
import type { IronCurtainConfig } from '../config/types.js';
import type { CheckResult, CheckStatus } from './checks.js';

/**
 * Computes a human-readable description for an OAuth-typed AuthMethod,
 * including expiry information.
 */
function describeOAuthExpiry(auth: Extract<AuthMethod, { kind: 'oauth' }>): {
  message: string;
  status: CheckStatus;
  hint?: string;
} {
  const remainingMs = auth.credentials.expiresAt - Date.now();
  if (remainingMs <= 0) {
    return {
      message: 'OAuth (expired)',
      status: 'warn',
      hint: 'Token will be refreshed automatically on next use, or run `claude login` to re-authenticate.',
    };
  }
  const remainingDays = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  if (remainingDays >= 1) {
    return {
      message: `OAuth (expires in ${remainingDays} day${remainingDays === 1 ? '' : 's'})`,
      status: 'ok',
    };
  }
  const remainingHours = Math.max(1, Math.floor(remainingMs / (60 * 60 * 1000)));
  if (isTokenExpired(auth.credentials)) {
    return {
      message: `OAuth (expires in ${remainingHours}h, will auto-refresh)`,
      status: 'ok',
    };
  }
  return {
    message: `OAuth (expires in ${remainingHours}h)`,
    status: 'ok',
  };
}

/**
 * Checks Anthropic credential availability. Uses detectAuthMethod with
 * no-refresh sources so doctor never rewrites the credentials file just
 * by being run.
 */
export async function checkAnthropicCredentials(config: IronCurtainConfig): Promise<CheckResult> {
  const auth = await detectAuthMethod(config, readOnlyCredentialSources);

  if (auth.kind === 'oauth') {
    const desc = describeOAuthExpiry(auth);
    return { name: 'Anthropic', status: desc.status, message: desc.message, hint: desc.hint };
  }
  if (auth.kind === 'apikey') {
    return { name: 'Anthropic', status: 'ok', message: 'API key set' };
  }
  return {
    name: 'Anthropic',
    status: 'warn',
    message: 'no credentials detected',
    hint: 'Set ANTHROPIC_API_KEY or run `claude login` to obtain OAuth credentials.',
  };
}

/**
 * Validates the OAuth refresh flow by exchanging the stored refresh token
 * for new credentials. Anthropic rotates refresh tokens, so the new
 * credentials MUST be persisted — otherwise the next refresh attempt
 * (whether by doctor or by the running agent) fails because the local
 * refresh token has been invalidated server-side.
 */
export async function checkOAuthRefresh(config: IronCurtainConfig): Promise<CheckResult> {
  const auth = await detectAuthMethod(config, readOnlyCredentialSources);
  if (auth.kind !== 'oauth') {
    return {
      name: 'OAuth refresh',
      status: 'skip',
      message: 'no OAuth credentials in file or Keychain',
    };
  }

  let result: RefreshResult;
  let elapsed: string;
  try {
    const start = Date.now();
    result = await refreshOAuthToken(auth.credentials.refreshToken);
    elapsed = formatElapsed(Date.now() - start);
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return {
      name: 'OAuth refresh',
      status: 'fail',
      message: (err instanceof Error ? err.message : String(err)) + cause,
    };
  }

  if (result.kind !== 'ok') {
    return formatRefreshFailure(result, elapsed);
  }

  // Refresh succeeded server-side; the old refresh token is now consumed.
  // If we can't persist the rotated credentials, the host is effectively
  // logged out — surface that clearly rather than swallowing the write error.
  try {
    persistRefreshedOAuth(auth, result.credentials);
  } catch (err) {
    return {
      name: 'OAuth refresh',
      status: 'fail',
      message: `refresh succeeded but persistence failed: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'The server-side refresh token has rotated; your stored credentials are now invalid. Run `claude login` to recover.',
    };
  }

  const sourceLabel = auth.source === 'keychain' ? 'Keychain' : 'file';
  return { name: 'OAuth refresh', status: 'ok', message: `valid (${elapsed}, ${sourceLabel})` };
}

function formatRefreshFailure(result: Exclude<RefreshResult, { kind: 'ok' }>, elapsed: string): CheckResult {
  if (result.kind === 'http-error') {
    return {
      name: 'OAuth refresh',
      status: 'fail',
      message: `refresh rejected (HTTP ${result.status}, ${elapsed})`,
      hint:
        result.status === 400 || result.status === 401
          ? 'Refresh token has been invalidated (likely consumed by an earlier refresh). Run `claude login` to issue a new one.'
          : 'Run `claude login` to obtain a new refresh token.',
    };
  }
  if (result.kind === 'parse-error') {
    return {
      name: 'OAuth refresh',
      status: 'fail',
      message: `refresh response unparseable (${elapsed})`,
      hint: result.detail,
    };
  }
  return {
    name: 'OAuth refresh',
    status: 'fail',
    message: `network error (${elapsed})`,
    hint: result.message,
  };
}

/**
 * Writes refreshed credentials back to the same place they came from.
 * Anthropic rotates refresh tokens on every grant, so skipping this would
 * leave the host with an invalidated refresh token next run.
 */
function persistRefreshedOAuth(auth: Extract<AuthMethod, { kind: 'oauth' }>, credentials: OAuthCredentials): void {
  if (auth.source === 'file') {
    saveOAuthCredentials(credentials);
  } else {
    writeToKeychain(credentials, auth.keychainServiceName);
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
