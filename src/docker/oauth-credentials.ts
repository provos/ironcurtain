/**
 * OAuth credential detection for Docker agent sessions.
 *
 * Detects whether the host user has OAuth credentials from Claude Code
 * and provides them for the fake-key-swap pattern. Real credentials
 * never enter the container -- the MITM proxy swaps fake tokens for
 * real ones on the host side.
 *
 * Detection order (prefer OAuth):
 * 1. ~/.claude/.credentials.json (claudeAiOauth)
 * 2. macOS Keychain (if credentials file missing)
 * 3. Fall back to API key from config
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IronCurtainConfig } from '../config/types.js';
import * as logger from '../logger.js';

/** OAuth credentials from Claude Code's credential store. */
export interface OAuthCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

/** Where OAuth credentials were loaded from. */
export type OAuthCredentialSource = 'file' | 'keychain';

/** Authentication method detected on the host. */
export type AuthMethod =
  | { readonly kind: 'oauth'; readonly credentials: OAuthCredentials; readonly source: OAuthCredentialSource }
  | { readonly kind: 'apikey'; readonly key: string }
  | { readonly kind: 'none' };

/** Minimum remaining token lifetime (5 minutes) to consider a token usable. */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Service names used by Claude Code in macOS Keychain. */
const KEYCHAIN_SERVICE_NAMES = ['Claude Code-credentials', 'Claude Code'] as const;

/**
 * Returns the path to Claude Code's credentials file.
 * Exposed for testing.
 */
export function getCredentialsFilePath(): string {
  return resolve(homedir(), '.claude', '.credentials.json');
}

/**
 * Checks whether an OAuth token is expired or too close to expiry.
 * Returns true if the token has fewer than 5 minutes of validity remaining.
 */
export function isTokenExpired(credentials: OAuthCredentials): boolean {
  return Date.now() + TOKEN_EXPIRY_BUFFER_MS >= credentials.expiresAt;
}

/**
 * Loads OAuth credentials from ~/.claude/.credentials.json.
 * Returns null if the file is missing, unreadable, or lacks valid credentials.
 */
export function loadOAuthCredentials(): OAuthCredentials | null {
  const credPath = getCredentialsFilePath();
  return loadCredentialsFromFile(credPath);
}

/**
 * Parses credentials from a file path. Extracted for testability.
 */
export function loadCredentialsFromFile(filePath: string): OAuthCredentials | null {
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    return parseCredentialsJson(raw);
  } catch {
    logger.warn(`Failed to read OAuth credentials from ${filePath}`);
    return null;
  }
}

/**
 * Parses the claudeAiOauth section from a credentials JSON string.
 * Returns null if parsing fails or required fields are missing.
 */
export function parseCredentialsJson(json: string): OAuthCredentials | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const obj = parsed as Record<string, unknown>;
    const oauth = obj.claudeAiOauth;
    if (typeof oauth !== 'object' || oauth === null) return null;

    const creds = oauth as Record<string, unknown>;
    if (!isNonEmptyString(creds.accessToken)) return null;
    if (!isNonEmptyString(creds.refreshToken)) return null;
    if (!isPositiveFiniteNumber(creds.expiresAt)) return null;

    return {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Attempts to extract OAuth credentials from the macOS Keychain.
 * Returns null on non-macOS platforms, Keychain access failure, or
 * when no valid credentials are found.
 *
 * Tries both service names because Claude Code has a known bug where
 * the write and read service names differ.
 */
export function extractFromKeychain(): OAuthCredentials | null {
  if (platform() !== 'darwin') return null;

  const account = userInfo().username;
  for (const service of KEYCHAIN_SERVICE_NAMES) {
    try {
      const result = execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      });
      const credentials = parseCredentialsJson(result.trim());
      if (credentials) {
        logger.info(`Found OAuth credentials in macOS Keychain (service: "${service}")`);
        return credentials;
      }
    } catch {
      // Not found or keychain locked -- try next service name
      continue;
    }
  }

  return null;
}

/** Claude Code's public OAuth client ID. */
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Anthropic's OAuth token endpoint (platform.claude.com since mid-2025). */
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

/**
 * Refreshes an OAuth access token using a refresh token grant.
 *
 * Returns new credentials on success, or null on failure (expired refresh
 * token, network error, etc.).
 */
export async function refreshOAuthToken(refreshToken: string): Promise<OAuthCredentials | null> {
  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });

    if (!response.ok) {
      logger.warn(`OAuth token refresh failed: HTTP ${response.status}`);
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;
    return parseTokenResponse(data);
  } catch (err) {
    logger.warn(`OAuth token refresh error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Validates and extracts credentials from an OAuth token endpoint response.
 * Returns null if any required field is missing or invalid.
 */
function parseTokenResponse(data: Record<string, unknown>): OAuthCredentials | null {
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = data;

  if (!isNonEmptyString(accessToken)) return null;
  if (!isNonEmptyString(refreshToken)) return null;
  if (!isPositiveFiniteNumber(expiresIn)) return null;

  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

/**
 * Writes updated OAuth credentials back to ~/.claude/.credentials.json,
 * preserving other fields in the file (e.g., scopes, subscriptionType).
 */
export function saveOAuthCredentials(credentials: OAuthCredentials, filePath?: string): void {
  const credPath = filePath ?? getCredentialsFilePath();

  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(credPath)) {
      existing = JSON.parse(readFileSync(credPath, 'utf-8')) as Record<string, unknown>;
    }
  } catch {
    // Start fresh if file is unreadable
  }

  const existingOauth =
    typeof existing.claudeAiOauth === 'object' && existing.claudeAiOauth !== null
      ? (existing.claudeAiOauth as Record<string, unknown>)
      : {};

  existing.claudeAiOauth = {
    ...existingOauth,
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
  };

  writeFileSync(credPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  // chmod after write — writeFileSync's mode only applies when creating new files;
  // existing files with broader permissions need an explicit chmod.
  chmodSync(credPath, 0o600);
}

/** Injectable credential sources for testability. */
export interface CredentialSources {
  loadFromFile: () => OAuthCredentials | null;
  loadFromKeychain: () => OAuthCredentials | null;
}

const defaultSources: CredentialSources = {
  loadFromFile: loadOAuthCredentials,
  loadFromKeychain: extractFromKeychain,
};

/**
 * Detects the best authentication method available on the host.
 *
 * Priority:
 * 1. IRONCURTAIN_DOCKER_AUTH=apikey env var forces API key mode
 * 2. OAuth credentials from ~/.claude/.credentials.json (if not expired)
 * 3. OAuth credentials from macOS Keychain (if credentials file missing)
 * 4. API key from config
 * 5. None
 */
export function detectAuthMethod(config: IronCurtainConfig, sources?: CredentialSources): AuthMethod {
  const { loadFromFile, loadFromKeychain } = sources ?? defaultSources;

  // Allow explicit override to force API key mode
  if (process.env.IRONCURTAIN_DOCKER_AUTH === 'apikey') {
    logger.info('Docker auth override: forced API key mode via IRONCURTAIN_DOCKER_AUTH');
    return resolveApiKeyAuth(config);
  }

  // Try OAuth from credentials file
  const fileCreds = loadFromFile();
  if (fileCreds) {
    if (!isTokenExpired(fileCreds)) {
      logger.info('Detected OAuth credentials from ~/.claude/.credentials.json');
      return { kind: 'oauth', credentials: fileCreds, source: 'file' };
    }
    logger.warn('OAuth token from credentials file is expired');
  }

  // Try macOS Keychain if credentials file was not found
  if (!fileCreds) {
    const keychainCreds = loadFromKeychain();
    if (keychainCreds) {
      if (!isTokenExpired(keychainCreds)) {
        return { kind: 'oauth', credentials: keychainCreds, source: 'keychain' };
      }
      logger.warn('OAuth token from macOS Keychain is expired');
    }
  }

  // Fall back to API key
  return resolveApiKeyAuth(config);
}

/**
 * Resolves API key authentication from config.
 */
function resolveApiKeyAuth(config: IronCurtainConfig): AuthMethod {
  const key = config.userConfig.anthropicApiKey;
  if (key) {
    logger.info('Using API key authentication for Docker session');
    return { kind: 'apikey', key };
  }
  return { kind: 'none' };
}
