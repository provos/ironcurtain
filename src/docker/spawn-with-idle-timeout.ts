/**
 * Runs a child process with an *idle* timeout: the watchdog resets every time
 * the child emits stdout or stderr, and only fires when no output has been
 * seen for `idleTimeoutMs`. This is the right primitive for long-running
 * Docker operations (pull/build) where total wall-clock can legitimately span
 * hours, but a genuine hang means the daemon has stopped emitting progress.
 *
 * The child's stdout/stderr are also piped to the parent's stdout/stderr so
 * the user sees layer downloads / build steps in real time. Today's
 * execFile-based callers buffer everything until exit, which is what makes
 * pulls feel like silent hangs.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export type SpawnFn = (cmd: string, args: readonly string[], options?: SpawnOptions) => ChildProcess;

export interface SpawnWithIdleTimeoutOptions {
  /** Reset-on-output watchdog threshold. Fires SIGTERM (then SIGKILL) when idle. */
  idleTimeoutMs: number;
  /**
   * Label used in error messages so the caller can tell which operation hung
   * (e.g. `"docker pull"`, `"docker build"`).
   */
  operation: string;
  /** Extra env vars merged on top of `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Stream sink for child stdout. Defaults to `process.stdout`. */
  stdoutSink?: NodeJS.WritableStream;
  /** Stream sink for child stderr. Defaults to `process.stderr`. */
  stderrSink?: NodeJS.WritableStream;
  /** Override the underlying spawn implementation (used by tests). */
  spawn?: SpawnFn;
  /** Grace period after SIGTERM before escalating to SIGKILL. Defaults to 2s. */
  killGraceMs?: number;
}

/**
 * Cap on the rolling stderr tail kept for error messages. Measured in JS
 * string length (UTF-16 code units), not UTF-8 bytes — for ASCII-only
 * output (the overwhelming majority of docker stderr) the two are equal;
 * for multi-byte UTF-8 the retained byte count is up to ~3× this value.
 * 4096 is comfortably enough headroom for the short stderr blurbs we
 * actually quote back to the user.
 */
const STDERR_TAIL_CHARS = 4096;

const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * Spawns `cmd args`, streams stdio to the parent terminal, and enforces an
 * idle (not wall-clock) timeout. Resolves on clean exit; rejects on
 * non-zero exit, idle timeout, or spawn error.
 */
export function spawnWithIdleTimeout(
  cmd: string,
  args: readonly string[],
  options: SpawnWithIdleTimeoutOptions,
): Promise<void> {
  const {
    idleTimeoutMs,
    operation,
    env,
    stdoutSink = process.stdout,
    stderrSink = process.stderr,
    spawn = nodeSpawn,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
  } = options;

  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });

    let stderrTail = '';
    let settled = false;
    let exited = false;
    let idleTimer: NodeJS.Timeout | null = null;

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      // Detach data listeners so a SIGTERM-resistant child can't keep
      // spamming the user's terminal (or mutating `stderrTail`) between
      // the promise rejection and the eventual SIGKILL. The kill-escalation
      // setTimeout is left to fire on its own schedule.
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      action();
    };

    const onIdleTimeout = (): void => {
      // Two-phase kill: SIGTERM first, SIGKILL after the grace period for
      // children that ignore SIGTERM. We gate the SIGKILL on our own
      // `exited` flag (set in the `close` handler) rather than on
      // `child.killed`, because Node flips `child.killed` to true the moment
      // a signal is *sent*, not when the child actually exits — using it
      // here would make SIGKILL unreachable in practice. The grace timer is
      // `.unref()`'d so a dropped promise never keeps the Node event loop
      // alive on it alone.
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, killGraceMs).unref();

      settle(() => {
        rejectPromise(
          new Error(
            `${operation} produced no output for ${idleTimeoutMs}ms and was killed. ` +
              `The Docker daemon may be hung or the registry/builder is unresponsive.`,
          ),
        );
      });
    };

    const resetIdleTimer = (): void => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdleTimeout, idleTimeoutMs);
      // Match `killTimer.unref()`: don't keep the event loop alive if the
      // caller drops the promise reference (e.g. a CLI early-exit path).
      idleTimer.unref();
    };

    const forward = (chunk: Buffer | string, sink: NodeJS.WritableStream, captureTail: boolean): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      // Best-effort write; ignore backpressure since stdio piping is informational.
      sink.write(text);
      if (captureTail) {
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
      }
      resetIdleTimer();
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      forward(chunk, stdoutSink, false);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      forward(chunk, stderrSink, true);
    });

    child.on('error', (err: Error) => {
      settle(() => {
        rejectPromise(new Error(`${operation} failed to spawn: ${err.message}`));
      });
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      if (settled) return;
      if (code === 0 && !signal) {
        settle(() => resolvePromise());
        return;
      }
      const tail = stderrTail.trim();
      const tailSuffix = tail ? `: ${tail}` : '';
      const reason = signal ? `killed by signal ${signal}` : `exited with code ${code ?? 'unknown'}`;
      settle(() => {
        rejectPromise(new Error(`${operation} ${reason}${tailSuffix}`));
      });
    });

    // Arm the watchdog. If the child produces no output at all, this fires
    // exactly once at `idleTimeoutMs` from start.
    resetIdleTimer();
  });
}
