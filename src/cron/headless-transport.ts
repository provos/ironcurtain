/**
 * HeadlessTransport -- Minimal transport for headless cron sessions.
 *
 * Unlike SignalSessionTransport which blocks run() indefinitely,
 * HeadlessTransport's run() resolves when the single-shot task
 * message completes. It does not accept follow-up messages.
 *
 * Escalations raised during the cron session follow the normal
 * daemon escalation resolution path and will be auto-denied
 * if no human approval is provided within the timeout.
 */

import { BaseTransport } from '../session/base-transport.js';
import type { Session } from '../session/types.js';
import * as logger from '../logger.js';

export interface HeadlessTransportOptions {
  /** The initial task message to send. */
  readonly taskMessage: string;
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
