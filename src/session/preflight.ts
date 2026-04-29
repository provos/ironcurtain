/**
 * Pre-flight checks and explicit session mode selection.
 *
 * When `--agent` is explicit, validates prerequisites and fails fast.
 * When no `--agent` is given, dispatches on the user's `preferredMode`
 * (`'docker'` or `'builtin'`) — there is no silent fallback. If the
 * preferred mode's prerequisites are unmet, a `PreflightError` is raised
 * with remediation hints and the session refuses to start.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { IronCurtainConfig } from '../config/types.js';
import type { AgentId } from '../docker/agent-adapter.js';
import type { SessionMode } from './types.js';
import { detectAuthMethod, preflightCredentialSources, type CredentialSources } from '../docker/oauth-credentials.js';
import { resolveApiKeyForProvider } from '../config/model-provider.js';
import { isExecError, isExecTimeout } from '../utils/exec-error.js';

const execFile = promisify(execFileCb);

/**
 * Per-attempt timeout for `docker info`. The daemon call can be slow under
 * load (cold daemon, busy machine), so we use a generous timeout and retry
 * on timeout-class failures rather than tightening the bound.
 */
const DOCKER_PROBE_TIMEOUT_MS = 10_000;

/** Maximum number of additional attempts after the first one. */
const DOCKER_PROBE_MAX_RETRIES = 2;

const DOCKER_UNAVAILABLE_REASON = 'Docker not available';

/**
 * Function signature for `execFile` injection in tests. Matches the shape of
 * `promisify(child_process.execFile)` for the subset of options we use.
 */
export type ProbeExecFileFn = (
  cmd: string,
  args: readonly string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Thrown when explicit `--agent` prerequisites are not met, or when the
 * user's `preferredMode` cannot be honored (Docker unavailable while
 * preferring docker, missing API key while preferring builtin, etc.).
 */
export class PreflightError extends Error {
  constructor(message: string) {
    super(`${message}\n\nRun \`ironcurtain doctor\` for a full diagnostic.`);
    this.name = 'PreflightError';
  }
}

export interface PreflightResult {
  readonly mode: SessionMode;
  /** Human-readable explanation of why this mode was selected. */
  readonly reason: string;
}

export type DockerAvailability = { available: true } | { available: false; reason: string; detailedMessage: string };

export interface PreflightOptions {
  config: IronCurtainConfig;
  /** The --agent flag value. undefined = use preferredMode from config. */
  requestedAgent?: AgentId;
  /** Dependency injection for tests. Defaults to real Docker check. */
  isDockerAvailable?: () => Promise<DockerAvailability>;
  /** Dependency injection for tests. Defaults to real credential detection. */
  credentialSources?: CredentialSources;
}

function describeProbeFailure(err: unknown, fallback: string): string {
  if (!isExecError(err)) return fallback;

  if (err.code === 'ENOENT') {
    return 'The "docker" command was not found in your PATH. Is Docker installed?';
  }

  const stderr = err.stderr.trim();
  if (stderr.length === 0) return fallback;
  if (stderr.includes('permission denied')) {
    return 'Permission denied while connecting to the Docker daemon socket.\nIs your user in the "docker" group?';
  }
  if (stderr.includes('Cannot connect to the Docker daemon')) {
    return (
      'Cannot connect to the Docker daemon.\n' +
      'Is the Docker service running? On macOS/Windows, ensure Docker Desktop is started.'
    );
  }
  return stderr;
}

/**
 * Single canonical "is Docker available?" probe for the entire codebase. Other
 * modules MUST call this rather than re-implementing `docker info`.
 *
 * `docker info` can blow past a tight timeout on a cold/busy daemon, so we use
 * a generous 10s per attempt and retry on timeout-class failures. We do NOT
 * retry on deterministic failures (ENOENT, permission denied, "Cannot connect
 * to the Docker daemon") — those won't change between attempts and the
 * user-visible failure path should be fast.
 *
 * @param execFileFn Optional `execFile` implementation for tests.
 */
export async function checkDockerAvailable(execFileFn: ProbeExecFileFn = execFile): Promise<DockerAvailability> {
  const totalAttempts = DOCKER_PROBE_MAX_RETRIES + 1;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      await execFileFn('docker', ['info'], { timeout: DOCKER_PROBE_TIMEOUT_MS });
      return { available: true };
    } catch (err: unknown) {
      lastErr = err;
      if (!isExecError(err) || !isExecTimeout(err)) {
        return {
          available: false,
          reason: DOCKER_UNAVAILABLE_REASON,
          detailedMessage: describeProbeFailure(err, err instanceof Error ? err.message : String(err)),
        };
      }
    }
  }

  const baseMessage = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const timeoutSeconds = DOCKER_PROBE_TIMEOUT_MS / 1000;
  return {
    available: false,
    reason: DOCKER_UNAVAILABLE_REASON,
    detailedMessage:
      `Docker daemon did not respond within ${timeoutSeconds}s after ${totalAttempts} attempts. ` +
      `The daemon may be overloaded or starting up. Original error: ${baseMessage}`,
  };
}

/**
 * Checks whether credentials (OAuth or API key) are available for the given agent.
 * Returns the auth kind if available, or null if no credentials found.
 *
 * Includes macOS Keychain lookup and token refresh for expired credentials.
 */
async function detectCredentials(
  agentId: AgentId,
  config: IronCurtainConfig,
  sources?: CredentialSources,
): Promise<'oauth' | 'apikey' | null> {
  // Goose uses provider-specific API keys, not Anthropic OAuth.
  if (agentId === 'goose') {
    const provider = config.userConfig.gooseProvider;
    const key = resolveApiKeyForProvider(provider, config.userConfig);
    return key ? 'apikey' : null;
  }

  // Default path: Anthropic OAuth + API key detection (Claude Code and others).
  // Uses preflightCredentialSources, which may refresh expired tokens and update credential storage.
  const auth = await detectAuthMethod(config, sources ?? preflightCredentialSources);
  if (auth.kind === 'none') return null;
  return auth.kind === 'oauth' ? 'oauth' : 'apikey';
}

/**
 * Returns true when Anthropic OAuth credentials are present (file or
 * Keychain) but no `ANTHROPIC_API_KEY` is configured. Used to surface a
 * goose-specific addendum: a tester who just ran `claude login` deserves
 * to know that OAuth is unusable with goose.
 */
async function hasAnthropicOAuthOnly(config: IronCurtainConfig, sources?: CredentialSources): Promise<boolean> {
  const auth = await detectAuthMethod(config, sources ?? preflightCredentialSources);
  if (auth.kind !== 'oauth') return false;
  return resolveApiKeyForProvider('anthropic', config.userConfig).length === 0;
}

/**
 * Returns the error message for missing credentials when `--agent` is
 * explicit. Wording leads with `--agent ${agentId} requires...` since the
 * user typed that flag.
 */
function credentialErrorMessageForExplicit(agentId: AgentId, config: IronCurtainConfig, oauthOnly: boolean): string {
  if (agentId === 'goose') {
    const provider = config.userConfig.gooseProvider;
    const base =
      `--agent goose requires an API key for provider "${provider}". ` +
      'Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY, ' +
      'or configure via `ironcurtain config`.';
    if (provider === 'anthropic' && oauthOnly) {
      return `${base}\n\nOAuth credentials are not usable with goose; provider "anthropic" requires an API key.`;
    }
    return base;
  }
  return `--agent ${agentId} requires authentication. Log in with \`claude login\` (OAuth) or set ANTHROPIC_API_KEY.`;
}

/**
 * Returns the error message for missing credentials when the session mode
 * was selected via `preferredMode`. Wording leads with `preferredMode is
 * "docker"...` so the user understands the cause and can change either the
 * one-shot (`--agent builtin`) or the permanent default (`ironcurtain config`).
 */
function credentialErrorMessageForPreferredMode(
  agentId: AgentId,
  config: IronCurtainConfig,
  oauthOnly: boolean,
): string {
  const lines: string[] = [];
  lines.push('Cannot start IronCurtain.');
  lines.push(`preferredMode is "docker" but no credentials are configured for "${agentId}".`);
  lines.push('');
  if (agentId === 'goose') {
    const provider = config.userConfig.gooseProvider;
    lines.push(
      `Goose requires an API key for provider "${provider}". ` +
        'Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY, ' +
        'or configure via `ironcurtain config`.',
    );
    if (provider === 'anthropic' && oauthOnly) {
      lines.push('');
      lines.push('OAuth credentials are not usable with goose; provider "anthropic" requires an API key.');
    }
  } else {
    lines.push(
      `Authentication is required for "${agentId}". ` + 'Log in with `claude login` (OAuth) or set ANTHROPIC_API_KEY.',
    );
  }
  lines.push('');
  lines.push('To run this session in builtin mode, pass:');
  lines.push('  --agent builtin');
  lines.push('');
  lines.push('To make builtin the default permanently, run:');
  lines.push('  ironcurtain config');
  lines.push('and set Session Mode > Preferred mode to "builtin".');
  return lines.join('\n');
}

/**
 * Error message for `preferredMode === 'docker'` but the Docker daemon
 * cannot be reached. Includes the underlying probe diagnostic plus both
 * the one-shot and permanent escapes.
 */
function dockerUnavailableMessage(detailedMessage: string): string {
  return [
    'Cannot start IronCurtain.',
    'preferredMode is "docker" but Docker is not available:',
    '',
    detailedMessage,
    '',
    'To run this session in builtin mode, pass:',
    '  --agent builtin',
    '',
    'To make builtin the default permanently, run:',
    '  ironcurtain config',
    'and set Session Mode > Preferred mode to "builtin".',
  ].join('\n');
}

/**
 * Error message for `preferredMode === 'builtin'` but no Anthropic API key
 * is configured. Builtin mode talks to Anthropic directly and Claude OAuth
 * tokens are not usable on that path.
 */
function builtinNeedsApiKeyMessage(): string {
  return [
    'Cannot start IronCurtain.',
    'preferredMode is "builtin" but no ANTHROPIC_API_KEY is configured.',
    'Builtin mode talks to Anthropic directly using an API key — Claude OAuth credentials are not usable in builtin mode.',
    '',
    'To run this session in Docker mode, pass:',
    '  --agent claude-code',
    '',
    'To make Docker the default permanently, run:',
    '  ironcurtain config',
    'and set Session Mode > Preferred mode to "docker".',
    '',
    'Set ANTHROPIC_API_KEY in your environment, or run `ironcurtain config`.',
  ].join('\n');
}

/**
 * Resolves the session mode based on the explicit `--agent` flag or the
 * user's `preferredMode`.
 *
 * - Explicit agent: validates prerequisites; throws PreflightError on failure.
 * - Default path: dispatches on `preferredMode`. There is no silent
 *   fallback — Docker unavailability or missing credentials throw.
 */
export async function resolveSessionMode(options: PreflightOptions): Promise<PreflightResult> {
  const { config, requestedAgent, credentialSources } = options;
  const isDockerAvailable = options.isDockerAvailable ?? checkDockerAvailable;

  if (requestedAgent !== undefined) {
    return resolveExplicit(requestedAgent, config, isDockerAvailable, credentialSources);
  }

  return resolveDefaultMode(config, isDockerAvailable, credentialSources);
}

async function resolveExplicit(
  agent: AgentId,
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<DockerAvailability>,
  credentialSources?: CredentialSources,
): Promise<PreflightResult> {
  if (agent === 'builtin') {
    return {
      mode: { kind: 'builtin' },
      reason: 'Explicit --agent builtin',
    };
  }

  const dockerStatus = await isDockerAvailable();
  if (!dockerStatus.available) {
    throw new PreflightError(
      `--agent ${agent} requires Docker, but it is not available:\n\n${dockerStatus.detailedMessage}\n\n` +
        'Please fix your Docker installation or use the builtin agent.',
    );
  }

  const credKind = await detectCredentials(agent, config, credentialSources);
  if (credKind === null) {
    const oauthOnly = agent === 'goose' && (await hasAnthropicOAuthOnly(config, credentialSources));
    throw new PreflightError(credentialErrorMessageForExplicit(agent, config, oauthOnly));
  }

  return {
    mode: { kind: 'docker', agent, authKind: credKind },
    reason: `Explicit --agent selection (${credKind === 'oauth' ? 'OAuth' : 'API key'})`,
  };
}

async function resolveDefaultMode(
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<DockerAvailability>,
  credentialSources?: CredentialSources,
): Promise<PreflightResult> {
  const { preferredMode, preferredDockerAgent } = config.userConfig;

  if (preferredMode === 'builtin') {
    // Fail before any Docker probe so the user gets fast feedback.
    const apiKey = resolveApiKeyForProvider('anthropic', config.userConfig);
    if (apiKey.length === 0) {
      throw new PreflightError(builtinNeedsApiKeyMessage());
    }
    return { mode: { kind: 'builtin' }, reason: 'preferredMode = builtin' };
  }

  // preferredMode === 'docker' — the default branch.
  const agent = preferredDockerAgent as AgentId;
  const dockerStatus = await isDockerAvailable();
  if (!dockerStatus.available) {
    throw new PreflightError(dockerUnavailableMessage(dockerStatus.detailedMessage));
  }

  const credKind = await detectCredentials(agent, config, credentialSources);
  if (credKind === null) {
    const oauthOnly = preferredDockerAgent === 'goose' && (await hasAnthropicOAuthOnly(config, credentialSources));
    throw new PreflightError(credentialErrorMessageForPreferredMode(agent, config, oauthOnly));
  }

  return {
    mode: { kind: 'docker', agent, authKind: credKind },
    reason: `${preferredDockerAgent} (${credKind === 'oauth' ? 'OAuth' : 'API key'})`,
  };
}
