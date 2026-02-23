import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig, loadGeneratedPolicy, checkConstitutionFreshness, getPackageGeneratedDir } from './config/index.js';
import * as logger from './logger.js';
import { CliTransport } from './session/cli-transport.js';
import { createSession } from './session/index.js';
import { resolveSessionMode } from './session/preflight.js';
import type { AgentId } from './docker/agent-adapter.js';

export async function main(args?: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: args ?? process.argv.slice(2),
    options: {
      resume: { type: 'string', short: 'r' },
      agent: { type: 'string', short: 'a' },
      'list-agents': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });

  // Handle --list-agents: print registered agents and exit
  if (values['list-agents']) {
    const { registerBuiltinAdapters, listAgents } = await import('./docker/agent-registry.js');
    await registerBuiltinAdapters();
    const agents = listAgents();
    for (const agent of agents) {
      process.stderr.write(`  ${agent.id}  ${agent.displayName}\n`);
    }
    return;
  }

  const task = positionals.join(' ');
  const resumeSessionId = values.resume as string | undefined;
  const agentName = values.agent as string | undefined;
  const config = loadConfig();

  // Pre-flight: resolve session mode (auto-detect or validate explicit --agent)
  const preflight = await resolveSessionMode({
    config,
    requestedAgent: agentName ? (agentName as AgentId) : undefined,
  });

  // Log auto-selection reason (skip for explicit --agent)
  if (!agentName) {
    process.stderr.write(chalk.dim(`Mode: ${preflight.mode.kind} (${preflight.reason})\n`));
  }

  const mode = preflight.mode;

  // Check constitution freshness once here, before any proxy processes are spawned.
  const { compiledPolicy } = loadGeneratedPolicy(config.generatedDir, getPackageGeneratedDir());
  checkConstitutionFreshness(compiledPolicy, config.constitutionPath);

  // Create the transport first so we can wire its callbacks into the session.
  const transport = new CliTransport({ initialMessage: task || undefined });

  const initSpinner = ora({
    text: mode.kind === 'docker' ? `Initializing Docker session (${mode.agent})...` : 'Initializing session...',
    stream: process.stderr,
    discardStdin: false,
  }).start();

  let session: Awaited<ReturnType<typeof createSession>>;
  try {
    session = await createSession({
      config,
      mode,
      resumeSessionId,
      onEscalation: transport.createEscalationHandler(),
      onEscalationExpired: transport.createEscalationExpiredHandler(),
      onDiagnostic: transport.createDiagnosticHandler(),
    });
  } catch (error) {
    initSpinner.fail(chalk.red('Session initialization failed'));
    throw error;
  }

  initSpinner.succeed(chalk.dim('Session ready'));
  process.stderr.write('\n');

  // Handle Ctrl-C: first signal initiates graceful shutdown,
  // second signal force-exits immediately.
  let shuttingDown = false;
  const handleSignal = (): void => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    process.stderr.write(chalk.dim('\nShutting down...\n'));
    transport.close();
    // Force exit if cleanup takes too long
    const forceExitTimeout = setTimeout(() => process.exit(1), 5_000);
    forceExitTimeout.unref();
    session
      .close()
      .catch(() => {})
      .finally(() => {
        clearTimeout(forceExitTimeout);
        logger.teardown();
        process.exit(0);
      });
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    await transport.run(session);
  } finally {
    // session.close() is idempotent -- safe to call here even if the
    // signal handler already initiated shutdown. Signal handlers stay
    // active during cleanup so a second Ctrl-C can force-exit.
    await session.close();
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    logger.teardown();
    process.exit(0);
  }
}

// Only run when executed directly (not when imported by cli.ts)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await import('dotenv/config');
  main().catch((err: unknown) => {
    process.stderr.write(chalk.red(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  });
}
