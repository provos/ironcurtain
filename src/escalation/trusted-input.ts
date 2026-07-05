/**
 * Trusted input for host-mediated PTY sessions (mux terminal multiplexer and
 * the web-ui PTY terminal).
 *
 * Writes user-context.json with a `source: "mux-trusted-input"` field
 * that the auto-approver can check to distinguish trusted input written by the
 * trusted host from context written by the session (which is in-sandbox and
 * untrusted in PTY mode). The `mux-trusted-input` source string is the wire
 * contract the auto-approver checks (see tool-call-pipeline `isUserContextTrusted`);
 * it is kept for both host front-ends.
 */

import { atomicWriteJsonSync } from './escalation-watcher.js';
import { resolve } from 'node:path';

/**
 * The user-context.json schema for mux trusted input.
 */
export interface TrustedUserContext {
  /** The user's message text. */
  readonly userMessage: string;
  /** ISO 8601 timestamp when the input was captured. */
  readonly timestamp: string;
  /** Source identifier. Must be "mux-trusted-input" for auto-approver trust. */
  readonly source: 'mux-trusted-input';
}

/**
 * Writes a trusted user context file to the session's escalation directory.
 * Uses atomicWriteJsonSync for crash-safe writes.
 *
 * @param escalationDir - Absolute path to the session's escalation directory
 * @param userMessage - The user's message text
 */
export function writeTrustedUserContext(escalationDir: string, userMessage: string): void {
  const contextPath = resolve(escalationDir, 'user-context.json');
  const context: TrustedUserContext = {
    userMessage,
    timestamp: new Date().toISOString(),
    source: 'mux-trusted-input',
  };
  atomicWriteJsonSync(contextPath, context);
}
