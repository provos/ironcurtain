/**
 * CLI entry point for `ironcurtain mux`.
 *
 * Parses command-line options, loads config, acquires the listener lock,
 * creates the MuxApp, and runs until quit.
 */

import chalk from 'chalk';
import { mkdirSync } from 'node:fs';
import { getListenerLockPath, getPtyRegistryDir } from '../config/paths.js';
import { acquireLock, releaseLock } from '../escalation/listener-lock.js';
import { loadUserConfig } from '../config/user-config.js';
import { parseModelId, resolveApiKeyForProvider } from '../config/model-provider.js';
import { loadConfig } from '../config/index.js';
import { createMuxApp } from './mux-app.js';

export async function main(args?: string[]): Promise<void> {
  // Check for optional mux dependencies
  try {
    await import('node-pty');
  } catch {
    process.stderr.write(
      chalk.red('Error: ironcurtain mux requires the node-pty package.\n') + 'Install it with: npm install node-pty\n',
    );
    process.exit(1);
  }
  try {
    await import('terminal-kit');
  } catch {
    process.stderr.write(
      chalk.red('Error: ironcurtain mux requires the terminal-kit package.\n') +
        'Install it with: npm install terminal-kit\n',
    );
    process.exit(1);
  }

  // Parse args
  let agent = 'claude-code';
  if (args) {
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '--agent' || args[i] === '-a') && args[i + 1]) {
        agent = args[i + 1];
        i++;
      }
    }
  }

  // Acquire single-instance lock
  const lockPath = getListenerLockPath();
  if (!acquireLock(lockPath)) {
    process.stderr.write(
      chalk.red('Another escalation listener or mux is already running.\n') +
        'Only one instance can run at a time to prevent escalation conflicts.\n',
    );
    process.exit(1);
  }

  // Ensure registry directory exists
  const registryDir = getPtyRegistryDir();
  mkdirSync(registryDir, { recursive: true, mode: 0o700 });

  // Pre-flight warnings (shown before fullscreen takes over)
  let hasWarnings = false;
  try {
    const userConfig = loadUserConfig({ readOnly: true });
    if (userConfig.autoApprove.enabled) {
      const { provider } = parseModelId(userConfig.autoApprove.modelId);
      const apiKey = resolveApiKeyForProvider(provider, userConfig);
      if (!apiKey) {
        process.stderr.write(
          chalk.yellow(
            `Warning: auto-approve is enabled but no API key found for provider "${provider}".\n` +
              'Auto-approve will be silently disabled. Set the API key in your environment or config.\n',
          ),
        );
        hasWarnings = true;
      }
    }
  } catch {
    // Config load failure is not fatal here -- the child sessions will report it.
  }

  if (hasWarnings) {
    process.stderr.write(chalk.dim('\nStarting in 3 seconds...\n'));
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Load config once for workspace validation
  let protectedPaths: string[] = [];
  try {
    protectedPaths = loadConfig().protectedPaths;
  } catch {
    // Config load failure is not fatal; child sessions will report it.
  }

  try {
    const app = createMuxApp({
      agent,
      autoSpawn: false,
      protectedPaths,
    });

    await app.start();
  } finally {
    releaseLock(lockPath);
  }
}
