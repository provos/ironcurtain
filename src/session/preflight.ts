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
import { isObjectWithProp } from '../utils/is-plain-object.js';

const execFile = promisify(execFileCb);

const DOCKER_TIMEOUT_MS = 5_000;
const DOCKER_UNAVAILABLE_REASON = 'Docker not available';

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

/**
 * Checks whether the Docker daemon is responsive.
 * Returns detailed diagnostic information if it fails.
 */
export async function checkDockerAvailable(): Promise<DockerAvailability> {
  try {
    await execFile('docker', ['info'], { timeout: DOCKER_TIMEOUT_MS });
    return { available: true };
  } catch (err: unknown) {
    let detailedMessage = err instanceof Error ? err.message : String(err);
    const errCode = isObjectWithProp(err, 'code') ? err.code : undefined;
    const errStderr = isObjectWithProp(err, 'stderr') ? err.stderr : undefined;
    if (errCode === 'ENOENT') {
      detailedMessage = 'The "docker" command was not found in your PATH. Is Docker installed?';
    } else if (typeof errStderr === 'string' && errStderr.length > 0) {
      const stderr = errStderr.trim();
      if (stderr.includes('permission denied')) {
        detailedMessage =
          'Permission denied while connecting to the Docker daemon socket.\n' + 'Is your user in the "docker" group?';
      } else if (stderr.includes('Cannot connect to the Docker daemon')) {
        detailedMessage =
          'Cannot connect to the Docker daemon.\n' +
          'Is the Docker service running? On macOS/Windows, ensure Docker Desktop is started.';
      } else {
        detailedMessage = stderr;
      }
    }
    return { available: false, reason: DOCKER_UNAVAILABLE_REASON, detailedMessage };
  }
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
