import type { Session } from './types.js';

/**
 * A transport delivers messages between an external source and a session.
 * It is responsible for:
 * - Reading input from its source (stdin, HTTP, WebSocket, etc.)
 * - Calling session.sendMessage() with each input
 * - Delivering the response back to the source
 * - Handling slash commands (including escalation approval)
 * - Signaling when the conversation should end
 *
 * The transport does NOT own the session -- the caller creates the session
 * and passes it to the transport. This allows the same session to be
 * used with different transports (e.g., migrate from CLI to web mid-session).
 */
export interface Transport {
  /**
   * Starts the transport's message loop. Returns when the transport
   * is done (user typed /quit, connection closed, etc.).
   *
   * The transport must handle errors from session.sendMessage()
   * gracefully (display to user, continue accepting input).
   */
  run(session: Session): Promise<void>;

  /**
   * Signals the transport to stop accepting input and unblock run().
   * Called during shutdown so the process can exit cleanly.
   */
  close(): void;
}
