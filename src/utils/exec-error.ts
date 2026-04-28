/**
 * Shared types and helpers for failures produced by `child_process.execFile`
 * (and `promisify(execFile)`).
 *
 * `code` carries different shapes depending on the failure mode: a numeric
 * process exit code for non-zero exits, a Node errno string (e.g. `'ENOENT'`)
 * for spawn failures, or `null` when the process was signal-killed (including
 * timeouts, where `killed === true` and `signal === 'SIGTERM'`).
 */

export interface ExecError {
  code: number | string | null;
  stdout: string;
  stderr: string;
  killed?: boolean;
  signal?: string;
  message?: string;
}

export function isExecError(err: unknown): err is ExecError {
  return typeof err === 'object' && err !== null && 'stdout' in err;
}

export function isExecTimeout(err: ExecError): boolean {
  return err.killed === true && err.signal === 'SIGTERM';
}
