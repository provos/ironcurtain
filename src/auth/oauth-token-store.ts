/**
 * OAuth token persistence for third-party providers.
 *
 * Stores tokens as JSON files in ~/.ironcurtain/oauth/{providerId}.json
 * with owner-only (0o600) permissions, following the same pattern as
 * saveOAuthCredentials in src/docker/oauth-credentials.ts.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { getOAuthDir, getOAuthTokenPath } from '../config/paths.js';
import type { StoredOAuthToken } from './oauth-provider.js';

/** 5-minute buffer before expiry, matching OAuthTokenManager convention. */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Loads a stored OAuth token for a provider.
 * Returns null if no token file exists.
 * Throws if the file exists but contains invalid JSON or is missing required fields.
 */
export function loadOAuthToken(providerId: string): StoredOAuthToken | null {
  const tokenPath = getOAuthTokenPath(providerId);
  if (!existsSync(tokenPath)) {
    return null;
  }

  const raw = readFileSync(tokenPath, 'utf-8');
  const parsed = parseTokenJson(raw, tokenPath);
  return validateTokenShape(parsed, tokenPath);
}

/**
 * Saves an OAuth token for a provider.
 * Creates the oauth directory if it does not exist.
 * Sets file permissions to 0o600 (owner-only read/write).
 */
export function saveOAuthToken(providerId: string, token: StoredOAuthToken): void {
  const dir = getOAuthDir();
  mkdirSync(dir, { recursive: true });

  const tokenPath = getOAuthTokenPath(providerId);
  writeFileSync(tokenPath, JSON.stringify(token, null, 2) + '\n', { mode: 0o600 });
  // chmod after write -- writeFileSync's mode only applies when creating new files;
  // existing files with broader permissions need an explicit chmod.
  chmodSync(tokenPath, 0o600);
}

/**
 * Deletes a stored OAuth token for a provider.
 * No-op if the file does not exist.
 */
export function deleteOAuthToken(providerId: string): void {
  const tokenPath = getOAuthTokenPath(providerId);
  if (existsSync(tokenPath)) {
    unlinkSync(tokenPath);
  }
}

/**
 * Checks whether a stored token is expired or near expiry.
 * Returns true if fewer than 5 minutes of validity remain.
 */
export function isTokenExpired(token: StoredOAuthToken): boolean {
  return Date.now() + TOKEN_EXPIRY_BUFFER_MS >= token.expiresAt;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseTokenJson(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`, { cause: err });
  }
}

function validateTokenShape(parsed: unknown, filePath: string): StoredOAuthToken {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid token format in ${filePath}: expected a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.accessToken !== 'string' || obj.accessToken.length === 0) {
    throw new Error(`Missing or empty accessToken in ${filePath}`);
  }
  if (typeof obj.refreshToken !== 'string' || obj.refreshToken.length === 0) {
    throw new Error(`Missing or empty refreshToken in ${filePath}`);
  }
  if (typeof obj.expiresAt !== 'number' || !Number.isFinite(obj.expiresAt)) {
    throw new Error(`Missing or invalid expiresAt in ${filePath}`);
  }
  if (!Array.isArray(obj.scopes) || !obj.scopes.every((s: unknown) => typeof s === 'string')) {
    throw new Error(`Missing or invalid scopes in ${filePath}`);
  }

  return {
    accessToken: obj.accessToken,
    refreshToken: obj.refreshToken,
    expiresAt: obj.expiresAt,
    scopes: obj.scopes,
  };
}
