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
import { createMuxApp } from './mux-app.js';

export async function main(args?: string[]): Promise<void> {
  // Check for node-pty availability
  try {
    await import('node-pty');
  } catch {
    process.stderr.write(
      chalk.red('Error: ironcurtain mux requires the node-pty package.\n') +
        'Install it with: npm install node-pty\n',
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

  try {
    const app = createMuxApp({
      agent,
    });

    await app.start();
  } finally {
    releaseLock(lockPath);
  }
}
