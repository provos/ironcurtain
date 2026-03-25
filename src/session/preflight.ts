/**
 * Pre-flight checks and automatic session mode selection.
 *
 * When --agent is explicit, validates prerequisites and fails fast.
 * When no --agent is given, auto-detects the best mode (Docker preferred,
 * builtin fallback) without ever throwing.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { IronCurtainConfig } from '../config/types.js';
import type { AgentId } from '../docker/agent-adapter.js';
import type { SessionMode } from './types.js';
import {
  detectAuthMethod,
  loadOAuthCredentials,
  extractFromKeychain,
  refreshOAuthToken,
  saveOAuthCredentials,
  extractFromKeychainWithService,
  writeToKeychain,
  type CredentialSources,
} from '../docker/oauth-credentials.js';
import { resolveApiKeyForProvider } from '../config/model-provider.js';

const execFile = promisify(execFileCb);

const DOCKER_TIMEOUT_MS = 5_000;

/**
 * Thrown when explicit --agent prerequisites are not met.
 * Never thrown during auto-detect.
 */
export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

export interface PreflightResult {
  readonly mode: SessionMode;
  /** Human-readable explanation of why this mode was selected. */
  readonly reason: string;
}

export interface PreflightOptions {
  config: IronCurtainConfig;
  /** The --agent flag value. undefined = auto-detect. */
  requestedAgent?: AgentId;
  /** Dependency injection for tests. Defaults to real Docker check. */
  isDockerAvailable?: () => Promise<boolean>;
  /** Dependency injection for tests. Defaults to real credential detection. */
  credentialSources?: CredentialSources;
}

/**
 * Checks whether the Docker daemon is responsive.
 * Returns false if the binary is missing, the daemon is stopped, or the check times out.
 */
export async function checkDockerAvailable(): Promise<boolean> {
  try {
    await execFile('docker', ['info'], { timeout: DOCKER_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Credential sources for preflight detection including Keychain lookup (~19ms)
 * and token refresh so that expired credentials are refreshed at startup.
 */
const preflightSources: CredentialSources = {
  loadFromFile: loadOAuthCredentials,
  loadFromKeychain: extractFromKeychain,
  refreshToken: refreshOAuthToken,
  saveToFile: saveOAuthCredentials,
  loadFromKeychainWithService: extractFromKeychainWithService,
  writeToKeychain,
};

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
  // Uses preflightSources, which may refresh expired tokens and update credential storage.
  const auth = await detectAuthMethod(config, sources ?? preflightSources);
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
 * - Auto-detect: prefers Docker when available; silently falls back to builtin. Never throws.
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
  isDockerAvailable: () => Promise<boolean>,
  credentialSources?: CredentialSources,
): Promise<PreflightResult> {
  if (agent === 'builtin') {
    return {
      mode: { kind: 'builtin' },
      reason: 'Explicit --agent builtin',
    };
  }

  const dockerOk = await isDockerAvailable();
  if (!dockerOk) {
    throw new PreflightError(
      `--agent ${agent} requires Docker, but the Docker daemon is not available. ` + 'Is Docker installed and running?',
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
  isDockerAvailable: () => Promise<boolean>,
  credentialSources?: CredentialSources,
): Promise<PreflightResult> {
  const dockerOk = await isDockerAvailable();
  if (!dockerOk) {
    return {
      mode: { kind: 'builtin' },
      reason: 'Docker not available',
    };
  }

  const defaultAgent = config.userConfig.preferredDockerAgent as AgentId;
  const credKind = await detectCredentials(defaultAgent, config, credentialSources);
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
