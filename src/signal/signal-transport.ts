/**
 * Signal session transport - thin adapter implementing the Transport interface.
 *
 * One SignalSessionTransport exists per session. It does not own the
 * WebSocket or manage identity verification - those responsibilities
 * belong to the SignalBotDaemon. The transport's job is to:
 *
 * 1. Block run() until close() is called (session lifetime)
 * 2. Create callback factories that bridge session events to the daemon
 */

import { BaseTransport } from '../session/base-transport.js';
import type { Session, DiagnosticEvent, EscalationRequest } from '../session/types.js';
import type { SignalBotDaemon } from './signal-bot-daemon.js';
import { formatEscalationBanner } from './format.js';
import * as logger from '../logger.js';

export class SignalSessionTransport extends BaseTransport {
  private session: Session | null = null;
  private readonly daemon: SignalBotDaemon;
  private exitResolve: (() => void) | null = null;

  /** Session label assigned by the daemon after construction. */
  sessionLabel = 0;

  constructor(daemon: SignalBotDaemon) {
    super();
    this.daemon = daemon;
  }

  /**
   * Implements the session lifecycle. The returned promise resolves when
   * close() is called, which signals that the session is done.
   */
  protected async runSession(session: Session): Promise<void> {
    this.session = session;
    return new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  /**
   * Signals the transport to stop. Resolves the run() promise.
   * Does NOT call daemon.endSession() - the daemon owns session
   * lifecycle and calls this method, not the other way around.
   */
  close(): void {
    this.session = null;
    this.exitResolve?.();
    this.exitResolve = null;
  }

  /**
   * Forwards a message through the transport's sendAndLog() pipeline.
   * Called by the daemon to route user messages through the transport layer.
   */
  async forwardMessage(text: string): Promise<string> {
    if (!this.session) {
      throw new Error('No active session');
    }
    return this.sendAndLog(this.session, text);
  }

  // --- Callback factories (wired into SessionOptions by the daemon) ---

  createDiagnosticHandler(): (event: DiagnosticEvent) => void {
    const label = this.sessionLabel;
    return (event) => {
      switch (event.kind) {
        case 'tool_call':
          // Don't send every tool call - too noisy for messaging
          break;
        case 'budget_warning':
          this.daemon.sendSignalMessage(`[#${label}] [Budget warning] ${event.message}`).catch(() => {});
          break;
        case 'budget_exhausted':
          this.daemon.sendSignalMessage(`[#${label}] [Budget exhausted] ${event.message}`).catch(() => {});
          break;
      }
    };
  }

  createEscalationHandler(): (request: EscalationRequest) => void {
    const label = this.sessionLabel;
    return (request) => {
      const currentLabel = this.sessionLabel;
      if (currentLabel !== label) {
        logger.error(
          `[Signal Transport] LABEL MISMATCH: escalation handler created for #${label} ` +
            `but this.sessionLabel is now #${currentLabel} (escalationId=${request.escalationId})`,
        );
      }
      logger.info(
        `[Signal Transport] Escalation fired on session #${label} ` +
          `(tool=${request.serverName}/${request.toolName}, id=${request.escalationId})`,
      );
      this.daemon.setPendingEscalation(label, request.escalationId);
      const banner = formatEscalationBanner(request, label);
      this.daemon.sendSignalMessage(banner).catch(() => {});
    };
  }

  createEscalationExpiredHandler(): () => void {
    const label = this.sessionLabel;
    return () => {
      this.daemon.clearPendingEscalation(label);
      this.daemon.sendSignalMessage('Escalation expired (timed out).').catch(() => {});
    };
  }
}
