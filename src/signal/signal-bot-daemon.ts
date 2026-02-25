/**
 * SignalBotDaemon - long-lived singleton managing the Signal transport.
 *
 * Responsibilities:
 * - WebSocket connection to signal-cli-rest-api with reconnect + exponential backoff
 * - Message routing: authorization, identity verification, escalation replies,
 *   control commands, and session forwarding
 * - Session lifecycle: creates transport+session on demand, cleans up on end
 * - Identity verification with TTL cache (5 min), fail-closed
 * - Escalation state with race prevention
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
import { formatBudgetMessage, formatBudgetSummary, splitMessage, SIGNAL_MAX_MESSAGE_LENGTH } from './format.js';
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

  // Session state - at most one active session at a time
  private activeSession: Session | null = null;
  private activeTransport: SignalSessionTransport | null = null;
  private messageInFlight = false;

  // Escalation state - owned by the daemon because the daemon routes
  // "approve"/"deny" messages before they reach the transport.
  private pendingEscalationId: string | null = null;
  private escalationResolving = false;

  // Identity verification state
  private identityLocked = false;
  private lastIdentityCheckMs = 0;

  // Message deduplication for drainMissedMessages()
  private recentTimestamps = new Set<number>();

  // Resolves when the daemon should exit (shutdown() called)
  private exitResolve: (() => void) | null = null;

  constructor(options: SignalBotDaemonOptions) {
    this.config = options.config;
    this.containerManager = options.containerManager;
    this.mode = options.mode;
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
   * Initiates graceful shutdown. Ends the active session,
   * closes the WebSocket, and unblocks start().
   */
  async shutdown(): Promise<void> {
    logger.info('[Signal Daemon] Shutting down...');
    this.closed = true;
    await this.sendSignalMessage('IronCurtain bot is shutting down. Goodbye.').catch(() => {});
    await this.endCurrentSession();
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

    // Control commands: /quit, /new, /budget, /help
    if (this.handleControlCommand(text)) return;

    // Regular message -> route to session
    await this.routeToSession(text);
  }

  /**
   * Routes a user message to the active session. Creates a new
   * session if none exists. Handles BudgetExhaustedError by ending
   * the exhausted session and notifying the user.
   */
  private async routeToSession(text: string): Promise<void> {
    if (this.messageInFlight) {
      await this.sendSignalMessage('Still processing previous message, please wait...');
      return;
    }

    // Create session on demand
    if (!this.activeSession) {
      try {
        await this.startNewSession();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.sendSignalMessage(`Failed to create session: ${msg}`);
        return;
      }
    }

    const session = this.activeSession;
    if (!session) return;

    this.messageInFlight = true;
    try {
      const response = await session.sendMessage(text);
      const styledText = markdownToSignal(response);
      await this.sendSignalMessage(styledText);
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        const status = session.getBudgetStatus();
        await this.sendSignalMessage(
          `Session budget exhausted: ${error.message}\n` +
            formatBudgetSummary(status) +
            '\n' +
            'Send a new message to start a fresh session.',
        );
        await this.endCurrentSession();
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await this.sendSignalMessage(`Error: ${message}`);
      }
    } finally {
      this.messageInFlight = false;
    }
  }

  // --- Session lifecycle ---

  /**
   * Creates a new session with a fresh SignalSessionTransport.
   * Follows the same pattern as index.ts: create transport,
   * wire callbacks, create session, start transport.
   */
  private async startNewSession(): Promise<void> {
    const transport = new SignalSessionTransport(this);
    this.activeTransport = transport;

    const config = loadConfig();

    const session = await createSession({
      config,
      mode: this.mode,
      onEscalation: transport.createEscalationHandler(),
      onEscalationExpired: transport.createEscalationExpiredHandler(),
      onDiagnostic: transport.createDiagnosticHandler(),
    });

    this.activeSession = session;

    // Start the transport in the background. When it resolves
    // (session closed/budget exhausted), clean up.
    transport
      .run(session)
      .then(() => {
        // Transport exited - session is done
        if (this.activeTransport === transport) {
          this.activeSession = null;
          this.activeTransport = null;
        }
      })
      .catch((err: unknown) => {
        logger.error(`[Signal Daemon] Transport error: ${String(err)}`);
      });

    await this.sendSignalMessage('Started a new session.');
  }

  /**
   * Ends the current session and cleans up. Awaits session.close()
   * to ensure resources are released (sandbox, MCP connections, etc.).
   * Guarded against re-entrance.
   */
  async endCurrentSession(): Promise<void> {
    if (!this.activeSession) return;
    const session = this.activeSession;
    const transport = this.activeTransport;
    this.activeSession = null;
    this.activeTransport = null;
    this.pendingEscalationId = null;
    this.escalationResolving = false;

    // Close transport first (resolves run() promise), then session
    transport?.close();
    await session.close();
  }

  // --- Escalation handling ---

  /**
   * Checks if the message is an escalation reply.
   * Accepts: approve, deny, /approve, /deny (case-insensitive).
   *
   * Race condition prevention: escalationResolving flag prevents
   * concurrent replies. pendingEscalationId is cleared in .finally()
   * after async resolution completes, not before.
   */
  private handleEscalationReply(text: string): boolean {
    if (!this.pendingEscalationId || !this.activeSession) return false;

    const normalized = text.trim().toLowerCase();
    const isApprove = normalized === 'approve' || normalized === '/approve';
    const isDeny = normalized === 'deny' || normalized === '/deny';
    if (!isApprove && !isDeny) return false;

    if (this.escalationResolving) {
      this.sendSignalMessage('Escalation is being resolved, please wait...').catch(() => {});
      return true;
    }

    const decision = isApprove ? ('approved' as const) : ('denied' as const);
    const escalationId = this.pendingEscalationId;
    this.escalationResolving = true;

    this.activeSession
      .resolveEscalation(escalationId, decision)
      .then(() => {
        return this.sendSignalMessage(`Escalation ${decision}.`);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.sendSignalMessage(`Escalation error: ${msg}`).catch(() => {});
      })
      .finally(() => {
        this.escalationResolving = false;
        if (this.pendingEscalationId === escalationId) {
          this.pendingEscalationId = null;
        }
      });

    return true;
  }

  /** Called by SignalSessionTransport when the session surfaces an escalation. */
  setPendingEscalation(escalationId: string): void {
    this.pendingEscalationId = escalationId;
  }

  /** Called by SignalSessionTransport when an escalation expires. */
  clearPendingEscalation(): void {
    this.pendingEscalationId = null;
  }

  // --- Control commands ---

  private handleControlCommand(text: string): boolean {
    const trimmed = text.trim().toLowerCase();

    switch (trimmed) {
      case '/quit':
      case '/exit':
      case '/new':
        this.endCurrentSession()
          .then(() => {
            this.sendSignalMessage('Session ended. Send a message to start a new one.').catch(() => {});
          })
          .catch(() => {});
        return true;

      case '/budget': {
        if (!this.activeSession) {
          this.sendSignalMessage('No active session.').catch(() => {});
          return true;
        }
        const status = this.activeSession.getBudgetStatus();
        this.sendSignalMessage(formatBudgetMessage(status)).catch(() => {});
        return true;
      }

      case '/help':
        this.sendSignalMessage(
          'Commands:\n' +
            '  /quit or /new - end current session\n' +
            '  /budget - show resource usage\n' +
            '  /help - show this message\n' +
            '  approve or /approve - approve pending escalation\n' +
            '  deny or /deny - deny pending escalation',
        ).catch(() => {});
        return true;

      default:
        return false;
    }
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
    this.lastIdentityCheckMs = now;

    try {
      // Use the all-identities endpoint and filter by recipient number.
      // The per-recipient endpoint is not available in all versions.
      const resp = await fetch(
        `${this.baseUrl}/v1/identities/${encodeURIComponent(this.config.botNumber)}`,
      );
      if (!resp.ok) {
        // Fail closed: treat API errors as unverifiable
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
    } catch {
      // Fail closed: reject message when we cannot verify identity
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
