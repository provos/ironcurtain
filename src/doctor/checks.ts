/**
 * Diagnostic check functions for `ironcurtain doctor`.
 *
 * Each check is a thin wrapper around an existing helper. Functions in
 * this module MUST NOT call process.exit — the entry point alone is
 * responsible for translating results into an exit code so unit tests
 * can call check functions directly without short-circuits.
 */

import { checkSandboxViability } from '../utils/preflight-checks.js';
import { checkDockerAvailable, type DockerAvailability } from '../session/preflight.js';
import {
  detectAuthMethod,
  loadOAuthCredentials,
  isTokenExpired,
  saveOAuthCredentials,
  extractFromKeychain,
  extractFromKeychainWithService,
  writeToKeychain,
  OAUTH_CLIENT_ID,
  OAUTH_TOKEN_URL,
  type AuthMethod,
  type OAuthCredentials,
} from '../docker/oauth-credentials.js';
import {
  resolveApiKeyForProvider,
  createLanguageModel,
  parseModelId,
  type ProviderId,
} from '../config/model-provider.js';
import { loadGeneratedPolicy, getPackageGeneratedDir, findAnnotationServerDrift, loadConfig } from '../config/index.js';
import { computeConstitutionHash } from '../config/paths.js';
import type { IronCurtainConfig, MCPServerConfig } from '../config/types.js';
import { probeServer, type ProbeResult } from './mcp-liveness.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly message: string;
  /** Optional remediation suggestion shown indented under the result. */
  readonly hint?: string;
}

// ---------------------------------------------------------------------------
// Environment checks
// ---------------------------------------------------------------------------

/** Minimum and maximum supported Node.js major versions. */
const NODE_MIN_MAJOR = 22;
const NODE_MAX_MAJOR = 24;

export function checkNodeVersion(versionString: string = process.versions.node): CheckResult {
  const match = /^(\d+)\./.exec(versionString);
  const major = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(major)) {
    return {
      name: 'Node.js',
      status: 'fail',
      message: `unrecognized version "${versionString}"`,
      hint: `Install Node.js ${NODE_MIN_MAJOR}.x – ${NODE_MAX_MAJOR}.x from https://nodejs.org/`,
    };
  }
  if (major < NODE_MIN_MAJOR || major > NODE_MAX_MAJOR) {
    return {
      name: 'Node.js',
      status: 'fail',
      message: `${versionString} (unsupported)`,
      hint: `IronCurtain requires Node.js ${NODE_MIN_MAJOR}.x – ${NODE_MAX_MAJOR}.x.`,
    };
  }
  return {
    name: 'Node.js',
    status: 'ok',
    message: versionString,
  };
}

export async function checkSandbox(): Promise<CheckResult> {
  const result = await checkSandboxViability();
  if (result.ok) {
    const note = result.message === 'cached' ? 'OK (cached)' : 'OK';
    return { name: 'V8 sandbox', status: 'ok', message: note };
  }
  return {
    name: 'V8 sandbox',
    status: 'fail',
    message: result.message,
    hint: result.details,
  };
}

/**
 * Reports Docker daemon status. Returns `warn` (not `fail`) on unavailability
 * because the builtin agent runs without Docker — doctor doesn't know whether
 * the user intends to run Docker mode, so it surfaces the issue without
 * forcing a non-zero exit.
 */
export async function checkDocker(
  probe: () => Promise<DockerAvailability> = checkDockerAvailable,
): Promise<CheckResult> {
  const status = await probe();
  if (status.available) {
    return { name: 'Docker', status: 'ok', message: 'running' };
  }
  return {
    name: 'Docker',
    status: 'warn',
    message: 'unavailable',
    hint: status.detailedMessage,
  };
}

// ---------------------------------------------------------------------------
// Configuration / policy checks
// ---------------------------------------------------------------------------

export interface ConfigLoadOk {
  readonly result: CheckResult;
  readonly config: IronCurtainConfig;
}

export interface ConfigLoadFail {
  readonly result: CheckResult;
  readonly config: undefined;
}

/**
 * Loads ~/.ironcurtain/config.json and reports the outcome. Returns the
 * resolved config alongside the CheckResult so subsequent checks can
 * reuse it without re-loading.
 */
export function checkConfigLoad(): ConfigLoadOk | ConfigLoadFail {
  try {
    const config = loadConfig();
    return {
      result: { name: 'User config', status: 'ok', message: 'parsed cleanly' },
      config,
    };
  } catch (err) {
    return {
      result: {
        name: 'User config',
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        hint: 'Run `ironcurtain config` to fix configuration issues.',
      },
      config: undefined,
    };
  }
}

export interface PolicyLoadOk {
  readonly results: CheckResult[];
  readonly compiledPolicy: ReturnType<typeof loadGeneratedPolicy>['compiledPolicy'];
  readonly toolAnnotations: ReturnType<typeof loadGeneratedPolicy>['toolAnnotations'];
}

export interface PolicyLoadFail {
  readonly results: CheckResult[];
  readonly compiledPolicy: undefined;
  readonly toolAnnotations: undefined;
}

/**
 * Loads compiled-policy.json and tool-annotations.json. On success the
 * caller can run drift checks against the result; on failure both
 * artifacts are reported as missing/unparseable in a single CheckResult.
 */
export function checkPolicyArtifacts(config: IronCurtainConfig): PolicyLoadOk | PolicyLoadFail {
  try {
    const loaded = loadGeneratedPolicy({
      policyDir: config.generatedDir,
      toolAnnotationsDir: config.toolAnnotationsDir ?? config.generatedDir,
      fallbackDir: getPackageGeneratedDir(),
    });
    return {
      results: [{ name: 'Policy artifacts', status: 'ok', message: 'present and parseable' }],
      compiledPolicy: loaded.compiledPolicy,
      toolAnnotations: loaded.toolAnnotations,
    };
  } catch (err) {
    return {
      results: [
        {
          name: 'Policy artifacts',
          status: 'fail',
          message: err instanceof Error ? err.message : String(err),
          hint: 'Run `ironcurtain compile-policy` to (re)generate compiled-policy.json and tool-annotations.json.',
        },
      ],
      compiledPolicy: undefined,
      toolAnnotations: undefined,
    };
  }
}

/**
 * Compares the active constitution hash to the value baked into the
 * compiled policy. A mismatch means the constitution was edited without
 * recompiling.
 */
export function checkConstitutionDrift(
  config: IronCurtainConfig,
  compiledPolicy: { constitutionHash: string },
): CheckResult {
  let currentHash: string;
  try {
    currentHash = computeConstitutionHash(config.constitutionPath);
  } catch (err) {
    return {
      name: 'Compiled policy',
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Verify that constitution.md exists at the configured location.',
    };
  }
  if (currentHash === compiledPolicy.constitutionHash) {
    return { name: 'Compiled policy', status: 'ok', message: 'fresh' };
  }
  return {
    name: 'Compiled policy',
    status: 'warn',
    message: 'constitution has changed since last compile',
    hint: 'Run `ironcurtain compile-policy` to update compiled-policy.json.',
  };
}

/**
 * Reports drift between configured MCP servers and tool-annotations.json.
 * Uses the pure helper findAnnotationServerDrift so output goes through
 * the doctor renderer rather than stderr.
 */
export function checkAnnotationDrift(
  toolAnnotations: Parameters<typeof findAnnotationServerDrift>[0],
  mcpServers: Record<string, MCPServerConfig>,
): CheckResult {
  const { missing, orphaned } = findAnnotationServerDrift(toolAnnotations, mcpServers);
  if (missing.length === 0 && orphaned.length === 0) {
    return { name: 'Tool annotations', status: 'ok', message: 'in sync with mcp-servers.json' };
  }
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  if (orphaned.length > 0) parts.push(`orphaned: ${orphaned.join(', ')}`);
  const hint =
    missing.length > 0
      ? `Run \`ironcurtain annotate-tools --server ${missing[0]}\` for each missing server.`
      : 'Re-run `ironcurtain annotate-tools --all` to drop orphaned entries.';
  return {
    name: 'Tool annotations',
    status: 'warn',
    message: parts.join('; '),
    hint,
  };
}

// ---------------------------------------------------------------------------
// Credential checks
// ---------------------------------------------------------------------------

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
 * Checks Anthropic credential availability. Uses the production
 * detectAuthMethod by default, but injects no-op refresh/save so doctor
 * doesn't accidentally rewrite credential files when invoked.
 */
export async function checkAnthropicCredentials(config: IronCurtainConfig): Promise<CheckResult> {
  const auth = await detectAuthMethod(config, {
    loadFromFile: loadOAuthCredentials,
    loadFromKeychain: extractFromKeychain,
    // No refresh/save during diagnostics: the user did not opt into
    // mutating their credential store. --check-api can verify the
    // refresh token works without persisting the result.
    loadFromKeychainWithService: extractFromKeychainWithService,
  });

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
 * Reports per-MCP-server credential presence. Looks at:
 *   - `-e <VAR>` arguments (Docker convention used by mcp-servers.json)
 *   - keys of `config.env`
 * For each declared env var, the check passes if the value is set in
 * process.env or in serverCredentials[serverName].
 */
export function checkServerCredentials(
  serverName: string,
  serverConfig: MCPServerConfig,
  config: IronCurtainConfig,
): CheckResult {
  const required = collectDeclaredEnvVars(serverConfig);
  if (required.length === 0) {
    return { name: serverName, status: 'ok', message: 'no credentials required' };
  }
  const provided = config.userConfig.serverCredentials[serverName] ?? {};
  const missing = required.filter((name) => {
    const fromEnv = process.env[name];
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return false;
    const fromCfg = provided[name];
    if (typeof fromCfg === 'string' && fromCfg.length > 0) return false;
    return true;
  });
  if (missing.length === 0) {
    return {
      name: serverName,
      status: 'ok',
      message: `${required.length} credential${required.length === 1 ? '' : 's'} set`,
    };
  }
  return {
    name: serverName,
    status: 'warn',
    message: `missing: ${missing.join(', ')}`,
    hint: 'Set the env var(s) or run `ironcurtain config` to store the credentials.',
  };
}

/**
 * Walks an MCP server config to collect declared env-var names from
 * `-e <NAME>` argument pairs and from the keys of `config.env`.
 */
export function collectDeclaredEnvVars(serverConfig: MCPServerConfig): string[] {
  const names = new Set<string>();
  for (let i = 0; i < serverConfig.args.length - 1; i++) {
    if (serverConfig.args[i] === '-e') {
      const candidate = serverConfig.args[i + 1];
      // Plain `-e VAR` (Docker forward) — skip `KEY=value` form because
      // those carry an inline value, not a host-env reference.
      if (typeof candidate === 'string' && !candidate.includes('=')) {
        names.add(candidate);
      }
    }
  }
  if (serverConfig.env) {
    for (const key of Object.keys(serverConfig.env)) {
      // Skip transport-style env vars that carry hard-coded values rather
      // than secrets. Only flag vars that are likely credential refs.
      if (looksLikeCredentialEnv(key)) {
        names.add(key);
      }
    }
  }
  return [...names].sort();
}

const CREDENTIAL_KEYWORDS = ['TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'API'];

function looksLikeCredentialEnv(name: string): boolean {
  const upper = name.toUpperCase();
  return CREDENTIAL_KEYWORDS.some((kw) => upper.includes(kw));
}

// ---------------------------------------------------------------------------
// MCP server liveness
// ---------------------------------------------------------------------------

export interface ServerLivenessOptions {
  readonly probe?: typeof probeServer;
}

/**
 * Builds the per-server CheckResult based on whether the server's
 * declared credentials are present. Servers with missing credentials
 * are skipped (no spawn) to avoid spurious failures.
 */
export async function checkMcpServerLiveness(
  config: IronCurtainConfig,
  options: ServerLivenessOptions = {},
): Promise<CheckResult[]> {
  const probe = options.probe ?? probeServer;
  const entries = Object.entries(config.mcpServers);
  if (entries.length === 0) {
    return [
      {
        name: '(no servers configured)',
        status: 'skip',
        message: 'mcp-servers.json contains no entries',
      },
    ];
  }

  const tasks = entries.map(async ([name, serverConfig]): Promise<CheckResult> => {
    if (checkServerCredentials(name, serverConfig, config).status === 'warn') {
      return { name, status: 'skip', message: 'skipped — missing creds' };
    }
    const result = await probe(name, serverConfig);
    return formatProbeResult(name, result);
  });

  return Promise.all(tasks);
}

function formatProbeResult(name: string, result: ProbeResult): CheckResult {
  if (result.status === 'ok') {
    const elapsed = formatElapsed(result.elapsedMs);
    return { name, status: 'ok', message: `${result.toolCount} tool${result.toolCount === 1 ? '' : 's'}, ${elapsed}` };
  }
  return {
    name,
    status: 'fail',
    message: `failed after ${formatElapsed(result.elapsedMs)}`,
    hint: result.reason,
  };
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Optional API round-trip checks (--check-api)
// ---------------------------------------------------------------------------

/**
 * Runs a 1-token generateText call against the configured agent model,
 * checking the API key for that model's provider (which may not be
 * Anthropic — IronCurtain supports OpenAI and Google too).
 */
export async function checkAgentApiRoundtrip(config: IronCurtainConfig): Promise<CheckResult> {
  const { provider } = parseModelId(config.agentModelId);
  const label = formatProviderLabel(provider);
  const name = `${label} API round-trip`;
  const apiKey = resolveApiKeyForProvider(provider, config.userConfig);
  if (apiKey.length === 0) {
    if (provider === 'anthropic' && loadOAuthFromAnySource() !== null) {
      return {
        name,
        status: 'skip',
        message: 'OAuth-only setup — covered by OAuth refresh check below',
      };
    }
    return {
      name,
      status: 'skip',
      message: `no ${label} API key — round-trip uses API key auth only`,
    };
  }
  try {
    const start = Date.now();
    // Lazy-import the AI SDK so the default doctor run doesn't pay the load cost.
    const { generateText } = await import('ai');
    const model = await createLanguageModel(config.agentModelId, config.userConfig);
    await generateText({
      model,
      prompt: 'Reply with the single word OK.',
      maxOutputTokens: 1,
    });
    const elapsed = formatElapsed(Date.now() - start);
    return { name, status: 'ok', message: `responded in ${elapsed}` };
  } catch (err) {
    return {
      name,
      status: 'fail',
      message: describeApiError(err),
      hint: `Verify the ${label} API key is valid and the configured agentModelId exists.`,
    };
  }
}

/**
 * Renders an AI SDK error with as much diagnostic info as we can extract.
 * The SDK's APICallError frequently has an empty .message but a useful
 * .url and .cause (the underlying fetch error). Surface all of them so
 * "Cannot connect to API:" doesn't lose the actual reason.
 */
function describeApiError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [];
  if (err.message) parts.push(err.message);
  // AI SDK APICallError surfaces the URL it tried to hit.
  const url = (err as { url?: unknown }).url;
  if (typeof url === 'string' && url.length > 0) parts.push(`url=${url}`);
  // Status code from APICallError.
  const status = (err as { statusCode?: unknown }).statusCode;
  if (typeof status === 'number') parts.push(`status=${status}`);
  // Underlying cause (e.g., fetch's TypeError with the system error code).
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) {
    parts.push(`cause=${cause.message}`);
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') parts.push(`code=${code}`);
  } else if (typeof cause === 'string') {
    parts.push(`cause=${cause}`);
  }
  return parts.join(' | ');
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

function formatProviderLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider];
}

/**
 * Validates the OAuth refresh flow by exchanging the stored refresh token
 * for new credentials. Anthropic rotates refresh tokens, so the new
 * credentials MUST be persisted — otherwise the next refresh attempt
 * (whether by doctor or by the running agent) fails because the local
 * refresh token has been invalidated server-side.
 *
 * Calls the token endpoint directly (rather than via refreshOAuthToken)
 * so failures surface the HTTP status code — a generic "refresh failed"
 * isn't actionable. Used only under --check-api.
 */
export async function checkOAuthRefresh(): Promise<CheckResult> {
  const found = loadOAuthFromAnySource();
  if (!found) {
    return {
      name: 'OAuth refresh',
      status: 'skip',
      message: 'no OAuth credentials in file or Keychain',
    };
  }
  try {
    const start = Date.now();
    const result = await probeOAuthRefresh(found.credentials.refreshToken);
    const elapsed = formatElapsed(Date.now() - start);
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
    persistRefreshedOAuth(found.source, result.credentials);
    const sourceLabel = found.source.kind === 'keychain' ? 'Keychain' : 'file';
    return { name: 'OAuth refresh', status: 'ok', message: `valid (${elapsed}, ${sourceLabel})` };
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return {
      name: 'OAuth refresh',
      status: 'fail',
      message: (err instanceof Error ? err.message : String(err)) + cause,
    };
  }
}

type OAuthSource = { kind: 'file' } | { kind: 'keychain'; serviceName: string };

/**
 * Loads OAuth credentials from the credentials file or, on macOS, the
 * Keychain. Returns the credentials together with the source so callers
 * can write rotated tokens back to the same place.
 */
function loadOAuthFromAnySource(): { credentials: OAuthCredentials; source: OAuthSource } | null {
  const fileCreds = loadOAuthCredentials();
  if (fileCreds) {
    return { credentials: fileCreds, source: { kind: 'file' } };
  }
  const kc = extractFromKeychainWithService();
  if (kc) {
    return { credentials: kc.credentials, source: { kind: 'keychain', serviceName: kc.serviceName } };
  }
  return null;
}

function persistRefreshedOAuth(source: OAuthSource, credentials: OAuthCredentials): void {
  if (source.kind === 'file') {
    saveOAuthCredentials(credentials);
  } else {
    writeToKeychain(credentials, source.serviceName);
  }
}

type RefreshProbeResult =
  | { kind: 'ok'; credentials: OAuthCredentials }
  | { kind: 'http-error'; status: number }
  | { kind: 'parse-error'; detail: string };

async function probeOAuthRefresh(refreshToken: string): Promise<RefreshProbeResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    return { kind: 'http-error', status: response.status };
  }
  const data = (await response.json()) as Record<string, unknown>;
  const accessToken = data.access_token;
  const expiresIn = data.expires_in;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return { kind: 'parse-error', detail: 'response missing access_token' };
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { kind: 'parse-error', detail: 'response missing or invalid expires_in' };
  }
  const newRefresh = data.refresh_token;
  return {
    kind: 'ok',
    credentials: {
      accessToken,
      refreshToken: typeof newRefresh === 'string' && newRefresh.length > 0 ? newRefresh : refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    },
  };
}
