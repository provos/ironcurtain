/**
 * Entry point for `ironcurtain bot` - runs the Signal transport daemon.
 *
 * Unlike `ironcurtain start "task"` which runs a single task and exits,
 * `ironcurtain bot` starts the SignalBotDaemon and waits for messages
 * indefinitely. Sessions are created on demand when the user sends a
 * Signal message and destroyed when they end.
 */

import { loadConfig } from '../config/index.js';
import { loadUserConfig } from '../config/user-config.js';
import { createDockerManager } from '../docker/docker-manager.js';
import { resolveSessionMode } from '../session/preflight.js';
import { SignalBotDaemon } from './signal-bot-daemon.js';
import { createSignalContainerManager } from './signal-container.js';
import { resolveSignalConfig } from './signal-config.js';
import * as logger from '../logger.js';
import type { AgentId } from '../docker/agent-adapter.js';

export interface BotOptions {
  /** Explicit agent selection (e.g., 'claude-code'). */
  agent?: string;
}

export async function runBot(options: BotOptions = {}): Promise<void> {
  const userConfig = loadUserConfig();
  const signalConfig = resolveSignalConfig(userConfig);

  if (!signalConfig) {
    process.stderr.write('Signal is not configured. Run: ironcurtain setup-signal\n');
    process.exit(1);
  }

  const config = loadConfig();

  // Resolve session mode (same logic as `ironcurtain start`)
  const preflight = await resolveSessionMode({
    config,
    requestedAgent: options.agent ? (options.agent as AgentId) : undefined,
  });
  const mode = preflight.mode;

  const docker = createDockerManager();
  const containerManager = createSignalContainerManager(docker, signalConfig.container);

  const daemon = new SignalBotDaemon({
    config: signalConfig,
    containerManager,
    mode,
  });

  // Wire up signal handling for graceful shutdown
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) process.exit(1); // Second signal: force exit
    shuttingDown = true;
    await daemon.shutdown();
    logger.teardown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  process.stderr.write(`IronCurtain bot starting (mode: ${mode.kind})...\n`);
  process.stderr.write('Press Ctrl+C to stop.\n');

  await daemon.start();
}
