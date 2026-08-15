import { describe, expect, it, vi } from 'vitest';

import { runStatisticsCommand } from '../src/llm-metrics/statistics-command.js';
import type { LlmDeleteBeforeResult } from '../src/llm-metrics/persistence/repository.js';

function result(
  status: LlmDeleteBeforeResult['status'],
  deletedCount: number,
  snapshotMaxSequence: number | null,
): LlmDeleteBeforeResult {
  return { status, cutoffMs: 1_001, snapshotMaxSequence, deletedCount, chunksProcessed: 1 };
}

describe('statistics management command', () => {
  it('prints help without opening the database', async () => {
    const write = vi.fn();
    const openRepository = vi.fn();
    await runStatisticsCommand(['--help'], { write, openRepository });
    expect(write).toHaveBeenCalledWith(expect.stringContaining('statistics delete --before'));
    expect(openRepository).not.toHaveBeenCalled();
  });

  it('does not create a database when none exists', async () => {
    const write = vi.fn();
    const openRepository = vi.fn();
    await runStatisticsCommand(['delete', '--all'], {
      databasePath: '/missing/statistics.sqlite3',
      databaseExists: () => false,
      openRepository,
      write,
    });
    expect(openRepository).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('nothing was deleted'));
  });

  it('continues a stable bounded snapshot while preserving the initial cutoff', async () => {
    const deleteBefore = vi
      .fn()
      .mockResolvedValueOnce(result('partial', 10_000, 42))
      .mockResolvedValueOnce(result('complete', 7, 42));
    const close = vi.fn(async () => {});
    const write = vi.fn();

    await runStatisticsCommand(['delete', '--all'], {
      databasePath: '/tmp/statistics.sqlite3',
      databaseExists: () => true,
      now: () => 1_000,
      openRepository: async () => ({ deleteBefore, close }),
      write,
    });

    expect(deleteBefore).toHaveBeenNthCalledWith(1, 1_001, expect.not.objectContaining({ snapshotMaxSequence: 42 }));
    expect(deleteBefore).toHaveBeenNthCalledWith(2, 1_001, expect.objectContaining({ snapshotMaxSequence: 42 }));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Deleted 10007 statistics exchange(s)'));
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects ambiguous or malformed deletion requests before opening storage', async () => {
    const openRepository = vi.fn();
    await expect(
      runStatisticsCommand(['delete', '--all', '--before', '2026-08-15'], { openRepository }),
    ).rejects.toThrow(/either --before or --all/);
    await expect(runStatisticsCommand(['delete', '--before', 'not-a-date'], { openRepository })).rejects.toThrow(
      /Invalid statistics cutoff/,
    );
    await expect(
      runStatisticsCommand(['delete', '--before', String(Number.MAX_SAFE_INTEGER)], { openRepository }),
    ).rejects.toThrow(/Invalid statistics cutoff/);
    await expect(runStatisticsCommand(['delete'], { openRepository })).rejects.toThrow(/requires --before.*--all/);
    expect(openRepository).not.toHaveBeenCalled();
  });
});
