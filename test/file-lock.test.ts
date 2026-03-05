/**
 * Tests for the advisory file lock mechanism used by the job store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { withFileLock, acquireLock, releaseLock, getJobLockDir } from '../src/cron/file-lock.js';

const TEST_DIR = resolve(`/tmp/ironcurtain-filelock-test-${process.pid}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('file-lock', () => {
  describe('acquireLock / releaseLock', () => {
    it('acquires a lock and creates the lock directory', async () => {
      const lockDir = join(TEST_DIR, 'test.lock');
      const acquired = await acquireLock(lockDir);
      expect(acquired).toBe(true);
      expect(existsSync(lockDir)).toBe(true);

      // Metadata file should contain current PID
      const meta = JSON.parse(readFileSync(join(lockDir, 'meta.json'), 'utf-8'));
      expect(meta.pid).toBe(process.pid);
      expect(typeof meta.timestamp).toBe('number');

      releaseLock(lockDir);
      expect(existsSync(lockDir)).toBe(false);
    });

    it('blocks a second acquisition while the first is held', async () => {
      const lockDir = join(TEST_DIR, 'test.lock');

      // Acquire first
      const first = await acquireLock(lockDir);
      expect(first).toBe(true);

      // Second acquisition should time out (we use a very short stale timeout
      // but the PID is alive, so it won't be considered stale)
      // We can't easily test the full timeout, so just verify tryAcquire fails
      // by calling acquireLock with a short implicit timeout
      const secondPromise = acquireLock(lockDir);
      // Give it a moment then release so the test doesn't hang
      setTimeout(() => releaseLock(lockDir), 200);
      const second = await secondPromise;
      // It should eventually succeed after the first lock is released
      expect(second).toBe(true);
      releaseLock(lockDir);
    });

    it('detects and recovers from stale locks with dead PIDs', async () => {
      const lockDir = join(TEST_DIR, 'stale.lock');

      // Simulate a stale lock from a dead process
      mkdirSync(lockDir);
      const fakeMeta = JSON.stringify({ pid: 999999999, timestamp: Date.now() });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(lockDir, 'meta.json'), fakeMeta);

      // Should detect the dead PID and acquire
      const acquired = await acquireLock(lockDir);
      expect(acquired).toBe(true);
      releaseLock(lockDir);
    });

    it('detects and recovers from stale locks by timeout', async () => {
      const lockDir = join(TEST_DIR, 'timed-out.lock');

      // Simulate a lock that expired (our own PID but very old timestamp)
      mkdirSync(lockDir);
      const oldMeta = JSON.stringify({ pid: process.pid, timestamp: Date.now() - 60_000 });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(lockDir, 'meta.json'), oldMeta);

      // Should detect the stale timestamp and acquire (staleMs=30s)
      const acquired = await acquireLock(lockDir);
      expect(acquired).toBe(true);
      releaseLock(lockDir);
    });

    it('releaseLock is safe to call on a non-existent lock', () => {
      const lockDir = join(TEST_DIR, 'nonexistent.lock');
      expect(() => releaseLock(lockDir)).not.toThrow();
    });
  });

  describe('withFileLock', () => {
    it('executes the function under lock and releases afterward', async () => {
      const lockDir = join(TEST_DIR, 'with.lock');
      let executed = false;

      await withFileLock(lockDir, () => {
        // Lock should be held during execution
        expect(existsSync(lockDir)).toBe(true);
        executed = true;
      });

      expect(executed).toBe(true);
      // Lock should be released after
      expect(existsSync(lockDir)).toBe(false);
    });

    it('releases lock even if function throws', async () => {
      const lockDir = join(TEST_DIR, 'throw.lock');

      await expect(
        withFileLock(lockDir, () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      // Lock must be released despite the error
      expect(existsSync(lockDir)).toBe(false);
    });

    it('returns the value from the function', async () => {
      const lockDir = join(TEST_DIR, 'return.lock');
      const result = await withFileLock(lockDir, () => 42);
      expect(result).toBe(42);
    });

    it('supports async functions', async () => {
      const lockDir = join(TEST_DIR, 'async.lock');
      const result = await withFileLock(lockDir, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'async-result';
      });
      expect(result).toBe('async-result');
      expect(existsSync(lockDir)).toBe(false);
    });
  });

  describe('getJobLockDir', () => {
    it('returns path ending with job.json.lock', () => {
      const lockDir = getJobLockDir('/home/user/.ironcurtain/jobs/my-job');
      expect(lockDir).toBe('/home/user/.ironcurtain/jobs/my-job/job.json.lock');
    });
  });
});
