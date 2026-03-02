/**
 * Trusted input module for the terminal multiplexer.
 *
 * Writes user-context.json with a `source: "mux-trusted-input"` field
 * that the auto-approver can check to distinguish trusted input from
 * context written by the session (which is in-sandbox and untrusted
 * in PTY mode).
 */

import { atomicWriteJsonSync } from '../escalation/escalation-watcher.js';
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
