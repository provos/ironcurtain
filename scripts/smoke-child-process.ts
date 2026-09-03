import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export interface SmokeChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

export interface WaitForSmokeChildOptions {
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
  const first = await wait(timeoutMs);
  if (first !== undefined) return first;

  const terminate = options.terminate ?? ((signal: NodeJS.Signals) => child.kill(signal));
  terminate('SIGTERM');
  const afterTerm = await wait(options.termGraceMs ?? 60_000);
  if (afterTerm !== undefined) return { ...afterTerm, timedOut: true };

  terminate('SIGKILL');
  const afterKill = await wait(options.killGraceMs ?? 10_000);
  if (afterKill === undefined) throw new Error(`smoke child survived SIGKILL after exceeding ${timeoutMs}ms`);
  return { ...afterKill, timedOut: true };
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
  const terminate =
    options.terminate ??
    ((signal: NodeJS.Signals) => {
      try {
        process.kill(-processGroupId, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    });
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
