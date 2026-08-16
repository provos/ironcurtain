import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireLlmMetricsRuntime,
  getActiveLlmStatisticsReader,
  type LlmMetricsRuntimeLease,
} from '../src/llm-metrics/runtime.js';

describe('process-scoped LLM metrics runtime', () => {
  const directories: string[] = [];
  const leases: LlmMetricsRuntimeLease[] = [];

  async function databasePath(name = 'statistics.sqlite3'): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-llm-runtime-'));
    directories.push(directory);
    return join(directory, name);
  }

  afterEach(async () => {
    await Promise.all(leases.splice(0).map((lease) => lease.release()));
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('shares concurrent acquisitions and rejects a second active database identity', async () => {
    const path = await databasePath();
    const [first, second] = await Promise.all([acquireLlmMetricsRuntime(path), acquireLlmMetricsRuntime(path)]);
    leases.push(first, second);
    expect(first.repository).toBe(second.repository);
    expect(await getActiveLlmStatisticsReader()).toBe(first.reader);

    await expect(acquireLlmMetricsRuntime(await databasePath('other.sqlite3'))).rejects.toThrow(
      /different database path/,
    );
  });

  it('serializes last release with a racing reacquisition instead of returning a closing repository', async () => {
    const path = await databasePath();
    const first = await acquireLlmMetricsRuntime(path);
    const oldRepository = first.repository;

    const release = first.release();
    const reacquired = acquireLlmMetricsRuntime(path);
    const second = await reacquired;
    leases.push(second);
    await release;

    expect(second.repository).not.toBe(oldRepository);
    expect(await getActiveLlmStatisticsReader()).toBe(second.reader);
  });
});
