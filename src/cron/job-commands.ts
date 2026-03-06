/**
 * CLI subcommands for cron job management.
 *
 * These commands work without a running daemon -- they read/write
 * job files directly from ~/.ironcurtain/jobs/. When a daemon is
 * running, daemon-command.ts forwards commands via the control socket
 * instead of calling these functions directly.
 */

import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { loadAllJobs, loadJob, saveJob, deleteJob, loadRecentRuns } from './job-store.js';
import { createJobId, type JobDefinition, type RunOutcome, type RunRecord } from './types.js';
import { getJobWorkspaceDir, getJobDir } from '../config/paths.js';
import { compileTaskPolicy } from './compile-task-policy.js';
import { parseCronExpression, getNextFireTime } from './cron-scheduler.js';
import { syncGitRepo, validateGitUri } from './git-sync.js';

/**
 * Opens the user's $VISUAL / $EDITOR with a temporary file and returns
 * the edited content. Lines beginning with '#' are stripped (instructions).
 * Returns undefined if the user saves an empty file.
 *
 * @param initialContent Pre-populate the file with existing content (for editing).
 */
function openEditorForMultiline(instructions: string, initialContent = ''): string | undefined {
  const editor = process.env['VISUAL'] ?? process.env['EDITOR'] ?? 'nano';
  const tmpFile = join(tmpdir(), `ironcurtain-task-${Date.now()}.txt`);

  const header = instructions
    .split('\n')
    .map((l) => `# ${l}`)
    .join('\n');
  writeFileSync(tmpFile, `${header}\n\n${initialContent}`, 'utf-8');

  try {
    const result = spawnSync(editor, [tmpFile], { stdio: 'inherit' });
    if (result.error) throw result.error;

    const raw = readFileSync(tmpFile, 'utf-8');
    const content = raw
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')
      .trim();

    return content || undefined;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

/** Generates a unique default JobDefinition with empty task fields. */
function generateDefaultJob(): JobDefinition {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    id: createJobId(`job-${suffix}`),
    name: '',
    schedule: '0 9 * * *',
    taskDescription: '',
    taskConstitution: '',
    gitRepo: undefined,
    notifyOnEscalation: true,
    notifyOnCompletion: true,
    enabled: true,
  };
}

const TASK_DESCRIPTION_INSTRUCTIONS =
  'Enter the task description — what the agent should do each run.\n' +
  'This is sent to the agent as its work prompt.\n' +
  'Lines starting with # are ignored.';

const TASK_CONSTITUTION_INSTRUCTIONS =
  'Enter the task constitution — what the agent is and is not permitted to do.\n' +
  'This is the policy compilation input; be specific about allowed operations.\n' +
  'Lines starting with # are ignored.';

/**
 * Interactive review-and-edit loop shared by add-job and edit-job.
 *
 * Shows a summary of all fields and lets the user edit any of them
 * before confirming. Confirm is blocked until task is non-empty.
 * In add mode the ID is editable; in edit mode it is fixed.
 */
async function runJobReviewLoop(initial: JobDefinition, isNew: boolean): Promise<JobDefinition> {
  const { text, confirm, select, note, isCancel, cancel, log } = await import('@clack/prompts');

  let job = initial;

  for (;;) {
    const gitRepoDisplay = job.gitRepo ?? '(none)';
    const descIsEmpty = !job.taskDescription.trim();
    const constIsEmpty = !job.taskConstitution.trim();
    const anyEmpty = descIsEmpty || constIsEmpty;

    function fieldPreview(text: string, empty: boolean): string {
      if (empty) return '  (not set — required)';
      const lines = text.split('\n');
      return [
        ...lines.slice(0, 3).map((l) => `  ${l}`),
        ...(lines.length > 3 ? [`  … (${lines.length - 3} more lines)`] : []),
      ].join('\n');
    }

    const notifyParts = [job.notifyOnEscalation ? 'escalation' : '', job.notifyOnCompletion ? 'completion' : ''].filter(
      Boolean,
    );
    const notifyStr = notifyParts.length ? notifyParts.join(', ') : 'none';

    note(
      [
        `ID:        ${job.id}`,
        `Name:      ${job.name || '(not set)'}`,
        `Schedule:  ${job.schedule}`,
        `Git repo:  ${gitRepoDisplay}`,
        `Notify:    ${notifyStr}`,
        ``,
        `Task description:`,
        fieldPreview(job.taskDescription, descIsEmpty),
        ``,
        `Task constitution:`,
        fieldPreview(job.taskConstitution, constIsEmpty),
      ].join('\n'),
      isNew ? 'New job' : 'Edit job',
    );

    const confirmLabel = isNew ? 'Confirm — create this job' : 'Save changes';
    const action = await select({
      message: 'Confirm or edit a field',
      options: [
        { value: 'confirm', label: anyEmpty ? `${confirmLabel}  (required fields missing)` : confirmLabel },
        ...(isNew ? [{ value: 'id', label: `Edit ID               ${job.id}` }] : []),
        { value: 'name', label: `Edit name             ${job.name || '(not set)'}` },
        { value: 'schedule', label: `Edit schedule         ${job.schedule}` },
        { value: 'gitRepo', label: `Edit git repo         ${gitRepoDisplay}` },
        { value: 'taskDescription', label: `Edit task description${descIsEmpty ? '  ← required' : ''}` },
        { value: 'taskConstitution', label: `Edit task constitution${constIsEmpty ? '  ← required' : ''}` },
        { value: 'notify', label: `Edit notify           ${notifyStr}` },
      ],
    });
    if (isCancel(action)) {
      cancel('Cancelled.');
      process.exit(0);
    }

    if (action === 'confirm') {
      if (anyEmpty) {
        log.warn('Task description and constitution are both required. Please set them before confirming.');
        continue;
      }
      if (isNew && loadJob(job.id)) {
        log.error(`Job "${job.id}" already exists. Please edit the ID.`);
        continue;
      }
      break;
    }

    switch (action) {
      case 'id': {
        const inp = await text({
          message: 'Job ID (slug)',
          initialValue: job.id,
          validate: (v) => {
            if (!v) return 'Required';
            try {
              createJobId(v);
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          },
        });
        if (isCancel(inp)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        job = { ...job, id: createJobId(inp) };
        break;
      }
      case 'name': {
        const inp = await text({ message: 'Display name', initialValue: job.name });
        if (isCancel(inp)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        job = { ...job, name: inp };
        break;
      }
      case 'schedule': {
        const inp = await text({
          message: 'Schedule (cron expression)',
          initialValue: job.schedule,
          validate: (v) => {
            if (!v) return 'Required';
            try {
              parseCronExpression(v);
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          },
        });
        if (isCancel(inp)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        job = { ...job, schedule: inp };
        break;
      }
      case 'gitRepo': {
        const inp = await text({
          message: 'Git repository URI (optional, leave empty to skip)',
          placeholder: 'git@github.com:org/repo.git',
          initialValue: job.gitRepo ?? '',
          validate: (v) => {
            if (!v) return; // empty is valid (skip)
            try {
              validateGitUri(v);
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          },
        });
        if (isCancel(inp)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        job = { ...job, gitRepo: inp || undefined };
        break;
      }
      case 'taskDescription': {
        log.step('Opening editor — save and close to continue');
        const newDesc = openEditorForMultiline(TASK_DESCRIPTION_INSTRUCTIONS, job.taskDescription);
        if (newDesc) {
          job = { ...job, taskDescription: newDesc };
        } else {
          log.warn('Editor was empty — keeping existing task description.');
        }
        break;
      }
      case 'taskConstitution': {
        log.step('Opening editor — save and close to continue');
        const initialConstitution = job.taskConstitution || 'The agent is allowed ';
        const newConst = openEditorForMultiline(TASK_CONSTITUTION_INSTRUCTIONS, initialConstitution);
        if (newConst) {
          job = { ...job, taskConstitution: newConst };
        } else {
          log.warn('Editor was empty — keeping existing task constitution.');
        }
        break;
      }
      case 'notify': {
        const esc = await confirm({
          message: 'Notify on escalation via Signal?',
          initialValue: job.notifyOnEscalation,
        });
        if (isCancel(esc)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        const comp = await confirm({
          message: 'Notify on completion via Signal?',
          initialValue: job.notifyOnCompletion,
        });
        if (isCancel(comp)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        job = { ...job, notifyOnEscalation: esc, notifyOnCompletion: comp };
        break;
      }
    }
  }

  return job;
}

/** Loads a job by ID string, exiting with an error if not found. */
function loadJobOrExit(jobIdStr: string): JobDefinition {
  const jobId = createJobId(jobIdStr);
  const job = loadJob(jobId);
  if (!job) {
    console.error(`Job not found: ${jobIdStr}`);
    process.exit(1);
  }
  return job;
}

function formatRunOutcome(outcome: RunOutcome, verbose = true): string {
  if (outcome.kind === 'success') return chalk.green('success');
  if (outcome.kind === 'budget_exhausted') {
    return verbose ? chalk.yellow(`budget exhausted: ${outcome.dimension}`) : chalk.yellow('budget exhausted');
  }
  return verbose ? chalk.red(`error: ${outcome.message}`) : chalk.red('error');
}

/**
 * Clones a git repo into workspace with interactive retry on failure.
 * Returns the final URI cloned, or undefined if the user skipped.
 */
async function cloneWithRetry(uri: string, workspace: string): Promise<string | undefined> {
  const { text, isCancel, log } = await import('@clack/prompts');
  let currentUri = uri;
  for (;;) {
    console.error('Cloning repository...');
    try {
      syncGitRepo(currentUri, workspace, /* verbose= */ true);
      return currentUri;
    } catch (err) {
      log.error(`Git clone failed: ${err instanceof Error ? err.message : String(err)}`);
      const retryInput = await text({
        message: 'Enter a corrected repository URI, or leave empty to skip cloning',
        placeholder: currentUri,
      });
      if (isCancel(retryInput) || !retryInput) return undefined;
      currentUri = retryInput;
    }
  }
}

/** Creates a new scheduled job interactively. */
export async function runAddJobWizard(): Promise<void> {
  const { intro, outro } = await import('@clack/prompts');
  intro('Add a new scheduled job');

  let job = await runJobReviewLoop(generateDefaultJob(), true);

  const workspace = getJobWorkspaceDir(job.id);
  mkdirSync(workspace, { recursive: true });

  if (job.gitRepo) {
    const finalUri = await cloneWithRetry(job.gitRepo, workspace);
    job = { ...job, gitRepo: finalUri };
  }

  // Save job first so it's not lost if policy compilation fails
  await saveJob(job);

  console.error('');
  console.error('Compiling task policy...');
  try {
    await compileTaskPolicy(job.taskConstitution, getJobDir(job.id));
  } catch (err) {
    console.error(chalk.red(`Policy compilation failed: ${err instanceof Error ? err.message : String(err)}`));
    console.error(
      chalk.yellow(`Job "${job.id}" was saved. Fix the issue then run: ironcurtain daemon recompile-job ${job.id}`),
    );
    process.exit(1);
  }

  const nextRun = getNextFireTime(parseCronExpression(job.schedule), new Date());

  outro(`Job "${job.id}" created. Next run: ${nextRun.toLocaleString()}`);
}

/** Edits an existing job interactively. Re-compiles policy if task changed. */
export async function runEditJobWizard(jobIdStr: string): Promise<void> {
  const { intro, outro } = await import('@clack/prompts');
  const existing = loadJobOrExit(jobIdStr);

  intro(`Edit job "${existing.name || existing.id}"`);

  const originalConstitution = existing.taskConstitution;
  const job = await runJobReviewLoop(existing, false);

  // Save first so changes aren't lost if recompilation fails
  await saveJob(job);

  if (job.taskConstitution !== originalConstitution) {
    console.error('Constitution changed — recompiling policy...');
    try {
      await compileTaskPolicy(job.taskConstitution, getJobDir(job.id));
    } catch (err) {
      console.error(chalk.red(`Policy compilation failed: ${err instanceof Error ? err.message : String(err)}`));
      console.error(
        chalk.yellow(`Job "${job.id}" was saved. Fix the issue then run: ironcurtain daemon recompile-job ${job.id}`),
      );
      process.exit(1);
    }
  }

  outro(`Job "${job.id}" updated.`);
}

/** Lists all jobs with their schedules and last run status. */
/** Shared display data for a single job entry. */
interface JobDisplayEntry {
  job: JobDefinition;
  nextRunStr: string;
  lastRun: RunRecord | undefined;
  statusLabels: string[];
}

/** Formats and prints a single job entry. */
function printJobEntry(entry: JobDisplayEntry): void {
  const statusLabel = entry.statusLabels.length > 0 ? ` ${entry.statusLabels.join(' ')}` : '';

  let lastRunStr = '';
  if (entry.lastRun) {
    lastRunStr = `Last run: ${entry.lastRun.startedAt} -- ${formatRunOutcome(entry.lastRun.outcome)}`;
    if (entry.lastRun.summary) {
      lastRunStr += `\n${' '.repeat(20)}${entry.lastRun.summary.split('\n')[0].slice(0, 60)}`;
    }
  }

  console.error(
    `  ${chalk.bold(entry.job.id.padEnd(20))} ${entry.job.name.padEnd(30)} ${entry.job.schedule.padEnd(15)} ${entry.nextRunStr}${statusLabel}`,
  );
  if (lastRunStr) {
    console.error(`  ${' '.repeat(20)}${lastRunStr}`);
  }
}

export function runListJobs(): void {
  const jobs = loadAllJobs();

  if (jobs.length === 0) {
    console.error('No jobs configured. Use "ironcurtain daemon add-job" to create one.');
    return;
  }

  console.error('Jobs:');
  for (const job of jobs) {
    let nextRunStr = '';
    if (job.enabled) {
      try {
        const nextRun = getNextFireTime(parseCronExpression(job.schedule), new Date());
        nextRunStr = `next: ${nextRun.toLocaleString()}`;
      } catch {
        nextRunStr = chalk.red('invalid schedule');
      }
    }

    const lastRuns = loadRecentRuns(job.id, 1);
    printJobEntry({
      job,
      nextRunStr,
      lastRun: lastRuns[0],
      statusLabels: job.enabled ? [] : [chalk.yellow('DISABLED')],
    });
  }
}

/** Daemon job list entry received over the control socket. */
export interface DaemonJobListEntry {
  job: JobDefinition;
  nextRun: string | null;
  lastRun: RunRecord | undefined;
  isRunning: boolean;
}

/**
 * Formats job list data received from the daemon control socket.
 * Used when list-jobs is forwarded to a running daemon, which provides
 * live running status and next-run times from the scheduler.
 */
export function formatDaemonJobList(jobs: DaemonJobListEntry[]): void {
  if (jobs.length === 0) {
    console.error('No jobs configured. Use "ironcurtain daemon add-job" to create one.');
    return;
  }

  console.error('Jobs (from running daemon):');
  for (const entry of jobs) {
    const statusLabels: string[] = [];
    if (!entry.job.enabled) statusLabels.push(chalk.yellow('DISABLED'));
    if (entry.isRunning) statusLabels.push(chalk.cyan('RUNNING'));

    printJobEntry({
      job: entry.job,
      nextRunStr: entry.nextRun ? `next: ${new Date(entry.nextRun).toLocaleString()}` : '',
      lastRun: entry.lastRun,
      statusLabels,
    });
  }
}

/** Manually triggers a job run. */
export async function runJobCommand(jobIdStr: string): Promise<void> {
  const job = loadJobOrExit(jobIdStr);

  console.error(`Running job "${job.name}"...`);
  const { resolveSessionMode } = await import('../session/preflight.js');
  const { loadConfig } = await import('../config/index.js');
  const preflight = await resolveSessionMode({ config: loadConfig() });
  console.error(`Mode: ${preflight.mode.kind} (${preflight.reason})`);
  const { IronCurtainDaemon } = await import('../daemon/ironcurtain-daemon.js');
  const daemon = new IronCurtainDaemon({ mode: preflight.mode, noSignal: true });
  const record = await daemon.runJobNow(job.id);

  console.error(`  Outcome: ${formatRunOutcome(record.outcome)}`);
  console.error(`  Duration: ${record.budget.elapsedSeconds.toFixed(0)}s`);
  console.error(`  Cost: $${record.budget.estimatedCostUsd.toFixed(2)}`);
  if (record.summary) {
    console.error(`  Summary: ${record.summary.split('\n')[0].slice(0, 100)}`);
  }

  // Clean up daemon resources (scheduler, logger file handles) and exit.
  // Without this, lingering handles keep the Node.js event loop alive.
  await daemon.shutdown();
  process.exit(record.outcome.kind === 'success' ? 0 : 1);
}

/** Removes a job. */
export function runRemoveJob(jobIdStr: string): void {
  const job = loadJobOrExit(jobIdStr);

  deleteJob(job.id);
  console.error(`Job "${jobIdStr}" removed.`);
}

/** Sets a job's enabled state. */
async function runSetJobEnabled(jobIdStr: string, enabled: boolean): Promise<void> {
  const job = loadJobOrExit(jobIdStr);

  await saveJob({ ...job, enabled });
  console.error(`Job "${jobIdStr}" ${enabled ? 'enabled' : 'disabled'}.`);
}

/** Disables a job. */
export const runDisableJob = (jobIdStr: string): Promise<void> => runSetJobEnabled(jobIdStr, false);

/** Enables a job. */
export const runEnableJob = (jobIdStr: string): Promise<void> => runSetJobEnabled(jobIdStr, true);

/** Re-runs policy compilation for a job. */
export async function runRecompileJob(jobIdStr: string): Promise<void> {
  const job = loadJobOrExit(jobIdStr);

  console.error(`Recompiling policy for job "${jobIdStr}"...`);
  await compileTaskPolicy(job.taskConstitution, getJobDir(job.id));
  console.error('Done.');
}

/** Shows recent run logs for a job. */
export function runShowLogs(jobIdStr: string, limit: number): void {
  const job = loadJobOrExit(jobIdStr);

  const runs = loadRecentRuns(job.id, limit);
  if (runs.length === 0) {
    console.error(`No run history for job "${jobIdStr}".`);
    return;
  }

  console.error(`Recent runs for "${job.name}" (last ${runs.length}):`);
  console.error('');
  for (const run of runs) {
    console.error(
      `  ${run.startedAt}  ${formatRunOutcome(run.outcome, false)}  ${run.budget.elapsedSeconds.toFixed(0)}s  $${run.budget.estimatedCostUsd.toFixed(2)}`,
    );
    if (run.summary) {
      const firstLine = run.summary.split('\n').find((l) => l.trim()) ?? '';
      console.error(`    ${firstLine.slice(0, 80)}`);
    }
  }
}
