/**
 * Web session transport -- bridges session events to the WebEventBus.
 *
 * Follows the same pattern as SignalSessionTransport: run() blocks
 * until close() is called, forwardMessage() routes input through
 * the session, and callback factories emit events to the event bus.
 */

import { BaseTransport, type BaseTransportOptions } from '../session/base-transport.js';
import type { Session, DiagnosticEvent, EscalationRequest } from '../session/types.js';
import type { SessionManager, PendingEscalationData } from '../session/session-manager.js';
import type { WebEventBus } from './web-event-bus.js';
import type { EscalationDto } from './web-ui-types.js';
import * as logger from '../logger.js';

export interface WebSessionTransportOptions extends BaseTransportOptions {
  readonly eventBus: WebEventBus;
  readonly sessionManager: SessionManager;
}

export class WebSessionTransport extends BaseTransport {
  private session: Session | null = null;
  private readonly eventBus: WebEventBus;
  private readonly sessionManager: SessionManager;
  private exitResolve: (() => void) | null = null;

  /** Session label assigned after construction. */
  sessionLabel = 0;

  constructor(options: WebSessionTransportOptions) {
    super(options);
    this.eventBus = options.eventBus;
    this.sessionManager = options.sessionManager;
  }

  protected async runSession(session: Session): Promise<void> {
    this.session = session;
    return new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  close(): void {
    this.session = null;
    this.exitResolve?.();
    this.exitResolve = null;
  }

  async forwardMessage(text: string): Promise<string> {
    if (!this.session) throw new Error('No active session');
    return this.sendAndLog(this.session, text);
  }

  // --- Callback factories (wired into SessionOptions) ---

  createDiagnosticHandler(): (event: DiagnosticEvent) => void {
    return (event) => {
      switch (event.kind) {
        case 'tool_call':
          this.eventBus.emit('session.tool_call', {
            label: this.sessionLabel,
            toolName: event.toolName,
            preview: event.preview,
          });
          break;
        case 'agent_text':
          this.eventBus.emit('session.text_delta', {
            label: this.sessionLabel,
            preview: event.preview,
          });
          break;
        case 'step_finish':
          this.eventBus.emit('session.tool_result', {
            label: this.sessionLabel,
            toolName: '',
            stepIndex: event.stepIndex,
          });
          break;
      }
    };
  }

  createEscalationHandler(): (request: EscalationRequest) => void {
    return (request) => {
      logger.info(
        `[Web Transport] Escalation fired on session #${this.sessionLabel} ` +
          `(tool=${request.serverName}/${request.toolName}, id=${request.escalationId})`,
      );

      const escalationData: PendingEscalationData = {
        escalationId: request.escalationId,
        sessionLabel: this.sessionLabel,
        toolName: request.toolName,
        serverName: request.serverName,
        arguments: request.arguments,
        reason: request.reason,
        context: request.context as Record<string, string> | undefined,
        receivedAt: new Date().toISOString(),
      };

      this.sessionManager.setPendingEscalation(this.sessionLabel, escalationData);

      const dto: EscalationDto = {
        ...escalationData,
        sessionSource: { kind: 'web' },
        whitelistCandidates: request.whitelistCandidates,
      };
      this.eventBus.emit('escalation.created', dto);
    };
  }

  createEscalationResolvedHandler(): (escalationId: string, decision: string) => void {
    return (escalationId, decision) => {
      this.eventBus.emit('escalation.resolved', {
        escalationId,
        decision: decision as 'approved' | 'denied',
      });
    };
  }

  createEscalationExpiredHandler(): () => void {
    return () => {
      const managed = this.sessionManager.get(this.sessionLabel);
      const escalationId = managed?.pendingEscalation?.escalationId ?? 'unknown';
      this.sessionManager.clearPendingEscalation(this.sessionLabel);
      this.eventBus.emit('escalation.expired', {
        escalationId,
        sessionLabel: this.sessionLabel,
      });
    };
  }
}
