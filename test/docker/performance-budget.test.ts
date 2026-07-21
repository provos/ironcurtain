import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPerformanceWithinBudget,
  assertPerformanceBudgetScope,
  loadPerformanceBudget,
  type PerformanceBudget,
  type PerformanceMeasurements,
} from '../../src/docker/performance-budget.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('secure nested performance budget', () => {
  it('loads the checked-in Apple rootless candidate budget and binds its concrete runtime tuple', () => {
    const loaded = loadPerformanceBudget(
      join(process.cwd(), 'test/docker-workload/performance-budget.apple-rootless-vfs-arm64.json'),
    );
    expect(loaded.budget.budgetId).toBe('apple-rootless-vfs-arm64-v1');
    expect(() =>
      assertPerformanceBudgetScope(loaded.budget, {
        platform: 'apple-container',
        variant: 'apple-rootless-vfs',
        architecture: 'arm64',
        outerRuntime: 'container 1.1.0',
        innerDocker: '29.2.1',
        storageDriver: 'vfs',
      }),
    ).not.toThrow();
  });

  it('rejects a budget selected for a different backend, architecture, version, or storage driver', () => {
    expect(() =>
      assertPerformanceBudgetScope(budget(), {
        platform: 'docker-desktop',
        variant: 'desktop-rootless-vfs',
        architecture: 'amd64',
        outerRuntime: 'Docker Desktop 99.0',
        innerDocker: '29.2.2',
        storageDriver: 'overlay2',
      }),
    ).toThrow(/platform, variant, architecture, outerRuntime, innerDocker, storageDriver/u);
  });

  it('accepts a complete measurement set at or below every frozen ceiling', () => {
    const result = assertPerformanceWithinBudget(budget(), measurements());
    expect(result.passed).toBe(true);
    expect(result.headroom.daemonReadinessMs).toBe(45_000);
    expect(result.headroom.retainedOwnedStateBytes).toBe(0);
  });

  it('reports every exceeded duration/state metric in one terminal failure', () => {
    expect(() =>
      assertPerformanceWithinBudget(budget(), {
        ...measurements(),
        daemonReadinessMs: 90_001,
        peakOwnedStateBytes: 8 * 1024 ** 3 + 1,
        retainedOwnedStateBytes: 1,
      }),
    ).toThrow(/daemonReadinessMs=.*peakOwnedStateBytes=.*retainedOwnedStateBytes=/u);
  });

  it('rejects missing, negative, and unknown measurement fields', () => {
    const missing = { ...measurements() } as Partial<PerformanceMeasurements>;
    delete missing.scannerWorkflowMs;
    expect(() => assertPerformanceWithinBudget(budget(), missing as PerformanceMeasurements)).toThrow();
    expect(() => assertPerformanceWithinBudget(budget(), { ...measurements(), mandatorySuiteMs: -1 })).toThrow();
    expect(() =>
      assertPerformanceWithinBudget(budget(), { ...measurements(), selfRelaxedLimit: 999 } as PerformanceMeasurements),
    ).toThrow();
  });

  it('loads only a strict non-writable non-symlink budget', () => {
    const directory = mkdtempSync(join(tmpdir(), 'performance-budget-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'performance-budget.json');
    writeFileSync(path, JSON.stringify(budget()), { mode: 0o444 });
    expect(loadPerformanceBudget(path).budget.budgetId).toBe('apple-rootless-vfs-arm64-v1');

    chmodSync(path, 0o666);
    expect(() => loadPerformanceBudget(path)).toThrow(/group\/world writable/u);
    chmodSync(path, 0o444);
    const link = join(directory, 'budget-link.json');
    symlinkSync(path, link);
    expect(() => loadPerformanceBudget(link)).toThrow(/non-symlink/u);
  });
});

function budget(): PerformanceBudget {
  return {
    schemaVersion: 1,
    budgetId: 'apple-rootless-vfs-arm64-v1',
    platform: 'apple-container',
    variant: 'apple-rootless-vfs',
    architecture: 'arm64',
    versionScope: { outerRuntime: 'container 1.1.0', innerDocker: '29.2.1', storageDriver: 'vfs' },
    maxima: {
      daemonReadinessMs: 90_000,
      primitiveSuiteMs: 600_000,
      ironcurtainBuildMs: 600_000,
      scannerWorkflowMs: 300_000,
      mandatorySuiteMs: 1_800_000,
      wholeQualificationMs: 4_500_000,
      peakOwnedStateBytes: 8 * 1024 ** 3,
      retainedOwnedStateBytes: 0,
    },
  };
}

function measurements(): PerformanceMeasurements {
  return {
    daemonReadinessMs: 45_000,
    primitiveSuiteMs: 300_000,
    ironcurtainBuildMs: 400_000,
    scannerWorkflowMs: 200_000,
    mandatorySuiteMs: 1_200_000,
    wholeQualificationMs: 3_600_000,
    peakOwnedStateBytes: 4 * 1024 ** 3,
    retainedOwnedStateBytes: 0,
  };
}
