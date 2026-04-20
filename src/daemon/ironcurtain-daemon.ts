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

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { syncGitRepo } from '../cron/git-sync.js';
import { resolve } from 'node:path';
import { createSession } from '../session/index.js';
import { loadConfig } from '../config/index.js';
import { loadUserConfig, type ResolvedUserConfig } from '../config/user-config.js';
import { getJobWorkspaceDir, getJobGeneratedDir, getJobDir, getWebUiStatePath } from '../config/paths.js';
import type { IronCurtainConfig } from '../config/types.js';
import type { SessionMode, EscalationRequest } from '../session/types.js';
import { SessionManager, type SessionSource } from '../session/session-manager.js';
import { HeadlessTransport } from '../cron/headless-transport.js';
import { shouldAutoSaveMemory } from '../memory/auto-save.js';
import { buildCronSystemPromptAugmentation } from '../session/prompts.js';
import { createCronScheduler, type CronScheduler } from '../cron/cron-scheduler.js';
import { loadAllJobs, loadJob, saveJob, deleteJob, saveRunRecord, loadRecentRuns } from '../cron/job-store.js';
import { compileTaskPolicy } from '../cron/compile-task-policy.js';
import type { JobDefinition, JobId, RunRecord, RunOutcome } from '../cron/types.js';
import { CRON_BUDGET_DEFAULTS } from '../cron/types.js';
import { BudgetExhaustedError } from '../session/errors.js';
import { validateWorkspacePath } from '../session/workspace-validation.js';
import * as logger from '../logger.js';
import { getDaemonLogPath } from '../config/paths.js';
import { getTokenStreamBus } from '../docker/token-stream-bus.js';
import { ControlSocketServer, type ControlRequestHandler, type DaemonStatus } from './control-socket.js';

export type { SessionSource, ManagedSession } from '../session/session-manager.js';

export interface IronCurtainDaemonOptions {
  /** Session mode for both Signal and cron sessions. */
  readonly mode: SessionMode;

  /** When true, skip starting Signal transport. */
  readonly noSignal?: boolean;

  /** When set, starts the web UI server. */
  readonly webUi?: { port?: number; host?: string; devMode?: boolean };
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

  /** Time the daemon was started (for uptime calculation). */
  private startTime: Date | null = null;

  /** Tracks which jobs are currently running (jobId -> session label). */
  private readonly activeJobRuns = new Map<string, number>();

  /** Control socket server for CLI communication. */
  private controlSocket: ControlSocketServer | null = null;

  /** Signal daemon instance (null if Signal not configured). */
  private signalDaemon: import('../signal/signal-bot-daemon.js').SignalBotDaemon | null = null;

  /** Web UI server (null if not enabled). */
  private webUiServer: import('../web-ui/web-ui-server.js').WebUiServer | null = null;

  /** Token stream bridge (null if web UI not enabled). */
  private tokenStreamBridge: import('../web-ui/token-stream-bridge.js').TokenStreamBridge | null = null;

  /** Web UI options from constructor. */
  private readonly webUiOptions: IronCurtainDaemonOptions['webUi'];

  /** Control request handler (saved for web UI reuse). */
  private controlRequestHandler: ControlRequestHandler | null = null;

  /** Resolve to exit the daemon. */
  private exitResolve: (() => void) | null = null;

  constructor(options: IronCurtainDaemonOptions) {
    this.mode = options.mode;
    this.noSignal = options.noSignal ?? false;
    this.webUiOptions = options.webUi;
    this.scheduler = createCronScheduler();
  }

  /**
   * Starts the daemon. Loads all enabled jobs, schedules them,
   * optionally starts the Signal transport.
   */
  async start(): Promise<void> {
    this.startTime = new Date();

    // Set up file-based logger (redirects console.* to log file)
    logger.setup({ logFilePath: getDaemonLogPath('daemon') });

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

    // Start web UI server if enabled
    if (this.webUiOptions) {
      try {
        await this.startWebUiServer();
      } catch (err) {
        logger.warn(`[Daemon] Web UI not available: ${err instanceof Error ? err.message : String(err)}`);
        logger.info('[Daemon] Continuing without web UI');
      }
    }

    process.stderr.write('IronCurtain daemon started.\n');
    if (this.controlSocket) {
      process.stderr.write('  Control socket: listening\n');
    }
    if (enabledJobs.length > 0) {
      process.stderr.write(`  Scheduled jobs: ${enabledJobs.length}\n`);
    }
    if (this.signalDaemon) {
      process.stderr.write('  Signal transport: connected\n');
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

    // Stop web UI server (ends web sessions)
    if (this.webUiServer) {
      try {
        await this.webUiServer.stop();
      } catch (err: unknown) {
        logger.warn(`[Daemon] Error stopping web UI: ${String(err)}`);
      }
      this.webUiServer = null;
      this.tokenStreamBridge = null;
      this.removeWebUiState();
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
        const sessionId = s.session.getInfo().id;
        try {
          await this.sessionManager.end(s.label);
        } catch (err: unknown) {
          logger.warn(`[Daemon] Error ending session #${s.label}: ${String(err)}`);
        }
        getTokenStreamBus().endSession(sessionId);
        this.tokenStreamBridge?.closeSession(s.label);
      }),
    );

    // Teardown logger last (restores console.* to original behavior)
    logger.teardown();

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
      const managed = this.sessionManager.get(activeLabel);
      const sessionId = managed?.session.getInfo().id;
      await this.sessionManager.end(activeLabel);
      if (sessionId) getTokenStreamBus().endSession(sessionId);
      this.tokenStreamBridge?.closeSession(activeLabel);
      this.activeJobRuns.delete(jobId);
      // The ended session tore down the logger; re-claim for daemon logs.
      logger.setup({ logFilePath: getDaemonLogPath('daemon') });
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

  /** Reloads a job definition from disk and reschedules it. */
  // eslint-disable-next-line @typescript-eslint/require-await -- must be async to satisfy ControlRequestHandler interface
  async reloadJob(jobId: JobId): Promise<void> {
    const job = loadJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    this.scheduler.unschedule(jobId);

    if (job.enabled) {
      this.scheduler.schedule(job, (j) => this.onJobTrigger(j));
      const nextRun = this.scheduler.getNextRun(jobId);
      logger.info(`[Daemon] Reloaded job ${jobId}: rescheduled (next: ${nextRun?.toISOString() ?? 'unknown'})`);
    } else {
      logger.info(`[Daemon] Reloaded job ${jobId}: disabled, not scheduled`);
    }
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

  /** Returns a status snapshot for the control socket. */
  getStatus(): DaemonStatus {
    const jobs = loadAllJobs();
    const enabledJobs = jobs.filter((j) => j.enabled);

    // Find the earliest next fire time across all scheduled jobs
    let nextFireTime: Date | null = null;
    for (const job of enabledJobs) {
      const nextRun = this.scheduler.getNextRun(job.id);
      if (nextRun && (nextFireTime === null || nextRun < nextFireTime)) {
        nextFireTime = nextRun;
      }
    }

    const uptimeSeconds = this.startTime ? (Date.now() - this.startTime.getTime()) / 1000 : 0;

    return {
      uptimeSeconds,
      jobs: {
        total: jobs.length,
        enabled: enabledJobs.length,
        running: this.activeJobRuns.size,
      },
      signalConnected: this.signalDaemon !== null,
      nextFireTime,
    };
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
      this.signalDaemon
        ?.sendSignalMessage(`Skipped job "${job.name}": previous run still in progress.`)
        .catch(() => {});
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
    const transport = new HeadlessTransport({
      taskMessage: job.taskDescription,
      autoSaveMemory: shouldAutoSaveMemory(patchedConfig),
      dockerMode: this.mode.kind === 'docker',
    });

    // Track escalation counts for this run
    let escalationsEncountered = 0;
    let escalationsApproved = 0;

    // Create the session with per-job policy and escalation handler.
    // Auto-approver is disabled: cron sessions have no interactive user
    // context, so intent-matching against a user message is meaningless.
    // When job.persona is set, use the persona's compiled policy instead
    // of the job-specific generated dir.
    const session = await createSession({
      mode: this.mode,
      config: patchedConfig,
      workspacePath: workspace,
      ...(job.persona ? { persona: job.persona } : { policyDir: jobGeneratedDir }),
      jobId: job.id,
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

    // Register with the token stream bridge so an active `observe --all`
    // subscription can route this session's events. The bridge may not
    // exist if the web UI is not enabled; registerSession is idempotent,
    // so re-registration from the web UI's event bus subscription is safe.
    this.tokenStreamBridge?.registerSession(label, session.getInfo().id);

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
    if (job.notifyOnCompletion && this.signalDaemon) {
      const outcomeStr =
        outcome.kind === 'success'
          ? 'Completed'
          : outcome.kind === 'budget_exhausted'
            ? `Budget exhausted: ${outcome.dimension}`
            : `Error: ${outcome.message}`;

      const notify = `[cron: ${job.name}] ${outcomeStr} (${budgetStatus.elapsedSeconds.toFixed(0)}s, $${budgetStatus.estimatedCostUsd.toFixed(2)})`;
      const notifyMsg = summary ? `${notify}\n${summary.slice(0, 500)}` : notify;
      this.signalDaemon.sendSignalMessage(notifyMsg).catch(() => {});
    }

    // Cleanup
    this.activeJobRuns.delete(job.id);
    const sessionId = session.getInfo().id;
    await this.sessionManager.end(label);
    getTokenStreamBus().endSession(sessionId);
    this.tokenStreamBridge?.closeSession(label);

    // Session.close() tears down the logger singleton (the session
    // claimed it for the job's duration). Re-claim it for the daemon
    // so subsequent daemon logs still reach the daemon log file.
    logger.setup({ logFilePath: getDaemonLogPath('daemon') });

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

    if (job.notifyOnEscalation && this.signalDaemon) {
      const banner = [
        `[#${label} cron: ${job.name}] Escalation: ${request.serverName}/${request.toolName}`,
        `Reason: "${request.reason}"`,
        `Reply: approve #${label} / deny #${label}`,
      ].join('\n');
      this.signalDaemon.sendSignalMessage(banner).catch(() => {});
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

    process.stderr.write('Starting Signal transport...\n');
    const docker = createDockerManager();
    const containerManager = createSignalContainerManager(docker, signalConfig.container);

    const signalDaemon = new SignalBotDaemon({
      config: signalConfig,
      containerManager,
      mode: this.mode,
      sessionManager: this.sessionManager,
      // Wire Signal-created sessions into the token stream bridge so that
      // an active `observe --all` subscription receives their events.
      // The bridge may not exist (web UI disabled) -- calls are null-safe.
      onSessionRegistered: (label, managed) => {
        this.tokenStreamBridge?.registerSession(label, managed.session.getInfo().id);
      },
      onSessionEnded: (label) => {
        this.tokenStreamBridge?.closeSession(label);
      },
    });

    // Await the connection phase (starts Docker, health check, WebSocket).
    // Throws if the container won't start or health check times out.
    await signalDaemon.connect();

    this.signalDaemon = signalDaemon;

    // Run the blocking event loop in the background (blocks until shutdown)
    signalDaemon.run().catch((err: unknown) => {
      logger.warn(`[Daemon] Signal daemon exited: ${String(err)}`);
      this.signalDaemon = null;
    });
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async startControlSocket(): Promise<void> {
    const handler: ControlRequestHandler = {
      getStatus: () => this.getStatus(),
      addJob: (job) => this.addJob(job),
      removeJob: (jobId) => this.removeJob(jobId as JobId),
      enableJob: (jobId) => this.enableJob(jobId as JobId),
      disableJob: (jobId) => this.disableJob(jobId as JobId),
      recompileJob: (jobId) => this.recompileJob(jobId as JobId),
      reloadJob: (jobId) => this.reloadJob(jobId as JobId),
      runJobNow: (jobId) => this.runJobNow(jobId as JobId),
      listJobs: () => this.listJobs(),
    };

    this.controlRequestHandler = handler;
    this.controlSocket = new ControlSocketServer(handler);
    try {
      await this.controlSocket.start();
    } catch (err: unknown) {
      logger.warn(`[Daemon] Failed to start control socket: ${err instanceof Error ? err.message : String(err)}`);
      this.controlSocket = null;
    }
  }

  private async startWebUiServer(): Promise<void> {
    const { WebUiServer } = await import('../web-ui/web-ui-server.js');
    const { WorkflowManager } = await import('../web-ui/workflow-manager.js');
    const { TokenStreamBridge } = await import('../web-ui/token-stream-bridge.js');

    if (!this.controlRequestHandler) {
      throw new Error('Control socket must be started before web UI');
    }

    // Create server first, then create WorkflowManager using the server's event bus
    const server = new WebUiServer({
      port: this.webUiOptions?.port ?? 7400,
      host: this.webUiOptions?.host ?? '127.0.0.1',
      handler: this.controlRequestHandler,
      sessionManager: this.sessionManager,
      mode: this.mode,
      maxConcurrentWebSessions: 5,
      devMode: this.webUiOptions?.devMode,
    });
    server.setWorkflowManager(new WorkflowManager({ eventBus: server.getEventBus() }));

    // Wire token stream bridge for per-client subscription delivery.
    // The bridge fetches `getTokenStreamBus()` internally at subscription
    // time, so no bus reference is threaded through here.
    const bridge = new TokenStreamBridge(server);
    server.setTokenStreamBridge(bridge);
    this.tokenStreamBridge = bridge;

    // Belt-and-suspenders: the web UI also emits session.created / session.ended
    // events. registerSession is idempotent (Map.set overwrite), so repeat
    // registrations from this bus event and the direct executeJob()/Signal
    // paths are safe. Cron/Signal sessions are registered directly at their
    // creation sites because they do not go through the web UI event bus.
    server.getEventBus().subscribe((event, payload) => {
      if (event === 'session.created') {
        const { label } = payload as { label: number };
        const managed = this.sessionManager.get(label);
        if (managed) {
          bridge.registerSession(label, managed.session.getInfo().id);
        }
      } else if (event === 'session.ended') {
        bridge.closeSession((payload as { label: number }).label);
      }
    });

    const url = await server.start();
    this.webUiServer = server;
    process.stderr.write(`  Web UI: ${url}\n`);
    if (this.webUiOptions?.devMode) {
      const token = url.split('token=')[1];
      process.stderr.write(`  Web UI (dev): http://localhost:5173?token=${token}\n`);
    }

    // Persist connection info so CLI commands (e.g., `observe`) can connect
    this.writeWebUiState(server);
  }

  /**
   * Normalize a bind host into a host a CLI client can actually connect to.
   *
   * The daemon may bind to a wildcard address (0.0.0.0 or ::) to accept
   * connections on all interfaces, but wildcards are not valid *destination*
   * hosts, so persisting them verbatim would break `ironcurtain observe`.
   * The server's bind host is unchanged; only the persisted connect host is
   * normalized.
   */
  private getWebUiConnectHost(host: string | undefined): string {
    if (!host || host.trim() === '') return '127.0.0.1';
    const normalized = host.trim();
    if (normalized === '0.0.0.0') return '127.0.0.1';
    if (normalized === '::' || normalized === '[::]' || normalized === '::0') return 'localhost';
    return normalized;
  }

  /** Write web UI connection info to a well-known file for CLI consumers. */
  private writeWebUiState(server: import('../web-ui/web-ui-server.js').WebUiServer): void {
    const state = {
      port: server.getPort(),
      host: this.getWebUiConnectHost(this.webUiOptions?.host),
      token: server.getAuthToken(),
    };
    try {
      writeFileSync(getWebUiStatePath(), JSON.stringify(state) + '\n', { mode: 0o600 });
    } catch (err) {
      logger.warn(`[Daemon] Could not write web UI state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Remove the web UI state file (called on shutdown). */
  private removeWebUiState(): void {
    try {
      unlinkSync(getWebUiStatePath());
    } catch {
      // File may not exist -- that's fine
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
