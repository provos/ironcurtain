import type { Transport } from './transport.js';
import type { Session } from './types.js';
import { InteractionLog, type InteractionEntry } from './interaction-log.js';
import { getSessionInteractionLogPath } from '../config/paths.js';

/**
 * Abstract base class for transports that provides interaction logging.
 *
 * Subclasses implement runSession() instead of run(), and use
 * sendAndLog() instead of session.sendMessage() directly.
 */
export abstract class BaseTransport implements Transport {
  private interactionLog: InteractionLog | null = null;
  private turnCounter = 0;

  async run(session: Session): Promise<void> {
    const logPath = getSessionInteractionLogPath(session.getInfo().id);
    this.interactionLog = new InteractionLog(logPath);
    try {
      await this.runSession(session);
    } finally {
      await this.interactionLog.close();
      this.interactionLog = null;
    }
  }

  /** Subclasses implement this instead of run(). */
  protected abstract runSession(session: Session): Promise<void>;

  abstract close(): void;

  /** Sends a message through the session and logs both sides. */
  protected async sendAndLog(session: Session, userMessage: string): Promise<string> {
    const turnNumber = ++this.turnCounter;
    const sessionId = session.getInfo().id;

    this.logEntry({ sessionId, turnNumber, role: 'user', content: userMessage });
    const response = await session.sendMessage(userMessage);
    this.logEntry({ sessionId, turnNumber, role: 'assistant', content: response });

    return response;
  }

  private logEntry(fields: Omit<InteractionEntry, 'timestamp'>): void {
    this.interactionLog?.log({ timestamp: new Date().toISOString(), ...fields });
  }
}
