/**
 * CLI entry point for `ironcurtain daemon` and its subcommands.
 *
 * When no sub-subcommand is given, starts the unified daemon.
 * Subcommands: add-job, list-jobs, run-job, remove-job,
 *              disable-job, enable-job, recompile-job, logs
 *
 * Commands that modify daemon state (remove-job, enable-job, disable-job,
 * recompile-job, run-job) first check if a daemon is running via the
 * control socket. If running, the command is forwarded to the daemon.
 * Otherwise, the command operates directly on the filesystem.
 */

import { parseArgs } from 'node:util';
import { IronCurtainDaemon } from './ironcurtain-daemon.js';
import { sendControlRequest, type ControlRequest, type ControlResponse } from './control-socket.js';
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

/** Extracts a required job-id positional, exiting with usage if missing. */
function requireJobIdArg(positionals: string[]): string {
  const jobId = positionals[1];
  if (!jobId) {
    console.error('Usage: ironcurtain daemon <subcommand> <job-id>');
    process.exit(1);
  }
  return jobId;
}

/**
 * Attempts to forward a command to a running daemon.
 * Returns the response if the daemon handled it, or null if no daemon
 * is running (caller should fall back to local filesystem operations).
 */
async function tryForwardToDaemon(request: ControlRequest): Promise<ControlResponse | null> {
  return sendControlRequest(request);
}

/**
 * Handles a forwarded response: prints success/error and exits.
 * Returns true if the response was handled (caller should return).
 */
function handleForwardedResponse(response: ControlResponse | null, successMessage?: string): boolean {
  if (response === null) return false;

  if (!response.ok) {
    console.error(`Error from daemon: ${response.error}`);
    process.exit(1);
  }

  if (successMessage) {
    console.error(successMessage);
  }
  return true;
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
      const jobId = requireJobIdArg(positionals);
      const { runEditJobWizard } = await import('../cron/job-commands.js');
      await runEditJobWizard(jobId);
      break;
    }
    case 'list-jobs': {
      const resp = await tryForwardToDaemon({ command: 'list-jobs' });
      if (handleForwardedResponse(resp)) {
        const { formatDaemonJobList } = await import('../cron/job-commands.js');
        formatDaemonJobList(
          (resp as ControlResponse & { ok: true }).data as import('../cron/job-commands.js').DaemonJobListEntry[],
        );
        break;
      }
      const { runListJobs } = await import('../cron/job-commands.js');
      runListJobs();
      break;
    }
    case 'run-job': {
      const jobId = requireJobIdArg(positionals);
      const resp = await tryForwardToDaemon({ command: 'run-job', jobId });
      if (handleForwardedResponse(resp)) {
        const record = (resp as ControlResponse & { ok: true }).data as import('../cron/types.js').RunRecord;
        console.error(`Job "${jobId}" completed via daemon.`);
        console.error(`  Outcome: ${record.outcome.kind}`);
        console.error(`  Duration: ${record.budget.elapsedSeconds.toFixed(0)}s`);
        console.error(`  Cost: $${record.budget.estimatedCostUsd.toFixed(2)}`);
        break;
      }
      const { runJobCommand } = await import('../cron/job-commands.js');
      await runJobCommand(jobId);
      break;
    }
    case 'remove-job': {
      const jobId = requireJobIdArg(positionals);
      const resp = await tryForwardToDaemon({ command: 'remove-job', jobId });
      if (handleForwardedResponse(resp, `Job "${jobId}" removed (daemon notified).`)) break;
      const { runRemoveJob } = await import('../cron/job-commands.js');
      runRemoveJob(jobId);
      break;
    }
    case 'disable-job': {
      const jobId = requireJobIdArg(positionals);
      const resp = await tryForwardToDaemon({ command: 'disable-job', jobId });
      if (handleForwardedResponse(resp, `Job "${jobId}" disabled (daemon notified).`)) break;
      const { runDisableJob } = await import('../cron/job-commands.js');
      await runDisableJob(jobId);
      break;
    }
    case 'enable-job': {
      const jobId = requireJobIdArg(positionals);
      const resp = await tryForwardToDaemon({ command: 'enable-job', jobId });
      if (handleForwardedResponse(resp, `Job "${jobId}" enabled (daemon notified).`)) break;
      const { runEnableJob } = await import('../cron/job-commands.js');
      await runEnableJob(jobId);
      break;
    }
    case 'recompile-job': {
      const jobId = requireJobIdArg(positionals);
      const resp = await tryForwardToDaemon({ command: 'recompile-job', jobId });
      if (handleForwardedResponse(resp, `Job "${jobId}" policy recompiled (daemon notified).`)) break;
      const { runRecompileJob } = await import('../cron/job-commands.js');
      await runRecompileJob(jobId);
      break;
    }
    case 'logs': {
      const jobId = requireJobIdArg(positionals);
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
