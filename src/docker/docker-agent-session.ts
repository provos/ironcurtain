/**
 * DockerAgentSession -- Session implementation that runs an external
 * agent inside a Docker container.
 *
 * The agent communicates with IronCurtain's MCP proxy server via a
 * Unix domain socket. The proxy enforces the same policy rules as
 * the built-in agent session.
 *
 * Docker infrastructure (proxies, orientation, image, running `sleep
 * infinity` container, TCP-mode sidecar and internal network) is created
 * by `createDockerInfrastructure()` in `docker-infrastructure.ts` and
 * handed to this class as a `DockerInfrastructure` bundle. The session
 * is a thin exec-harness over that bundle.
 *
 * Infrastructure ownership (`ownsInfra`):
 * - `ownsInfra: true` (standalone mode): the session owns the bundle and
 *   its `close()` method tears down proxies, container, sidecar, and
 *   internal network along with session-local state.
 * - `ownsInfra: false` (borrow mode): the session uses a bundle owned by
 *   an external caller (e.g., a workflow that shares one container across
 *   multiple sessions). `close()` stops session-owned state (escalation
 *   watcher, audit tailer) but leaves the infrastructure alive for the
 *   caller to destroy via `destroyDockerInfrastructure()`.
 *
 * Lifecycle:
 * 1. initialize() -- write system prompt; start escalation watcher and audit tailer
 * 2. sendMessage() -- docker exec agent command, wait for exit, collect output
 * 3. close() -- tear down watchers; tear down infra too iff `ownsInfra` is true
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  Session,
  SessionId,
  SessionInfo,
  SessionStatus,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
  BudgetStatus,
} from '../session/types.js';
import type { IronCurtainConfig } from '../config/types.js';
import type { DockerInfrastructure } from './docker-infrastructure.js';
import { destroyDockerInfrastructure } from './docker-infrastructure.js';
import { AuditLogTailer } from './audit-log-tailer.js';
import { SessionNotReadyError, SessionClosedError } from '../session/errors.js';
import { createEscalationWatcher, atomicWriteJsonSync } from '../escalation/escalation-watcher.js';
import type { EscalationWatcher } from '../escalation/escalation-watcher.js';
import * as logger from '../logger.js';
import { DEFAULT_EXEC_TIMEOUT_MS } from './docker-manager.js';

export interface DockerAgentSessionDeps {
  readonly config: IronCurtainConfig;
  readonly sessionId: SessionId;
  /**
   * Fully-formed infrastructure bundle produced by
   * `createDockerInfrastructure()`. The main agent container is already
   * created and running; the session drives it via `docker exec`. All of
   * `docker`, `proxy`, `mitmProxy`, `adapter`, `fakeKeys`, `useTcp`,
   * `sessionDir`, `sandboxDir`, `escalationDir`, `auditLogPath`,
   * `conversationStateDir`, `conversationStateConfig`, `systemPrompt`,
   * `containerId`, `sidecarContainerId`, and `internalNetwork` live on
   * this bundle.
   */
  readonly infra: DockerInfrastructure;
  /**
   * Whether this session owns the infrastructure bundle.
   *
   * - `true`: standalone mode -- `close()` invokes
   *   `destroyDockerInfrastructure(infra)` to tear down proxies, container,
   *   sidecar, and internal network alongside session-local state.
   * - `false`: borrow mode -- the bundle is owned by an external caller
   *   (e.g., a workflow driver sharing one container across sessions).
   *   `close()` leaves the infrastructure alive and the caller is
   *   responsible for invoking `destroyDockerInfrastructure` when done.
   *
   * This flag is required: callers must state ownership explicitly so a
   * missing value never silently selects the wrong teardown behavior.
   */
  readonly ownsInfra: boolean;
  /**
   * Optional system prompt override composed by the caller (e.g., with
   * persona augmentation appended). When unset, `infra.systemPrompt` is
   * used as-is.
   */
  readonly systemPromptOverride?: string;
  /** Qualified model ID ("provider:model-name") to use for this session's turns, overriding the adapter default. */
  readonly agentModelOverride?: string;
  readonly onEscalation?: (request: EscalationRequest) => void;
  readonly onEscalationExpired?: () => void;
  readonly onEscalationResolved?: (escalationId: string, decision: 'approved' | 'denied') => void;
  readonly onDiagnostic?: (event: DiagnosticEvent) => void;
}

export class DockerAgentSession implements Session {
  private readonly sessionId: SessionId;
  private readonly config: IronCurtainConfig;
  private readonly infra: DockerInfrastructure;
  private readonly ownsInfra: boolean;
  private readonly agentModelOverride?: string;
  private readonly systemPrompt: string;

  private status: SessionStatus = 'initializing';
  private readonly createdAt: string;

  /**
   * Whether the first turn of this conversation has completed at least once.
   * Used to decide whether to pin a fresh session id (`--session-id`) or
   * resume an existing one (`--resume`) for agents like Claude Code. Set to
   * true in the constructor if the conversation state dir already contains
   * prior content (resumed session); otherwise flipped to true after the
   * first successful sendMessage() turn.
   */
  private firstTurnComplete = false;

  private turns: ConversationTurn[] = [];
  private diagnosticLog: DiagnosticEvent[] = [];
  private escalationWatcher: EscalationWatcher | null = null;

  private auditTailer: AuditLogTailer | null = null;
  private cumulativeActiveMs = 0;
  private cumulativeCostUsd = 0;

  private readonly onEscalation?: (request: EscalationRequest) => void;
  private readonly onEscalationExpired?: () => void;
  private readonly onEscalationResolved?: (escalationId: string, decision: 'approved' | 'denied') => void;
  private readonly onDiagnostic?: (event: DiagnosticEvent) => void;

  constructor(deps: DockerAgentSessionDeps) {
    this.sessionId = deps.sessionId;
    this.config = deps.config;
    this.infra = deps.infra;
    this.ownsInfra = deps.ownsInfra;
    this.agentModelOverride = deps.agentModelOverride;
    this.systemPrompt = deps.systemPromptOverride ?? deps.infra.systemPrompt;
    this.onEscalation = deps.onEscalation;
    this.onEscalationExpired = deps.onEscalationExpired;
    this.onEscalationResolved = deps.onEscalationResolved;
    this.onDiagnostic = deps.onDiagnostic;
    this.createdAt = new Date().toISOString();

    // If the conversation state dir already has real content (beyond the
    // empty `projects/` seed), treat this as a resumed session -- the next
    // turn should use `--resume <uuid>` rather than pin a fresh session id.
    if (this.infra.conversationStateDir && hasConversationStateContent(this.infra.conversationStateDir)) {
      this.firstTurnComplete = true;
    }
  }

  /**
   * Initialize the Docker agent session. All infrastructure (proxies,
   * orientation, image, container, sidecar, internal network) is already
   * created by `createDockerInfrastructure()` before the session is
   * constructed. This method only wires up session-local state:
   *
   * 1. Ensure session directories exist
   * 2. Write the effective system prompt for debugging
   * 3. Start the escalation watcher
   * 4. Start the audit log tailer
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- must be async to satisfy Session interface
  async initialize(): Promise<void> {
    mkdirSync(this.infra.sandboxDir, { recursive: true });
    mkdirSync(this.infra.escalationDir, { recursive: true });

    // Write the effective system prompt for debugging
    writeFileSync(resolve(this.infra.sessionDir, 'system-prompt.txt'), this.systemPrompt);

    logger.info(`Session attached to container: ${this.infra.containerId.substring(0, 12)}`);

    this.escalationWatcher = createEscalationWatcher(this.infra.escalationDir, {
      onEscalation: (request) => this.onEscalation?.(request),
      onEscalationExpired: () => this.onEscalationExpired?.(),
      onEscalationResolved: (id, decision) => this.onEscalationResolved?.(id, decision),
    });
    this.escalationWatcher.start();

    // AuditLogTailer handles missing files: openSync catches ENOENT, and
    // watchFile polls regardless of existence. Don't create the file here --
    // it would race the proxy subprocess, which appends audit entries
    // concurrently, and the default `writeFileSync` 'w' flag could truncate
    // an entry the proxy just wrote.
    this.auditTailer = new AuditLogTailer(this.infra.auditLogPath, (event) => this.emitDiagnostic(event));
    this.auditTailer.start();

    this.status = 'ready';
  }

  getInfo(): SessionInfo {
    return {
      id: this.sessionId,
      status: this.status,
      turnCount: this.turns.length,
      createdAt: this.createdAt,
    };
  }

  async sendMessage(userMessage: string): Promise<string> {
    if (this.status === 'closed') throw new SessionClosedError();
    if (this.status !== 'ready') throw new SessionNotReadyError(this.status);

    this.status = 'processing';

    // Per-turn wall-clock timeout (matches builtin session semantics:
    // maxSessionSeconds is a per-turn limit, idle time doesn't count).
    // When not configured, docker.exec applies its own default timeout
    // (currently 10 minutes) to prevent runaway processes.
    const maxSeconds = this.config.userConfig.resourceBudget.maxSessionSeconds;
    const execTimeout = maxSeconds != null ? maxSeconds * 1000 : undefined;

    const turnStartMs = Date.now();
    const turnStart = new Date(turnStartMs).toISOString();

    // Write user context for the auto-approver
    this.writeUserContext(userMessage);

    const command = this.infra.adapter.buildCommand(userMessage, this.systemPrompt, {
      sessionId: this.sessionId,
      firstTurn: !this.firstTurnComplete,
      modelOverride: this.agentModelOverride,
    });
    logger.info(`[docker-agent] exec: ${formatCommand(command)}`);

    const execStartMs = Date.now();
    const { exitCode, stdout, stderr } = await this.infra.docker.exec(this.infra.containerId, command, execTimeout);
    const execDurationMs = Date.now() - execStartMs;
    const timeoutLabel = execTimeout != null ? `${execTimeout}ms` : `${DEFAULT_EXEC_TIMEOUT_MS}ms (default)`;
    logger.info(
      `[docker-agent] exit=${exitCode} stdout=${stdout.length}B stderr=${stderr.length}B ` +
        `duration=${execDurationMs}ms timeout=${timeoutLabel}`,
    );
    if (exitCode !== 0) {
      logger.warn(`[docker-agent] non-zero exit code ${exitCode} after ${execDurationMs}ms`);
    }

    if (stderr) {
      logger.info(`[docker-agent] stderr: ${stderr.substring(0, 500)}`);
    }

    this.cumulativeActiveMs += Date.now() - turnStartMs;

    const response = this.infra.adapter.extractResponse(exitCode, stdout);

    if (response.costUsd !== undefined) {
      this.cumulativeCostUsd = response.costUsd;
    }

    const turn: ConversationTurn = {
      turnNumber: this.turns.length + 1,
      userMessage,
      assistantResponse: response.text,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      timestamp: turnStart,
    };
    this.turns.push(turn);

    // Only mark the first turn as complete on success. On a failed turn
    // (non-zero exit), the agent may not have created the session yet, so
    // the next turn must still pin a fresh session id rather than resume.
    if (exitCode === 0) {
      this.firstTurnComplete = true;
    }

    this.status = 'ready';
    return response.text;
  }

  getHistory(): readonly ConversationTurn[] {
    return this.turns;
  }

  getDiagnosticLog(): readonly DiagnosticEvent[] {
    return this.diagnosticLog;
  }

  /** Process any new audit log entries immediately (useful for tests). */
  flushAuditLog(): void {
    this.auditTailer?.readNewEntries();
  }

  getPendingEscalation(): EscalationRequest | undefined {
    return this.escalationWatcher?.getPending();
  }

  getBudgetStatus(): BudgetStatus {
    const elapsedSeconds = this.cumulativeActiveMs / 1000;

    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: this.turns.length,
      elapsedSeconds,
      estimatedCostUsd: this.cumulativeCostUsd,
      limits: this.config.userConfig.resourceBudget,
      cumulative: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        stepCount: this.turns.length,
        activeSeconds: elapsedSeconds,
        estimatedCostUsd: this.cumulativeCostUsd,
      },
      tokenTrackingAvailable: false,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- must be async to satisfy Session interface
  async resolveEscalation(
    escalationId: string,
    decision: 'approved' | 'denied',
    options?: { whitelistSelection?: number },
  ): Promise<void> {
    if (!this.escalationWatcher) {
      throw new Error(`No pending escalation with ID: ${escalationId}`);
    }
    this.escalationWatcher.resolve(escalationId, decision, options);
  }

  async close(): Promise<void> {
    // Session-owned state (status, escalation watcher, audit tailer) is
    // always torn down. Infrastructure teardown is gated on `ownsInfra`:
    // borrow mode leaves the bundle alive for the external owner to
    // destroy via `destroyDockerInfrastructure()`.
    if (this.status === 'closed') return;
    this.status = 'closed';

    this.escalationWatcher?.stop();
    this.auditTailer?.stop();

    if (this.ownsInfra) {
      await destroyDockerInfrastructure(this.infra);
    }
  }

  // --- Private helpers ---

  private emitDiagnostic(event: DiagnosticEvent): void {
    this.diagnosticLog.push(event);
    this.onDiagnostic?.(event);
  }

  private writeUserContext(userMessage: string): void {
    try {
      const contextPath = resolve(this.infra.escalationDir, 'user-context.json');
      atomicWriteJsonSync(contextPath, { userMessage });
    } catch {
      // Ignore write failures
    }
  }
}

/**
 * Returns true if the conversation state dir contains prior Claude Code
 * conversation history beyond the empty seed.
 *
 * On fresh sessions, `prepareConversationStateDir()` seeds an empty
 * `projects/` directory. Claude Code writes transcripts as `.jsonl` files
 * under `projects/<cwd-hash>/`, so we must look inside that tree to detect
 * whether the agent has populated any per-project session files. Seed files
 * (hook scripts, configs) are not considered; only actual conversation
 * history counts as prior content.
 */
function hasConversationStateContent(stateDir: string): boolean {
  try {
    const projectsDir = resolve(stateDir, 'projects');
    if (!existsSync(projectsDir)) return false;
    for (const entry of readdirSync(projectsDir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Formats a command array for logging, truncating long arguments. */
function formatCommand(args: readonly string[]): string {
  const MAX_ARG_LEN = 80;
  return args
    .map((a) => {
      const display = a.length > MAX_ARG_LEN ? `${a.substring(0, MAX_ARG_LEN)}...` : a;
      return a.includes(' ') ? `"${display}"` : display;
    })
    .join(' ');
}
