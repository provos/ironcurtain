/**
 * Core OAuth provider types and credential loading.
 *
 * Defines the shape of an OAuth provider configuration and provides
 * utilities for loading client credentials from disk.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getOAuthDir } from '../config/paths.js';
import { isPlainObject } from '../utils/is-plain-object.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Expand this union as new providers are registered in oauth-registry.ts. */
export type OAuthProviderId = 'google';

export interface OAuthProviderConfig {
  readonly id: OAuthProviderId;
  readonly displayName: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly defaultScopes: readonly string[];
  readonly callbackPath: string;
  readonly usePkce: boolean;
  readonly serverNames: readonly string[];
  readonly tokenEnvVar: string;
  readonly refreshTokenEnvVar: string;
  readonly clientIdEnvVar: string;
  readonly clientSecretEnvVar: string;
  readonly credentialsFilename: string;
  readonly additionalEnvVars?: Readonly<Record<string, (token: StoredOAuthToken) => string>>;
  readonly postAuthUrl?: string;
  readonly revocationUrl?: string;
  /** Extra query parameters for the authorization URL (e.g. access_type, prompt). */
  readonly extraAuthParams?: Readonly<Record<string, string>>;
  /** Interactive scope picker shown when no --scopes flag and stdin is a TTY. */
  readonly scopePicker?: (existingScopes: readonly string[]) => Promise<readonly string[] | symbol>;
  /** Resolves short scope names (e.g. "gmail.send") to full scope URLs for --scopes flag. */
  readonly resolveShortScopes?: (shortNames: readonly string[]) => readonly string[];
  /** Provider-specific guidance shown when non-default scopes are requested. */
  readonly nonDefaultScopeWarning?: string;
}

export interface OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface StoredOAuthToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
}

// ---------------------------------------------------------------------------
// Credential loading
// ---------------------------------------------------------------------------

/**
 * Loads OAuth client credentials from the provider's credentials file.
 *
 * Reads from ~/.ironcurtain/oauth/{provider.credentialsFilename}.
 * Supports the Google "installed" Desktop app JSON format:
 *   { "installed": { "client_id": "...", "client_secret": "..." } }
 *
 * Returns null if the file does not exist.
 * Throws if the file exists but contains invalid or incomplete data.
 */
export function loadClientCredentials(provider: OAuthProviderConfig): OAuthClientCredentials | null {
  const credentialsPath = resolve(getOAuthDir(), provider.credentialsFilename);

  if (!existsSync(credentialsPath)) {
    return null;
  }

  const raw = readFileSync(credentialsPath, 'utf-8');
  const parsed = parseCredentialsJson(raw, credentialsPath);
  return extractClientCredentials(parsed, credentialsPath);
}

/**
 * Parses the raw JSON string from a credentials file.
 * Throws a descriptive error on invalid JSON.
 */
function parseCredentialsJson(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`, { cause: err });
  }
}

/**
 * Extracts client_id and client_secret from the parsed credentials object.
 *
 * Supports two formats:
 * 1. Desktop app (Google "installed"): { "installed": { "client_id": "...", "client_secret": "..." } }
 * 2. Flat format: { "client_id": "...", "client_secret": "..." }
 */
function extractClientCredentials(parsed: unknown, filePath: string): OAuthClientCredentials {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid credentials format in ${filePath}: expected a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;

  // Check for "installed" wrapper (Google Desktop app format)
  const source = isPlainObject(obj['installed']) ? obj['installed'] : obj;

  const clientId = source['client_id'];
  const clientSecret = source['client_secret'];

  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new Error(`Missing or empty client_id in ${filePath}`);
  }
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
    throw new Error(`Missing or empty client_secret in ${filePath}`);
  }

  return { clientId, clientSecret };
}
