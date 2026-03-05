/**
 * CLI entry point for `ironcurtain daemon` and its subcommands.
 *
 * When no sub-subcommand is given, starts the unified daemon.
 * Subcommands: add-job, list-jobs, run-job, remove-job,
 *              disable-job, enable-job, recompile-job, logs
 */

import { parseArgs } from 'node:util';
import { IronCurtainDaemon } from './ironcurtain-daemon.js';
import type { AgentId } from '../docker/agent-adapter.js';

function printDaemonHelp(): void {
  console.error(
    `
ironcurtain daemon - Unified Signal + cron daemon

Usage:
  ironcurtain daemon [options]          Start the daemon
  ironcurtain daemon add-job            Add a new scheduled job (interactive)
  ironcurtain daemon edit-job <id>      Edit an existing job (interactive)
  ironcurtain daemon list-jobs          List all jobs with schedule info
  ironcurtain daemon run-job <id>       Manually trigger a job run
  ironcurtain daemon remove-job <id>    Delete a job and all artifacts
  ironcurtain daemon disable-job <id>   Stop scheduling a job
  ironcurtain daemon enable-job <id>    Resume scheduling a job
  ironcurtain daemon recompile-job <id> Re-run policy compilation
  ironcurtain daemon logs <id> [--runs N]  Show recent run summaries

Options:
  -a, --agent <name>   Agent mode (same as start)
  --no-signal          Skip Signal transport (cron-only mode)
`.trim(),
  );
}

export async function runDaemonCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      agent: { type: 'string', short: 'a' },
      'no-signal': { type: 'boolean' },
      runs: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printDaemonHelp();
    return;
  }

  const subcommand = positionals[0];

  // Resolve session mode (same as `start` command)
  const { resolveSessionMode } = await import('../session/preflight.js');
  const { loadConfig } = await import('../config/index.js');
  const preflight = await resolveSessionMode({
    config: loadConfig(),
    requestedAgent: values.agent ? (values.agent as AgentId) : undefined,
  });
  const mode = preflight.mode;
  console.error(`Mode: ${mode.kind} (${preflight.reason})`);

  if (!subcommand) {
    // Start the daemon
    const daemon = new IronCurtainDaemon({
      mode,
      noSignal: values['no-signal'] as boolean | undefined,
    });

    // Handle shutdown signals
    const shutdownHandler = async () => {
      await daemon.shutdown();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdownHandler());
    process.on('SIGTERM', () => void shutdownHandler());

    await daemon.start();
    return;
  }

  // Sub-subcommands that work without a running daemon
  switch (subcommand) {
    case 'add-job': {
      const { runAddJobWizard } = await import('../cron/job-commands.js');
      await runAddJobWizard();
      break;
    }
    case 'edit-job': {
      const jobId = positionals[1];
      if (!jobId) {
        console.error('Usage: ironcurtain daemon edit-job <job-id>');
        process.exit(1);
      }
      const { runEditJobWizard } = await import('../cron/job-commands.js');
      await runEditJobWizard(jobId);
      break;
    }
    case 'list-jobs': {
      const { runListJobs } = await import('../cron/job-commands.js');
      runListJobs();
      break;
    }
    case 'run-job': {
      const jobId = positionals[1];
      if (!jobId) {
        console.error('Usage: ironcurtain daemon run-job <job-id>');
        process.exit(1);
      }
      const { runJobCommand } = await import('../cron/job-commands.js');
      await runJobCommand(jobId);
      break;
    }
    case 'remove-job': {
      const jobId = positionals[1];
      if (!jobId) {
        console.error('Usage: ironcurtain daemon remove-job <job-id>');
        process.exit(1);
      }
      const { runRemoveJob } = await import('../cron/job-commands.js');
      runRemoveJob(jobId);
      break;
    }
    case 'disable-job': {
      const jobId = positionals[1];
      if (!jobId) {
        console.error('Usage: ironcurtain daemon disable-job <job-id>');
        process.exit(1);
      }
      const { runDisableJob } = await import('../cron/job-commands.js');
      runDisableJob(jobId);
      break;
    }
    case 'enable-job': {
      const jobId = positionals[1];
      if (!jobId) {
        console.error('Usage: ironcurtain daemon enable-job <job-id>');
        process.exit(1);
      }
      const { runEnableJob } = await import('../cron/job-commands.js');
      runEnableJob(jobId);
      break;
    }
    case 'recompile-job': {
      const jobId = positionals[1];
      if (!jobId) {
        console.error('Usage: ironcurtain daemon recompile-job <job-id>');
        process.exit(1);
      }
      const { runRecompileJob } = await import('../cron/job-commands.js');
      await runRecompileJob(jobId);
      break;
    }
    case 'logs': {
      const jobId = positionals[1];
      if (!jobId) {
        console.error('Usage: ironcurtain daemon logs <job-id> [--runs N]');
        process.exit(1);
      }
      const limit = values.runs ? parseInt(values.runs as string, 10) : 5;
      const { runShowLogs } = await import('../cron/job-commands.js');
      runShowLogs(jobId, limit);
      break;
    }
    default:
      console.error(`Unknown daemon subcommand: ${subcommand}\n`);
      printDaemonHelp();
      process.exit(1);
  }
}
