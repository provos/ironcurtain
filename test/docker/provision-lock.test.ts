import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { withProvisionLock } from '../../src/docker/provision-lock.js';

describe('withProvisionLock', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'provision-lock-'));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(`${cacheDir}.lock`, { recursive: true, force: true });
  });

  it('runs the critical section and releases the lock afterward', async () => {
    let ran = false;
    const result = await withProvisionLock(cacheDir, async () => {
      ran = true;
      // Lock dir exists while held.
      expect(existsSync(`${cacheDir}.lock`)).toBe(true);
      return 'done';
    });

    expect(ran).toBe(true);
    expect(result).toBe('done');
    // Lock released after the critical section.
    expect(existsSync(`${cacheDir}.lock`)).toBe(false);
  });

  it('releases the lock even when the critical section throws', async () => {
    await expect(
      withProvisionLock(cacheDir, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(existsSync(`${cacheDir}.lock`)).toBe(false);
  });

  it('serializes two concurrent critical sections on the same cache dir', async () => {
    const events: string[] = [];
    const enter = (tag: string) => events.push(`enter-${tag}`);
    const exit = (tag: string) => events.push(`exit-${tag}`);

    const slow = withProvisionLock(cacheDir, async () => {
      enter('A');
      await new Promise((r) => setTimeout(r, 150));
      exit('A');
    });
    // Start B shortly after A so A wins the lock first.
    await new Promise((r) => setTimeout(r, 20));
    const fast = withProvisionLock(cacheDir, async () => {
      enter('B');
      exit('B');
    });

    await Promise.all([slow, fast]);

    // B must not interleave inside A's critical section.
    expect(events).toEqual(['enter-A', 'exit-A', 'enter-B', 'exit-B']);
  });

  it('lets concurrent sections on DIFFERENT cache dirs run in parallel', async () => {
    const other = mkdtempSync(join(tmpdir(), 'provision-lock-other-'));
    try {
      const events: string[] = [];
      const a = withProvisionLock(cacheDir, async () => {
        events.push('enter-A');
        await new Promise((r) => setTimeout(r, 100));
        events.push('exit-A');
      });
      const b = withProvisionLock(other, async () => {
        events.push('enter-B');
        events.push('exit-B');
      });
      await Promise.all([a, b]);
      // Distinct locks → B runs while A is still sleeping (interleaved).
      expect(events.indexOf('enter-B')).toBeLessThan(events.indexOf('exit-A'));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('times out when the lock cannot be acquired within maxWaitMs', async () => {
    // Hold the lock for longer than the waiter's tolerance.
    const holder = withProvisionLock(cacheDir, async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await new Promise((r) => setTimeout(r, 20));

    await expect(withProvisionLock(cacheDir, async () => 'never', { maxWaitMs: 100, staleMs: 60_000 })).rejects.toThrow(
      /Failed to acquire workflow provisioning lock/,
    );

    await holder;
  });

  it('does not steal a freshly-created lock dir that has no meta.json yet (mkdir→write race)', async () => {
    // Simulate a holder that has created the lock dir but not yet written meta.json.
    mkdirSync(`${cacheDir}.lock`);
    // A waiter must treat the fresh meta-less dir as held (mid-acquisition), not stale.
    await expect(
      withProvisionLock(cacheDir, async () => 'stolen', { maxWaitMs: 100, staleMs: 60_000 }),
    ).rejects.toThrow(/Failed to acquire workflow provisioning lock/);
  });

  it('reclaims an orphaned meta-less lock dir older than the grace window', async () => {
    const lockDir = `${cacheDir}.lock`;
    mkdirSync(lockDir);
    // Backdate the dir mtime past ACQUIRE_GRACE_MS to simulate a holder that
    // crashed between mkdir and the meta.json write.
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);
    const result = await withProvisionLock(cacheDir, async () => 'reclaimed', { maxWaitMs: 2_000, staleMs: 60_000 });
    expect(result).toBe('reclaimed');
  });

  it('reclaims a lock whose holder process is dead', async () => {
    const lockDir = `${cacheDir}.lock`;
    mkdirSync(lockDir);
    // A PID that is essentially guaranteed not to be running → probe yields ESRCH.
    writeFileSync(resolve(lockDir, 'meta.json'), JSON.stringify({ pid: 2 ** 30, timestamp: Date.now() }));
    const result = await withProvisionLock(cacheDir, async () => 'reclaimed', { maxWaitMs: 2_000, staleMs: 60_000 });
    expect(result).toBe('reclaimed');
  });
});
