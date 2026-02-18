/**
 * Base class for session-related errors. Uses a discriminant
 * `code` field for programmatic handling without instanceof checks.
 */
export class SessionError extends Error {
  constructor(
    message: string,
    public readonly code: SessionErrorCode,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export type SessionErrorCode =
  | 'SESSION_NOT_READY'
  | 'SESSION_CLOSED'
  | 'SESSION_INIT_FAILED';

export class SessionNotReadyError extends SessionError {
  constructor(currentStatus: string) {
    super(
      `Session is not ready to accept messages (current status: ${currentStatus})`,
      'SESSION_NOT_READY',
    );
    this.name = 'SessionNotReadyError';
  }
}

export class SessionClosedError extends SessionError {
  constructor() {
    super('Session has been closed', 'SESSION_CLOSED');
    this.name = 'SessionClosedError';
  }
}
