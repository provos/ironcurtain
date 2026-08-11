import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProcessLock,
  ProcessLockBusyError,
  type ProcessLockOwner,
} from '../../src/docker-workload/process-lock.js';

const temporaryDirectories: string[] = [];
const SELF_IDENTITY = 'self-process-start-fixture';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function lockDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'docker-workload-process-lock-'));
  temporaryDirectories.push(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function lockPath(): string {
  return join(lockDirectory(), 'owner.lock');
}

function owner(overrides: Partial<ProcessLockOwner> = {}): ProcessLockOwner {
  return {
    schemaVersion: 1,
    pid: process.pid,
    processIdentity: SELF_IDENTITY,
    token: '00000000-0000-4000-8000-000000000001',
    createdAtMs: Date.now(),
    ...overrides,
  };
}

function identityForPid(pid: number): string | undefined {
  return pid === process.pid ? SELF_IDENTITY : undefined;
}

/** Install a distinct inode at `path`, the way a racing publisher would. */
function publishForeignLock(path: string, record: ProcessLockOwner): void {
  const staging = `${path}.foreign`;
  writeFileSync(staging, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(staging, path);
}

function entries(directory: string): string[] {
  return readdirSync(directory).sort();
}

function thrown(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to throw');
}

describe('Docker-workload process lock', () => {
  it('atomically publishes a complete owner and keeps a live contender out', () => {
    const path = lockPath();
    const held = acquireProcessLock(path, { processIdentityForPid: identityForPid });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(held.owner);
    expect(() => acquireProcessLock(path, { processIdentityForPid: identityForPid })).toThrow(ProcessLockBusyError);

    held.release();
    expect(existsSync(path)).toBe(false);
  });

  it('never leaves a partial record or candidate alias beside the published lock', () => {
    const directory = lockDirectory();
    const path = join(directory, 'owner.lock');
    const held = acquireProcessLock(path, { processIdentityForPid: identityForPid });

    // Publication links a fully written inode into place, so a contender can
    // never observe an empty placeholder, and no candidate alias survives.
    expect(entries(directory)).toEqual(['owner.lock']);
    held.release();
    expect(entries(directory)).toEqual([]);
  });

  it('reports the live owner pid on the busy error', () => {
    const path = lockPath();
    const held = acquireProcessLock(path, { processIdentityForPid: identityForPid });
    const error = thrown(() => acquireProcessLock(path, { processIdentityForPid: identityForPid }));
    held.release();

    expect(error).toBeInstanceOf(ProcessLockBusyError);
    expect((error as ProcessLockBusyError).ownerPid).toBe(process.pid);
  });

  it('reclaims a lock whose owning PID is gone', () => {
    const path = lockPath();
    writeFileSync(path, `${JSON.stringify(owner({ pid: 4242, processIdentity: 'dead-process-start' }))}\n`, {
      mode: 0o600,
    });

    const held = acquireProcessLock(path, { processIdentityForPid: identityForPid });
    expect(held.owner.pid).toBe(process.pid);
    held.release();
  });

  it('reclaims a reused PID only when its process-start identity differs', () => {
    const path = lockPath();
    const reusedPid = 4242;
    const stale = owner({
      pid: reusedPid,
      processIdentity: 'old-process-start',
      token: '00000000-0000-4000-8000-000000000002',
    });
    writeFileSync(path, `${JSON.stringify(stale)}\n`, { mode: 0o600 });

    expect(() =>
      acquireProcessLock(path, {
        processIdentityForPid: (pid) => (pid === process.pid ? SELF_IDENTITY : 'old-process-start'),
      }),
    ).toThrow(ProcessLockBusyError);

    const held = acquireProcessLock(path, {
      processIdentityForPid: (pid) => {
        if (pid === process.pid) return SELF_IDENTITY;
        return pid === reusedPid ? 'new-process-start' : undefined;
      },
    });
    expect(held.owner.pid).toBe(process.pid);
    held.release();
  });

  it('stays busy when process-start adjudication throws', () => {
    const path = lockPath();
    writeFileSync(path, `${JSON.stringify(owner({ pid: 4242, processIdentity: 'unknown' }))}\n`, { mode: 0o600 });

    expect(() =>
      acquireProcessLock(path, {
        processIdentityForPid: (pid) => {
          if (pid === process.pid) return SELF_IDENTITY;
          throw new Error('process table unavailable');
        },
      }),
    ).toThrow(ProcessLockBusyError);
    expect(existsSync(path)).toBe(true);
  });

  it('does not reclaim a fresh malformed owner record as though publication completed', () => {
    const path = lockPath();
    writeFileSync(path, '', { mode: 0o600 });

    expect(() =>
      acquireProcessLock(path, {
        processIdentityForPid: identityForPid,
        malformedGraceMs: 5000,
      }),
    ).toThrow(ProcessLockBusyError);
    expect(existsSync(path)).toBe(true);
  });

  it('reclaims a malformed owner record once it is older than the grace window', () => {
    const path = lockPath();
    writeFileSync(path, 'not-json', { mode: 0o600 });

    const held = acquireProcessLock(path, {
      processIdentityForPid: identityForPid,
      malformedGraceMs: 0,
      now: () => Date.now() + 60_000,
    });
    expect(held.owner.pid).toBe(process.pid);
    held.release();
  });

  it('does not delete a lock that a racer published after the stale observation', () => {
    const directory = lockDirectory();
    const path = join(directory, 'owner.lock');
    const racer = owner({ pid: 4243, token: '00000000-0000-4000-8000-000000000004' });
    writeFileSync(path, `${JSON.stringify(owner({ pid: 4242, processIdentity: 'dead-process-start' }))}\n`, {
      mode: 0o600,
    });

    // Adjudication is the last step before reclaim, so swapping the inode there
    // mimics a racer publishing between the observation and the capture.
    let swapped = false;
    const error = thrown(() =>
      acquireProcessLock(path, {
        attempts: 1,
        processIdentityForPid: (pid) => {
          if (pid === process.pid) return SELF_IDENTITY;
          if (!swapped) {
            swapped = true;
            publishForeignLock(path, racer);
          }
          return undefined;
        },
      }),
    );

    expect(error).toBeInstanceOf(ProcessLockBusyError);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(racer);
    expect(entries(directory)).toEqual(['owner.lock']);
  });

  it('refuses to release once the published path is a different inode', () => {
    const path = lockPath();
    const held = acquireProcessLock(path, { processIdentityForPid: identityForPid });
    const replacement = owner({ token: '00000000-0000-4000-8000-000000000003' });
    publishForeignLock(path, replacement);

    expect(() => held.release()).toThrow(/ownership was lost/u);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(replacement);
  });

  it('refuses to release once the lock has been removed', () => {
    const path = lockPath();
    const held = acquireProcessLock(path, { processIdentityForPid: identityForPid });
    rmSync(path);

    expect(() => held.release()).toThrow(/ownership was lost/u);
  });
});
