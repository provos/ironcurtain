import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const QUALIFICATION_TERM_GRACE_MS = 60_000;
export const QUALIFICATION_KILL_GRACE_MS = 10_000;
const QUALIFICATION_OUTPUT_DRAIN_MS = 5_000;

export class QualificationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`qualification child timed out after ${timeoutMs}ms`);
    this.name = 'QualificationTimeoutError';
  }
}

export interface SmokeChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

export interface WaitForSmokeChildOptions {
  readonly signal?: AbortSignal;
  readonly terminate?: (signal: NodeJS.Signals) => void;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
}

export interface ReapSmokeProcessGroupOptions {
  readonly isAlive?: () => boolean;
  readonly terminate?: (signal: NodeJS.Signals) => void;
  readonly cleanWaitMs?: number;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  readonly pollMs?: number;
}

/** Wait for one smoke child and bound teardown with TERM, then KILL. */
export async function waitForSmokeChild(
  child: ChildProcess,
  timeoutMs: number,
  options: WaitForSmokeChildOptions = {},
): Promise<SmokeChildExit> {
  const exitPromise = new Promise<SmokeChildExit>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal, timedOut: false }));
  });
  const wait = (milliseconds: number): Promise<SmokeChildExit | undefined> =>
    Promise.race([exitPromise, delay(milliseconds, undefined, { ref: false }).then(() => undefined)]);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolvePromise) => {
    onAbort = () => resolvePromise('aborted');
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const first = await Promise.race([wait(timeoutMs), aborted]);
    if (first !== undefined && first !== 'aborted') return first;

    const timedOut = first !== 'aborted';
    const terminate = options.terminate ?? ((signal: NodeJS.Signals) => child.kill(signal));
    terminate(!timedOut && options.signal?.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    const afterTerm = await wait(options.termGraceMs ?? QUALIFICATION_TERM_GRACE_MS);
    if (afterTerm !== undefined) return { ...afterTerm, timedOut };

    terminate('SIGKILL');
    const afterKill = await wait(options.killGraceMs ?? QUALIFICATION_KILL_GRACE_MS);
    if (afterKill === undefined) throw new Error('smoke child survived SIGKILL during bounded teardown');
    return { ...afterKill, timedOut };
  } finally {
    if (onAbort !== undefined) options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Own a detached qualification child's whole process group until it is empty. */
export async function waitForQualificationProcess(
  child: ChildProcess,
  timeoutMs: number,
  options: Omit<WaitForSmokeChildOptions, 'terminate'> = {},
): Promise<SmokeChildExit> {
  if (child.pid === undefined) {
    // Failed spawn emits error asynchronously even though no group was created.
    child.once('error', () => undefined);
    throw new Error('qualification child has no process group ID');
  }
  const processGroupId = child.pid;
  let onClose: (() => void) | undefined;
  const closed = new Promise<boolean>((resolvePromise) => {
    onClose = () => resolvePromise(true);
    child.once('close', onClose);
  });
  const terminate = (signal: NodeJS.Signals): void => signalProcessGroup(processGroupId, signal);
  const cancellation = new AbortController();
  const onSigint = (): void => cancellation.abort('SIGINT');
  const onSigterm = (): void => cancellation.abort('SIGTERM');
  const onAbort = (): void => cancellation.abort(options.signal?.reason);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted === true) onAbort();
  try {
    let exit: SmokeChildExit | undefined;
    let waitFailure: Error | undefined;
    try {
      exit = await waitForSmokeChild(child, timeoutMs, { ...options, signal: cancellation.signal, terminate });
    } catch (error) {
      waitFailure = error instanceof Error ? error : new Error(String(error));
    }
    let group: Awaited<ReturnType<typeof reapSmokeProcessGroup>>;
    try {
      group = await reapSmokeProcessGroup(processGroupId, {
        terminate,
        cleanWaitMs: cancellation.signal.aborted || waitFailure !== undefined ? 0 : undefined,
      });
    } catch (error) {
      if (waitFailure !== undefined) {
        throw new AggregateError([waitFailure, error], 'qualification wait and process-group cleanup failed', {
          cause: error,
        });
      }
      throw error;
    }
    // Exiting the process group does not close pipes inherited by a detached
    // descendant. Preserve final output, but bound draining for every caller.
    const drained = await Promise.race([closed, delay(QUALIFICATION_OUTPUT_DRAIN_MS, false, { ref: false })]);
    if (waitFailure !== undefined) throw waitFailure;
    if (cancellation.signal.aborted) {
      const reason: unknown = cancellation.signal.reason;
      throw reason instanceof Error ? reason : new Error(`qualification interrupted by ${String(reason)}`);
    }
    if (exit === undefined) throw new Error('qualification child ended without an exit result');
    if (exit.timedOut) throw new QualificationTimeoutError(timeoutMs);
    if (group.leaked) throw new Error('qualification child leaked a descendant process');
    if (!drained) throw new Error('qualification child output pipes did not close during bounded teardown');
    return exit;
  } finally {
    if (onClose !== undefined) child.removeListener('close', onClose);
    child.stdout?.destroy();
    child.stderr?.destroy();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Prove a detached smoke's process group is empty, cleaning and reporting any leak. */
export async function reapSmokeProcessGroup(
  processGroupId: number,
  options: ReapSmokeProcessGroupOptions = {},
): Promise<{ readonly leaked: boolean }> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    throw new Error('smoke process group ID is invalid');
  }
  const isAlive = options.isAlive ?? (() => processGroupIsAlive(processGroupId));
  const terminate = options.terminate ?? ((signal: NodeJS.Signals) => signalProcessGroup(processGroupId, signal));
  const waitUntilEmpty = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (isAlive()) {
      if (Date.now() >= deadline) return false;
      await delay(options.pollMs ?? 50);
    }
    return true;
  };

  if (await waitUntilEmpty(options.cleanWaitMs ?? 5_000)) return { leaked: false };
  terminate('SIGTERM');
  if (await waitUntilEmpty(options.termGraceMs ?? 5_000)) return { leaked: true };
  terminate('SIGKILL');
  if (!(await waitUntilEmpty(options.killGraceMs ?? 5_000))) {
    throw new Error(`smoke process group ${processGroupId} survived SIGKILL`);
  }
  return { leaked: true };
}

function processGroupIsAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
