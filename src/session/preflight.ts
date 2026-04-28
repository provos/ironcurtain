/**
 * Pre-flight checks and automatic session mode selection.
 *
 * When --agent is explicit, validates prerequisites and fails fast.
 * When no --agent is given, auto-detects the best mode (Docker preferred,
 * builtin fallback) without ever throwing, EXCEPT when the user has OAuth
 * credentials but no API key (which strictly requires Docker).
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
 * Thrown when explicit --agent prerequisites are not met, or when
 * auto-detect finds an unresolvable constraint (e.g. OAuth-only without Docker).
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
  /** The --agent flag value. undefined = auto-detect. */
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
 * Returns the error message for missing credentials, tailored to the agent.
 */
function credentialErrorMessage(agentId: AgentId, config: IronCurtainConfig): string {
  if (agentId === 'goose') {
    const provider = config.userConfig.gooseProvider;
    return (
      `--agent goose requires an API key for provider "${provider}". ` +
      'Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY, ' +
      'or configure via `ironcurtain config`.'
    );
  }
  return `--agent ${agentId} requires authentication. Log in with \`claude login\` (OAuth) or set ANTHROPIC_API_KEY.`;
}

/**
 * Resolves the session mode based on explicit --agent flag or auto-detection.
 *
 * - Explicit agent: validates prerequisites; throws PreflightError on failure.
 * - Auto-detect: prefers Docker when available; falls back to builtin, but throws if
 *   OAuth is the only available credential (since builtin requires an API key).
 */
export async function resolveSessionMode(options: PreflightOptions): Promise<PreflightResult> {
  const { config, requestedAgent, credentialSources } = options;
  const isDockerAvailable = options.isDockerAvailable ?? checkDockerAvailable;

  if (requestedAgent !== undefined) {
    return resolveExplicit(requestedAgent, config, isDockerAvailable, credentialSources);
  }

  return resolveAutoDetect(config, isDockerAvailable, credentialSources);
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
    throw new PreflightError(credentialErrorMessage(agent, config));
  }

  return {
    mode: { kind: 'docker', agent, authKind: credKind },
    reason: `Explicit --agent selection (${credKind === 'oauth' ? 'OAuth' : 'API key'})`,
  };
}

async function resolveAutoDetect(
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<DockerAvailability>,
  credentialSources?: CredentialSources,
): Promise<PreflightResult> {
  const defaultAgent = config.userConfig.preferredDockerAgent as AgentId;
  const [dockerStatus, credKind, authMethod] = await Promise.all([
    isDockerAvailable(),
    detectCredentials(defaultAgent, config, credentialSources),
    detectAuthMethod(config, credentialSources ?? preflightCredentialSources),
  ]);

  if (!dockerStatus.available) {
    // Check Anthropic OAuth presence directly, independent of the preferred agent.
    // detectCredentials only probes Anthropic OAuth on the Claude Code path; when the
    // preferred agent is goose it reports credKind based on the goose provider key and
    // never looks at Anthropic OAuth. Call detectAuthMethod explicitly so we catch the
    // OAuth-only-no-Docker failure even for goose-preferred configs.
    if (authMethod.kind === 'oauth' && resolveApiKeyForProvider('anthropic', config.userConfig).length === 0) {
      throw new PreflightError(
        `Cannot start IronCurtain. You have Claude OAuth credentials, which require Docker mode, ` +
          `but Docker is not available:\n\n${dockerStatus.detailedMessage}\n\n` +
          `To run without Docker, you must provide an ANTHROPIC_API_KEY.`,
      );
    }

    return {
      mode: { kind: 'builtin' },
      reason: DOCKER_UNAVAILABLE_REASON,
    };
  }

  if (credKind === null) {
    return {
      mode: { kind: 'builtin' },
      reason: 'No credentials (OAuth or API key)',
    };
  }

  return {
    mode: { kind: 'docker', agent: defaultAgent, authKind: credKind },
    reason: `Docker available, ${credKind === 'oauth' ? 'OAuth' : 'API key'} detected`,
  };
}
