/**
 * HeadlessTransport -- Minimal transport for headless cron sessions.
 *
 * Unlike SignalSessionTransport which blocks run() indefinitely,
 * HeadlessTransport's run() resolves when the single-shot task
 * message completes. It does not accept follow-up messages.
 *
 * Escalation handling is configured via the constructor:
 * - When an onEscalation callback is provided, escalations are
 *   surfaced and the session waits for external resolution.
 * - When no callback is provided, escalations are auto-denied.
 */

import { BaseTransport } from '../session/base-transport.js';
import type { Session, EscalationRequest, DiagnosticEvent } from '../session/types.js';
import * as logger from '../logger.js';

export interface HeadlessTransportOptions {
  /** The initial task message to send. */
  readonly taskMessage: string;

  /**
   * Optional callback invoked when an escalation is surfaced.
   * When absent, escalations are auto-denied immediately.
   */
  readonly onEscalation?: (request: EscalationRequest) => void;

  /** Optional callback when an escalation expires (proxy timed out). */
  readonly onEscalationExpired?: () => void;

  /** Optional diagnostic event callback. */
  readonly onDiagnostic?: (event: DiagnosticEvent) => void;
}

export class HeadlessTransport extends BaseTransport {
  private readonly taskMessage: string;
  private response: string | undefined;
  private closed = false;

  constructor(options: HeadlessTransportOptions) {
    super();
    this.taskMessage = options.taskMessage;
  }

  protected async runSession(session: Session): Promise<void> {
    if (this.closed) return;

    try {
      logger.info(`[HeadlessTransport] Sending task message (${this.taskMessage.length} chars)`);
      this.response = await this.sendAndLog(session, this.taskMessage);
      logger.info(`[HeadlessTransport] Task completed, response: ${this.response.length} chars`);
    } catch (err) {
      logger.warn(`[HeadlessTransport] Task failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /** Returns the agent's response from the task. */
  getResponse(): string | undefined {
    return this.response;
  }

  close(): void {
    this.closed = true;
  }
}
