/**
 * CLI entry point for `ironcurtain mux`.
 *
 * Parses command-line options, loads config, acquires the listener lock,
 * creates the MuxApp, and runs until quit.
 */

import chalk from 'chalk';
import { randomBytes } from 'node:crypto';
import { chmodSync, constants, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getPtyRegistryDir } from '../config/paths.js';
import { loadUserConfig } from '../config/user-config.js';
import { parseModelId, resolveApiKeyForProvider } from '../config/model-provider.js';
import { loadConfig } from '../config/index.js';
import { checkHelp, type CommandSpec } from '../cli-help.js';
import { createMuxApp } from './mux-app.js';

const muxSpec: CommandSpec = {
  name: 'ironcurtain mux',
  description: 'Terminal multiplexer for PTY sessions (requires node-pty)',
  usage: ['ironcurtain mux [options]'],
  options: [{ flag: 'agent', short: 'a', description: 'Agent mode (default: claude-code)', placeholder: '<name>' }],
};

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

  // On macOS, node-pty <=1.1.0 ships spawn-helper without the execute bit
  // (https://github.com/microsoft/node-pty/issues/850), causing
  // "posix_spawnp failed" at runtime.  Try to fix it; if we can't (e.g.
  // read-only npx cache), give the user an actionable error message.
  if (process.platform === 'darwin') {
    try {
      const nodePtyEntry = fileURLToPath(import.meta.resolve('node-pty'));
      const helperPath = join(dirname(nodePtyEntry), '..', 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
      const st = statSync(helperPath);
      if (!(st.mode & constants.S_IXUSR)) {
        try {
          chmodSync(helperPath, st.mode | constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH);
        } catch {
          process.stderr.write(
            chalk.red('Error: node-pty spawn-helper is not executable and cannot be fixed automatically.\n') +
              `Run: chmod +x "${helperPath}"\n` +
              'See: https://github.com/microsoft/node-pty/issues/850\n',
          );
          process.exit(1);
        }
      }
    } catch {
      // Could not locate spawn-helper; not fatal — let node-pty report
      // its own error if spawning fails.
    }
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
  const { values } = parseArgs({
    args: args ?? [],
    options: {
      help: { type: 'boolean', short: 'h' },
      agent: { type: 'string', short: 'a' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (checkHelp(values as { help?: boolean }, muxSpec)) return;

  const agent = (values.agent as string | undefined) ?? 'claude-code';

  // Generate a unique mux instance ID for session ownership
  const muxId = `mux-${randomBytes(4).toString('hex')}`;

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

  const app = createMuxApp({
    agent,
    autoSpawn: false,
    protectedPaths,
    muxId,
    muxPid: process.pid,
  });

  await app.start();
}
