/**
 * SignalBotDaemon - long-lived singleton managing the Signal transport.
 *
 * Responsibilities:
 * - WebSocket connection to signal-cli-rest-api with reconnect + exponential backoff
 * - Message routing: authorization, identity verification, escalation replies,
 *   control commands, and session forwarding
 * - Multi-session lifecycle: creates transport+session on demand, cleans up on end
 * - Identity verification with TTL cache (5 min), fail-closed
 * - Escalation state with race prevention (per-session)
 * - Message sending via POST /v2/send with text_mode: "styled"
 */

import { createSession } from '../session/index.js';
import { loadConfig } from '../config/index.js';
import { loadUserConfig } from '../config/user-config.js';
import { resolveSignalConfig, type ResolvedSignalConfig } from './signal-config.js';
import type { Session, SessionMode } from '../session/types.js';
import type { SignalContainerManager } from './signal-container.js';
import { SignalSessionTransport } from './signal-transport.js';
import { markdownToSignal } from './markdown-to-signal.js';
import {
  formatBudgetMessage,
  formatBudgetSummary,
  formatSessionList,
  prefixWithLabel,
  splitMessage,
  SIGNAL_MAX_MESSAGE_LENGTH,
  type SessionListEntry,
} from './format.js';
import { BudgetExhaustedError } from '../session/errors.js';
import * as logger from '../logger.js';

/** How often to proactively verify the recipient's identity key (ms). */
const IDENTITY_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// --- Signal envelope types ---

/**
 * Signal message envelope received via WebSocket.
 * Only the fields relevant to IronCurtain are typed here;
 * the full envelope has many more fields (receipts, typing
 * indicators, etc.) that we ignore.
 */
export interface SignalEnvelope {
  /** Sender's phone number or UUID. */
  source?: string;
  /** Sender's phone number (may differ from source in group messages). */
  sourceNumber?: string;
  /** Whether the sender's identity key has changed since last seen by signal-cli. */
  untrustedIdentity?: boolean;
  /** The actual message content, present for data messages. */
  dataMessage?: {
    /** Message text. */
    message?: string;
    /** Timestamp of the message. */
    timestamp?: number;
    /** Group context, if this is a group message. */
    groupInfo?: { groupId: string };
  };
  /** Typing indicator events - ignored. */
  typingMessage?: unknown;
  /** Receipt events - ignored. */
  receiptMessage?: unknown;
}

export interface SignalBotDaemonOptions {
  readonly config: ResolvedSignalConfig;
  readonly containerManager: SignalContainerManager;
  readonly mode: SessionMode;
}

/** Per-session state bundle managed by the daemon. */
interface ManagedSession {
  readonly label: number;
  readonly session: Session;
  readonly transport: SignalSessionTransport;
  messageInFlight: boolean;
  pendingEscalationId: string | null;
  escalationResolving: boolean;
}

export class SignalBotDaemon {
  private config: ResolvedSignalConfig;
  private readonly containerManager: SignalContainerManager;
  private readonly mode: SessionMode;

  // WebSocket state
  private ws: WebSocket | null = null;
  private baseUrl: string = '';
  private closed = false;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_DELAY_MS = 30_000;
  private static readonly BASE_RECONNECT_DELAY_MS = 1_000;

  // Multi-session state
  private sessions = new Map<number, ManagedSession>();
  private currentLabel: number | null = null;
  private nextLabel = 1;
  private readonly maxConcurrentSessions: number;

  // Identity verification state
  private identityLocked = false;
  private lastIdentityCheckMs = 0;

  // Message deduplication for drainMissedMessages()
  private recentTimestamps = new Set<number>();

  // Serializes session-mutating operations (/new, /quit) so that
  // routeToSession() sees the updated currentLabel after the operation completes.
  // Without this, the fire-and-forget WebSocket handler can process a user message
  // concurrently with /new, routing it to the old session.
  private sessionOpInProgress: Promise<void> = Promise.resolve();

  // Resolves when the daemon should exit (shutdown() called)
  private exitResolve: (() => void) | null = null;

  constructor(options: SignalBotDaemonOptions) {
    this.config = options.config;
    this.containerManager = options.containerManager;
    this.mode = options.mode;
    this.maxConcurrentSessions = options.config.maxConcurrentSessions;
  }

  /**
   * Schedules a session-mutating operation (/new, /quit) so that
   * concurrent routeToSession() calls wait for it to complete.
   * Operations are chained to prevent interleaving.
   */
  private scheduleSessionOp(op: () => Promise<void>): void {
    this.sessionOpInProgress = this.sessionOpInProgress.then(op).catch((err: unknown) => {
      logger.error(`[Signal Daemon] Session operation failed: ${String(err)}`);
    });
  }

  /**
   * Starts the daemon. Returns a promise that resolves when
   * shutdown() is called (e.g., SIGTERM/SIGINT).
   */
  async start(): Promise<void> {
    this.baseUrl = await this.containerManager.ensureRunning();
    await this.containerManager.waitForHealthy(this.baseUrl);
    await this.connectWebSocket();
    await this.sendSignalMessage('IronCurtain bot is online. Send a message to begin.');

    // Block until shutdown
    await new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  /**
   * Initiates graceful shutdown. Ends all active sessions,
   * closes the WebSocket, and unblocks start().
   */
  async shutdown(): Promise<void> {
    logger.info('[Signal Daemon] Shutting down...');
    this.closed = true;
    await this.sendSignalMessage('IronCurtain bot is shutting down. Goodbye.').catch(() => {});

    // Wait for any in-flight session operations (e.g., /new) to complete
    await this.sessionOpInProgress.catch(() => {});

    // End all sessions without letting a single failure abort shutdown
    const labels = [...this.sessions.keys()];
    await Promise.allSettled(
      labels.map((label) =>
        this.endSession(label).catch((err: unknown) => {
          logger.error(`[Signal Daemon] Failed to end session #${label} during shutdown: ${String(err)}`);
        }),
      ),
    );

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.exitResolve?.();
  }

  // --- WebSocket connection ---

  private async connectWebSocket(): Promise<void> {
    const wsUrl = `ws://127.0.0.1:${this.config.container.port}/v1/receive/${encodeURIComponent(this.config.botNumber)}`;
    const isReconnect = this.reconnectAttempts > 0;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);

      ws.addEventListener('open', () => {
        this.reconnectAttempts = 0;

        if (isReconnect) {
          this.drainMissedMessages().catch((err: unknown) => {
            logger.info(`[Signal Daemon] Failed to drain missed messages: ${String(err)}`);
          });
        }

        resolve();
      });

      ws.addEventListener('message', (event) => {
        this.handleIncomingMessage(String(event.data)).catch((err: unknown) => {
          logger.error(`[Signal Daemon] Error handling message: ${String(err)}`);
        });
      });

      ws.addEventListener('close', () => {
        if (!this.closed) {
          this.scheduleReconnect();
        }
      });

      ws.addEventListener('error', () => {
        if (this.reconnectAttempts === 0 && !this.ws) {
          reject(new Error('WebSocket connection failed'));
        }
      });

      this.ws = ws;
    });
  }

  /**
   * Polls GET /v1/receive/{number} to drain messages missed during
   * a WebSocket disconnect. Uses timestamp-based deduplication to
   * avoid processing messages that the WebSocket already delivered.
   */
  private async drainMissedMessages(): Promise<void> {
    const url = `${this.baseUrl}/v1/receive/${encodeURIComponent(this.config.botNumber)}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      const messages = (await resp.json()) as unknown[];
      for (const msg of messages) {
        const data = JSON.stringify(msg);
        await this.handleIncomingMessage(data);
      }
    } catch {
      // Best-effort - new messages will arrive via WS
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.reconnectAttempts++;

    const delay = Math.min(
      SignalBotDaemon.BASE_RECONNECT_DELAY_MS * Math.pow(1.5, this.reconnectAttempts),
      SignalBotDaemon.MAX_RECONNECT_DELAY_MS,
    );

    setTimeout(() => {
      if (!this.closed) {
        this.connectWebSocket().catch(() => {
          // Retry will be scheduled by the close handler
        });
      }
    }, delay);
  }

  // --- Message routing ---

  private async handleIncomingMessage(data: string): Promise<void> {
    const envelope = parseSignalEnvelope(data);
    if (!envelope) return;

    // Authorization: only accept messages from the configured user
    if (!isAuthorizedSender(envelope, this.config.recipientNumber)) return;

    // Deduplication: skip messages we've already processed
    const ts = envelope.dataMessage?.timestamp;
    if (ts) {
      if (this.recentTimestamps.has(ts)) return;
      this.recentTimestamps.add(ts);
      // Prune old timestamps (keep last 5 minutes)
      if (this.recentTimestamps.size > 500) {
        const cutoff = Date.now() - 5 * 60 * 1000;
        for (const t of this.recentTimestamps) {
          if (t < cutoff) this.recentTimestamps.delete(t);
        }
      }
    }

    // Identity verification
    if (await this.checkIdentityChanged(envelope)) return;

    const text = envelope.dataMessage?.message;
    if (!text) return;

    // Escalation replies: approve/deny (also accept /approve, /deny)
    if (this.handleEscalationReply(text)) return;

    // Control commands: /quit, /new, /sessions, /switch, /budget, /help
    if (this.handleControlCommand(text)) return;

    // Regular message -> route to session
    await this.routeToSession(text);
  }

  /**
   * Routes a user message to the current session. Creates a new
   * session if none exists. Handles BudgetExhaustedError by ending
   * the exhausted session and notifying the user.
   */
  private async routeToSession(text: string): Promise<void> {
    // Wait for any pending session operation (/new, /quit) to complete
    // before routing, so we see the updated currentLabel.
    await this.sessionOpInProgress;

    // Create session on demand if none exists.
    // Serialize through scheduleSessionOp so concurrent messages don't
    // race to create multiple sessions.
    if (this.currentLabel === null) {
      const createOp = new Promise<void>((resolve, reject) => {
        this.scheduleSessionOp(async () => {
          try {
            // Re-check after serialization — another message may have created one
            if (this.currentLabel === null) {
              await this.startNewSession();
            }
            resolve();
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });
      try {
        await createOp;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.sendSignalMessage(`Failed to create session: ${msg}`);
        return;
      }
    }

    if (this.currentLabel === null) return;
    const managed = this.sessions.get(this.currentLabel);
    if (!managed) return;

    logger.info(
      `[Signal Daemon] Routing message to session #${managed.label} ` +
        `(currentLabel=${this.currentLabel}, sessions=${[...this.sessions.keys()].join(',')}, ` +
        `transportLabel=${managed.transport.sessionLabel})`,
    );

    if (managed.messageInFlight) {
      await this.sendSignalMessage(
        prefixWithLabel('Still processing previous message, please wait...', managed.label, this.sessions.size),
      );
      return;
    }

    managed.messageInFlight = true;
    try {
      const response = await managed.transport.forwardMessage(text);
      const styledText = markdownToSignal(response);
      await this.sendSignalMessage(prefixWithLabel(styledText, managed.label, this.sessions.size));
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        const status = managed.session.getBudgetStatus();
        await this.sendSignalMessage(
          prefixWithLabel(
            `Session budget exhausted: ${error.message}\n` +
              formatBudgetSummary(status) +
              '\n' +
              'Send a new message to start a fresh session.',
            managed.label,
            this.sessions.size,
          ),
        );
        await this.endSession(managed.label);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await this.sendSignalMessage(prefixWithLabel(`Error: ${message}`, managed.label, this.sessions.size));
      }
    } finally {
      managed.messageInFlight = false;
    }
  }

  // --- Session lifecycle ---

  /**
   * Creates a new session with a fresh SignalSessionTransport.
   * Follows the same pattern as index.ts: create transport,
   * wire callbacks, create session, start transport.
   * Returns the label of the new session.
   */
  private async startNewSession(): Promise<number> {
    if (this.sessions.size >= this.maxConcurrentSessions) {
      throw new Error(`Session limit reached (max ${this.maxConcurrentSessions}). Use /quit to end a session first.`);
    }

    const label = this.nextLabel++;
    const transport = new SignalSessionTransport(this);
    transport.sessionLabel = label;

    const config = loadConfig();

    const session = await createSession({
      config,
      mode: this.mode,
      onEscalation: transport.createEscalationHandler(),
      onEscalationExpired: transport.createEscalationExpiredHandler(),
      onDiagnostic: transport.createDiagnosticHandler(),
    });

    const managed: ManagedSession = {
      label,
      session,
      transport,
      messageInFlight: false,
      pendingEscalationId: null,
      escalationResolving: false,
    };

    this.sessions.set(label, managed);
    this.currentLabel = label;

    // Start the transport in the background. When it resolves
    // (session closed/budget exhausted), clean up.
    transport
      .run(session)
      .then(() => {
        // Transport exited - remove session if still present
        if (this.sessions.has(label)) {
          this.sessions.delete(label);
          if (this.currentLabel === label) {
            this.autoSwitchCurrent();
          }
        }
      })
      .catch((err: unknown) => {
        logger.error(`[Signal Daemon] Transport #${label} error: ${String(err)}`);
      });

    await this.sendSignalMessage(prefixWithLabel('Started a new session.', label, this.sessions.size));
    return label;
  }

  /**
   * Ends a specific session by label and cleans up.
   * If it was the current session, auto-switches to the most recent remaining.
   */
  async endSession(label: number): Promise<void> {
    const managed = this.sessions.get(label);
    if (!managed) return;

    this.sessions.delete(label);
    if (this.currentLabel === label) {
      this.autoSwitchCurrent();
    }

    // Close transport first (resolves run() promise), then session
    managed.transport.close();
    await managed.session.close();
  }

  /**
   * Convenience method: ends the current session (if any).
   */
  async endCurrentSession(): Promise<void> {
    if (this.currentLabel === null) return;
    await this.endSession(this.currentLabel);
  }

  /**
   * Auto-switches currentLabel to the highest remaining label (most recent),
   * or null if no sessions remain.
   */
  private autoSwitchCurrent(): void {
    if (this.sessions.size === 0) {
      this.currentLabel = null;
      return;
    }
    this.currentLabel = Math.max(...this.sessions.keys());
  }

  // --- Escalation handling ---

  /**
   * Checks if the message is an escalation reply.
   * Accepts: approve, deny, /approve, /deny (case-insensitive).
   * Optionally with a session label: "approve #2", "/approve 2".
   *
   * Routes to the session with a pending escalation. If multiple
   * sessions have pending escalations and no label is specified,
   * asks for disambiguation.
   */
  private handleEscalationReply(text: string): boolean {
    const normalized = text.trim().toLowerCase();

    // Parse: approve, /approve, approve #2, /approve 2, deny, /deny, etc.
    const match = normalized.match(/^\/?(approve|deny)(?:\s+#?(\d+))?$/);
    if (!match) return false;

    const isApprove = match[1] === 'approve';
    const explicitLabel = match[2] ? parseInt(match[2], 10) : null;

    // Find sessions with pending escalations
    const pending: ManagedSession[] = [];
    for (const managed of this.sessions.values()) {
      if (managed.pendingEscalationId) {
        pending.push(managed);
      }
    }

    if (pending.length === 0) return false;

    // Determine target session
    let target: ManagedSession | undefined;
    if (explicitLabel !== null) {
      target = this.sessions.get(explicitLabel);
      if (!target?.pendingEscalationId) {
        this.sendSignalMessage(`Session #${explicitLabel} has no pending escalation.`).catch(() => {});
        return true;
      }
    } else if (pending.length === 1) {
      target = pending[0];
    } else {
      // Multiple pending - need disambiguation
      const labels = pending.map((m) => `#${m.label}`).join(', ');
      this.sendSignalMessage(`Multiple escalations pending (${labels}). Specify: \`approve #N\` or \`deny #N\``).catch(
        () => {},
      );
      return true;
    }

    if (target.escalationResolving) {
      this.sendSignalMessage('Escalation is being resolved, please wait...').catch(() => {});
      return true;
    }

    const decision = isApprove ? ('approved' as const) : ('denied' as const);
    const escalationId = target.pendingEscalationId as string; // guarded by early returns above
    // Capture in a const so TypeScript narrows inside async closures below
    const managed = target;
    managed.escalationResolving = true;

    managed.session
      .resolveEscalation(escalationId, decision)
      .then(() => {
        return this.sendSignalMessage(prefixWithLabel(`Escalation ${decision}.`, managed.label, this.sessions.size));
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.sendSignalMessage(prefixWithLabel(`Escalation error: ${msg}`, managed.label, this.sessions.size)).catch(
          () => {},
        );
      })
      .finally(() => {
        managed.escalationResolving = false;
        if (managed.pendingEscalationId === escalationId) {
          managed.pendingEscalationId = null;
        }
      });

    return true;
  }

  /** Called by SignalSessionTransport when the session surfaces an escalation. */
  setPendingEscalation(label: number, escalationId: string): void {
    const managed = this.sessions.get(label);
    if (managed) {
      managed.pendingEscalationId = escalationId;
      logger.info(`[Signal Daemon] Escalation ${escalationId} set on session #${label}`);
    } else {
      logger.error(
        `[Signal Daemon] setPendingEscalation: no session #${label} in map (keys: ${[...this.sessions.keys()].join(',')})`,
      );
    }
  }

  /** Called by SignalSessionTransport when an escalation expires. */
  clearPendingEscalation(label: number): void {
    const managed = this.sessions.get(label);
    if (managed) {
      managed.pendingEscalationId = null;
    }
  }

  // --- Control commands ---

  private handleControlCommand(text: string): boolean {
    const lower = text.trim().toLowerCase();

    // /quit [N] or /exit [N]
    const quitMatch = lower.match(/^\/(quit|exit)(?:\s+#?(\d+))?$/);
    if (quitMatch) {
      const explicitLabel = quitMatch[2] ? parseInt(quitMatch[2], 10) : null;
      this.scheduleSessionOp(async () => {
        const labelToEnd = explicitLabel ?? this.currentLabel;

        if (labelToEnd === null) {
          await this.sendSignalMessage('No active session.');
          return;
        }
        if (!this.sessions.has(labelToEnd)) {
          await this.sendSignalMessage(`No session #${labelToEnd}.`);
          return;
        }

        const wasCurrent = labelToEnd === this.currentLabel;
        await this.endSession(labelToEnd);

        if (wasCurrent && this.sessions.size > 0 && this.currentLabel !== null) {
          await this.sendSignalMessage(`Session #${labelToEnd} ended. Switched to #${this.currentLabel}.`);
        } else if (this.sessions.size > 0) {
          await this.sendSignalMessage(`Session #${labelToEnd} ended.`);
        } else {
          await this.sendSignalMessage('Session ended. Send a message to start a new one.');
        }
      });
      return true;
    }

    // /new
    if (lower === '/new') {
      this.scheduleSessionOp(async () => {
        try {
          await this.startNewSession();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.sendSignalMessage(msg);
        }
      });
      return true;
    }

    // /sessions
    if (lower === '/sessions') {
      const entries: SessionListEntry[] = Array.from(this.sessions.values(), (managed) => {
        const budget = managed.session.getBudgetStatus();
        const maxTokens = budget.limits.maxTotalTokens;
        return {
          label: managed.label,
          turnCount: managed.session.getInfo().turnCount,
          budgetPercent: maxTokens ? Math.round((budget.totalTokens / maxTokens) * 100) : 0,
        };
      });
      this.sendSignalMessage(formatSessionList(entries, this.currentLabel)).catch(() => {});
      return true;
    }

    // /switch N
    const switchMatch = lower.match(/^\/switch\s+#?(\d+)$/);
    if (switchMatch) {
      const label = parseInt(switchMatch[1], 10);
      this.scheduleSessionOp(async () => {
        if (!this.sessions.has(label)) {
          await this.sendSignalMessage(`No session #${label}.`);
        } else {
          this.currentLabel = label;
          await this.sendSignalMessage(`Switched to session #${label}.`);
        }
      });
      return true;
    }

    // /budget [N]
    const budgetMatch = lower.match(/^\/budget(?:\s+#?(\d+))?$/);
    if (budgetMatch) {
      const label = budgetMatch[1] ? parseInt(budgetMatch[1], 10) : this.currentLabel;
      if (label === null) {
        this.sendSignalMessage('No active session.').catch(() => {});
      } else {
        const managed = this.sessions.get(label);
        if (!managed) {
          this.sendSignalMessage(`No session #${label}.`).catch(() => {});
        } else {
          const status = managed.session.getBudgetStatus();
          this.sendSignalMessage(prefixWithLabel(formatBudgetMessage(status), label, this.sessions.size)).catch(
            () => {},
          );
        }
      }
      return true;
    }

    // /help
    if (lower === '/help') {
      this.sendSignalMessage(
        'Commands:\n' +
          '  /new - start a new session\n' +
          '  /sessions - list active sessions\n' +
          '  /switch N - switch to session #N\n' +
          '  /quit [N] - end session (current or #N)\n' +
          '  /budget [N] - show resource usage\n' +
          '  /help - show this message\n' +
          '  approve [#N] - approve pending escalation\n' +
          '  deny [#N] - deny pending escalation',
      ).catch(() => {});
      return true;
    }

    return false;
  }

  // --- Identity verification ---

  /**
   * Checks whether the sender's Signal identity key has changed.
   *
   * Detection path 1: signal-cli flags the envelope with `untrustedIdentity`.
   * Detection path 2: periodic proactive check via GET /v1/identities.
   *   Cached with IDENTITY_CHECK_INTERVAL_MS TTL to avoid HTTP overhead
   *   on every message.
   *
   * When locked, attempts self-healing by re-reading config from disk
   * (handles the case where the user ran `--re-trust` externally).
   *
   * Returns true if the message should be rejected.
   */
  async checkIdentityChanged(envelope: SignalEnvelope): Promise<boolean> {
    // If locked, attempt self-healing via config reload
    if (this.identityLocked) {
      try {
        const freshUserConfig = loadUserConfig();
        const freshSignal = resolveSignalConfig(freshUserConfig);
        if (freshSignal && freshSignal.recipientIdentityKey !== this.config.recipientIdentityKey) {
          logger.info('[Signal Daemon] Detected new identity key on disk. Unlocking.');
          this.config = freshSignal;
          this.identityLocked = false;
        }
      } catch {
        logger.error('[Signal Daemon] Failed to reload config during lock check.');
      }
      if (this.identityLocked) return true;
    }

    // Detection path 1: envelope flag (real-time)
    if (envelope.untrustedIdentity) {
      this.lockTransport('Identity key change detected via envelope flag.');
      return true;
    }

    // Detection path 2: proactive API check (periodic, TTL-cached)
    const now = Date.now();
    if (now - this.lastIdentityCheckMs < IDENTITY_CHECK_INTERVAL_MS) {
      return false; // Within TTL, skip API call
    }

    try {
      // Use the all-identities endpoint and filter by recipient number.
      // The per-recipient endpoint is not available in all versions.
      const resp = await fetch(`${this.baseUrl}/v1/identities/${encodeURIComponent(this.config.botNumber)}`);
      if (!resp.ok) {
        // Fail closed: treat API errors as unverifiable.
        // Don't update lastIdentityCheckMs so the next message retries.
        logger.error(
          `[Signal Daemon] Identity check API returned ${resp.status}. ` +
            'Rejecting message (fail-closed). Check signal-cli container health.',
        );
        return true;
      }
      const identities = (await resp.json()) as Array<{ number: string; fingerprint: string }>;
      const current = identities.find((id) => id.number === this.config.recipientNumber);
      // Normalize fingerprint (signal-cli may return space-separated hex)
      const currentFp = current?.fingerprint.replace(/\s+/g, '');
      if (currentFp && currentFp !== this.config.recipientIdentityKey) {
        this.lockTransport(
          `Identity key mismatch.\n` +
            `  Expected: ${this.config.recipientIdentityKey.substring(0, 20)}...\n` +
            `  Received: ${currentFp.substring(0, 20)}...`,
        );
        return true;
      }
      // Only cache success - failures will retry on the next message
      this.lastIdentityCheckMs = now;
    } catch {
      // Fail closed: reject message when we cannot verify identity.
      // Don't update lastIdentityCheckMs so the next message retries.
      logger.error(
        '[Signal Daemon] Identity check API unavailable. ' +
          'Rejecting message (fail-closed). Check signal-cli container health.',
      );
      return true;
    }

    return false;
  }

  private lockTransport(reason: string): void {
    this.identityLocked = true;
    logger.error(
      `[Signal Daemon] LOCKED: ${reason}\n` +
        `The Signal identity key for ${this.config.recipientNumber} has changed.\n` +
        `All messages are being rejected until re-trust is completed.\n` +
        `Run: ironcurtain setup-signal --re-trust`,
    );
  }

  // --- Message sending ---

  async sendSignalMessage(text: string): Promise<void> {
    const chunks = splitMessage(text, SIGNAL_MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await this.postMessage(chunk);
    }
  }

  private async postMessage(text: string): Promise<void> {
    const body: Record<string, unknown> = {
      message: text,
      number: this.config.botNumber,
      recipients: [this.config.recipientNumber],
      text_mode: 'styled',
    };

    const resp = await fetch(`${this.baseUrl}/v2/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Signal send failed: ${resp.status} ${errBody}`);
    }
  }
}

// --- Envelope parsing and authorization ---

export function parseSignalEnvelope(data: string): SignalEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // json-rpc mode wraps the envelope
    const record = parsed as Record<string, unknown>;
    const envelope = (record.envelope ?? parsed) as SignalEnvelope;
    return envelope;
  } catch {
    return null;
  }
}

/** Normalize a phone number by stripping spaces. */
export function normalizePhoneNumber(number: string): string {
  return number.replace(/\s+/g, '');
}

export function isAuthorizedSender(envelope: SignalEnvelope, recipientNumber: string): boolean {
  const sender = envelope.sourceNumber ?? envelope.source;
  if (!sender) return false;
  return normalizePhoneNumber(sender) === normalizePhoneNumber(recipientNumber);
}
