/**
 * Types for PTY session management and the escalation listener.
 */

/** Registration file written by PTY sessions for the escalation listener. */
export interface PtySessionRegistration {
  /** Unique session identifier (SessionId). */
  readonly sessionId: string;
  /** Absolute path to the session's escalation directory. */
  readonly escalationDir: string;
  /** Human-readable label for TUI display. */
  readonly label: string;
  /** ISO 8601 timestamp when the session started. */
  readonly startedAt: string;
  /** PID of the ironcurtain process managing this session. */
  readonly pid: number;
}

/** Well-known directory for PTY session registration files. */
export const PTY_REGISTRY_DIR_NAME = 'pty-registry';

/** Lock file name for single-instance enforcement. */
export const LISTENER_LOCK_FILE = 'escalation-listener.lock';

/** PTY socket filename (Linux UDS mode). */
export const PTY_SOCK_NAME = 'pty.sock';

/** Default PTY port inside the container (macOS TCP mode only). */
export const DEFAULT_PTY_PORT = 19000;
