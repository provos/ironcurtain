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

import { existsSync, readFileSync } from 'node:fs';
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

/** Authentication method detected on the host. */
export type AuthMethod =
  | { readonly kind: 'oauth'; readonly credentials: OAuthCredentials }
  | { readonly kind: 'apikey'; readonly key: string }
  | { readonly kind: 'none' };

/** Minimum remaining token lifetime (5 minutes) to consider a token usable. */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

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
    if (typeof creds.accessToken !== 'string' || !creds.accessToken) return null;
    if (typeof creds.refreshToken !== 'string' || !creds.refreshToken) return null;
    if (typeof creds.expiresAt !== 'number' || !Number.isFinite(creds.expiresAt) || creds.expiresAt <= 0) return null;

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
 *
 * @param sources - Injectable credential loaders (for testing)
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
      return { kind: 'oauth', credentials: fileCreds };
    }
    logger.warn('OAuth token from credentials file is expired');
  }

  // Try macOS Keychain if credentials file was not found
  if (!fileCreds) {
    const keychainCreds = loadFromKeychain();
    if (keychainCreds) {
      if (!isTokenExpired(keychainCreds)) {
        return { kind: 'oauth', credentials: keychainCreds };
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
