# Design: Cron Mode

**Status:** Draft
**Date:** 2026-03-04
**Author:** IronCurtain Engineering

## 1. Problem Statement

IronCurtain currently supports two interaction patterns: single-shot tasks (`ironcurtain start "task"`) and interactive sessions (CLI or Signal bot). Both require a human to initiate the work. Many valuable use cases -- GitHub issue triage, daily code health checks, scheduled backups, inbox summaries -- are inherently periodic and should run unattended on a schedule.

Adding cron capability requires solving several interrelated problems:

1. **Scheduling infrastructure.** A long-running process that fires agent sessions at cron-scheduled times.
2. **Headless escalation.** The policy engine may escalate tool calls that require human approval, but there is no interactive human present. The default must be safe (auto-deny), with an optional path to notify and wait for approval via Signal.
3. **Per-job policy scoping.** A job that triages GitHub issues should be able to list issues and add labels, but must not push code or delete files. The global constitution is too broad -- each job needs a task-scoped whitelist compiled from its English description.
4. **Cross-run persistence.** Scheduled jobs run repeatedly. The agent needs a stable workspace to maintain state across runs (what it did last time, what changed since then).
5. **Daemon unification.** The existing `ironcurtain bot` command already runs a long-lived daemon for Signal. Running a second daemon for cron doubles operational complexity. A unified daemon should handle both.

### Motivating example: GitHub Issue Triage

**Task description:** "Triage open GitHub issues on the ironcurtain repo: label each issue by type (bug/feature/question/docs), add a comment on issues that haven't been updated in 14+ days asking for status, and close issues with no response for 30+ days. Write a brief summary of what you did."

**Expected per-job policy behavior:**
- Allow: `github.list_issues`, `github.get_issue`, `github.add_label`, `github.create_comment`, `github.update_issue`
- Escalate: `github.close_issue` (consequential -- even though the task authorizes it for stated conditions, the per-job compiler should recognize "close issues" as an explicit allowance and generate an `allow` rule for `close_issue` when the task description specifically authorizes it)
- Deny (default fallthrough): everything else -- `filesystem.write_file` outside workspace, `github.create_pull_request`, `exec.*`, etc.

**Expected run lifecycle:**
1. Cron fires at 09:00 daily
2. Daemon creates a session with the job's workspace and per-job policy
3. Agent reads `workspace/memory.md` for context from previous runs
4. Agent triages issues, writes actions to `workspace/last-run.md`
5. If `close_issue` was compiled as `escalate` and Signal is configured with `notifyOnEscalation: true`, the daemon sends a Signal message and waits for approval
6. On completion, daemon sends a Signal notification with the summary (if `notifyOnCompletion: true`)
7. Run outcome recorded to `~/.ironcurtain/jobs/{jobId}/runs/{timestamp}.json`

## 2. Design Overview

Cron Mode is implemented as an extension of the daemon lifecycle. A new `IronCurtainDaemon` class composes the existing `SignalBotDaemon` (for Signal transport) with a `CronScheduler` (for timed job execution). Both register `ManagedSession` entries via a shared `SessionManager` (extracted from `SignalBotDaemon`), enabling Signal-based escalation approval for cron-initiated sessions.

```
                          ironcurtain daemon
                                |
                     +----------+-----------+
                     |                      |
              IronCurtainDaemon             |
              (unified lifecycle)           |
                     |                      |
          +----------+----------+           |
          |                     |           |
   SignalBotDaemon       CronScheduler      |
   (WebSocket + sessions) (node-cron)       |
          |                     |           |
          +-----+-------+------+           |
                |       |                   |
           ManagedSession Map               |
           (shared, label-keyed)            |
                |                           |
         +------+------+                   |
         |             |                   |
   Signal sessions  Cron sessions          |
   (interactive)    (headless)             |
         |             |                   |
         +------+------+                   |
                |                          |
         Escalation routing                |
         (approve #N / deny #N)            |
                                           |
                                  ~/.ironcurtain/jobs/
                                  +-- {jobId}/
                                  |   +-- job.json
                                  |   +-- generated/
                                  |   |   +-- compiled-policy.json
                                  |   |   +-- dynamic-lists.json (optional)
                                  |   +-- workspace/
                                  |   |   +-- memory.md
                                  |   |   +-- last-run.md
                                  |   +-- runs/
                                  |       +-- 2026-03-04T09:00:00Z.json
                                  +-- {jobId2}/
                                      +-- ...

Note: tool-annotations.json is NOT stored per-job. Annotations
are always loaded from the global location (~/.ironcurtain/generated/
or the package-bundled fallback). Only compiled-policy.json (and
optionally dynamic-lists.json) are per-job artifacts.
```

## 3. Key Design Decisions

### 1. Unified `IronCurtainDaemon` composes `SignalBotDaemon` via extracted `SessionManager`.

**Rationale:** `SignalBotDaemon` has a well-defined responsibility (Signal WebSocket management, identity verification, message routing) and is already complex at ~900 lines. Cron scheduling is an orthogonal concern. Composition via a new `IronCurtainDaemon` class keeps both focused.

The session map and its lifecycle methods are extracted from `SignalBotDaemon` into a standalone `SessionManager` class. `IronCurtainDaemon` owns the `SessionManager` and passes it to both `SignalBotDaemon` and `CronScheduler`. This makes `SessionManager` the single owner of all session state, and decouples session lifecycle from any specific transport.

### 2. Cron sessions are `ManagedSession` entries in the shared session map.

**Rationale:** This is the key insight that makes escalation routing work for free. When a cron job hits an escalation and Signal is configured, the daemon surfaces it via Signal using the existing `setPendingEscalation()` / `handleEscalationReply()` machinery. The user replies `approve #7` just as they would for an interactive session. No new escalation mechanism is needed.

Cron sessions are distinguished from Signal sessions by a `source` discriminant on `ManagedSession` (`'signal' | 'cron'`). This controls cleanup behavior (cron sessions auto-close on completion; Signal sessions wait for user input) and notification routing.

### 3. Headless escalation: auto-deny by default, pause-and-notify via Signal.

**Rationale:** Unattended jobs must fail safe. Auto-deny is the only safe default when no human is present. However, for jobs where the user wants human-in-the-loop oversight (e.g., closing GitHub issues), the daemon can optionally notify via Signal and wait for a response.

The timeout behavior is: wait up to `escalationTimeoutSeconds` (from global config, default 300s). If no response arrives, auto-deny. The job continues with the denial (the agent sees a denied tool call and can adapt). This reuses the existing proxy-side escalation timeout mechanism -- the proxy writes a request file, polls for a response file, and times out if none appears.

For cron sessions without Signal or without `notifyOnEscalation`, the session's `onEscalation` callback immediately auto-denies by writing the response file. No pause, no notification.

### 4. Per-job persistent workspace at `~/.ironcurtain/jobs/{jobId}/workspace/`.

**Rationale:** Each job needs stable state across runs. Using the existing `workspacePath` mechanism in `SessionOptions` is the natural fit -- the session factory already supports pointing `allowedDirectory` at an existing directory. The workspace persists indefinitely; the agent is instructed (via system prompt augmentation) to maintain `memory.md` and `last-run.md` as cross-run coordination files.

### 5. Per-job policy replaces global constitution (not layered on top).

**Rationale:** The global constitution is designed for general-purpose interactive sessions. A cron job has a narrow, well-defined scope. Layering per-job rules on top of the global constitution would be confusing (which wins?) and would allow the broad global rules to permit operations the job should not perform. Instead, the per-job policy is authoritative:

Evaluation order for cron sessions:
1. Structural invariants (always, hardcoded) -- protected paths, sandbox containment, unknown tools
2. Per-job compiled rules (from `~/.ironcurtain/jobs/{jobId}/generated/compiled-policy.json`)
3. Default deny (no matching rule)

The global constitution is not consulted. This makes the per-job policy a true whitelist: only operations explicitly generated from the task description are permitted.

### 6. Policy compilation reuses the existing pipeline via `PipelineRunner`.

**Rationale:** The existing pipeline (`constitution-compiler.ts`, `policy-verifier.ts`, scenario generation, verify-and-repair loop) is battle-tested and handles content-hash caching, multi-turn repair, and structural conflict filtering. Duplicating this for per-job compilation would be a maintenance burden.

Instead, a `PipelineRunner` class (see Section 4.7) encapsulates the full compile-verify-repair loop behind a `run(config)` method. The `constitutionKind` discriminant selects the prompt variant:
- `'constitution'`: existing broad-principle compilation (used by `compile.ts` CLI)
- `'task-policy'`: whitelist-generation from task description (used by `compileTaskPolicy()`)

The `PipelineRunConfig` parameterizes:
- Input: `constitutionInput` -- task description string or constitution markdown
- Output: `outputDir` -- `~/.ironcurtain/jobs/{jobId}/generated/` for per-job
- Annotations: `toolAnnotationsDir` -- always the global generated directory
- Content hash: computed over the input text and prompt variant

Tool annotations (`tool-annotations.json`) are loaded from the global generated directory. Per-job compilation does not re-annotate tools -- that is a global operation run via `ironcurtain annotate-tools`.

### 7. Cron sessions get a `source: 'cron'` label and are visible in `/sessions`.

**Rationale:** Signal users need to see cron sessions alongside interactive ones for escalation management. The `/sessions` command output distinguishes them:

```
Sessions:
  #1 [signal] turns: 3, budget: 12%
  #5 [cron: issue-triage] running, budget: 8%
  #6 [cron: code-health] completed 2m ago
```

Cron session labels use the same numeric sequence as Signal sessions. This is important for escalation routing -- `approve #5` must work regardless of whether session #5 is Signal- or cron-initiated.

### 8. Skip-on-overlap for concurrent runs of the same job.

**Rationale:** If a job fires while a previous run of the same job is still active, the new run is skipped with a warning notification via Signal (if configured). Queuing introduces unbounded backlog risk for jobs that consistently exceed their schedule interval. Skipping is the safer default for unattended systems -- the next scheduled invocation will pick up where the previous one should have finished.

The daemon tracks `activeJobRuns: Map<JobId, number>` (jobId to session label) to detect overlap.

### 9. Budget defaults for scheduled jobs differ from interactive sessions.

**Rationale:** Interactive sessions have a 30-minute wall-clock limit (appropriate for human-supervised work). Scheduled jobs may need to process many items (e.g., triage 50 issues) but should have tighter cost controls since they run unattended. Per-job `budgetOverrides` allow tuning per task.

Default budget for cron sessions:
- `maxTotalTokens`: 500,000 (lower than interactive 1M -- triage is focused)
- `maxSteps`: 100 (lower than interactive 200 -- prevent runaway loops)
- `maxSessionSeconds`: 3,600 (1 hour -- higher than interactive 30min; batch processing takes time)
- `maxEstimatedCostUsd`: 2.00 (lower than interactive $5 -- cost discipline for recurring jobs)

### 10. Run history is recorded to per-job `runs/` directory.

**Rationale:** Each completed run writes a summary to `~/.ironcurtain/jobs/{jobId}/runs/{timestamp}.json`. This provides an audit trail and enables the `daemon logs <id>` command to show recent run outcomes. Run records include: start time, end time, budget consumed, completion status (success/budget-exhausted/error), and a summary extracted from `last-run.md` if available.

## 4. Interface Definitions

### 4.1 Job Definition

```typescript
// src/cron/types.ts

/**
 * Stable, user-chosen identifier for a cron job.
 * Must be a valid slug: lowercase alphanumeric, hyphens, underscores.
 * Branded to prevent mixing with other string identifiers.
 */
export type JobId = string & { readonly __brand: 'JobId' };

/** Validates and creates a JobId from a user-provided string. */
export function createJobId(raw: string): JobId {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(raw)) {
    throw new Error(
      `Invalid job ID "${raw}": must be 1-63 chars, ` +
      `lowercase alphanumeric, hyphens, or underscores, ` +
      `starting with a letter or digit`,
    );
  }
  return raw as JobId;
}

/**
 * Persisted job definition. Stored as JSON at
 * ~/.ironcurtain/jobs/{jobId}/job.json.
 *
 * Invariant: the `task` field is the "constitution" input for
 * per-job policy compilation. Changing it invalidates the
 * compiled policy (detected via content hash comparison).
 */
export interface JobDefinition {
  /** Stable user-chosen slug. Matches the directory name. */
  readonly id: JobId;

  /** Human-friendly display name. */
  readonly name: string;

  /** Standard cron expression (5 fields: min hour dom mon dow). */
  readonly schedule: string;

  /**
   * English task description. This is the "constitution" input
   * for per-job policy compilation. The LLM generates a whitelist
   * of allow/escalate rules covering exactly what this description
   * requires.
   */
  readonly task: string;

  /**
   * Working directory for this job. Persists across runs.
   * Default: ~/.ironcurtain/jobs/{jobId}/workspace/
   */
  readonly workspace?: string;

  /**
   * When true and Signal is configured, the daemon sends a Signal
   * message on escalation and waits for approval. When false or
   * Signal is not configured, escalations are auto-denied.
   */
  readonly notifyOnEscalation: boolean;

  /**
   * When true and Signal is configured, the daemon sends a Signal
   * message with the run summary on completion.
   */
  readonly notifyOnCompletion: boolean;

  /**
   * Per-job resource budget overrides. Null fields inherit from
   * the cron-specific defaults (not the interactive defaults).
   * Omit entirely to use cron defaults.
   */
  readonly budgetOverrides?: Partial<JobBudgetOverrides>;

  /** Whether this job is active. Disabled jobs are not scheduled. */
  readonly enabled: boolean;
}

/**
 * Budget fields that can be overridden per-job.
 * All fields are nullable: null means "disable this limit".
 */
export interface JobBudgetOverrides {
  readonly maxTotalTokens: number | null;
  readonly maxSteps: number | null;
  readonly maxSessionSeconds: number | null;
  readonly maxEstimatedCostUsd: number | null;
}
```

### 4.2 Run Record

```typescript
// src/cron/types.ts (continued)

/**
 * Outcome status for a completed run.
 */
export type RunOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'budget_exhausted'; readonly dimension: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Persisted run record. Written to
 * ~/.ironcurtain/jobs/{jobId}/runs/{timestamp}.json
 * after each run completes.
 */
export interface RunRecord {
  /** ISO 8601 start time. Also used as the filename. */
  readonly startedAt: string;

  /** ISO 8601 end time. */
  readonly completedAt: string;

  /** How the run ended. */
  readonly outcome: RunOutcome;

  /** Resource consumption snapshot. */
  readonly budget: {
    readonly totalTokens: number;
    readonly stepCount: number;
    readonly elapsedSeconds: number;
    readonly estimatedCostUsd: number;
  };

  /**
   * Brief summary extracted from workspace/last-run.md, if it exists.
   * Truncated to 2000 chars. Null if the file was not written.
   */
  readonly summary: string | null;

  /** Whether any escalations were surfaced during this run. */
  readonly escalationsEncountered: number;

  /** Whether any escalations were approved (vs. denied or timed out). */
  readonly escalationsApproved: number;
}
```

### 4.3 Job Store

```typescript
// src/cron/job-store.ts

import type { JobDefinition, JobId, RunRecord } from './types.js';

/**
 * Filesystem-backed store for job definitions and run records.
 *
 * Directory layout:
 *   ~/.ironcurtain/jobs/{jobId}/
 *     job.json              -- JobDefinition
 *     generated/            -- per-job compiled policy artifacts
 *       compiled-policy.json
 *       dynamic-lists.json  -- (optional)
 *     workspace/            -- persistent agent workspace
 *     runs/                 -- run history
 *       2026-03-04T09:00:00.000Z.json
 *
 * Tool annotations (tool-annotations.json) are always loaded from
 * the global location (~/.ironcurtain/generated/ or package fallback),
 * never stored per-job.
 */

/** Returns the jobs base directory: ~/.ironcurtain/jobs/ */
export function getJobsDir(): string;

/** Returns the directory for a specific job: ~/.ironcurtain/jobs/{jobId}/ */
export function getJobDir(jobId: JobId): string;

/** Returns the generated artifacts directory for a job. */
export function getJobGeneratedDir(jobId: JobId): string;

/** Returns the workspace directory for a job. */
export function getJobWorkspaceDir(jobId: JobId): string;

/** Returns the runs directory for a job. */
export function getJobRunsDir(jobId: JobId): string;

/** Loads a job definition from disk. Returns undefined if not found. */
export function loadJob(jobId: JobId): JobDefinition | undefined;

/** Loads all job definitions from disk. */
export function loadAllJobs(): JobDefinition[];

/** Saves a job definition to disk. Creates directories as needed. */
export function saveJob(job: JobDefinition): void;

/** Deletes a job and all its artifacts (generated, workspace, runs). */
export function deleteJob(jobId: JobId): void;

/** Records a completed run. */
export function saveRunRecord(jobId: JobId, record: RunRecord): void;

/**
 * Loads recent run records for a job, most recent first.
 * @param limit Maximum number of records to return (default 10).
 */
export function loadRecentRuns(jobId: JobId, limit?: number): RunRecord[];
```

### 4.4 Cron Scheduler

```typescript
// src/cron/cron-scheduler.ts

import type { JobDefinition, JobId } from './types.js';

/**
 * Callback invoked when a scheduled job fires.
 * The daemon implements this to create a session.
 */
export type JobTriggerCallback = (job: JobDefinition) => Promise<void>;

/**
 * Manages cron schedules for all enabled jobs.
 * Uses node-cron for cron expression parsing and scheduling.
 *
 * Invariant: at most one schedule exists per jobId at any time.
 * Calling schedule() for an already-scheduled job replaces the
 * previous schedule.
 */
export interface CronScheduler {
  /**
   * Registers a job's schedule. The callback fires at each
   * scheduled time. Does not fire immediately.
   *
   * @throws InvalidCronExpressionError if the cron expression
   * in job.schedule is syntactically invalid. The add-job wizard
   * catches this and surfaces it to the user before writing the
   * job file to disk.
   */
  schedule(job: JobDefinition, onTrigger: JobTriggerCallback): void;

  /**
   * Removes a job's schedule. No-op if not scheduled.
   */
  unschedule(jobId: JobId): void;

  /**
   * Removes all schedules. Called during shutdown.
   */
  unscheduleAll(): void;

  /**
   * Returns the next scheduled fire time for a job, or undefined
   * if the job is not scheduled.
   */
  getNextRun(jobId: JobId): Date | undefined;
}

/**
 * Thrown when a cron expression cannot be parsed.
 * The message includes the invalid expression and the parse error.
 */
export class InvalidCronExpressionError extends Error {
  constructor(readonly expression: string, cause: unknown);
}

/** Creates a CronScheduler backed by node-cron. */
export function createCronScheduler(): CronScheduler;
```

### 4.5 IronCurtainDaemon

```typescript
// src/daemon/ironcurtain-daemon.ts

import type { SessionMode } from '../session/types.js';
import type { SessionManager, ManagedSession, SessionSource } from '../session/session-manager.js';
import type { SignalBotDaemon } from '../signal/signal-bot-daemon.js';
import type { CronScheduler } from '../cron/cron-scheduler.js';
import type { JobDefinition, JobId, RunRecord } from '../cron/types.js';

// SessionSource and ManagedSession are defined in src/session/session-manager.ts
// and re-exported here for convenience. See Section 4.6 for their definitions.
export type { SessionSource, ManagedSession } from '../session/session-manager.js';

export interface IronCurtainDaemonOptions {
  /** Session mode for both Signal and cron sessions. */
  readonly mode: SessionMode;
}

/**
 * Unified daemon managing both Signal-initiated interactive sessions
 * and cron-scheduled headless sessions.
 *
 * Lifecycle:
 *   1. start() -- loads jobs, starts Signal (if configured), schedules jobs
 *   2. Runs indefinitely, processing Signal messages and cron triggers
 *   3. shutdown() -- unschedules all jobs, ends all sessions, disconnects
 *
 * Session map is unified: both Signal and cron sessions share a single
 * Map<number, ManagedSession> with a shared label counter. This enables
 * Signal-based escalation approval for cron sessions via "approve #N".
 */
export class IronCurtainDaemon {
  /**
   * Starts the daemon. Loads all enabled jobs, schedules them,
   * optionally starts the Signal transport. Returns a promise
   * that resolves when shutdown() is called.
   */
  start(): Promise<void>;

  /** Graceful shutdown. Ends all sessions, unschedules all jobs. */
  shutdown(): Promise<void>;

  // --- Job management (called by CLI subcommands) ---

  /**
   * Adds a new job. Runs the full policy compilation pipeline
   * synchronously before confirming. Schedules the job if enabled.
   * @throws on invalid job definition or compilation failure
   */
  addJob(job: JobDefinition): Promise<void>;

  /** Removes a job. Stops any active run, unschedules, deletes files. */
  removeJob(jobId: JobId): Promise<void>;

  /** Enables a previously disabled job. Schedules it. */
  enableJob(jobId: JobId): void;

  /** Disables a job. Unschedules it but preserves files. */
  disableJob(jobId: JobId): void;

  /** Re-runs policy compilation for an existing job. */
  recompileJob(jobId: JobId): Promise<void>;

  /**
   * Manually triggers a job run (for testing). Does not affect
   * the cron schedule. Returns the run record on completion.
   */
  runJobNow(jobId: JobId): Promise<RunRecord>;

  /** Lists all jobs with their schedules and last run status. */
  listJobs(): Array<{
    job: JobDefinition;
    nextRun: Date | undefined;
    lastRun: RunRecord | undefined;
    isRunning: boolean;
  }>;
}
```

**Message routing guard:** When the daemon's `forwardToSession()` is called (i.e., a Signal user sends a follow-up message), it must check `managed.source.kind` before forwarding:

```typescript
private async forwardToSession(label: number, text: string): Promise<void> {
  const managed = this.sessionManager.get(label);
  if (!managed) return;

  if (managed.source.kind !== 'signal') {
    logger.warn(
      `[Daemon] Ignoring message for cron session #${label} ` +
        `(job: ${managed.source.jobName}) -- cron sessions do not accept follow-up messages`,
    );
    this.signalDaemon?.sendSignalMessage(
      `Session #${label} is a cron job (${managed.source.jobName}). ` +
        `It does not accept messages. Use escalation commands (approve/deny #${label}) instead.`,
    ).catch(() => {});
    return;
  }

  // Narrow transport to SignalSessionTransport for forwardMessage()
  const transport = managed.transport as SignalSessionTransport;
  // ... existing forwarding logic ...
}
```

Note: the escalation machinery (`handleEscalationReply`, `setPendingEscalation`, `clearPendingEscalation`) requires **no changes**. It operates on `managed.pendingEscalationId` and `session.resolveEscalation()` directly, both of which are source-agnostic. An `approve #5` command works identically whether session #5 is Signal-initiated or cron-initiated.

### 4.6 SessionManager

```typescript
// src/session/session-manager.ts

import type { Session, Transport } from './types.js';
import type { JobId } from '../cron/types.js';

/**
 * Source discriminant for managed sessions.
 * Determines cleanup behavior, notification routing, and
 * message forwarding eligibility.
 *
 * - 'signal': interactive session created via Signal message.
 *   Accepts follow-up messages via forwardToSession().
 * - 'cron': headless session created by the cron scheduler.
 *   Does NOT accept follow-up messages -- forwardToSession()
 *   logs a warning and returns for cron sessions.
 */
export type SessionSource =
  | { readonly kind: 'signal' }
  | { readonly kind: 'cron'; readonly jobId: JobId; readonly jobName: string };

/**
 * Unified managed session entry. Used for both Signal-initiated
 * interactive sessions and cron-initiated headless sessions.
 *
 * The transport field uses the base Transport interface, not
 * SignalSessionTransport, because cron sessions use HeadlessTransport.
 * Code that needs Signal-specific methods (e.g., forwardMessage())
 * must guard on source.kind === 'signal' and narrow the transport type.
 *
 * The escalation machinery (handleEscalationReply, setPendingEscalation,
 * clearPendingEscalation) requires NO changes -- it operates on
 * session.resolveEscalation() directly, which works identically for
 * both session kinds. Escalation state lives on ManagedSession and
 * is source-agnostic.
 */
export interface ManagedSession {
  readonly label: number;
  readonly session: Session;
  readonly transport: Transport;
  readonly source: SessionSource;
  messageInFlight: boolean;
  pendingEscalationId: string | null;
  escalationResolving: boolean;
}

/**
 * Owns all managed session state. Both SignalBotDaemon and
 * CronScheduler delegate to this class for session registration,
 * lookup, and teardown.
 *
 * Invariants:
 * - Labels are monotonically increasing integers starting at 1.
 * - At most one session exists per label.
 * - currentLabel is always either null (no sessions) or a valid
 *   label in the sessions map.
 */
export class SessionManager {
  private sessions = new Map<number, ManagedSession>();
  private nextLabel = 1;

  /**
   * The currently "focused" session label for Signal message routing.
   * When a Signal message arrives without an explicit #N prefix, it
   * is routed to this session. Null when no sessions are active.
   *
   * Only updated by register() for Signal sessions (source.kind === 'signal').
   * Cron sessions do not accept follow-up messages, so registering one
   * must not steal the Signal user's focus -- the next untagged Signal
   * message should still go to the interactive session the user was
   * talking to, not to a background cron job that cannot process it.
   *
   * On end(): if the ended session was currentLabel, switches to the
   * most recently registered remaining Signal session (or null if
   * none remain). Cron sessions are skipped during this fallback search.
   */
  currentLabel: number | null = null;

  /**
   * Registers a new session and returns its assigned label.
   *
   * For Signal sessions (source.kind === 'signal'): sets currentLabel
   * to the new session, matching the existing SignalBotDaemon behavior
   * where the most recently created session receives untagged messages.
   *
   * For cron sessions (source.kind === 'cron'): the session is added
   * to the map and assigned a label, but currentLabel is NOT changed.
   * This prevents background cron jobs from stealing Signal focus.
   */
  register(session: Session, transport: Transport, source: SessionSource): number;

  /**
   * Ends a session by label: closes the transport, closes the
   * session, and removes it from the map. If the ended session
   * was currentLabel, switches to the most recently registered
   * remaining Signal session (skipping cron sessions), or null
   * if no Signal sessions remain.
   *
   * No-op if the label does not exist.
   */
  end(label: number): Promise<void>;

  /** Returns the ManagedSession for a label, or undefined. */
  get(label: number): ManagedSession | undefined;

  /** Returns all managed sessions (snapshot). */
  all(): readonly ManagedSession[];

  // --- Escalation state management ---

  /**
   * Records that a session has a pending escalation awaiting
   * human approval. Called by the daemon when an escalation
   * event fires on any session (Signal or cron).
   */
  setPendingEscalation(label: number, escalationId: string): void;

  /**
   * Clears a session's pending escalation. Called after approval,
   * denial, or timeout.
   */
  clearPendingEscalation(label: number): void;

  /**
   * Returns sessions that have pending escalations.
   * Used for disambiguation when the user replies "approve"
   * without a session label.
   */
  withPendingEscalation(): readonly ManagedSession[];
}
```

**What `SignalBotDaemon` retains after this extraction:**

`SignalBotDaemon` retains only Signal-specific concerns:
- WebSocket connection to signal-cli container (connect, reconnect, health checks)
- Message parsing and command dispatch (`/quit`, `/new`, `/sessions`, `/budget`, `/help`)
- Identity verification (fingerprint checks, TTL cache)
- Control command handling (approve, deny, session switching)
- Markdown-to-Signal formatting and message splitting

It no longer owns `this.sessions`, `this.nextLabel`, or `this.currentLabel`. Instead, it receives a `SessionManager` reference in its constructor and calls:
- `sessionManager.register()` to create Signal sessions
- `sessionManager.get(label)` / `sessionManager.currentLabel` for message routing
- `sessionManager.end(label)` when the user runs `/quit`
- `sessionManager.setPendingEscalation()` / `clearPendingEscalation()` for escalation state
- `sessionManager.all()` for the `/sessions` command

**What `CronScheduler` callbacks do:**

The `IronCurtainDaemon.onJobTrigger()` callback (not the scheduler itself) calls:
- `sessionManager.register(session, headlessTransport, { kind: 'cron', jobId, jobName })` when a job fires
- `sessionManager.end(label)` when the job completes

The `CronScheduler` itself has no knowledge of `SessionManager` -- it only fires callbacks.

### 4.7 PipelineRunner and Task Policy Compiler

The existing pipeline's internal functions (`compilePolicyRules`, `generateTestScenarios`, `verifyCompiledPolicy`) are currently tightly coupled to `PipelineConfig` and the global output directory. Rather than threading an `outputDir` parameter through three separate function signatures, the pipeline is refactored behind a `PipelineRunner` abstraction that encapsulates the full compile-verify-repair loop.

```typescript
// src/pipeline/pipeline-runner.ts

import type { CompiledPolicyFile } from './types.js';
import type { MCPServerConfig } from '../config/types.js';

/**
 * Selects the LLM prompt variant for policy compilation.
 *
 * - 'constitution': broad-principle compilation from a constitution
 *   document. Produces rules covering general filesystem, git, web,
 *   etc. categories. This is the existing behavior.
 * - 'task-policy': whitelist-generation from an English task
 *   description. Produces the MINIMUM set of allow/escalate rules
 *   for exactly what the task requires. Everything not explicitly
 *   covered falls through to default deny.
 */
export type ConstitutionKind = 'constitution' | 'task-policy';

/**
 * Configuration for a single pipeline run (compile + verify + repair).
 */
export interface PipelineRunConfig {
  /**
   * The input text for compilation.
   * - For 'constitution': the combined constitution markdown
   *   (base + user extension).
   * - For 'task-policy': the English task description.
   */
  readonly constitutionInput: string;

  /**
   * Controls which LLM prompt variant is used.
   * See ConstitutionKind for the two variants.
   */
  readonly constitutionKind: ConstitutionKind;

  /**
   * Directory where compiled-policy.json, test-scenarios.json,
   * and optionally dynamic-lists.json are written.
   */
  readonly outputDir: string;

  /**
   * Directory where tool-annotations.json is read from.
   * Always the global annotations dir -- never per-job.
   */
  readonly toolAnnotationsDir: string;

  /**
   * Sandbox boundary for structural invariant checks during
   * policy verification.
   */
  readonly allowedDirectory: string;

  /** Protected paths for structural invariant injection. */
  readonly protectedPaths: string[];

  /**
   * MCP server configs (for domain allowlist extraction).
   * Required for both constitution and task-policy modes to preserve
   * the structural domain-gate for URL-role arguments. Optional only
   * because callers that have no URL-role tools can omit it safely.
   */
  readonly mcpServers?: Record<string, MCPServerConfig>;

  /** Path to write LLM interaction logs. */
  readonly llmLogPath?: string;

  /**
   * Whether to include handwritten scenarios in verification.
   * Default true for 'constitution', false for 'task-policy'.
   *
   * Handwritten scenarios are filesystem/git-specific ground truth
   * and are NOT applicable to arbitrary task-scoped policies.
   * Per-job compilation relies entirely on LLM-generated scenarios
   * derived from the task description.
   */
  readonly includeHandwrittenScenarios?: boolean;

  /** Progress callback for CLI output. */
  readonly onProgress?: (message: string) => void;
}

/**
 * Encapsulates the full policy compilation pipeline:
 * compile rules -> generate scenarios -> verify -> repair loop.
 *
 * Constructed with LLM model references (shared across runs).
 * The run() method executes a single compilation with the given config.
 */
export class PipelineRunner {
  constructor(models: PipelineModels);

  /**
   * Runs the full pipeline. Returns the compiled policy on success.
   * Uses content-hash caching: if the inputHash matches the existing
   * artifact, returns immediately without LLM calls.
   *
   * @throws on compilation or verification failure after repair attempts
   */
  run(config: PipelineRunConfig): Promise<CompiledPolicyFile>;
}

/**
 * LLM model references shared across pipeline runs.
 * Created once by the daemon or CLI, reused for multiple compilations.
 */
export interface PipelineModels {
  readonly compilationModel: import('ai').LanguageModel;
  readonly verificationModel: import('ai').LanguageModel;
  readonly cacheStrategy: import('../session/prompt-cache.js').PromptCacheStrategy;
}

/** Creates PipelineModels from user config. */
export async function createPipelineModels(): Promise<PipelineModels>;
```

The existing `compile.ts` CLI `main()` becomes a thin wrapper:

```typescript
// In compile.ts main():
const models = await createPipelineModels();
const runner = new PipelineRunner(models);
await runner.run({
  constitutionInput: config.constitutionText,
  constitutionKind: 'constitution',
  outputDir: config.generatedDir,
  toolAnnotationsDir: config.generatedDir, // same dir for global
  allowedDirectory: config.allowedDirectory,
  protectedPaths: config.protectedPaths,
  includeHandwrittenScenarios: true,
});
```

The new `compileTaskPolicy()` convenience function:

```typescript
// src/pipeline/task-policy-compiler.ts

import { resolve } from 'node:path';
import { PipelineRunner, createPipelineModels } from './pipeline-runner.js';
import { loadConfig } from '../config/index.js';
import { getUserGeneratedDir } from '../config/paths.js';
import type { CompiledPolicyFile } from './types.js';

/**
 * Compiles a task-scoped policy from an English task description.
 * Convenience wrapper over PipelineRunner with task-policy defaults.
 *
 * Loads MCP server configs via loadConfig() to preserve the structural
 * domain-gate protection for URL-role arguments. Without mcpServers,
 * the pipeline would not know which domains are allowed for tools with
 * fetch-url or git-remote-url roles, and cron sessions using those
 * tools would lose domain allowlist enforcement.
 */
export async function compileTaskPolicy(
  taskDescription: string,
  jobDir: string,
  globalAnnotationsDir?: string,
): Promise<CompiledPolicyFile> {
  const config = loadConfig();
  const models = await createPipelineModels();
  const runner = new PipelineRunner(models);
  return runner.run({
    constitutionInput: taskDescription,
    constitutionKind: 'task-policy',
    outputDir: resolve(jobDir, 'generated'),
    toolAnnotationsDir: globalAnnotationsDir ?? getUserGeneratedDir(),
    allowedDirectory: resolve(jobDir, 'workspace'),
    protectedPaths: config.protectedPaths,
    mcpServers: config.mcpServers,
    includeHandwrittenScenarios: false,  // task-policy generates its own scenarios
  });
}
```

### 4.8 System Prompt Augmentation

```typescript
// Addition to src/session/prompts.ts

/**
 * Context injected into the system prompt for cron-initiated sessions.
 */
export interface CronPromptContext {
  /** The English task description from the job definition. */
  readonly taskDescription: string;

  /** Absolute path to the persistent workspace directory. */
  readonly workspacePath: string;
}

/**
 * Builds the system prompt augmentation for cron sessions.
 * Appended to the standard system prompt (from buildSystemPrompt).
 */
export function buildCronSystemPromptAugmentation(context: CronPromptContext): string;
```

### 4.9 SessionOptions Extension

```typescript
// Addition to src/session/types.ts

export interface SessionOptions {
  // ... existing fields ...

  /**
   * When set, loads compiled-policy.json (and optionally
   * dynamic-lists.json) from this directory instead of the global
   * generated directory. Tool annotations are always loaded from
   * the global location regardless of this setting.
   *
   * Used by cron sessions to load task-scoped policy.
   */
  policyDir?: string;

  /**
   * Additional content appended to the system prompt.
   * Used by cron sessions to inject task context and workspace
   * conventions. Not used for Docker sessions.
   */
  systemPromptAugmentation?: string;
}
```

### 4.10 Headless Escalation Transport

```typescript
// src/cron/headless-transport.ts

import { BaseTransport } from '../session/base-transport.js';
import type { Session, EscalationRequest } from '../session/types.js';

/**
 * Minimal transport for headless cron sessions.
 *
 * Unlike SignalSessionTransport which blocks run() indefinitely,
 * HeadlessTransport's run() resolves when the single-shot task
 * message completes. It does not accept follow-up messages.
 *
 * Escalation handling is configured via the constructor:
 * - When a notifier is provided, escalations are surfaced via Signal
 *   and the session waits for external resolution (via daemon).
 * - When no notifier is provided, escalations are auto-denied
 *   immediately by writing the response file.
 */
export class HeadlessTransport extends BaseTransport {
  constructor(options: {
    /** The initial task message to send. */
    readonly taskMessage: string;
    /**
     * Optional callback invoked when an escalation is surfaced.
     * When provided, the transport sets the pending escalation
     * on the ManagedSession and waits for external resolution.
     * When absent, escalations are auto-denied immediately.
     */
    readonly onEscalation?: (request: EscalationRequest) => void;
    readonly onEscalationExpired?: () => void;
    readonly onDiagnostic?: (event: import('../session/types.js').DiagnosticEvent) => void;
  });

  protected async runSession(session: Session): Promise<void>;

  /** Returns the agent's response from the task. */
  getResponse(): string | undefined;

  close(): void;
}
```

## 5. Task Policy Compiler Prompt Design

The per-job compilation uses a variant system prompt that instructs the LLM to produce a task-scoped whitelist rather than a broad constitution-based policy:

```typescript
const TASK_POLICY_SYSTEM_PROMPT_TEMPLATE = `You are compiling a task-scoped security policy for an automated scheduled job. The job runs unattended on a schedule. Your goal is to generate the MINIMUM set of policy rules required for this specific task -- nothing more.

## Task Description

{taskDescription}

## Tool Annotations

These are the available tools and their classified capabilities:

{annotationsSummary}

## Structural Invariants (handled automatically -- do NOT generate rules for these)

1. **Protected paths** -- reads/writes/deletes to these paths are automatically denied:
{protectedPaths}

2. **Workspace containment** -- operations within the job's workspace ({workspacePath}) are automatically allowed.

3. **Default deny** -- if no compiled rule matches, the operation is DENIED. You do NOT need catch-all rules.

## Instructions

Generate an ORDERED list of policy rules (first match wins) that allow EXACTLY the operations this task needs. Be a strict whitelist:

1. **Allow** operations the task explicitly describes or clearly requires.
   - "label each issue by type" -> allow github.add_label
   - "add a comment" -> allow github.create_comment
   - "close issues with no response for 30+ days" -> allow github.close_issue (the task explicitly authorizes this)

2. **Escalate** operations that are consequential AND only implicitly needed.
   - If the task says "fix bugs" but doesn't mention specific files, escalate write operations.
   - If an operation could cause data loss and the task doesn't explicitly authorize it, escalate.

3. **Omit** operations the task does not need. Default deny handles them.
   - Do NOT generate rules for tools unrelated to the task.
   - Do NOT generate broad "allow all reads" rules unless the task requires broad read access.

4. **Filesystem access**: The agent's workspace is automatically allowed. Only generate rules for filesystem access OUTSIDE the workspace if the task requires it.

5. **Side-effect-free operations**: Reading and listing operations for tools the task uses should generally be allowed. The task cannot operate without discovering available data.

{ruleFormat}`;
```

The `{ruleFormat}` placeholder is filled with `RULE_FORMAT_DOCUMENTATION` -- the shared constant extracted from `buildCompilerSystemPrompt()` in `constitution-compiler.ts` (see Section 6.6). This constant contains the rule schema (name, description, principle, if/then) and structural invariant documentation, identical between both prompt variants.

## 6. Integration Points

### 6.1 Policy Loading Parameterization (`src/config/index.ts`)

Per-job sessions use a **split load path**: policy files come from the per-job directory, while tool annotations always come from the global location.

The `loadGeneratedPolicy()` signature is updated to accept separate directories:

```typescript
export interface PolicyLoadOptions {
  /** Directory for compiled-policy.json and dynamic-lists.json. */
  readonly policyDir: string;
  /** Directory for tool-annotations.json (always global). */
  readonly toolAnnotationsDir: string;
  /** Fallback directory for missing artifacts (package-bundled defaults). */
  readonly fallbackDir?: string;
}

export function loadGeneratedPolicy(
  options: PolicyLoadOptions,
): {
  compiledPolicy: CompiledPolicyFile;
  toolAnnotations: ToolAnnotationsFile;
  dynamicLists: DynamicListsFile | undefined;
};
```

For interactive sessions, both directories point to the same global location (backward-compatible behavior). For cron sessions, they diverge:

```typescript
// In createBuiltinSession():
const policyDir = options.policyDir ?? config.generatedDir;
const toolAnnotationsDir = config.generatedDir; // always global
const { compiledPolicy, toolAnnotations, dynamicLists } =
  loadGeneratedPolicy({
    policyDir,
    toolAnnotationsDir,
    fallbackDir: getPackageGeneratedDir(),
  });
```

This ensures tool annotations are never duplicated or stale per-job. When new tools are added globally via `ironcurtain annotate-tools`, all jobs see the updated annotations immediately without per-job recompilation of annotations.

### 6.2 Session Factory Changes (`src/session/index.ts`)

The `buildSessionConfig()` function is extended to accept the `policyDir` override:

```typescript
function buildSessionConfig(
  config: IronCurtainConfig,
  effectiveSessionId: string,
  sessionId: SessionId,
  resumeSessionId?: string,
  workspacePath?: string,
  policyDir?: string,       // NEW
): SessionDirConfig {
  // ... existing logic ...

  const sessionConfig = {
    ...config,
    allowedDirectory: sandboxDir,
    // Override generated dir when per-job policy is provided
    generatedDir: policyDir ?? config.generatedDir,
    // ... other fields ...
  };

  return { config: sessionConfig, /* ... */ };
}
```

### 6.3 System Prompt Augmentation (`src/session/agent-session.ts`)

When `options.systemPromptAugmentation` is set, it is appended to the base system prompt:

```typescript
// In AgentSession.initialize():
let rawPrompt = buildSystemPrompt(serverListings, this.config.allowedDirectory);
if (this.systemPromptAugmentation) {
  rawPrompt += '\n\n' + this.systemPromptAugmentation;
}
this.systemPrompt = this.cacheStrategy.wrapSystemPrompt(rawPrompt);
```

The cron augmentation content:

```typescript
export function buildCronSystemPromptAugmentation(context: CronPromptContext): string {
  return `## Scheduled Task Mode

You are running as an automated scheduled task. There is no interactive user present.

### Your Task

${context.taskDescription}

### Workspace

Your persistent workspace is: ${context.workspacePath}
This directory persists across runs. Use it for cross-run state:

- **workspace/memory.md** -- Your notes for yourself. Read this at the start of each run to recall context from previous runs. Update it with anything you want to remember for next time (last processed item, patterns observed, recurring issues, etc.).
- **workspace/last-run.md** -- Write a structured summary here before finishing. Include:
  - Date and time of this run
  - Actions taken (with counts: "Labeled 12 issues, commented on 3, closed 1")
  - Any issues encountered or items skipped
  - Recommendations for next run (if any)

### Headless Behavior

- If a tool call is denied, do NOT retry it. Note the denial in your summary and continue with other work.
- If a tool call requires approval and no human responds in time, it will be auto-denied. Continue without that operation.
- Work efficiently: this is a recurring job, not an exploration. Focus on the task.
- Always write workspace/last-run.md before finishing, even if the task failed.`;
}
```

### 6.4 Budget Override Merge for Cron Sessions

Per-job `budgetOverrides` are merged into the resolved user config's `resourceBudget` using object spread. Since `ResolvedUserConfig` fields are `readonly`, a new config object is created for the session:

```typescript
/** Cron-specific budget defaults (differ from interactive defaults). */
const CRON_BUDGET_DEFAULTS: Required<JobBudgetOverrides> = {
  maxTotalTokens: 500_000,
  maxSteps: 100,
  maxSessionSeconds: 3_600,
  maxEstimatedCostUsd: 2.0,
};

function buildCronSessionConfig(
  globalConfig: IronCurtainConfig,
  job: JobDefinition,
): IronCurtainConfig {
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
```

The merge order is: cron defaults < per-job overrides. A `null` value in `budgetOverrides` disables that limit (e.g., `maxSessionSeconds: null` removes the wall-clock timeout). The global interactive defaults are not consulted -- cron sessions always start from `CRON_BUDGET_DEFAULTS`.

### 6.5 Daemon-to-Signal Bridge for Cron Escalations

When a cron session surfaces an escalation and `notifyOnEscalation` is true:

```typescript
// In IronCurtainDaemon, cron session escalation handler:
function createCronEscalationHandler(
  sessionManager: SessionManager,
  label: number,
  job: JobDefinition,
  signalDaemon: SignalBotDaemon | null,
): (request: EscalationRequest) => void {
  return (request: EscalationRequest) => {
    // Set pending escalation via SessionManager (same as Signal sessions)
    sessionManager.setPendingEscalation(label, request.escalationId);

    if (job.notifyOnEscalation && signalDaemon) {
      // Format and send via Signal
      const banner = formatCronEscalationBanner(request, label, job.name);
      signalDaemon.sendSignalMessage(banner).catch(() => {});
      // The proxy-side timeout handles the deadline. If the user
      // doesn't respond via Signal, the proxy auto-denies.
    } else {
      // Auto-deny immediately
      const managed = sessionManager.get(label);
      managed?.session.resolveEscalation(request.escalationId, 'denied').catch(() => {});
    }
  };
}
```

### 6.6 Pipeline Parameterization (`src/pipeline/pipeline-runner.ts`)

The existing pipeline internals (`compilePolicyRules`, `generateTestScenarios`, `verifyCompiledPolicy`) are encapsulated behind `PipelineRunner` (see Section 4.7). The `constitutionKind` flag selects the appropriate LLM prompt variant:

- **`'constitution'`** uses the existing `buildCompilerSystemPrompt()` -- broad-principle compilation from a constitution document. This is the current behavior, unchanged.
- **`'task-policy'`** uses `buildTaskCompilerSystemPrompt()` -- whitelist-generation from an English task description. Instructs the LLM to generate the minimum set of allow/escalate rules. Everything not covered falls through to default deny.

The `{ruleFormat}` section (rule schema documentation, structural invariant descriptions) is extracted from `buildCompilerSystemPrompt()` into a shared constant `RULE_FORMAT_DOCUMENTATION` used by both prompt variants.

The existing `compile.ts` CLI `main()` becomes a thin wrapper over `PipelineRunner.run()` with `constitutionKind: 'constitution'`. Its public interface is unchanged. The new `compileTaskPolicy()` convenience function (see Section 4.7) wraps `PipelineRunner.run()` with `constitutionKind: 'task-policy'` and task-appropriate defaults (no handwritten scenarios, per-job output directory, workspace as sandbox boundary).

**Handwritten scenarios:** Per-job compilation does **not** include `getHandwrittenScenarios()`. The handwritten scenarios in `src/pipeline/handwritten-scenarios.ts` are filesystem/git-specific ground truth designed for the global constitution. They are not applicable to arbitrary task-scoped policies (e.g., a GitHub triage job has no filesystem write scenarios). The task-policy prompt generates all scenarios from the task description. The `includeHandwrittenScenarios` flag on `PipelineRunConfig` controls this -- `true` for constitution mode, `false` for task-policy mode.

## 7. Component Relationships

```
ironcurtain daemon (CLI entry point)
        |
        v
  IronCurtainDaemon
  (unified lifecycle owner)
        |
        +---> SessionManager (owns all session state)
        |       |
        |       +---> Map<number, ManagedSession>
        |       +---> register(), end(), get(), all()
        |       +---> setPendingEscalation(), clearPendingEscalation()
        |       +---> currentLabel (for Signal routing)
        |
        +---> SignalBotDaemon (optional, when Signal configured)
        |       |
        |       +---> WebSocket connection to signal-cli
        |       +---> Message parsing, identity verification, commands
        |       +---> Calls sessionManager.register() for Signal sessions
        |       +---> Calls sessionManager.get() for message routing
        |       +---> Does NOT own session map (delegates to SessionManager)
        |
        +---> CronScheduler (node-cron)
        |       |
        |       +---> Fires JobTriggerCallback at scheduled times
        |       +---> Manages per-job cron tasks
        |
        +---> JobStore (filesystem)
        |       |
        |       +---> Reads/writes ~/.ironcurtain/jobs/{id}/job.json
        |       +---> Reads/writes run records
        |
        +---> Per-job policy compilation
                |
                +---> compileTaskPolicy() (wraps PipelineRunner)
                +---> Reads global tool-annotations.json
                +---> Writes to ~/.ironcurtain/jobs/{id}/generated/

Session creation flow (cron):
  1. CronScheduler fires -> IronCurtainDaemon.onJobTrigger(job)
  2. Check overlap (skip if same job already running)
  3. Create HeadlessTransport with task message
  4. createSession({
       config: patchedConfig,
       workspacePath: jobWorkspaceDir,
       policyDir: jobGeneratedDir,
       systemPromptAugmentation: buildCronSystemPromptAugmentation(job),
       onEscalation: createCronEscalationHandler(managed, job),
     })
  5. sessionManager.register(session, transport, { kind: 'cron', jobId, jobName })
  6. HeadlessTransport.run(session) -> sends task message
  7. On completion: record RunRecord, send notification,
     sessionManager.end(label)
```

## 8. CLI Commands

### 8.1 `ironcurtain daemon`

Starts the unified daemon. Replaces `ironcurtain bot` (which becomes an alias).

```
ironcurtain daemon [options]
  -a, --agent <name>  Agent mode (same as start)
  --no-signal         Skip Signal transport (cron-only mode)
```

**Backward compatibility:** `ironcurtain bot` becomes an alias for `ironcurtain daemon`. Its behavior changes slightly: the daemon now also starts the `CronScheduler` and loads any configured jobs from `~/.ironcurtain/jobs/`. Users with no jobs configured see no behavioral difference -- the scheduler starts with an empty job list and does nothing until jobs are added.

### 8.2 `ironcurtain daemon add-job`

Interactive wizard for creating a new job. Runs policy compilation synchronously before confirming.

```
ironcurtain daemon add-job

Interactive prompts:
  Job ID (slug): issue-triage
  Display name: GitHub Issue Triage
  Schedule (cron): 0 9 * * *
  Task description: (multi-line, ends with empty line)
    Triage open GitHub issues on the ironcurtain repo...
  Notify on escalation? (y/n): y
  Notify on completion? (y/n): y

Compiling task policy...
  [1/3] Compiling task policy: 6 rules compiled (4.2s)
  [2/3] Generating test scenarios: 15 scenarios (8.1s)
  [3/3] Verifying policy: 1 round (3.4s)

Job "issue-triage" created. Next run: 2026-03-05 09:00:00
```

The wizard uses `@clack/prompts` (already a dependency, used by `config-command.ts`). The cron expression is validated immediately via `CronScheduler.schedule()` (which throws `InvalidCronExpressionError` on invalid input). If validation fails, the wizard re-prompts rather than writing a job file that would fail at runtime.

If the daemon is already running, `add-job` communicates via a control socket (Unix domain socket at `~/.ironcurtain/daemon.sock`). If the daemon is not running, it writes the job files to disk and prints a message to start the daemon.

### 8.3 `ironcurtain daemon list-jobs`

```
ironcurtain daemon list-jobs

Jobs:
  issue-triage     GitHub Issue Triage          0 9 * * *    next: 2026-03-05 09:00
                   Last run: 2026-03-04 09:00 — success (12 issues triaged)
  code-health      Daily Code Health Check      0 8 * * 1-5  next: 2026-03-05 08:00
                   Last run: 2026-03-04 08:00 — success (all checks passed)
  backup-notes     Backup Notes to Repo         0 22 * * *   DISABLED
                   Last run: 2026-03-01 22:00 — error (git push denied)
```

### 8.4 `ironcurtain daemon run-job <id>`

One-shot manual trigger for testing. Does not affect the cron schedule.

```
ironcurtain daemon run-job issue-triage
Running job "issue-triage"...
  [session #8] Sending task: "Triage open GitHub issues..."
  [session #8] Completed in 45s, budget: 23%
  Summary: Labeled 12 issues, commented on 3 stale issues, closed 1 unresponsive issue.
```

### 8.5 Other commands

```
ironcurtain daemon remove-job <id>       Delete job and all artifacts
ironcurtain daemon disable-job <id>      Stop scheduling, preserve files
ironcurtain daemon enable-job <id>       Resume scheduling
ironcurtain daemon recompile-job <id>    Re-run policy compilation
ironcurtain daemon logs <id> [--runs N]  Show recent run summaries (default: 5)
```

### 8.6 CLI Architecture

All `daemon` subcommands are routed through `src/daemon/daemon-command.ts`, which is registered in `src/cli.ts`:

```typescript
// In src/cli.ts switch statement:
case 'daemon': {
  const { runDaemonCommand } = await import('./daemon/daemon-command.js');
  await runDaemonCommand(process.argv.slice(3));
  break;
}
```

The `runDaemonCommand()` function parses the sub-subcommand (`add-job`, `list-jobs`, etc.) and dispatches accordingly. When no sub-subcommand is given, it starts the daemon.

## 9. Run Lifecycle (Detailed)

```
CronScheduler fires
        |
        v
IronCurtainDaemon.onJobTrigger(job)
        |
        v
Check activeJobRuns.has(job.id)?
  YES -> log skip, notify Signal if configured, return
  NO  -> continue
        |
        v
Load job config, resolve workspace path
        |
        v
Create HeadlessTransport(taskMessage)
        |
        v
createSession({
  config: patchedConfig,
  workspacePath: job workspace,
  policyDir: job generated dir,
  systemPromptAugmentation: cron context,
  onEscalation: cron handler (auto-deny or Signal notify),
  onDiagnostic: budget warnings to Signal,
})
        |
        v
sessionManager.register(session, transport, { source: 'cron', jobId })
Set activeJobRuns.set(job.id, label)
        |
        v
HeadlessTransport.run(session)
  |
  +---> session.sendMessage(taskMessage)
  |       |
  |       +---> Agent runs autonomously
  |       +---> Policy engine evaluates against per-job rules
  |       +---> Escalations: auto-deny or Signal notify+wait
  |       +---> Agent writes workspace/last-run.md
  |       |
  |       v
  |     Response returned
  |
  v
On completion:
  1. Read workspace/last-run.md (if exists)
  2. Build RunRecord (outcome, budget, summary)
  3. saveRunRecord(jobId, record)
  4. If notifyOnCompletion && Signal configured:
       sendSignalMessage("[cron: issue-triage] Completed. Labeled 12 issues...")
  5. sessionManager.end(label)
  6. activeJobRuns.delete(job.id)
```

## 10. Walkthrough: GitHub Issue Triage

**Setup:**

```
$ ironcurtain daemon add-job
  Job ID: issue-triage
  Name: GitHub Issue Triage
  Schedule: 0 9 * * *
  Task: Triage open GitHub issues on the ironcurtain repo: label each
        issue by type (bug/feature/question/docs), add a comment on
        issues that haven't been updated in 14+ days asking for status,
        and close issues with no response for 30+ days. Write a brief
        summary of what you did.
  Notify on escalation: yes
  Notify on completion: yes

  Compiling task policy...
```

**Per-job policy compilation produces:**

```json
{
  "rules": [
    {
      "name": "allow-github-read-issues",
      "description": "Allow listing and reading GitHub issues for triage",
      "principle": "Task: triage requires reading issue data",
      "if": { "server": ["github"], "tool": ["list_issues", "get_issue", "list_issue_comments"] },
      "then": "allow"
    },
    {
      "name": "allow-github-label",
      "description": "Allow adding labels to issues for classification",
      "principle": "Task: label each issue by type",
      "if": { "server": ["github"], "tool": ["add_label"] },
      "then": "allow"
    },
    {
      "name": "allow-github-comment",
      "description": "Allow commenting on issues to ask for status",
      "principle": "Task: add a comment on stale issues",
      "if": { "server": ["github"], "tool": ["create_comment"] },
      "then": "allow"
    },
    {
      "name": "allow-github-close-issue",
      "description": "Allow closing issues with no response for 30+ days",
      "principle": "Task: close issues with no response for 30+ days",
      "if": { "server": ["github"], "tool": ["close_issue", "update_issue"] },
      "then": "allow"
    },
    {
      "name": "escalate-github-other",
      "description": "Escalate any other GitHub operations not explicitly authorized",
      "principle": "Least privilege: task does not authorize other GitHub operations",
      "if": { "server": ["github"] },
      "then": "escalate"
    }
  ]
}
```

Note: `close_issue` is `allow` (not `escalate`) because the task description explicitly authorizes closing issues under stated conditions. The LLM recognizes "close issues with no response for 30+ days" as explicit authorization. If the user had written a vaguer task like "help manage issues," `close_issue` would be `escalate`.

**First run at 09:00:**

1. Agent starts, reads `workspace/memory.md` -- file does not exist yet (first run).
2. Agent calls `github.list_issues` -- allowed by rule `allow-github-read-issues`.
3. Agent calls `github.add_label` for 12 issues -- allowed.
4. Agent calls `github.create_comment` on 3 stale issues -- allowed.
5. Agent calls `github.update_issue` (close) on 1 unresponsive issue -- allowed.
6. Agent writes `workspace/last-run.md`:
   ```
   # Run Summary: 2026-03-04 09:00

   ## Actions
   - Labeled 12 issues (5 bug, 4 feature, 2 question, 1 docs)
   - Commented on 3 issues with no activity for 14+ days
   - Closed 1 issue (#47) with no response for 35 days

   ## Notes for Next Run
   - Issue #52 has a complex bug report, may need label refinement
   - Issue #48 was commented today; check for response next run
   ```
7. Agent writes `workspace/memory.md`:
   ```
   # Issue Triage Memory

   ## Last processed: 2026-03-04 09:00
   ## Pending follow-ups:
   - #48: commented 2026-03-04, awaiting response (28 days since original activity)
   - #52: labeled as bug, complex report
   ```
8. Daemon reads `workspace/last-run.md`, records RunRecord.
9. Daemon sends Signal notification:
   ```
   [cron: issue-triage] Completed (45s, $0.12)
   Labeled 12 issues, commented on 3, closed 1.
   ```

**Second run at 09:00 next day:**

1. Agent reads `workspace/memory.md` -- sees pending follow-ups.
2. Agent checks #48 -- user responded, removes from pending list.
3. Continues with normal triage of new issues.

**Escalation scenario (if close_issue were compiled as `escalate`):**

1. Agent calls `github.close_issue` -- policy escalates.
2. Proxy writes escalation request file, daemon detects it.
3. Daemon sends Signal: `[#5 cron: issue-triage] Escalation: github/close_issue for issue #47. Reason: "Operation requires approval." Reply: approve #5 / deny #5`
4. User replies `approve #5` via Signal.
5. Daemon resolves escalation, agent continues.

## 11. Security Considerations

### 11.1 Per-job policy is a strict whitelist

The per-job policy's default-deny posture means a cron job can only perform operations that the policy compilation explicitly authorized from the task description. A compromised or confused agent in the issue-triage job cannot delete files, push code, or access unrelated servers.

### 11.2 Workspace isolation

Each job's workspace is scoped to `~/.ironcurtain/jobs/{jobId}/workspace/`. The sandbox containment structural invariant ensures filesystem operations outside this directory are denied (unless per-job rules explicitly allow them). Cross-job workspace access is impossible.

### 11.3 Headless escalation is fail-safe

When Signal is not configured or `notifyOnEscalation` is false, escalations are auto-denied immediately. The agent sees a denied tool call and must adapt. This is conservative -- the job may fail to complete some operations, but it cannot perform unauthorized actions.

### 11.4 Budget limits prevent runaway costs

Cron-specific budget defaults are lower than interactive defaults. Per-job `budgetOverrides` allow further tightening. The `BudgetExhaustedError` terminates the session cleanly, and the run record captures the exhaustion event.

### 11.5 Job definition integrity

Job files are stored under `~/.ironcurtain/` which is a protected path in the structural invariants. The agent cannot modify its own job definition, policy, or workspace memory through policy-mediated tool calls. Direct filesystem access outside the workspace is denied.

### 11.6 Policy compilation is synchronous and blocking

When `add-job` compiles the per-job policy, it runs the full verify-and-repair loop before the job is saved. A job with a task description that produces an unverifiable policy is rejected at creation time, not at first run.

### 11.7 Signal identity verification applies to cron escalations

Cron escalation notifications and approvals flow through the same Signal transport, with the same identity verification (fail-closed, TTL-cached fingerprint checks). A SIM-swap attack cannot approve cron escalations any more than it can approve interactive ones.

### 11.8 Task description is the trust root for per-job policy

The per-job compiled policy is only as good as the task description. A vague task description ("do whatever needs doing") would produce a broad policy. The LLM compiler is instructed to be a strict whitelist, but the ultimate scope is bounded by the user's description. The compilation wizard should warn about overly broad descriptions.

## 12. Testing Strategy

### 12.1 Unit tests

| Component | Test file | Key scenarios |
|-----------|-----------|---------------|
| `JobStore` | `test/job-store.test.ts` | CRUD operations, directory creation, run record persistence, malformed JSON handling |
| `CronScheduler` | `test/cron-scheduler.test.ts` | Schedule/unschedule, next-run calculation, overlap detection, `InvalidCronExpressionError` on bad expressions |
| `SessionManager` | `test/session-manager.test.ts` | Register/end lifecycle, label auto-increment, currentLabel switching, escalation state, `withPendingEscalation()` |
| `HeadlessTransport` | `test/headless-transport.test.ts` | Single-shot message delivery, auto-deny escalation, Signal-notify escalation, response capture |
| `PipelineRunner` | `test/pipeline-runner.test.ts` | `ConstitutionKind` prompt variant selection, content-hash caching, outputDir isolation, `includeHandwrittenScenarios` flag |
| `compileTaskPolicy()` | `test/task-policy-compiler.test.ts` | Task description to rules, cache hit, cache invalidation, verification failure handling |
| `buildCronSystemPromptAugmentation()` | `test/cron-prompts.test.ts` | Prompt content verification, workspace path injection |
| `IronCurtainDaemon` | `test/ironcurtain-daemon.test.ts` | Job lifecycle (add/remove/enable/disable), overlap skip, shutdown cleanup |

### 12.2 Integration tests

**Per-job policy compilation** (`test/task-policy-integration.test.ts`):
- Compile the GitHub issue triage task description against real tool annotations.
- Verify the produced rules allow the expected tools and deny others.
- Verify against a real PolicyEngine instance.
- Requires `INTEGRATION_TEST=true` (makes LLM calls).

**Cron session lifecycle** (`test/cron-session-integration.test.ts`):
- Create a job with a simple task ("list files in the workspace and write a summary").
- Run it via `runJobNow()`.
- Verify the workspace contains `last-run.md`.
- Verify the RunRecord was written.
- Requires a running filesystem MCP server.

### 12.3 Mock strategy

- `CronScheduler`: mock implementation that exposes a `trigger(jobId)` method for synchronous testing.
- `SessionManager`: real instance (lightweight, no I/O) -- test session registration, lookup, and escalation state directly.
- `SignalBotDaemon`: mock that records `sendSignalMessage()` calls for notification verification.
- `Session`: existing mock session from test infrastructure.
- LLM: mock model for unit tests; real model for integration tests.

## 13. Files Changed

| File | Change |
|------|--------|
| `src/cron/types.ts` | **New.** `JobId`, `JobDefinition`, `JobBudgetOverrides`, `RunOutcome`, `RunRecord`. |
| `src/cron/job-store.ts` | **New.** Filesystem-backed CRUD for jobs and run records. |
| `src/cron/cron-scheduler.ts` | **New.** `CronScheduler` interface and `node-cron` implementation. |
| `src/cron/headless-transport.ts` | **New.** `HeadlessTransport` for single-shot cron sessions. |
| `src/daemon/ironcurtain-daemon.ts` | **New.** `IronCurtainDaemon` composing Signal + cron. Imports and re-exports `SessionSource`, `ManagedSession` from `session-manager.ts`. |
| `src/daemon/daemon-command.ts` | **New.** CLI entry point for `ironcurtain daemon` and subcommands. |
| `src/pipeline/pipeline-runner.ts` | **New.** `PipelineRunner` class, `ConstitutionKind`, `PipelineRunConfig`, `PipelineModels`. Encapsulates compile-verify-repair loop. |
| `src/pipeline/task-policy-compiler.ts` | **New.** `compileTaskPolicy()` convenience wrapper over `PipelineRunner` with task-policy defaults. |
| `src/pipeline/compile.ts` | **Refactored:** `main()` becomes thin CLI wrapper over `PipelineRunner.run()`. Existing behavior unchanged. |
| `src/pipeline/constitution-compiler.ts` | Extract `RULE_FORMAT_DOCUMENTATION` constant for shared use by both prompt variants. |
| `src/config/index.ts` | Update `loadGeneratedPolicy()` to accept `PolicyLoadOptions` (split policyDir / toolAnnotationsDir). Existing callers updated to pass both dirs pointing to global location. |
| `src/session/types.ts` | Add `policyDir?` and `systemPromptAugmentation?` to `SessionOptions`. |
| `src/session/index.ts` | Thread `policyDir` into `buildSessionConfig()`. Override `generatedDir` when set. |
| `src/session/agent-session.ts` | Append `systemPromptAugmentation` to system prompt in `initialize()`. |
| `src/session/prompts.ts` | Add `CronPromptContext` and `buildCronSystemPromptAugmentation()`. |
| `src/config/paths.ts` | Add `getJobsDir()`, `getJobDir()`, `getJobGeneratedDir()`, `getJobWorkspaceDir()`, `getJobRunsDir()`. |
| `src/session/session-manager.ts` | **New.** `SessionManager` class extracted from `SignalBotDaemon`. Owns session map, labels, escalation state. Defines and exports `SessionSource` and `ManagedSession` types (canonical location -- daemon re-exports for convenience). |
| `src/signal/signal-bot-daemon.ts` | **Refactored:** session map and lifecycle methods extracted to `SessionManager`. Retains Signal WebSocket, identity verification, message parsing, and command handling. Accepts `SessionManager` via constructor. |
| `src/cli.ts` | Add `daemon` case routing to `daemon-command.ts`. Add `bot` as alias for `daemon` (backward compat). |
| `package.json` | Add `node-cron` dependency. |

## 14. Migration Plan

### Phase 1: Foundation types and job store (1 PR)

1. Create `src/cron/types.ts` with `JobId`, `JobDefinition`, `RunRecord`, etc.
2. Create `src/cron/job-store.ts` with filesystem CRUD.
3. Add path helpers to `src/config/paths.ts`.
4. Unit tests for job store.

### Phase 2: Session parameterization (1 PR)

1. Add `policyDir` and `systemPromptAugmentation` to `SessionOptions`.
2. Thread `policyDir` through `buildSessionConfig()` in `src/session/index.ts`.
3. Append augmentation in `AgentSession.initialize()`.
4. Add `buildCronSystemPromptAugmentation()` to `src/session/prompts.ts`.
5. Unit tests verifying session creates with custom policy dir and augmented prompt.

### Phase 3: PipelineRunner and task policy compiler (1 PR)

1. Create `src/pipeline/pipeline-runner.ts` with `PipelineRunner`, `ConstitutionKind`, `PipelineRunConfig`.
2. Extract `RULE_FORMAT_DOCUMENTATION` from `buildCompilerSystemPrompt()` in `constitution-compiler.ts` into a shared constant.
3. Refactor `compile.ts` `main()` to be a thin wrapper over `PipelineRunner.run()` with `constitutionKind: 'constitution'`. Existing CLI behavior is unchanged.
4. Create `src/pipeline/task-policy-compiler.ts` with `compileTaskPolicy()` convenience wrapper using `constitutionKind: 'task-policy'` and `includeHandwrittenScenarios: false`.
5. Integration test: compile the issue triage task against real annotations.

### Phase 4: Headless transport and cron scheduler (1 PR)

1. Create `src/cron/headless-transport.ts`.
2. Create `src/cron/cron-scheduler.ts` with `node-cron` integration.
3. Add `node-cron` to `package.json`.
4. Unit tests for both components.

### Phase 5: SessionManager extraction and unified daemon (1 PR)

1. Create `src/session/session-manager.ts` -- extract session map, label counter, escalation state management, and `currentLabel` from `SignalBotDaemon`.
2. Refactor `SignalBotDaemon` to accept `SessionManager` via constructor. Remove internal session map. All session operations delegate to `SessionManager`.
3. Create `src/daemon/ironcurtain-daemon.ts` -- owns `SessionManager`, composes `SignalBotDaemon` + `CronScheduler`.
4. Create `src/daemon/daemon-command.ts` with subcommand routing.
5. Register `daemon` in `src/cli.ts`. Make `bot` an alias (see backward compatibility note in Section 8.1).
6. Integration test: start daemon, add job, trigger manually, verify run record.

### Phase 6: CLI polish and documentation (1 PR)

1. Implement `add-job` interactive wizard using `@clack/prompts`.
2. Implement `list-jobs`, `logs`, `remove-job`, `disable-job`, `enable-job`, `recompile-job`.
3. Update help text in `src/cli.ts`.
4. User-facing documentation.

## 15. Future Extensions

### 15.1 Web dashboard for job monitoring

A local web UI showing job status, run history, and budget trends. Reads the same `~/.ironcurtain/jobs/` filesystem structure.

### 15.2 Job chaining

Allow jobs to trigger other jobs on completion (e.g., "after issue triage, run code health check"). Would require a DAG scheduler extension.

### 15.3 Adaptive scheduling

Adjust cron frequency based on workload (e.g., check issues hourly during active development, daily otherwise). Requires the agent to signal scheduling hints via workspace files.

### 15.4 Cross-job shared context

Allow jobs to read (but not write) other jobs' workspaces for information sharing. Requires policy extension to model cross-job read access.

### 15.5 Approval templates

For recurring escalation patterns, allow the user to pre-approve certain escalation types for a job (e.g., "always approve close_issue for issue-triage"). This would be a per-job auto-approve configuration layered on top of the existing auto-approver infrastructure.
