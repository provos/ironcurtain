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
 * 2. ~/.config/anthropic/credentials/default.json (Anthropic CLI store)
 * 3. macOS Keychain (if no credentials file found)
 * 4. Fall back to API key from config
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IronCurtainConfig } from '../config/types.js';
import * as logger from '../logger.js';

/**
 * Which OAuth application issued a credential. Claude Code and the Anthropic
 * CLI (`ant`) are separate OAuth clients with different client IDs, token
 * endpoints, and grant encodings — a refresh grant presented with the wrong
 * client is rejected as 400 invalid_grant. Undefined means Claude Code.
 */
export type OAuthClientKind = 'claude-code' | 'anthropic-cli';

/** OAuth credentials from Claude Code's credential store. */
export interface OAuthCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  /** Issuing OAuth application; decides how the token is refreshed. */
  readonly clientKind?: OAuthClientKind;
}

/** OAuth credentials from Codex CLI's ChatGPT auth cache. */
export interface CodexOAuthCredentials extends OAuthCredentials {
  readonly idToken?: string;
  readonly accountId?: string;
}

/** Where OAuth credentials were loaded from. */
export type OAuthCredentialSource = 'file' | 'keychain';

/** Keychain lookup result that preserves the service name for write-back. */
export interface KeychainResult {
  readonly credentials: OAuthCredentials;
  readonly serviceName: string;
}

/** Authentication method detected on the host. */
export type AuthMethod =
  | {
      readonly kind: 'oauth';
      readonly credentials: OAuthCredentials;
      readonly source: 'file';
      /** Which credentials file the tokens came from; refresh writes back here. */
      readonly filePath?: string;
    }
  | {
      readonly kind: 'oauth';
      readonly credentials: OAuthCredentials;
      readonly source: 'keychain';
      readonly keychainServiceName: string;
    }
  | { readonly kind: 'apikey'; readonly key: string }
  | { readonly kind: 'none' };

/** Minimum remaining token lifetime (5 minutes) to consider a token usable. */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_CODEX_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

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
 * Returns the path to the Anthropic CLI credential store's default profile.
 * Resolution: ANTHROPIC_CONFIG_DIR > $XDG_CONFIG_HOME/anthropic > ~/.config/anthropic.
 */
export function getAnthropicCredentialsFilePath(): string {
  // Truthy checks (not ??): an empty env var must fall through to the next
  // candidate rather than resolving to a cwd-relative path.
  const configDir = process.env.ANTHROPIC_CONFIG_DIR
    ? process.env.ANTHROPIC_CONFIG_DIR
    : process.env.XDG_CONFIG_HOME
      ? resolve(process.env.XDG_CONFIG_HOME, 'anthropic')
      : resolve(homedir(), '.config', 'anthropic');
  return resolve(configDir, 'credentials', 'default.json');
}

/** OAuth credentials together with the file they were loaded from. */
export interface FileCredentialsResult {
  readonly credentials: OAuthCredentials;
  readonly filePath: string;
}

/** Returns Codex's auth cache path, honoring CODEX_HOME when set. */
export function getCodexAuthFilePath(): string {
  return resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), 'auth.json');
}

/**
 * Checks whether an OAuth token is expired or too close to expiry.
 * Returns true if the token has fewer than 5 minutes of validity remaining.
 */
export function isTokenExpired(credentials: OAuthCredentials): boolean {
  return Date.now() + TOKEN_EXPIRY_BUFFER_MS >= credentials.expiresAt;
}

/**
 * Loads OAuth credentials from the first credential file that yields valid
 * credentials, checking ~/.claude/.credentials.json before the Anthropic CLI
 * store at ~/.config/anthropic/credentials/default.json.
 * Returns null if no file contains valid credentials.
 */
export function loadOAuthCredentials(): OAuthCredentials | null {
  return loadOAuthCredentialsWithSource()?.credentials ?? null;
}

/**
 * Loads credentials from every known credential file, in detection-priority
 * order (~/.claude/.credentials.json first, then the Anthropic CLI store).
 * Expired entries are included — detectAuthMethod() decides per file whether
 * to use, refresh, or skip them.
 */
export function loadAllOAuthCredentialFiles(): FileCredentialsResult[] {
  const results: FileCredentialsResult[] = [];
  for (const filePath of [getCredentialsFilePath(), getAnthropicCredentialsFilePath()]) {
    const credentials = loadCredentialsFromFile(filePath);
    if (credentials) results.push({ credentials, filePath });
  }
  return results;
}

/**
 * Like loadOAuthCredentials(), but also reports which file the credentials
 * came from so token refresh can write back to the same file. Prefers the
 * first file with an unexpired token; an expired higher-priority file must
 * not shadow a valid lower-priority one.
 */
export function loadOAuthCredentialsWithSource(): FileCredentialsResult | null {
  const all = loadAllOAuthCredentialFiles();
  return all.find((r) => !isTokenExpired(r.credentials)) ?? all.at(0) ?? null;
}

/**
 * Parses credentials from a file path, accepting either Claude Code's
 * claudeAiOauth shape or the Anthropic CLI's flat snake_case shape.
 * Extracted for testability.
 */
export function loadCredentialsFromFile(filePath: string): OAuthCredentials | null {
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    return parseCredentialsJson(raw) ?? parseAnthropicCredentialsJson(raw);
  } catch {
    logger.warn(`Failed to read OAuth credentials from ${filePath}`);
    return null;
  }
}

/** Loads Codex CLI ChatGPT OAuth credentials from CODEX_HOME/auth.json. */
export function loadCodexOAuthCredentials(filePath = getCodexAuthFilePath()): CodexOAuthCredentials | null {
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    return parseCodexAuthJson(raw);
  } catch {
    logger.warn(`Failed to read Codex OAuth credentials from ${filePath}`);
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
 * Parses the Anthropic CLI credential store shape
 * (~/.config/anthropic/credentials/default.json): flat snake_case fields
 * with `expires_at` in epoch seconds (normalized to milliseconds here).
 * Returns null if parsing fails or required fields are missing.
 */
export function parseAnthropicCredentialsJson(json: string): OAuthCredentials | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const creds = parsed as Record<string, unknown>;
    // The documented store schema (version, access_token, expires_at,
    // refresh_token, scope) does not include `type`; observed files carry
    // type: 'oauth_token'. Accept both, but reject explicit non-OAuth types.
    if (creds.type !== undefined && creds.type !== 'oauth_token') return null;
    if (!isNonEmptyString(creds.access_token)) return null;
    if (!isNonEmptyString(creds.refresh_token)) return null;
    if (!isPositiveFiniteNumber(creds.expires_at)) return null;

    return {
      accessToken: creds.access_token,
      refreshToken: creds.refresh_token,
      expiresAt: creds.expires_at * 1000,
      clientKind: 'anthropic-cli',
    };
  } catch {
    return null;
  }
}

/** Parses Codex CLI's auth.json shape for ChatGPT-backed OAuth sessions. */
export function parseCodexAuthJson(json: string): CodexOAuthCredentials | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const obj = parsed as Record<string, unknown>;
    if (obj.auth_mode !== 'chatgpt' && obj.auth_mode !== 'chatgptAuthTokens') return null;

    const tokens = obj.tokens;
    if (typeof tokens !== 'object' || tokens === null) return null;
    const tokenObj = tokens as Record<string, unknown>;
    if (!isNonEmptyString(tokenObj.access_token)) return null;

    return {
      accessToken: tokenObj.access_token,
      refreshToken: isNonEmptyString(tokenObj.refresh_token) ? tokenObj.refresh_token : '',
      expiresAt: parseJwtExpirationMs(tokenObj.access_token) ?? Date.now() + DEFAULT_CODEX_TOKEN_LIFETIME_MS,
      idToken: isNonEmptyString(tokenObj.id_token) ? tokenObj.id_token : undefined,
      accountId: isNonEmptyString(tokenObj.account_id) ? tokenObj.account_id : undefined,
    };
  } catch {
    return null;
  }
}

function parseJwtExpirationMs(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (typeof payload !== 'object' || payload === null) return null;
    const exp = (payload as Record<string, unknown>).exp;
    return isPositiveFiniteNumber(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Attempts to extract OAuth credentials from the macOS Keychain,
 * also returning which service name succeeded (needed for write-back).
 * Returns null on non-macOS platforms, Keychain access failure, or
 * when no valid credentials are found.
 *
 * Tries both service names because Claude Code has a known bug where
 * the write and read service names differ.
 */
export function extractFromKeychainWithService(): KeychainResult | null {
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
        return { credentials, serviceName: service };
      }
    } catch {
      // Not found or keychain locked -- try next service name
      continue;
    }
  }

  return null;
}

/**
 * Attempts to extract OAuth credentials from the macOS Keychain.
 * Returns null on non-macOS platforms, Keychain access failure, or
 * when no valid credentials are found.
 *
 * Delegates to extractFromKeychainWithService() and strips the service name.
 */
export function extractFromKeychain(): OAuthCredentials | null {
  return extractFromKeychainWithService()?.credentials ?? null;
}

/**
 * Writes updated OAuth credentials back to the macOS Keychain.
 * Preserves existing fields in the Keychain entry (e.g., scopes, subscriptionType).
 *
 * No-op on non-macOS platforms.
 */
export function writeToKeychain(credentials: OAuthCredentials, serviceName: string): void {
  if (platform() !== 'darwin') return;

  const account = userInfo().username;

  // Read existing Keychain value to preserve extra fields
  let existing: Record<string, unknown> = {};
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', serviceName, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    const parsed: unknown = JSON.parse(raw.trim());
    if (typeof parsed === 'object' && parsed !== null) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Entry doesn't exist or is unreadable -- start fresh
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

  const json = JSON.stringify(existing);

  // -U flag updates an existing entry or creates a new one
  execFileSync('security', ['add-generic-password', '-U', '-s', serviceName, '-a', account, '-w', json], {
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Claude Code's public OAuth client ID. */
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Anthropic's OAuth token endpoint (platform.claude.com since mid-2025). */
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

/** The Anthropic CLI's (`ant`) public OAuth client ID. */
const ANTHROPIC_CLI_OAUTH_CLIENT_ID = '41077d10-94b8-4194-be48-d251e9eb21b4';

/** Token endpoint for the Anthropic CLI's OAuth client (JSON grants only). */
const ANTHROPIC_CLI_OAUTH_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/**
 * Discriminated result of a refresh attempt.
 *
 * Doctor needs the failure mode (HTTP status vs network error vs malformed
 * response) so it can render an actionable hint. Production callers only
 * care about ok-vs-not, so they map non-`ok` to null via `refreshResultToCreds`.
 */
export type RefreshResult =
  | { kind: 'ok'; credentials: OAuthCredentials }
  | { kind: 'http-error'; status: number }
  | { kind: 'parse-error'; detail: string }
  | { kind: 'network-error'; message: string };

/**
 * Refreshes an OAuth access token using a refresh token grant.
 *
 * The grant must be presented by the OAuth client that issued the token:
 * Claude Code's client expects a form-encoded grant at platform.claude.com,
 * the Anthropic CLI's client a JSON grant at api.anthropic.com. Neither
 * grant carries workspace or organization identifiers — that binding lives
 * in the token itself.
 *
 * Returns a discriminated result so callers can distinguish HTTP failures
 * (refresh token invalidated) from network failures (transient) from
 * malformed responses (server bug). Production callers that only need
 * pass/fail should use `refreshResultToCreds` to flatten to OAuthCredentials | null.
 */
export async function refreshOAuthToken(
  refreshToken: string,
  clientKind: OAuthClientKind = 'claude-code',
): Promise<RefreshResult> {
  const REFRESH_TIMEOUT_MS = 30_000;
  try {
    const request =
      clientKind === 'anthropic-cli'
        ? {
            url: ANTHROPIC_CLI_OAUTH_TOKEN_URL,
            contentType: 'application/json',
            body: JSON.stringify({
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
              client_id: ANTHROPIC_CLI_OAUTH_CLIENT_ID,
            }),
          }
        : {
            url: OAUTH_TOKEN_URL,
            contentType: 'application/x-www-form-urlencoded',
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
              client_id: OAUTH_CLIENT_ID,
            }).toString(),
          };

    const response = await fetch(request.url, {
      method: 'POST',
      headers: { 'Content-Type': request.contentType },
      body: request.body,
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await readErrorBodySnippet(response);
      logger.warn(`OAuth token refresh failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
      return { kind: 'http-error', status: response.status };
    }

    const data = (await response.json()) as Record<string, unknown>;
    return parseTokenResponse(data, refreshToken, clientKind);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`OAuth token refresh error: ${message}`);
    return { kind: 'network-error', message };
  }
}

/**
 * Reads a bounded snippet of an error response body for diagnostics.
 * The token endpoint's error bodies ({"error": "invalid_grant"}, invalid_scope
 * details, etc.) are the only way to tell rejection modes apart.
 */
async function readErrorBodySnippet(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Flattens a RefreshResult into the legacy `OAuthCredentials | null` shape
 * for callers that don't need the failure detail (token-manager, preflight).
 */
export function refreshResultToCreds(result: RefreshResult): OAuthCredentials | null {
  return result.kind === 'ok' ? result.credentials : null;
}

export async function refreshCodexOAuthToken(refreshToken: string): Promise<RefreshResult> {
  const REFRESH_TIMEOUT_MS = 30_000;
  try {
    const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn(`Codex OAuth token refresh failed: HTTP ${response.status}`);
      return { kind: 'http-error', status: response.status };
    }

    const data = (await response.json()) as Record<string, unknown>;
    return parseCodexTokenResponse(data, refreshToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Codex OAuth token refresh error: ${message}`);
    return { kind: 'network-error', message };
  }
}

/**
 * Validates and extracts credentials from an OAuth token endpoint response.
 * Returns parse-error if access_token or expires_in are missing/invalid.
 * Preserves the original refresh token when the response omits refresh_token
 * (not all providers rotate refresh tokens on every grant). The client kind
 * is carried into the refreshed credentials so subsequent refreshes keep
 * using the issuing client.
 */
function parseTokenResponse(
  data: Record<string, unknown>,
  fallbackRefreshToken: string,
  clientKind?: OAuthClientKind,
): RefreshResult {
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = data;

  if (!isNonEmptyString(accessToken)) {
    return { kind: 'parse-error', detail: 'response missing access_token' };
  }
  if (!isPositiveFiniteNumber(expiresIn)) {
    return { kind: 'parse-error', detail: 'response missing or invalid expires_in' };
  }

  return {
    kind: 'ok',
    credentials: {
      accessToken,
      refreshToken: isNonEmptyString(refreshToken) ? refreshToken : fallbackRefreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      ...(clientKind === 'anthropic-cli' ? { clientKind } : {}),
    },
  };
}

function parseCodexTokenResponse(data: Record<string, unknown>, fallbackRefreshToken: string): RefreshResult {
  const { access_token: accessToken, refresh_token: refreshToken, id_token: idToken } = data;

  if (!isNonEmptyString(accessToken)) {
    return { kind: 'parse-error', detail: 'response missing access_token' };
  }

  return {
    kind: 'ok',
    credentials: {
      accessToken,
      refreshToken: isNonEmptyString(refreshToken) ? refreshToken : fallbackRefreshToken,
      expiresAt: parseJwtExpirationMs(accessToken) ?? Date.now() + DEFAULT_CODEX_TOKEN_LIFETIME_MS,
      ...(isNonEmptyString(idToken) ? { idToken } : {}),
    },
  };
}

/**
 * Decides whether a credentials write should use the Anthropic CLI's flat
 * snake_case shape. Content is authoritative: a top-level snake_case token
 * (or explicit type: 'oauth_token') marks a CLI file, a claudeAiOauth object
 * marks a Claude Code file. When the content is ambiguous — the origin file
 * was deleted or emptied between detection and this write-back — fall back
 * to the path: writing the claudeAiOauth wrapper into the CLI store's own
 * location would leave the Anthropic CLI unable to read its credentials.
 */
function shouldWriteAnthropicCliFormat(credPath: string, existing: Record<string, unknown>): boolean {
  if (existing.type === 'oauth_token' || isNonEmptyString(existing.access_token)) return true;
  if (typeof existing.claudeAiOauth === 'object' && existing.claudeAiOauth !== null) return false;
  return credPath === getAnthropicCredentialsFilePath();
}

/**
 * Writes updated OAuth credentials back to a credentials file (default
 * ~/.claude/.credentials.json), preserving other fields in the file
 * (e.g., scopes, subscriptionType). The write matches the file's existing
 * format: Anthropic CLI files keep their flat snake_case shape (with
 * `expires_at` in epoch seconds); everything else gets the claudeAiOauth
 * shape. For an empty or unreadable file the format falls back to the
 * target path (CLI store path -> CLI shape).
 */
export function saveOAuthCredentials(credentials: OAuthCredentials, filePath?: string): void {
  const credPath = filePath ?? getCredentialsFilePath();

  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(credPath)) {
      const parsed: unknown = JSON.parse(readFileSync(credPath, 'utf-8'));
      if (typeof parsed === 'object' && parsed !== null) {
        existing = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // Start fresh if file is unreadable
  }

  if (shouldWriteAnthropicCliFormat(credPath, existing)) {
    existing.access_token = credentials.accessToken;
    existing.refresh_token = credentials.refreshToken;
    existing.expires_at = Math.round(credentials.expiresAt / 1000);
  } else {
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
  }

  writeFileSync(credPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  // chmod after write — writeFileSync's mode only applies when creating new files;
  // existing files with broader permissions need an explicit chmod.
  chmodSync(credPath, 0o600);
}

export function saveCodexOAuthCredentials(credentials: OAuthCredentials, filePath = getCodexAuthFilePath()): void {
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(filePath)) {
      existing = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    }
  } catch {
    // Start fresh if the file is unreadable.
  }

  const existingTokens =
    typeof existing.tokens === 'object' && existing.tokens !== null ? (existing.tokens as Record<string, unknown>) : {};
  const codexCredentials = credentials as CodexOAuthCredentials;

  existing.auth_mode = 'chatgpt';
  existing.tokens = {
    ...existingTokens,
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    ...(codexCredentials.idToken ? { id_token: codexCredentials.idToken } : {}),
  };

  writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

/**
 * Injectable credential sources for testability.
 *
 * The optional refresh/save/keychain-write functions enable token refresh
 * and persistence in detectAuthMethod(). When these functions are omitted,
 * expired tokens are not refreshed or written back; the caller only receives
 * the detection result (and any existing, possibly stale, credentials).
 */
export interface CredentialSources {
  loadFromFile: () => OAuthCredentials | null;
  loadFromKeychain: () => OAuthCredentials | null;
  refreshToken?: (refreshToken: string, clientKind?: OAuthClientKind) => Promise<OAuthCredentials | null>;
  saveToFile?: (credentials: OAuthCredentials, filePath?: string) => void;
  /**
   * Path-aware multi-file loader; preferred over loadFromFile when present.
   * Returns every parseable credential file in detection-priority order so
   * detection can fall through to the next file when one is expired and
   * unrefreshable.
   */
  loadFromFilesWithSource?: () => FileCredentialsResult[];
  loadFromKeychainWithService?: () => KeychainResult | null;
  writeToKeychain?: (credentials: OAuthCredentials, serviceName: string) => void;
}

const defaultSources: CredentialSources = {
  loadFromFile: loadOAuthCredentials,
  loadFromKeychain: extractFromKeychain,
  refreshToken: async (rt, clientKind) => refreshResultToCreds(await refreshOAuthToken(rt, clientKind)),
  saveToFile: saveOAuthCredentials,
  loadFromFilesWithSource: loadAllOAuthCredentialFiles,
  loadFromKeychainWithService: extractFromKeychainWithService,
  writeToKeychain,
};

/**
 * Pre-built CredentialSources for active credential detection at startup.
 * Includes Keychain lookup (~19ms on macOS) and proactive token refresh,
 * so an expired token is rotated before the first MCP call.
 *
 * Shared between session/preflight.ts and doctor's OAuth checks so both
 * code paths exercise the same detection behavior.
 */
export const preflightCredentialSources: CredentialSources = {
  loadFromFile: loadOAuthCredentials,
  loadFromKeychain: extractFromKeychain,
  refreshToken: async (rt, clientKind) => refreshResultToCreds(await refreshOAuthToken(rt, clientKind)),
  saveToFile: saveOAuthCredentials,
  loadFromFilesWithSource: loadAllOAuthCredentialFiles,
  loadFromKeychainWithService: extractFromKeychainWithService,
  writeToKeychain,
};

/**
 * Pre-built CredentialSources for read-only detection (used by `ironcurtain doctor`).
 * Omits refresh/save so passive diagnostics never mutate credential storage.
 * The user can still validate refresh under `--check-api`, which makes its
 * own write decisions based on the detected auth source.
 */
export const readOnlyCredentialSources: CredentialSources = {
  loadFromFile: loadOAuthCredentials,
  loadFromKeychain: extractFromKeychain,
  loadFromFilesWithSource: loadAllOAuthCredentialFiles,
  loadFromKeychainWithService: extractFromKeychainWithService,
};

/**
 * Detects the best authentication method available on the host.
 * When refresh functions are provided in sources, attempts to refresh
 * expired OAuth tokens before falling back to API key auth.
 *
 * Priority:
 * 1. IRONCURTAIN_DOCKER_AUTH=apikey env var forces API key mode
 * 2. OAuth credentials from ~/.claude/.credentials.json or
 *    ~/.config/anthropic/credentials/default.json (valid or refreshable)
 * 3. OAuth credentials from macOS Keychain (valid or refreshable)
 * 4. API key from config
 * 5. None
 */
export async function detectAuthMethod(config: IronCurtainConfig, sources?: CredentialSources): Promise<AuthMethod> {
  const s = sources ?? defaultSources;

  // Allow explicit override to force API key mode
  if (process.env.IRONCURTAIN_DOCKER_AUTH === 'apikey') {
    logger.info('Docker auth override: forced API key mode via IRONCURTAIN_DOCKER_AUTH');
    return resolveApiKeyAuth(config);
  }

  // Try OAuth from credentials files, in detection-priority order. Each file
  // is considered independently: an expired, unrefreshable file must not
  // shadow a valid (or refreshable) lower-priority file.
  const fileResults = s.loadFromFilesWithSource ? s.loadFromFilesWithSource() : toFileResults(s.loadFromFile());
  for (const { credentials: fileCreds, filePath } of fileResults) {
    if (!isTokenExpired(fileCreds)) {
      logger.info(`Detected OAuth credentials from ${filePath ?? 'credentials file'}`);
      return { kind: 'oauth', credentials: fileCreds, source: 'file', filePath };
    }

    // Attempt refresh if refresh function is available
    if (s.refreshToken) {
      const refreshed = await tryRefreshFileCreds(fileCreds, s.refreshToken, s.saveToFile, filePath);
      if (refreshed) return refreshed;
    }
    logger.warn(`OAuth token from ${filePath ?? 'credentials file'} is expired`);
  }

  // Try macOS Keychain if no credentials file was found
  if (fileResults.length === 0) {
    const keychainResult = s.loadFromKeychainWithService?.() ?? toKeychainResult(s.loadFromKeychain());
    if (keychainResult) {
      if (!isTokenExpired(keychainResult.credentials)) {
        return {
          kind: 'oauth',
          credentials: keychainResult.credentials,
          source: 'keychain',
          keychainServiceName: keychainResult.serviceName,
        };
      }

      // Attempt refresh if refresh function is available
      if (s.refreshToken) {
        const refreshed = await tryRefreshKeychainCreds(keychainResult, s.refreshToken, s.writeToKeychain);
        if (refreshed) return refreshed;
      }
      logger.warn('OAuth token from macOS Keychain is expired');
    }
  }

  // Fall back to API key
  return resolveApiKeyAuth(config);
}

/**
 * Wraps a plain OAuthCredentials from loadFromKeychain() into a KeychainResult.
 * Uses the first service name as a fallback since we don't know which one matched.
 */
function toKeychainResult(creds: OAuthCredentials | null): KeychainResult | null {
  if (!creds) return null;
  return { credentials: creds, serviceName: KEYCHAIN_SERVICE_NAMES[0] };
}

/**
 * Wraps a plain OAuthCredentials from loadFromFile() into the path-aware
 * list shape. The path is unknown for legacy loaders, so refresh write-back
 * falls to saveToFile's default path.
 */
function toFileResults(creds: OAuthCredentials | null): Array<{ credentials: OAuthCredentials; filePath?: string }> {
  if (!creds) return [];
  return [{ credentials: creds }];
}

/**
 * Attempts to refresh expired file-sourced credentials.
 * On success, saves to the originating file and returns the oauth AuthMethod.
 */
async function tryRefreshFileCreds(
  fileCreds: OAuthCredentials,
  doRefresh: (refreshToken: string, clientKind?: OAuthClientKind) => Promise<OAuthCredentials | null>,
  saveToFile?: (credentials: OAuthCredentials, filePath?: string) => void,
  filePath?: string,
): Promise<AuthMethod | null> {
  const refreshed = await doRefresh(fileCreds.refreshToken, fileCreds.clientKind);
  if (!refreshed) return null;

  try {
    saveToFile?.(refreshed, filePath);
  } catch (err) {
    logger.warn(`Failed to save refreshed credentials to file: ${err instanceof Error ? err.message : String(err)}`);
  }
  logger.info('Refreshed expired OAuth token from credentials file');
  return { kind: 'oauth', credentials: refreshed, source: 'file', filePath };
}

/**
 * Attempts to refresh expired Keychain-sourced credentials.
 * On success, writes back to Keychain and returns the oauth AuthMethod.
 */
async function tryRefreshKeychainCreds(
  keychainResult: KeychainResult,
  doRefresh: (refreshToken: string, clientKind?: OAuthClientKind) => Promise<OAuthCredentials | null>,
  doWriteToKeychain?: (credentials: OAuthCredentials, serviceName: string) => void,
): Promise<AuthMethod | null> {
  const refreshed = await doRefresh(keychainResult.credentials.refreshToken, keychainResult.credentials.clientKind);
  if (!refreshed) return null;

  try {
    doWriteToKeychain?.(refreshed, keychainResult.serviceName);
  } catch (err) {
    logger.warn(
      `Failed to write refreshed credentials to Keychain: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  logger.info('Refreshed expired OAuth token from macOS Keychain');
  return {
    kind: 'oauth',
    credentials: refreshed,
    source: 'keychain',
    keychainServiceName: keychainResult.serviceName,
  };
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
