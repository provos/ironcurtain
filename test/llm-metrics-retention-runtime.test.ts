import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LlmMetricsRepository, LlmMetricsRepositoryHealth } from '../src/llm-metrics/persistence/repository.js';

const repositoryMocks = vi.hoisted(() => {
  const health: LlmMetricsRepositoryHealth = {
    state: 'ready',
    schemaVersion: 1,
    observed: 0,
    finalized: 0,
    enqueued: 0,
    persisted: 0,
    duplicates: 0,
    dropped: 0,
    queuedRecords: 0,
    queuedBytes: 0,
    lastError: null,
  };
  const repository: LlmMetricsRepository = {
    enqueue: vi.fn(() => true),
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    health: vi.fn(() => health),
    snapshotMaxSequence: vi.fn(async () => 0),
    scan: vi.fn(async () => []),
    dimensionValues: vi.fn(async () => []),
    deleteBefore: vi.fn(async (cutoffMs: number) => ({
      status: 'complete' as const,
      cutoffMs,
      snapshotMaxSequence: 0,
      deletedCount: 0,
      chunksProcessed: 0,
    })),
  };
  return { repository, open: vi.fn(async () => repository) };
});

vi.mock('../src/llm-metrics/persistence/sqlite-repository.js', () => ({
  SqliteLlmMetricsRepository: { open: repositoryMocks.open },
}));

import { acquireLlmMetricsRuntime, type LlmMetricsRuntimeLease } from '../src/llm-metrics/runtime.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;

describe('LLM metrics runtime retention', () => {
  const directories: string[] = [];
  const leases: LlmMetricsRuntimeLease[] = [];

  async function databasePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-retention-runtime-'));
    directories.push(directory);
    return join(directory, 'statistics.sqlite3');
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(leases.splice(0).map((lease) => lease.release()));
    vi.useRealTimers();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('acquires without waiting for startup pruning and uses bounded delete options', async () => {
    const now = Date.now();
    const lease = await acquireLlmMetricsRuntime({ databasePath: await databasePath(), retentionDays: 7 });
    leases.push(lease);

    expect(repositoryMocks.repository.deleteBefore).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(repositoryMocks.repository.deleteBefore).toHaveBeenCalledOnce();
    expect(repositoryMocks.repository.deleteBefore).toHaveBeenCalledWith(now - 7 * DAY_MS, {
      chunkSize: 1_000,
      maxRows: 10_000,
      maxDurationMs: 1_000,
      leaseDurationMs: 5_000,
    });

    await lease.release();
    vi.mocked(repositoryMocks.repository.deleteBefore).mockClear();
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS * 2);
    expect(repositoryMocks.repository.deleteBefore).not.toHaveBeenCalled();
  });

  it('uses the shortest active lease window and relaxes it after that lease releases', async () => {
    const path = await databasePath();
    const [thirtyDays, oneDay] = await Promise.all([
      acquireLlmMetricsRuntime({ databasePath: path, retentionDays: 30 }),
      acquireLlmMetricsRuntime({ databasePath: path, retentionDays: 1 }),
    ]);
    leases.push(thirtyDays, oneDay);

    await vi.advanceTimersByTimeAsync(0);
    expect(repositoryMocks.repository.deleteBefore).toHaveBeenLastCalledWith(Date.now() - DAY_MS, expect.any(Object));

    await oneDay.release();
    vi.mocked(repositoryMocks.repository.deleteBefore).mockClear();
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
    expect(repositoryMocks.repository.deleteBefore).toHaveBeenCalledOnce();
    expect(repositoryMocks.repository.deleteBefore).toHaveBeenCalledWith(Date.now() - 30 * DAY_MS, expect.any(Object));
  });

  it('continues a partial prune in another bounded event-loop turn', async () => {
    const deleteBefore = vi.mocked(repositoryMocks.repository.deleteBefore);
    deleteBefore
      .mockResolvedValueOnce({
        status: 'partial',
        cutoffMs: Date.now() - DAY_MS,
        snapshotMaxSequence: 20_000,
        deletedCount: 10_000,
        chunksProcessed: 10,
      })
      .mockResolvedValueOnce({
        status: 'complete',
        cutoffMs: Date.now() - DAY_MS,
        snapshotMaxSequence: 20_000,
        deletedCount: 10_000,
        chunksProcessed: 10,
      });
    const lease = await acquireLlmMetricsRuntime({ databasePath: await databasePath(), retentionDays: 1 });
    leases.push(lease);

    await vi.advanceTimersByTimeAsync(1);

    expect(deleteBefore).toHaveBeenCalledTimes(2);
    expect(deleteBefore).toHaveBeenNthCalledWith(1, Date.now() - DAY_MS - 1, expect.any(Object));
    expect(deleteBefore).toHaveBeenNthCalledWith(2, Date.now() - DAY_MS, expect.any(Object));
  });

  it('does not schedule pruning without a finite retention window and clears timers on final release', async () => {
    const path = await databasePath();
    const [unspecified, explicitlyDisabled] = await Promise.all([
      acquireLlmMetricsRuntime({ databasePath: path }),
      acquireLlmMetricsRuntime({ databasePath: path, retentionDays: null }),
    ]);
    leases.push(unspecified, explicitlyDisabled);

    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS * 2);
    expect(repositoryMocks.repository.deleteBefore).not.toHaveBeenCalled();

    await Promise.all([unspecified.release(), explicitlyDisabled.release()]);
    vi.mocked(repositoryMocks.repository.deleteBefore).mockClear();
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS * 2);
    expect(repositoryMocks.repository.deleteBefore).not.toHaveBeenCalled();
  });
});
