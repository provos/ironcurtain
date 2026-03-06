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
import { formatDuration } from '../cron/format-utils.js';
import { checkHelp, type CommandSpec } from '../cli-help.js';

const daemonSpec: CommandSpec = {
  name: 'ironcurtain daemon',
  description: 'Unified Signal + cron daemon',
  usage: [
    'ironcurtain daemon [options]              Start the daemon',
    'ironcurtain daemon <subcommand> [options]  Manage jobs',
  ],
  subcommands: [
    { name: 'add-job', description: 'Add a new scheduled job (interactive)' },
    { name: 'edit-job <id>', description: 'Edit an existing job (interactive)' },
    { name: 'list-jobs', description: 'List all jobs with schedule info' },
    { name: 'run-job <id>', description: 'Manually trigger a job run' },
    { name: 'status', description: 'Show daemon status' },
    { name: 'remove-job <id>', description: 'Delete a job and all artifacts' },
    { name: 'disable-job <id>', description: 'Stop scheduling a job' },
    { name: 'enable-job <id>', description: 'Resume scheduling a job' },
    { name: 'recompile-job <id>', description: 'Re-run policy compilation' },
    { name: 'logs <id>', description: 'Show recent run summaries' },
  ],
  options: [
    { flag: 'agent', short: 'a', description: 'Agent mode (same as start)', placeholder: '<name>' },
    { flag: 'force', short: 'f', description: 'Skip confirmation prompts' },
    { flag: 'no-signal', description: 'Skip Signal transport (cron-only mode)' },
    { flag: 'runs', description: 'Number of recent runs to show (for logs)', placeholder: '<N>' },
  ],
};

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
      force: { type: 'boolean', short: 'f' },
      runs: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (checkHelp(values as { help?: boolean }, daemonSpec)) {
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
      const { teardown: teardownLogger } = await import('../logger.js');
      teardownLogger();
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
    case 'status': {
      const { sendControlRequest: sendReq } = await import('./control-socket.js');
      const resp = await sendReq({ command: 'status' });
      if (!resp || !resp.ok) {
        console.error('Daemon is not running.');
        break;
      }
      const status = resp.data as import('./control-socket.js').DaemonStatusDto;
      const uptimeStr = formatDuration(status.uptimeSeconds);
      console.error('Daemon is running.');
      console.error(`  Uptime:             ${uptimeStr}`);
      console.error(
        `  Jobs:               ${status.jobs.total} total, ${status.jobs.enabled} enabled, ${status.jobs.running} running`,
      );
      console.error(`  Signal transport:   ${status.signalConnected ? 'connected' : 'not configured'}`);
      if (status.nextFireTime) {
        const { formatRelativeTime } = await import('../cron/format-utils.js');
        console.error(`  Next scheduled run: ${formatRelativeTime(new Date(status.nextFireTime))}`);
      } else {
        console.error('  Next scheduled run: none');
      }
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
      // When forwarding to daemon via control socket, skip interactive prompt
      const resp = await tryForwardToDaemon({ command: 'remove-job', jobId });
      if (handleForwardedResponse(resp, `Job "${jobId}" removed (daemon notified).`)) break;
      const { runRemoveJob } = await import('../cron/job-commands.js');
      await runRemoveJob(jobId, values.force as boolean | undefined);
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
      checkHelp({ help: true }, daemonSpec);
      process.exit(1);
  }
}
