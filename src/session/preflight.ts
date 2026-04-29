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
 * Result of credential detection for a given agent. `anthropicOAuthOnly`
 * is only meaningful for goose: it records whether Anthropic OAuth
 * credentials are present (and would have helped a claude-code session)
 * so the goose error message can tell a tester that OAuth is unusable
 * with goose. Combining it into a single struct lets us probe
 * `detectAuthMethod` once and share the result across the credential
 * decision and the error-message construction.
 */
interface CredentialState {
  credKind: 'oauth' | 'apikey' | null;
  anthropicOAuthOnly: boolean;
}

async function detectCredentialState(
  agentId: AgentId,
  config: IronCurtainConfig,
  sources?: CredentialSources,
): Promise<CredentialState> {
  if (agentId === 'goose') {
    const provider = config.userConfig.gooseProvider;
    const key = resolveApiKeyForProvider(provider, config.userConfig);
    if (key) return { credKind: 'apikey', anthropicOAuthOnly: false };

    const auth = await detectAuthMethod(config, sources ?? preflightCredentialSources);
    return {
      credKind: null,
      anthropicOAuthOnly:
        auth.kind === 'oauth' && resolveApiKeyForProvider('anthropic', config.userConfig).length === 0,
    };
  }

  const auth = await detectAuthMethod(config, sources ?? preflightCredentialSources);
  if (auth.kind === 'none') return { credKind: null, anthropicOAuthOnly: false };
  return { credKind: auth.kind === 'oauth' ? 'oauth' : 'apikey', anthropicOAuthOnly: false };
}

/**
 * Renders the "switch to <other mode>" remediation footer shared by every
 * preflight error message. Centralized so the wording can't drift between
 * the docker-unavailable, builtin-needs-key, and credential-missing paths.
 */
function formatModeRemediation(targetMode: 'docker' | 'builtin'): string[] {
  if (targetMode === 'builtin') {
    return [
      'To run this session in builtin mode, pass:',
      '  --agent builtin',
      '',
      'To make builtin the default permanently, run:',
      '  ironcurtain config',
      'and set Session Mode > Preferred mode to "builtin".',
    ];
  }
  return [
    'To run this session in Docker mode, pass:',
    '  --agent claude-code',
    '',
    'To make Docker the default permanently, run:',
    '  ironcurtain config',
    'and set Session Mode > Preferred mode to "docker".',
  ];
}

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

function credentialErrorMessageForPreferredMode(
  agentId: AgentId,
  config: IronCurtainConfig,
  oauthOnly: boolean,
): string {
  const lines: string[] = [
    'Cannot start IronCurtain.',
    `preferredMode is "docker" but no credentials are configured for "${agentId}".`,
    '',
  ];
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
      `Authentication is required for "${agentId}". Log in with \`claude login\` (OAuth) or set ANTHROPIC_API_KEY.`,
    );
  }
  lines.push('');
  lines.push(...formatModeRemediation('builtin'));
  return lines.join('\n');
}

function dockerUnavailableMessage(detailedMessage: string): string {
  return [
    'Cannot start IronCurtain.',
    'preferredMode is "docker" but Docker is not available:',
    '',
    detailedMessage,
    '',
    ...formatModeRemediation('builtin'),
  ].join('\n');
}

function builtinNeedsApiKeyMessage(): string {
  return [
    'Cannot start IronCurtain.',
    'preferredMode is "builtin" but no ANTHROPIC_API_KEY is configured.',
    'Builtin mode talks to Anthropic directly using an API key — Claude OAuth credentials are not usable in builtin mode.',
    '',
    ...formatModeRemediation('docker'),
    '',
    'Set ANTHROPIC_API_KEY in your environment, or run `ironcurtain config`.',
  ].join('\n');
}

/**
 * Renders the user-facing `Mode: ...` banner shown at session startup.
 * Single source of truth so `ironcurtain start`, the daemon, and cron
 * jobs all print identically. Docker mode includes the agent + auth
 * kind via `reason`; builtin has no parenthetical.
 */
export function formatModeLine(preflight: PreflightResult): string {
  if (preflight.mode.kind === 'builtin') return 'Mode: builtin';
  return `Mode: docker / ${preflight.reason}`;
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

  const [dockerStatus, credState] = await Promise.all([
    isDockerAvailable(),
    detectCredentialState(agent, config, credentialSources),
  ]);

  if (!dockerStatus.available) {
    throw new PreflightError(
      `--agent ${agent} requires Docker, but it is not available:\n\n${dockerStatus.detailedMessage}\n\n` +
        'Please fix your Docker installation or use the builtin agent.',
    );
  }

  if (credState.credKind === null) {
    throw new PreflightError(credentialErrorMessageForExplicit(agent, config, credState.anthropicOAuthOnly));
  }

  return {
    mode: { kind: 'docker', agent, authKind: credState.credKind },
    reason: `Explicit --agent selection (${credState.credKind === 'oauth' ? 'OAuth' : 'API key'})`,
  };
}

async function resolveDefaultMode(
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<DockerAvailability>,
  credentialSources?: CredentialSources,
): Promise<PreflightResult> {
  const { preferredMode, preferredDockerAgent } = config.userConfig;

  if (preferredMode === 'builtin') {
    // Order matters: fail before the Docker probe on the builtin path. Lock-in
    // at test/preflight.test.ts "Builtin path must not probe Docker".
    const apiKey = resolveApiKeyForProvider('anthropic', config.userConfig);
    if (apiKey.length === 0) {
      throw new PreflightError(builtinNeedsApiKeyMessage());
    }
    return { mode: { kind: 'builtin' }, reason: 'preferredMode = builtin' };
  }

  const agent = preferredDockerAgent as AgentId;
  const [dockerStatus, credState] = await Promise.all([
    isDockerAvailable(),
    detectCredentialState(agent, config, credentialSources),
  ]);

  if (!dockerStatus.available) {
    throw new PreflightError(dockerUnavailableMessage(dockerStatus.detailedMessage));
  }

  if (credState.credKind === null) {
    throw new PreflightError(credentialErrorMessageForPreferredMode(agent, config, credState.anthropicOAuthOnly));
  }

  return {
    mode: { kind: 'docker', agent, authKind: credState.credKind },
    reason: `${preferredDockerAgent} (${credState.credKind === 'oauth' ? 'OAuth' : 'API key'})`,
  };
}
