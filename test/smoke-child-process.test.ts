import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { reapSmokeProcessGroup, waitForSmokeChild } from '../scripts/smoke-child-process.js';

function fakeChild(): ChildProcess {
  return new EventEmitter() as ChildProcess;
}

describe('smoke child process lifecycle', () => {
  it('returns an ordinary clean exit without sending a signal', async () => {
    const child = fakeChild();
    const terminate = vi.fn();
    const waiting = waitForSmokeChild(child, 1_000, { terminate });

    child.emit('exit', 0, null);

    await expect(waiting).resolves.toEqual({ code: 0, signal: null, timedOut: false });
    expect(terminate).not.toHaveBeenCalled();
  });

  it('waits through TERM and escalates a timed-out child to KILL', async () => {
    const child = fakeChild();
    const signals: NodeJS.Signals[] = [];
    const waiting = waitForSmokeChild(child, 1, {
      termGraceMs: 1,
      killGraceMs: 1_000,
      terminate: (signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') child.emit('exit', null, signal);
      },
    });

    await expect(waiting).resolves.toEqual({ code: null, signal: 'SIGKILL', timedOut: true });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('accepts an already-empty detached process group', async () => {
    const terminate = vi.fn();

    await expect(reapSmokeProcessGroup(123, { isAlive: () => false, terminate, cleanWaitMs: 0 })).resolves.toEqual({
      leaked: false,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it('cleans and reports a surviving detached process group', async () => {
    let alive = true;
    const terminate = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGTERM') alive = false;
    });

    await expect(
      reapSmokeProcessGroup(123, {
        isAlive: () => alive,
        terminate,
        cleanWaitMs: 0,
        termGraceMs: 0,
      }),
    ).resolves.toEqual({ leaked: true });
    expect(terminate).toHaveBeenCalledWith('SIGTERM');
  });
});
