import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import ora from 'ora';
import {
  loadConfig,
  loadGeneratedPolicy,
  checkConstitutionFreshness,
  checkAnnotationFreshness,
  getPackageGeneratedDir,
} from './config/index.js';
import { getUserConfigPath } from './config/paths.js';
import { modelFlagMisusedAsAgent } from './config/agent-model-guard.js';
import { checkHelp, parseArgsStrict, type CommandSpec } from './cli-help.js';
import * as logger from './logger.js';
import { CliTransport } from './session/cli-transport.js';
import { createStandaloneSession } from './session/index.js';
import { formatModeLine, resolveSessionMode } from './session/preflight.js';
import { validateWorkspacePath } from './session/workspace-validation.js';
import { shouldAutoSaveMemory } from './memory/auto-save.js';
import type { AgentId } from './docker/agent-adapter.js';

const startSpec: CommandSpec = {
  name: 'ironcurtain start',
  description: 'Run a one-shot or non-mux agent session',
  usage: ['ironcurtain start [options] [task]'],
  options: [
    { flag: 'resume', short: 'r', description: 'Resume a previous session', placeholder: '<id>' },
    {
      flag: 'agent',
      short: 'a',
      description: 'Agent mode: builtin, claude-code, goose, or codex',
      placeholder: '<name>',
    },
    { flag: 'workspace', short: 'w', description: 'Use an existing directory as the workspace', placeholder: '<path>' },
    { flag: 'persona', short: 'p', description: 'Use a named persona profile', placeholder: '<name>' },
    {
      flag: 'pty',
      description: 'Legacy raw PTY/debug mode; use ironcurtain mux for normal interactive container sessions',
    },
    { flag: 'model', short: 'm', description: 'Override the agent model ID', placeholder: '<model>' },
    {
      flag: 'provider-profile',
      description: 'Route the container agent through a named provider profile (OpenRouter)',
      placeholder: '<name>',
    },
    {
      flag: 'capture-traces',
      description: 'Capture LLM API traces for this run (overrides config; container mode only)',
    },
    { flag: 'list-agents', description: 'List registered agent adapters' },
  ],
  examples: [
    'ironcurtain start "Summarize files in ."       # Single-shot/non-mux task',
    'ironcurtain start --agent builtin              # Local builtin REPL',
    'ironcurtain start --resume <session-id>        # Resume a non-mux session',
    'ironcurtain start -w ./my-project "Fix bugs"   # Work in existing directory',
    'ironcurtain start --agent claude-code "task"   # Docker: Claude Code',
    'ironcurtain start --agent codex "task"         # Docker: Codex CLI',
    'ironcurtain start -p exec-assistant "Check mail" # Use a persona',
    'ironcurtain start --provider-profile glm-5.2 "task" # Route via an OpenRouter profile',
    'ironcurtain start --pty                        # Legacy raw PTY/debug; prefer ironcurtain mux',
    'ironcurtain start --list-agents                # List available agents',
  ],
};

export async function main(args?: string[]): Promise<void> {
  const { values, positionals } = parseArgsStrict(
    {
      args: args ?? process.argv.slice(2),
      options: {
        help: { type: 'boolean', short: 'h' },
        resume: { type: 'string', short: 'r' },
        agent: { type: 'string', short: 'a' },
        workspace: { type: 'string', short: 'w' },
        persona: { type: 'string', short: 'p' },
        pty: { type: 'boolean' },
        model: { type: 'string', short: 'm' },
        'provider-profile': { type: 'string' },
        'capture-traces': { type: 'boolean' },
        'list-agents': { type: 'boolean' },
      },
      allowPositionals: true,
    },
    startSpec.name,
  );

  if (checkHelp(values, startSpec)) return;

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

  // First-start wizard: run when config file does not exist and stdin is a TTY
  if (!existsSync(getUserConfigPath()) && process.stdin.isTTY) {
    const { runFirstStart } = await import('./config/first-start.js');
    await runFirstStart();
  }

  const task = positionals.join(' ');
  const resumeSessionId = values.resume as string | undefined;
  const agentName = values.agent as string | undefined;
  const rawWorkspace = values.workspace as string | undefined;
  const personaName = values.persona as string | undefined;
  const providerProfileName = values['provider-profile'] as string | undefined;
  const modelOverride = values.model as string | undefined;
  const modelMisuse = modelFlagMisusedAsAgent(modelOverride);
  if (modelMisuse) {
    process.stderr.write(chalk.red(`${modelMisuse}\n`));
    process.exit(1);
  }
  const captureTracesOverride = (values['capture-traces'] as boolean | undefined) ? true : undefined;
  const config = loadConfig();

  // Apply --model override to both Code Mode and Docker agent model IDs
  if (modelOverride) {
    config.agentModelId = modelOverride;
    config.userConfig = { ...config.userConfig, agentModelId: modelOverride };
  }

  // When resuming, CLI --workspace and --persona are ignored -- the original
  // values are restored from persisted session metadata.
  if (resumeSessionId && rawWorkspace) {
    process.stderr.write(chalk.yellow('Note: --workspace is ignored when resuming; original workspace is restored.\n'));
  }
  if (resumeSessionId && personaName) {
    process.stderr.write(chalk.yellow('Note: --persona is ignored when resuming; original persona is restored.\n'));
  }
  if (resumeSessionId && providerProfileName) {
    process.stderr.write(
      chalk.yellow('Note: --provider-profile is ignored when resuming; original profile is restored.\n'),
    );
  }

  // Validate --workspace before anything else that uses config
  let workspacePath: string | undefined;
  if (rawWorkspace && !resumeSessionId) {
    try {
      workspacePath = validateWorkspacePath(rawWorkspace, config.protectedPaths);
    } catch (error) {
      process.stderr.write(chalk.red(`Invalid workspace: ${error instanceof Error ? error.message : String(error)}\n`));
      process.exit(1);
    }
  }

  // Pre-flight: resolve session mode (auto-detect or validate explicit --agent).
  // Thread the per-session --provider-profile so credential detection reflects
  // the profile the session will actually route through (OpenRouter-only users
  // on a native-default config must not be spuriously blocked). Ignored on
  // resume (the original profile is restored from metadata later).
  const preflight = await resolveSessionMode({
    config,
    requestedAgent: agentName ? (agentName as AgentId) : undefined,
    providerProfileName: resumeSessionId ? undefined : providerProfileName,
  });

  if (!agentName) {
    process.stderr.write(chalk.dim(`${formatModeLine(preflight)}\n`));
  }

  const mode = preflight.mode;

  // F4: --provider-profile only affects container agent mode; the builtin
  // (Code Mode) agent never reaches profile resolution. Warn on a harmless
  // no-op rather than silently ignoring the flag. Skip on resume (already
  // warned above that the flag is ignored).
  if (providerProfileName && !resumeSessionId && mode.kind !== 'docker') {
    process.stderr.write(
      chalk.yellow(
        'Note: --provider-profile applies only to container agent mode; ignored for the builtin (Code Mode) agent.\n',
      ),
    );
  }

  // Check constitution and annotation freshness once here, before any proxy processes are spawned.
  const { compiledPolicy, toolAnnotations } = loadGeneratedPolicy({
    policyDir: config.generatedDir,
    toolAnnotationsDir: config.toolAnnotationsDir ?? config.generatedDir,
    fallbackDir: getPackageGeneratedDir(),
  });
  checkConstitutionFreshness(compiledPolicy, config.constitutionPath);
  checkAnnotationFreshness(toolAnnotations, config.mcpServers);

  // Pre-flight the Docker image before starting the init spinner: the
  // progress sink and the spinner both render to stderr, so they fight for
  // the same line if they run concurrently. The inner ensureImage call
  // during session init is content-hash cached, so it's a cheap no-op.
  if (mode.kind === 'docker') {
    const { ensureDockerImage } = await import('./docker/docker-infrastructure.js');
    try {
      await ensureDockerImage(mode.agent, config.userConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`\n${chalk.red('Docker image setup failed:')} ${message}\n`);
      process.exit(1);
    }
  }

  // PTY mode: attach terminal directly to Claude Code in an agent container.
  if (values.pty) {
    if (mode.kind !== 'docker') {
      process.stderr.write(
        chalk.red(
          'PTY mode requires container agent mode. Use --agent claude-code or ensure a container runtime is available.\n',
        ),
      );
      process.exit(1);
    }

    if (task) {
      process.stderr.write(
        chalk.red('PTY mode is interactive -- do not provide a task message. Type your commands in the PTY.\n'),
      );
      process.exit(1);
    }

    const { runPtySession } = await import('./docker/pty-session.js');
    await runPtySession({
      config,
      mode,
      workspacePath,
      resumeSessionId,
      persona: resumeSessionId ? undefined : personaName,
      providerProfileName: resumeSessionId ? undefined : providerProfileName,
      captureTracesOverride,
    });
    process.exit(0);
  }

  // Create the transport first so we can wire its callbacks into the session.
  const transport = new CliTransport({
    initialMessage: task || undefined,
    autoSaveMemory: shouldAutoSaveMemory(config, { persona: personaName }),
    dockerMode: mode.kind === 'docker',
  });

  const initSpinner = ora({
    text: mode.kind === 'docker' ? `Initializing Docker session (${mode.agent})...` : 'Initializing session...',
    stream: process.stderr,
    discardStdin: false,
  }).start();

  let session: Awaited<ReturnType<typeof createStandaloneSession>>;
  try {
    session = await createStandaloneSession({
      config,
      mode,
      resumeSessionId,
      // workspacePath is already undefined when resuming (validation skipped above)
      workspacePath,
      persona: resumeSessionId ? undefined : personaName,
      providerProfileName: resumeSessionId ? undefined : providerProfileName,
      captureTracesOverride,
      onEscalation: transport.createEscalationHandler(),
      onEscalationExpired: transport.createEscalationExpiredHandler(),
      onDiagnostic: transport.createDiagnosticHandler(),
    });
  } catch (error) {
    initSpinner.fail(chalk.red('Session initialization failed'));
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n${chalk.red('Error:')} ${message}\n`);
    process.exit(1);
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
