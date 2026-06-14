/**
 * CLI entry point for `ironcurtain mux`.
 *
 * Parses command-line options, loads config, generates a unique muxId
 * for session ownership, creates the MuxApp, and runs until quit.
 */

import chalk from 'chalk';
import { randomBytes } from 'node:crypto';
import { chmodSync, constants, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPtyRegistryDir } from '../config/paths.js';
import type { ResolvedUserConfig } from '../config/user-config.js';
import { parseModelId, resolveApiKeyForProvider } from '../config/model-provider.js';
import { modelFlagMisusedAsAgent } from '../config/agent-model-guard.js';
import { loadConfig } from '../config/index.js';
import { checkHelp, parseArgsStrict, type CommandSpec } from '../cli-help.js';
import {
  resolveSessionMode as defaultResolveSessionMode,
  formatModeLine,
  PreflightError,
} from '../session/preflight.js';
import type { PreflightOptions, PreflightResult } from '../session/preflight.js';
import type { AgentId } from '../docker/agent-adapter.js';
import { createMuxApp, type MuxApp, type MuxAppOptions } from './mux-app.js';

const muxSpec: CommandSpec = {
  name: 'ironcurtain mux',
  description: 'Terminal multiplexer for PTY sessions (requires node-pty)',
  usage: ['ironcurtain mux [options]'],
  options: [
    { flag: 'agent', short: 'a', description: 'Agent mode (default: from config)', placeholder: '<name>' },
    { flag: 'model', short: 'm', description: 'Override the agent model ID', placeholder: '<model>' },
    {
      flag: 'capture-traces',
      description: 'Capture LLM API traces for sessions spawned by this mux (overrides config)',
    },
  ],
};

/** Test injection points; production callers pass nothing. */
export interface MuxMainDeps {
  readonly resolveSessionMode?: (options: PreflightOptions) => Promise<PreflightResult>;
  readonly createMuxApp?: (options: MuxAppOptions) => MuxApp;
  readonly skipNativeProbes?: boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

async function probeNativeDependencies(): Promise<void> {
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
}

/** Returns true if a warning was emitted (caller should pause before fullscreen). */
function emitAutoApproveWarning(userConfig: ResolvedUserConfig): boolean {
  if (!userConfig.autoApprove.enabled) return false;

  const { provider } = parseModelId(userConfig.autoApprove.modelId);
  const apiKey = resolveApiKeyForProvider(provider, userConfig);
  if (apiKey) return false;

  process.stderr.write(
    chalk.yellow(
      `Warning: auto-approve is enabled but no API key found for provider "${provider}".\n` +
        'Auto-approve will be silently disabled. Set the API key in your environment or config.\n',
    ),
  );
  return true;
}

export async function main(args?: string[], deps: MuxMainDeps = {}): Promise<void> {
  const resolveSessionMode = deps.resolveSessionMode ?? defaultResolveSessionMode;
  const createApp = deps.createMuxApp ?? createMuxApp;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (!deps.skipNativeProbes) {
    await probeNativeDependencies();
  }

  // Parse args
  const { values } = parseArgsStrict(
    {
      args: args ?? [],
      options: {
        help: { type: 'boolean', short: 'h' },
        agent: { type: 'string', short: 'a' },
        model: { type: 'string', short: 'm' },
        'capture-traces': { type: 'boolean' },
      },
      allowPositionals: true,
    },
    muxSpec.name,
  );

  if (checkHelp(values as { help?: boolean }, muxSpec)) return;

  const requestedAgentRaw = values.agent as string | undefined;
  const model = values.model as string | undefined;
  const modelMisuse = modelFlagMisusedAsAgent(model);
  if (modelMisuse) {
    process.stderr.write(chalk.red(`${modelMisuse}\n`));
    process.exit(1);
  }
  // CLI flag forces capture on for spawned sessions; absence falls through to
  // each child's config resolution (so we pass the flag, never an explicit off).
  const captureTraces = (values['capture-traces'] as boolean | undefined) ? true : undefined;

  const config = loadConfig();

  // Preflight runs before the autoApprove sleep so a fatal preflight does not wait 3 seconds.
  let preflight: PreflightResult;
  try {
    preflight = await resolveSessionMode({
      config,
      requestedAgent: requestedAgentRaw ? (requestedAgentRaw as AgentId) : undefined,
    });
  } catch (err) {
    if (err instanceof PreflightError) {
      process.stderr.write(chalk.red(err.message) + '\n');
      process.exit(1);
    }
    throw err;
  }

  process.stderr.write(chalk.dim(formatModeLine(preflight)) + '\n');

  // Builtin mode does not have a `--agent` flag to pass to the child PTY,
  // and the PTY child requires Docker mode anyway. Refuse cleanly here so
  // the user gets a single coherent message rather than per-tab failures.
  if (preflight.mode.kind !== 'docker') {
    process.stderr.write(
      chalk.red(
        'ironcurtain mux requires Docker agent mode.\n' +
          'Pass --agent claude-code, --agent goose, or --agent codex; or set Session Mode > Preferred mode to "docker" in `ironcurtain config`.\n',
      ),
    );
    process.exit(1);
  }
  const resolvedAgent = preflight.mode.agent;

  const hasWarnings = emitAutoApproveWarning(config.userConfig);
  if (hasWarnings) {
    process.stderr.write(chalk.dim('\nStarting in 3 seconds...\n'));
    await sleep(3000);
  }

  // Generate a unique mux instance ID for session ownership
  const muxId = `mux-${randomBytes(4).toString('hex')}`;

  // Ensure registry directory exists
  const registryDir = getPtyRegistryDir();
  mkdirSync(registryDir, { recursive: true, mode: 0o700 });

  const app = createApp({
    agent: resolvedAgent,
    model,
    captureTraces,
    autoSpawn: false,
    protectedPaths: config.protectedPaths,
    muxId,
    muxPid: process.pid,
  });

  await app.start();
}
