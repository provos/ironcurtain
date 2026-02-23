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

const execFile = promisify(execFileCb);

const DOCKER_TIMEOUT_MS = 5_000;
const DEFAULT_DOCKER_AGENT = 'claude-code' as AgentId;

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
 * Checks whether the API key required by the given agent is configured.
 * Currently all Docker agents (claude-code) require ANTHROPIC_API_KEY.
 */
function hasApiKeyForAgent(_agentId: AgentId, config: IronCurtainConfig): boolean {
  return config.userConfig.anthropicApiKey !== '';
}

/**
 * Resolves the session mode based on explicit --agent flag or auto-detection.
 *
 * - Explicit agent: validates prerequisites; throws PreflightError on failure.
 * - Auto-detect: prefers Docker when available; silently falls back to builtin. Never throws.
 */
export async function resolveSessionMode(options: PreflightOptions): Promise<PreflightResult> {
  const { config, requestedAgent } = options;
  const isDockerAvailable = options.isDockerAvailable ?? checkDockerAvailable;

  if (requestedAgent !== undefined) {
    return resolveExplicit(requestedAgent, config, isDockerAvailable);
  }

  return resolveAutoDetect(config, isDockerAvailable);
}

async function resolveExplicit(
  agent: AgentId,
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<boolean>,
): Promise<PreflightResult> {
  const dockerOk = await isDockerAvailable();
  if (!dockerOk) {
    throw new PreflightError(
      `--agent ${agent} requires Docker, but the Docker daemon is not available. ` + 'Is Docker installed and running?',
    );
  }

  if (!hasApiKeyForAgent(agent, config)) {
    throw new PreflightError(
      `--agent ${agent} requires ANTHROPIC_API_KEY to be set. ` +
        'Set it in your environment or in ~/.ironcurtain/config.json.',
    );
  }

  return {
    mode: { kind: 'docker', agent },
    reason: 'Explicit --agent selection',
  };
}

async function resolveAutoDetect(
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<boolean>,
): Promise<PreflightResult> {
  const dockerOk = await isDockerAvailable();
  if (!dockerOk) {
    return {
      mode: { kind: 'builtin' },
      reason: 'Docker not available',
    };
  }

  if (!hasApiKeyForAgent(DEFAULT_DOCKER_AGENT, config)) {
    return {
      mode: { kind: 'builtin' },
      reason: 'ANTHROPIC_API_KEY not set',
    };
  }

  return {
    mode: { kind: 'docker', agent: DEFAULT_DOCKER_AGENT },
    reason: 'Docker available, ANTHROPIC_API_KEY set',
  };
}
