/**
 * IronCurtainDaemon -- Unified daemon managing both Signal-initiated
 * interactive sessions and cron-scheduled headless sessions.
 *
 * Lifecycle:
 *   1. start() -- loads jobs, starts Signal (if configured), schedules jobs
 *   2. Runs indefinitely, processing Signal messages and cron triggers
 *   3. shutdown() -- unschedules all jobs, ends all sessions, disconnects
 *
 * Both Signal and cron sessions are managed through a shared SessionManager
 * instance. This enables unified escalation routing: `approve #N` from
 * Signal works for both Signal-initiated and cron-initiated sessions.
 */

import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { syncGitRepo } from '../cron/git-sync.js';
import { resolve } from 'node:path';
import { createSession } from '../session/index.js';
import { loadConfig } from '../config/index.js';
import { loadUserConfig, type ResolvedUserConfig } from '../config/user-config.js';
import { getJobWorkspaceDir, getJobGeneratedDir, getJobDir } from '../config/paths.js';
import type { IronCurtainConfig } from '../config/types.js';
import type { SessionMode, EscalationRequest } from '../session/types.js';
import { SessionManager, type SessionSource } from '../session/session-manager.js';
import { HeadlessTransport } from '../cron/headless-transport.js';
import { buildCronSystemPromptAugmentation } from '../session/prompts.js';
import { createCronScheduler, type CronScheduler } from '../cron/cron-scheduler.js';
import { loadAllJobs, loadJob, saveJob, deleteJob, saveRunRecord, loadRecentRuns } from '../cron/job-store.js';
import { compileTaskPolicy } from '../cron/compile-task-policy.js';
import type { JobDefinition, JobId, RunRecord, RunOutcome } from '../cron/types.js';
import { CRON_BUDGET_DEFAULTS } from '../cron/types.js';
import { BudgetExhaustedError } from '../session/errors.js';
import { validateWorkspacePath } from '../session/workspace-validation.js';
import * as logger from '../logger.js';
import { ControlSocketServer, type ControlRequestHandler } from './control-socket.js';

export type { SessionSource, ManagedSession } from '../session/session-manager.js';

export interface IronCurtainDaemonOptions {
  /** Session mode for both Signal and cron sessions. */
  readonly mode: SessionMode;

  /** When true, skip starting Signal transport. */
  readonly noSignal?: boolean;
}

/**
 * Builds an IronCurtainConfig patched for cron session budget defaults.
 */
function buildCronSessionConfig(globalConfig: IronCurtainConfig, job: JobDefinition): IronCurtainConfig {
  const cronBudget = {
    ...CRON_BUDGET_DEFAULTS,
    ...(job.budgetOverrides ?? {}),
  };

  const patchedUserConfig: ResolvedUserConfig = {
    ...globalConfig.userConfig,
    resourceBudget: {
      ...globalConfig.userConfig.resourceBudget,
      ...cronBudget,
    },
  };

  return {
    ...globalConfig,
    userConfig: patchedUserConfig,
  };
}

export class IronCurtainDaemon {
  private readonly mode: SessionMode;
  private readonly noSignal: boolean;
  private readonly sessionManager = new SessionManager();
  private readonly scheduler: CronScheduler;

  /** Tracks which jobs are currently running (jobId -> session label). */
  private readonly activeJobRuns = new Map<string, number>();

  /** Control socket server for CLI communication. */
  private controlSocket: ControlSocketServer | null = null;

  /** Signal daemon instance (null if Signal not configured). */
  private signalDaemon: import('../signal/signal-bot-daemon.js').SignalBotDaemon | null = null;

  /** Send a message via Signal (no-op if Signal not available). */
  private sendSignalMessage: ((message: string) => Promise<void>) | null = null;

  /** Resolve to exit the daemon. */
  private exitResolve: (() => void) | null = null;

  constructor(options: IronCurtainDaemonOptions) {
    this.mode = options.mode;
    this.noSignal = options.noSignal ?? false;
    this.scheduler = createCronScheduler();
  }

  /**
   * Starts the daemon. Loads all enabled jobs, schedules them,
   * optionally starts the Signal transport.
   */
  async start(): Promise<void> {
    // Start control socket for CLI communication
    await this.startControlSocket();

    // Load and schedule all enabled jobs
    const jobs = loadAllJobs();
    const enabledJobs = jobs.filter((j) => j.enabled);
    logger.info(`[Daemon] Loaded ${jobs.length} job(s), ${enabledJobs.length} enabled`);

    for (const job of enabledJobs) {
      try {
        this.scheduler.schedule(job, (j) => this.onJobTrigger(j));
        const nextRun = this.scheduler.getNextRun(job.id);
        logger.info(`[Daemon] Scheduled job ${job.id}: ${job.schedule} (next: ${nextRun?.toISOString() ?? 'unknown'})`);
      } catch (err: unknown) {
        logger.warn(`[Daemon] Failed to schedule job ${job.id}: ${String(err)}`);
      }
    }

    // Start Signal daemon if configured and not disabled
    if (!this.noSignal) {
      try {
        await this.startSignalDaemon();
      } catch (err) {
        logger.warn(`[Daemon] Signal transport not available: ${err instanceof Error ? err.message : String(err)}`);
        logger.info('[Daemon] Continuing in cron-only mode');
      }
    }

    console.error('IronCurtain daemon started.');
    if (this.controlSocket) {
      console.error('  Control socket: listening');
    }
    if (enabledJobs.length > 0) {
      console.error(`  Scheduled jobs: ${enabledJobs.length}`);
    }
    if (this.signalDaemon) {
      console.error('  Signal transport: connected');
    }

    // Block until shutdown
    await new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  /** Graceful shutdown. */
  async shutdown(): Promise<void> {
    logger.info('[Daemon] Shutting down...');

    // Stop control socket first (reject new CLI commands)
    if (this.controlSocket) {
      try {
        await this.controlSocket.stop();
      } catch (err: unknown) {
        logger.warn(`[Daemon] Error stopping control socket: ${String(err)}`);
      }
      this.controlSocket = null;
    }

    // Unschedule all jobs
    this.scheduler.unscheduleAll();

    // Shutdown Signal daemon first (ends Signal sessions via shared SessionManager)
    if (this.signalDaemon) {
      try {
        await this.signalDaemon.shutdown();
      } catch (err: unknown) {
        logger.warn(`[Daemon] Error shutting down Signal: ${String(err)}`);
      }
    }

    // End remaining sessions (cron sessions and any Signal stragglers)
    const remaining = this.sessionManager.all();
    await Promise.allSettled(
      remaining.map(async (s) => {
        try {
          await this.sessionManager.end(s.label);
        } catch (err: unknown) {
          logger.warn(`[Daemon] Error ending session #${s.label}: ${String(err)}`);
        }
      }),
    );

    this.exitResolve?.();
  }

  // -----------------------------------------------------------------------
  // Job management (called by CLI subcommands)
  // -----------------------------------------------------------------------

  /**
   * Adds a new job. Runs the full policy compilation pipeline
   * before confirming. Schedules the job if enabled.
   */
  async addJob(job: JobDefinition): Promise<void> {
    // Validate custom workspace before proceeding
    if (job.workspace) {
      const globalConfig = loadConfig();
      validateWorkspacePath(job.workspace, globalConfig.protectedPaths);
    }

    // Ensure workspace exists
    const workspace = job.workspace ?? getJobWorkspaceDir(job.id);
    mkdirSync(workspace, { recursive: true });

    // Clone git repo if specified
    if (job.gitRepo) {
      logger.info(`[Daemon] Cloning repo for job ${job.id}...`);
      syncGitRepo(job.gitRepo, workspace);
      logger.info(`[Daemon] Repo cloned for job ${job.id}`);
    }

    // Compile per-job policy
    logger.info(`[Daemon] Compiling task policy for job ${job.id}...`);
    await compileTaskPolicy(job.taskConstitution, getJobDir(job.id));

    // Save job definition
    await saveJob(job);

    // Schedule if enabled
    if (job.enabled) {
      this.scheduler.schedule(job, (j) => this.onJobTrigger(j));
      const nextRun = this.scheduler.getNextRun(job.id);
      logger.info(`[Daemon] Job ${job.id} scheduled. Next run: ${nextRun?.toISOString() ?? 'unknown'}`);
    }
  }

  /** Removes a job. Stops any active run, unschedules, deletes files. */
  async removeJob(jobId: JobId): Promise<void> {
    // Stop active run if any
    const activeLabel = this.activeJobRuns.get(jobId);
    if (activeLabel !== undefined) {
      await this.sessionManager.end(activeLabel);
      this.activeJobRuns.delete(jobId);
    }

    this.scheduler.unschedule(jobId);
    deleteJob(jobId);
    logger.info(`[Daemon] Removed job ${jobId}`);
  }

  /** Enables a previously disabled job. Schedules it. */
  async enableJob(jobId: JobId): Promise<void> {
    const job = loadJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const updated = { ...job, enabled: true };
    await saveJob(updated);
    this.scheduler.schedule(updated, (j) => this.onJobTrigger(j));
    logger.info(`[Daemon] Enabled job ${jobId}`);
  }

  /** Disables a job. Unschedules it but preserves files. */
  async disableJob(jobId: JobId): Promise<void> {
    const job = loadJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const updated = { ...job, enabled: false };
    await saveJob(updated);
    this.scheduler.unschedule(jobId);
    logger.info(`[Daemon] Disabled job ${jobId}`);
  }

  /** Re-runs policy compilation for an existing job. */
  async recompileJob(jobId: JobId): Promise<void> {
    const job = loadJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    await compileTaskPolicy(job.taskConstitution, getJobDir(jobId));
    logger.info(`[Daemon] Recompiled policy for job ${jobId}`);
  }

  /**
   * Manually triggers a job run (for testing).
   * Does not affect the cron schedule.
   */
  async runJobNow(jobId: JobId): Promise<RunRecord> {
    const job = loadJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    return this.executeJob(job);
  }

  /** Lists all jobs with their schedules and last run status. */
  listJobs(): Array<{
    job: JobDefinition;
    nextRun: Date | undefined;
    lastRun: RunRecord | undefined;
    isRunning: boolean;
  }> {
    const jobs = loadAllJobs();
    return jobs.map((job) => ({
      job,
      nextRun: this.scheduler.getNextRun(job.id),
      lastRun: loadRecentRuns(job.id, 1)[0],
      isRunning: this.activeJobRuns.has(job.id),
    }));
  }

  // -----------------------------------------------------------------------
  // Job execution
  // -----------------------------------------------------------------------

  /**
   * Called when a scheduled job fires.
   * Checks for overlap, creates a session, and runs the job.
   */
  private async onJobTrigger(job: JobDefinition): Promise<void> {
    // Check overlap
    if (this.activeJobRuns.has(job.id)) {
      const msg = `[Daemon] Skipping job ${job.id}: previous run still active (session #${this.activeJobRuns.get(job.id)})`;
      logger.warn(msg);
      if (this.sendSignalMessage) {
        this.sendSignalMessage(`Skipped job "${job.name}": previous run still in progress.`).catch(() => {});
      }
      return;
    }

    try {
      await this.executeJob(job);
    } catch (err: unknown) {
      logger.warn(`[Daemon] Job ${job.id} failed: ${String(err)}`);
    }
  }

  /**
   * Executes a job: creates a session with the job's workspace and
   * per-job policy, runs it to completion, and records the outcome.
   */
  private async executeJob(job: JobDefinition): Promise<RunRecord> {
    const startedAt = new Date().toISOString();
    const workspace = job.workspace ?? getJobWorkspaceDir(job.id);
    const globalConfig = loadConfig();

    // Validate custom workspace paths against sandbox containment rules.
    // Default job workspace dirs are safe (under ~/.ironcurtain/jobs/), but
    // user-provided workspace fields in job.json could be arbitrary paths.
    if (job.workspace) {
      try {
        validateWorkspacePath(job.workspace, globalConfig.protectedPaths);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[Daemon] Job ${job.id} has invalid workspace: ${message}`);
        const record: RunRecord = {
          startedAt,
          completedAt: new Date().toISOString(),
          outcome: { kind: 'error', message: `Invalid workspace: ${message}` },
          budget: { totalTokens: 0, stepCount: 0, elapsedSeconds: 0, estimatedCostUsd: 0 },
          summary: null,
          escalationsEncountered: 0,
          escalationsApproved: 0,
          discardedChanges: null,
        };
        saveRunRecord(job.id, record);
        return record;
      }
    }

    // Sync git repo if configured
    let discardedChanges: string | null = null;
    if (job.gitRepo) {
      logger.info(`[Daemon] Syncing repo for job ${job.id}...`);
      discardedChanges = syncGitRepo(job.gitRepo, workspace);
      if (discardedChanges) {
        logger.info(`[Daemon] Discarded local changes in job ${job.id}:\n${discardedChanges}`);
      }
      logger.info(`[Daemon] Repo synced for job ${job.id}`);
    }
    const patchedConfig = buildCronSessionConfig(globalConfig, job);
    const jobGeneratedDir = getJobGeneratedDir(job.id);

    // Build system prompt augmentation
    const augmentation = buildCronSystemPromptAugmentation({
      taskDescription: job.taskDescription,
      workspacePath: workspace,
    });

    // Create the headless transport
    const transport = new HeadlessTransport({ taskMessage: job.taskDescription });

    // Track escalation counts for this run
    let escalationsEncountered = 0;
    let escalationsApproved = 0;

    // Create the session with per-job policy and escalation handler.
    // Auto-approver is disabled: cron sessions have no interactive user
    // context, so intent-matching against a user message is meaningless.
    const session = await createSession({
      mode: this.mode,
      config: patchedConfig,
      workspacePath: workspace,
      policyDir: jobGeneratedDir,
      systemPromptAugmentation: augmentation,
      disableAutoApprove: true,
      onEscalation: (request) => {
        escalationsEncountered++;
        this.handleCronEscalation(request, job);
      },
      onEscalationResolved: (_id, decision) => {
        if (decision === 'approved') escalationsApproved++;
        const label = this.activeJobRuns.get(job.id);
        if (label !== undefined) {
          this.sessionManager.clearPendingEscalation(label);
        }
      },
      onEscalationExpired: () => {
        const label = this.activeJobRuns.get(job.id);
        if (label !== undefined) {
          this.sessionManager.clearPendingEscalation(label);
        }
      },
    });

    // Register in session manager
    const source: SessionSource = { kind: 'cron', jobId: job.id, jobName: job.name };
    const label = this.sessionManager.register(session, transport, source);
    this.activeJobRuns.set(job.id, label);

    logger.info(`[Daemon] Started job ${job.id} as session #${label}`);

    let outcome: RunOutcome;
    try {
      await transport.run(session);
      outcome = { kind: 'success' };
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        outcome = { kind: 'budget_exhausted', dimension: err.dimension };
      } else {
        outcome = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
      }
    }

    // Build run record
    const completedAt = new Date().toISOString();
    const budgetStatus = session.getBudgetStatus();
    const summary = this.readLastRunSummary(workspace);

    const record: RunRecord = {
      startedAt,
      completedAt,
      outcome,
      budget: {
        totalTokens: budgetStatus.totalTokens,
        stepCount: budgetStatus.stepCount,
        elapsedSeconds: budgetStatus.elapsedSeconds,
        estimatedCostUsd: budgetStatus.estimatedCostUsd,
      },
      summary,
      escalationsEncountered,
      escalationsApproved,
      discardedChanges,
    };

    // Save run record
    saveRunRecord(job.id, record);

    // Notify via Signal if configured
    if (job.notifyOnCompletion && this.sendSignalMessage) {
      const outcomeStr =
        outcome.kind === 'success'
          ? 'Completed'
          : outcome.kind === 'budget_exhausted'
            ? `Budget exhausted: ${outcome.dimension}`
            : `Error: ${outcome.message}`;

      const notify = `[cron: ${job.name}] ${outcomeStr} (${budgetStatus.elapsedSeconds.toFixed(0)}s, $${budgetStatus.estimatedCostUsd.toFixed(2)})`;
      const notifyMsg = summary ? `${notify}\n${summary.slice(0, 500)}` : notify;
      this.sendSignalMessage(notifyMsg).catch(() => {});
    }

    // Cleanup
    this.activeJobRuns.delete(job.id);
    await this.sessionManager.end(label);

    logger.info(`[Daemon] Job ${job.id} completed: ${outcome.kind}`);
    return record;
  }

  // -----------------------------------------------------------------------
  // Escalation handling for cron sessions
  // -----------------------------------------------------------------------

  private handleCronEscalation(request: EscalationRequest, job: JobDefinition): void {
    const label = this.activeJobRuns.get(job.id);
    if (label === undefined) return;

    this.sessionManager.setPendingEscalation(label, request.escalationId);

    if (job.notifyOnEscalation && this.sendSignalMessage) {
      const banner = [
        `[#${label} cron: ${job.name}] Escalation: ${request.serverName}/${request.toolName}`,
        `Reason: "${request.reason}"`,
        `Reply: approve #${label} / deny #${label}`,
      ].join('\n');
      this.sendSignalMessage(banner).catch(() => {});
    } else {
      // Auto-deny when Signal is not configured
      const managed = this.sessionManager.get(label);
      managed?.session.resolveEscalation(request.escalationId, 'denied').catch(() => {});
    }
  }

  // -----------------------------------------------------------------------
  // Signal integration
  // -----------------------------------------------------------------------

  private async startSignalDaemon(): Promise<void> {
    const { resolveSignalConfig } = await import('../signal/signal-config.js');
    const { SignalBotDaemon } = await import('../signal/signal-bot-daemon.js');
    const { createSignalContainerManager } = await import('../signal/signal-container.js');
    const { createDockerManager } = await import('../docker/docker-manager.js');

    const userConfig = loadUserConfig();
    const signalConfig = resolveSignalConfig(userConfig);

    if (!signalConfig) {
      throw new Error('Signal is not configured. Run: ironcurtain setup-signal');
    }

    const docker = createDockerManager();
    const containerManager = createSignalContainerManager(docker, signalConfig.container);

    const signalDaemon = new SignalBotDaemon({
      config: signalConfig,
      containerManager,
      mode: this.mode,
      sessionManager: this.sessionManager,
    });
    this.signalDaemon = signalDaemon;

    // Capture the sendSignalMessage method for cron notifications
    this.sendSignalMessage = (msg: string) => signalDaemon.sendSignalMessage(msg);

    // Start Signal daemon in the background (it blocks until shutdown)
    this.signalDaemon.start().catch((err: unknown) => {
      logger.warn(`[Daemon] Signal daemon exited: ${String(err)}`);
    });
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async startControlSocket(): Promise<void> {
    const handler: ControlRequestHandler = {
      addJob: (job) => this.addJob(job),
      removeJob: (jobId) => this.removeJob(jobId as JobId),
      enableJob: (jobId) => this.enableJob(jobId as JobId),
      disableJob: (jobId) => this.disableJob(jobId as JobId),
      recompileJob: (jobId) => this.recompileJob(jobId as JobId),
      runJobNow: (jobId) => this.runJobNow(jobId as JobId),
      listJobs: () => this.listJobs(),
    };

    this.controlSocket = new ControlSocketServer(handler);
    try {
      await this.controlSocket.start();
    } catch (err: unknown) {
      logger.warn(`[Daemon] Failed to start control socket: ${err instanceof Error ? err.message : String(err)}`);
      this.controlSocket = null;
    }
  }

  private readLastRunSummary(workspace: string): string | null {
    const summaryPath = resolve(workspace, 'last-run.md');
    if (!existsSync(summaryPath)) return null;

    try {
      const content = readFileSync(summaryPath, 'utf-8');
      return content.length > 2000 ? content.slice(0, 2000) + '...' : content;
    } catch {
      return null;
    }
  }
}
