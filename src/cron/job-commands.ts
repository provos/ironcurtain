/**
 * CLI subcommands for cron job management.
 *
 * These commands work without a running daemon -- they read/write
 * job files directly from ~/.ironcurtain/jobs/.
 */

import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { loadAllJobs, loadJob, saveJob, deleteJob, loadRecentRuns } from './job-store.js';
import { createJobId, type JobDefinition, type RunOutcome } from './types.js';
import { getJobWorkspaceDir, getJobDir } from '../config/paths.js';
import { compileTaskPolicy } from './compile-task-policy.js';
import { createCronScheduler, parseCronExpression } from './cron-scheduler.js';
import { syncGitRepo } from './git-sync.js';

/**
 * Opens the user's $VISUAL / $EDITOR with a temporary file and returns
 * the edited content. Lines beginning with '#' are stripped (instructions).
 * Returns undefined if the user saves an empty file.
 */
function openEditorForMultiline(instructions: string): string | undefined {
  const editor = process.env['VISUAL'] ?? process.env['EDITOR'] ?? 'nano';
  const tmpFile = join(tmpdir(), `ironcurtain-task-${Date.now()}.txt`);

  // Write instructional comments + blank line for the user to start typing
  const header = instructions
    .split('\n')
    .map((l) => `# ${l}`)
    .join('\n');
  writeFileSync(tmpFile, `${header}\n\n`, 'utf-8');

  try {
    const result = spawnSync(editor, [tmpFile], { stdio: 'inherit' });
    if (result.error) {
      throw result.error;
    }

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

function formatRunOutcome(outcome: RunOutcome, verbose = true): string {
  if (outcome.kind === 'success') return chalk.green('success');
  if (outcome.kind === 'budget_exhausted') {
    return verbose ? chalk.yellow(`budget exhausted: ${outcome.dimension}`) : chalk.yellow('budget exhausted');
  }
  return verbose ? chalk.red(`error: ${outcome.message}`) : chalk.red('error');
}

/**
 * Interactive wizard for creating a new job.
 * Uses @clack/prompts for the terminal UI.
 */
export async function runAddJobWizard(): Promise<void> {
  const { intro, text, confirm, select, note, outro, isCancel, cancel, log } = await import('@clack/prompts');

  intro('Add a new scheduled job');

  const idInput = await text({
    message: 'Job ID (slug)',
    placeholder: 'issue-triage',
    validate: (value) => {
      if (!value) return 'Required';
      try {
        createJobId(value);
        return undefined;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
  });
  if (isCancel(idInput)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  const jobId = createJobId(idInput);

  // Check if job already exists
  const existing = loadJob(jobId);
  if (existing) {
    console.error(`Job "${jobId}" already exists. Use 'remove-job' first or choose a different ID.`);
    process.exit(1);
  }

  const nameInput = await text({
    message: 'Display name',
    placeholder: 'GitHub Issue Triage',
  });
  if (isCancel(nameInput)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  const name = nameInput;

  const gitRepoInput = await text({
    message: 'Git repository URI (optional, leave empty to skip)',
    placeholder: 'git@github.com:org/repo.git',
  });
  if (isCancel(gitRepoInput)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  const gitRepo = gitRepoInput || undefined;

  const scheduleInput = await text({
    message: 'Schedule (cron expression)',
    placeholder: '0 9 * * *',
    validate: (value) => {
      if (!value) return 'Required';
      try {
        parseCronExpression(value);
        return undefined;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
  });
  if (isCancel(scheduleInput)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  const schedule = scheduleInput;

  log.step('Task description (opening editor — save and close to continue)');

  let task: string | undefined;
  while (!task) {
    task = openEditorForMultiline(
      'Enter the task description for this job.\nThis becomes the policy "constitution" — be specific.\nLines starting with # are ignored.',
    );
    if (!task) {
      log.warn('Task description cannot be empty. Re-opening editor...');
    }
  }

  const notifyOnEscalation = await confirm({
    message: 'Notify on escalation via Signal?',
    initialValue: true,
  });
  if (isCancel(notifyOnEscalation)) {
    cancel('Cancelled.');
    process.exit(0);
  }

  const notifyOnCompletion = await confirm({
    message: 'Notify on completion via Signal?',
    initialValue: true,
  });
  if (isCancel(notifyOnCompletion)) {
    cancel('Cancelled.');
    process.exit(0);
  }

  let job: JobDefinition = {
    id: jobId,
    name,
    schedule,
    task,
    gitRepo,
    notifyOnEscalation,
    notifyOnCompletion,
    enabled: true,
  };

  // Review-and-edit loop — user can change any field before confirming
  for (;;) {
    const gitRepoDisplay = job.gitRepo ?? '(none)';
    const taskLines = job.task.split('\n');
    const taskPreview = [
      ...taskLines.slice(0, 4).map((l) => `  ${l}`),
      ...(taskLines.length > 4 ? [`  … (${taskLines.length - 4} more lines)`] : []),
    ].join('\n');
    const notifyParts = [job.notifyOnEscalation ? 'escalation' : '', job.notifyOnCompletion ? 'completion' : ''].filter(
      Boolean,
    );
    const notifyStr = notifyParts.length ? notifyParts.join(', ') : 'none';

    note(
      [
        `ID:        ${job.id}`,
        `Name:      ${job.name}`,
        `Schedule:  ${job.schedule}`,
        `Git repo:  ${gitRepoDisplay}`,
        `Notify:    ${notifyStr}`,
        ``,
        `Task:`,
        taskPreview,
      ].join('\n'),
      'Review',
    );

    const action = await select({
      message: 'Confirm or edit a field',
      options: [
        { value: 'confirm', label: 'Confirm — create this job' },
        { value: 'id', label: `Edit ID          ${job.id}` },
        { value: 'name', label: `Edit name        ${job.name}` },
        { value: 'schedule', label: `Edit schedule    ${job.schedule}` },
        { value: 'gitRepo', label: `Edit git repo    ${gitRepoDisplay}` },
        { value: 'task', label: 'Edit task description' },
        { value: 'notify', label: `Edit notify      ${notifyStr}` },
      ],
    });
    if (isCancel(action)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    if (action === 'confirm') break;

    switch (action) {
      case 'id': {
        const inp = await text({
          message: 'Job ID (slug)',
          initialValue: job.id,
          validate: (value) => {
            if (!value) return 'Required';
            try {
              createJobId(value);
              return undefined;
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          },
        });
        if (isCancel(inp)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        const newId = createJobId(inp);
        if (newId !== job.id && loadJob(newId)) {
          log.error(`Job "${newId}" already exists.`);
        } else {
          job = { ...job, id: newId };
        }
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
          validate: (value) => {
            if (!value) return 'Required';
            try {
              parseCronExpression(value);
              return undefined;
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
        });
        if (isCancel(inp)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        job = { ...job, gitRepo: inp || undefined };
        break;
      }
      case 'task': {
        log.step('Re-opening task editor...');
        const newTask = openEditorForMultiline(
          'Enter the task description for this job.\nThis becomes the policy "constitution" — be specific.\nLines starting with # are ignored.',
        );
        if (newTask) {
          job = { ...job, task: newTask };
        } else {
          log.warn('Editor was empty — keeping existing task.');
        }
        break;
      }
      case 'notify': {
        const newEscalation = await confirm({
          message: 'Notify on escalation via Signal?',
          initialValue: job.notifyOnEscalation,
        });
        if (isCancel(newEscalation)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        const newCompletion = await confirm({
          message: 'Notify on completion via Signal?',
          initialValue: job.notifyOnCompletion,
        });
        if (isCancel(newCompletion)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        job = { ...job, notifyOnEscalation: newEscalation, notifyOnCompletion: newCompletion };
        break;
      }
    }
  }

  // Ensure workspace exists (uses final job.id in case it was changed during review)
  const workspace = getJobWorkspaceDir(job.id);
  mkdirSync(workspace, { recursive: true });

  // Clone git repo if specified, with retry on failure
  if (job.gitRepo) {
    let currentUri = job.gitRepo;
    for (;;) {
      console.error('Cloning repository...');
      try {
        syncGitRepo(currentUri, workspace, /* verbose= */ true);
        job = { ...job, gitRepo: currentUri };
        break;
      } catch (err) {
        log.error(`Git clone failed: ${err instanceof Error ? err.message : String(err)}`);
        const retryInput = await text({
          message: 'Enter a corrected repository URI, or leave empty to skip cloning',
          placeholder: currentUri,
        });
        if (isCancel(retryInput) || !retryInput) {
          job = { ...job, gitRepo: undefined };
          break;
        }
        currentUri = retryInput;
      }
    }
  }

  // Compile per-job policy
  console.error('');
  console.error('Compiling task policy...');
  try {
    await compileTaskPolicy(job.task, getJobDir(job.id));
  } catch (err) {
    console.error(chalk.red(`Policy compilation failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  // Save job definition
  saveJob(job);

  // Show next run time
  const scheduler = createCronScheduler();
  scheduler.schedule(job, async () => {});
  const nextRun = scheduler.getNextRun(job.id);
  scheduler.unscheduleAll();

  outro(`Job "${job.id}" created. Next run: ${nextRun?.toLocaleString() ?? 'unknown'}`);
}

/** Lists all jobs with their schedules and last run status. */
export function runListJobs(): void {
  const jobs = loadAllJobs();

  if (jobs.length === 0) {
    console.error('No jobs configured. Use "ironcurtain daemon add-job" to create one.');
    return;
  }

  const scheduler = createCronScheduler();

  console.error('Jobs:');
  for (const job of jobs) {
    const statusLabel = job.enabled ? '' : chalk.yellow(' DISABLED');

    // Get next run time
    let nextRunStr = '';
    if (job.enabled) {
      try {
        scheduler.schedule(job, async () => {});
        const nextRun = scheduler.getNextRun(job.id);
        scheduler.unschedule(job.id);
        nextRunStr = nextRun ? `next: ${nextRun.toLocaleString()}` : '';
      } catch {
        nextRunStr = chalk.red('invalid schedule');
      }
    }

    // Get last run
    const lastRuns = loadRecentRuns(job.id, 1);
    const lastRun = lastRuns.length > 0 ? lastRuns[0] : undefined;
    let lastRunStr = '';
    if (lastRun) {
      lastRunStr = `Last run: ${lastRun.startedAt} -- ${formatRunOutcome(lastRun.outcome)}`;
      if (lastRun.summary) {
        lastRunStr += `\n${' '.repeat(20)}${lastRun.summary.split('\n')[0].slice(0, 60)}`;
      }
    }

    console.error(
      `  ${chalk.bold(job.id.padEnd(20))} ${job.name.padEnd(30)} ${job.schedule.padEnd(15)} ${nextRunStr}${statusLabel}`,
    );
    if (lastRunStr) {
      console.error(`  ${' '.repeat(20)}${lastRunStr}`);
    }
  }

  scheduler.unscheduleAll();
}

/** Manually triggers a job run. */
export async function runJobCommand(jobIdStr: string): Promise<void> {
  const jobId = createJobId(jobIdStr);
  const job = loadJob(jobId);
  if (!job) {
    console.error(`Job not found: ${jobIdStr}`);
    process.exit(1);
  }

  console.error(`Running job "${job.name}"...`);
  const { IronCurtainDaemon } = await import('../daemon/ironcurtain-daemon.js');
  const daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true });
  const record = await daemon.runJobNow(jobId);

  console.error(`  Outcome: ${formatRunOutcome(record.outcome)}`);
  console.error(`  Duration: ${record.budget.elapsedSeconds.toFixed(0)}s`);
  console.error(`  Cost: $${record.budget.estimatedCostUsd.toFixed(2)}`);
  if (record.summary) {
    console.error(`  Summary: ${record.summary.split('\n')[0].slice(0, 100)}`);
  }
}

/** Removes a job. */
export function runRemoveJob(jobIdStr: string): void {
  const jobId = createJobId(jobIdStr);
  const job = loadJob(jobId);
  if (!job) {
    console.error(`Job not found: ${jobIdStr}`);
    process.exit(1);
  }

  deleteJob(jobId);
  console.error(`Job "${jobIdStr}" removed.`);
}

/** Disables a job. */
export function runDisableJob(jobIdStr: string): void {
  const jobId = createJobId(jobIdStr);
  const job = loadJob(jobId);
  if (!job) {
    console.error(`Job not found: ${jobIdStr}`);
    process.exit(1);
  }

  saveJob({ ...job, enabled: false });
  console.error(`Job "${jobIdStr}" disabled.`);
}

/** Enables a job. */
export function runEnableJob(jobIdStr: string): void {
  const jobId = createJobId(jobIdStr);
  const job = loadJob(jobId);
  if (!job) {
    console.error(`Job not found: ${jobIdStr}`);
    process.exit(1);
  }

  saveJob({ ...job, enabled: true });
  console.error(`Job "${jobIdStr}" enabled.`);
}

/** Re-runs policy compilation for a job. */
export async function runRecompileJob(jobIdStr: string): Promise<void> {
  const jobId = createJobId(jobIdStr);
  const job = loadJob(jobId);
  if (!job) {
    console.error(`Job not found: ${jobIdStr}`);
    process.exit(1);
  }

  console.error(`Recompiling policy for job "${jobIdStr}"...`);
  await compileTaskPolicy(job.task, getJobDir(jobId));
  console.error('Done.');
}

/** Shows recent run logs for a job. */
export function runShowLogs(jobIdStr: string, limit: number): void {
  const jobId = createJobId(jobIdStr);
  const job = loadJob(jobId);
  if (!job) {
    console.error(`Job not found: ${jobIdStr}`);
    process.exit(1);
  }

  const runs = loadRecentRuns(jobId, limit);
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
