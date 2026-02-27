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

export class SignalSessionTransport extends BaseTransport {
  private session: Session | null = null;
  private readonly daemon: SignalBotDaemon;
  private exitResolve: (() => void) | null = null;

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
   * Does NOT call daemon.endCurrentSession() - the daemon owns
   * session lifecycle and calls this method, not the other way around.
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
    return (event) => {
      switch (event.kind) {
        case 'tool_call':
          // Don't send every tool call - too noisy for messaging
          break;
        case 'budget_warning':
          this.daemon.sendSignalMessage(`[Budget warning] ${event.message}`).catch(() => {});
          break;
        case 'budget_exhausted':
          this.daemon.sendSignalMessage(`[Budget exhausted] ${event.message}`).catch(() => {});
          break;
      }
    };
  }

  createEscalationHandler(): (request: EscalationRequest) => void {
    return (request) => {
      this.daemon.setPendingEscalation(request.escalationId);
      const banner = formatEscalationBanner(request);
      this.daemon.sendSignalMessage(banner).catch(() => {});
    };
  }

  createEscalationExpiredHandler(): () => void {
    return () => {
      this.daemon.clearPendingEscalation();
      this.daemon.sendSignalMessage('Escalation expired (timed out).').catch(() => {});
    };
  }
}
