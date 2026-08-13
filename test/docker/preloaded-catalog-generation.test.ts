import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getPreloadedCatalogBuildLockPath,
  loadCatalogGenerationRecords,
  resolvePreloadedCatalogGeneration,
  type CatalogGenerationRecord,
} from '../../src/docker/preloaded-catalog-generation.js';
import { getFrozenCatalogPath } from '../../src/docker/preloaded-catalog-paths.js';

function record(
  generation: string,
  architecture: 'amd64' | 'arm64' = 'arm64',
  path = `/catalogs/${generation}.json`,
): CatalogGenerationRecord {
  return { path, runtimeKind: 'docker', generation, architectures: [architecture] };
}

describe('preloaded catalog generation resolver', () => {
  it('starts at v1 with no catalog and otherwise increments the maximum across every input', () => {
    expect(resolvePreloadedCatalogGeneration({ architecture: 'arm64', catalogs: [] })).toBe(
      'ironcurtain-preloaded-arm64-v1',
    );
    expect(
      resolvePreloadedCatalogGeneration({
        architecture: 'arm64',
        catalogs: [record('ironcurtain-preloaded-arm64-v2'), record('ironcurtain-preloaded-arm64-v7')],
      }),
    ).toBe('ironcurtain-preloaded-arm64-v8');
  });

  it('accepts only a canonical explicit generation newer than the observed maximum', () => {
    const catalogs = [record('ironcurtain-preloaded-arm64-v3')];
    expect(
      resolvePreloadedCatalogGeneration({
        architecture: 'arm64',
        requestedGeneration: 'ironcurtain-preloaded-arm64-v10',
        catalogs,
      }),
    ).toBe('ironcurtain-preloaded-arm64-v10');
    for (const requestedGeneration of [
      'ironcurtain-preloaded-arm64-v3',
      'ironcurtain-preloaded-arm64-v2',
      'ironcurtain-preloaded-arm64-v03',
      'ironcurtain-preloaded-arm64-v0',
      'ironcurtain-preloaded-arm64-v4-extra',
      'ironcurtain-preloaded-amd64-v4',
    ]) {
      expect(() =>
        resolvePreloadedCatalogGeneration({ architecture: 'arm64', requestedGeneration, catalogs }),
      ).toThrow();
    }
  });

  it('fails closed on a malformed, cross-architecture, empty, or mixed-architecture observation', () => {
    for (const catalogs of [
      [record('not-a-generation')],
      [record('ironcurtain-preloaded-amd64-v3', 'amd64')],
      [{ ...record('ironcurtain-preloaded-arm64-v3'), architectures: [] }],
      [{ ...record('ironcurtain-preloaded-arm64-v3'), architectures: ['arm64', 'amd64'] as const }],
      [record('ironcurtain-preloaded-arm64-v3', 'amd64')],
    ]) {
      expect(() => resolvePreloadedCatalogGeneration({ architecture: 'arm64', catalogs })).toThrow();
    }
  });

  it('rejects unsafe integer versions and cannot overflow a derived generation', () => {
    expect(() =>
      resolvePreloadedCatalogGeneration({
        architecture: 'arm64',
        catalogs: [record('ironcurtain-preloaded-arm64-v9007199254740992')],
      }),
    ).toThrow(/safe integer/u);
    expect(() =>
      resolvePreloadedCatalogGeneration({
        architecture: 'arm64',
        catalogs: [record(`ironcurtain-preloaded-arm64-v${Number.MAX_SAFE_INTEGER}`)],
      }),
    ).toThrow(/exhausted/u);
  });

  it('loads every present input through the real catalog validator and checks its runtime kind', () => {
    const docker = getFrozenCatalogPath('docker');
    const absent = join(realpathSync('/tmp'), 'ironcurtain-generation-test-absent.json');
    const loaded = loadCatalogGenerationRecords([
      { path: docker, runtimeKind: 'docker' },
      { path: absent, runtimeKind: 'apple-container' },
    ]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ path: docker, runtimeKind: 'docker', architectures: ['arm64'] });
    expect(() => loadCatalogGenerationRecords([{ path: docker, runtimeKind: 'apple-container' }])).toThrow(
      /wrong runtime kind/u,
    );
  });
});

describe('preloaded catalog build lock path', () => {
  it('is canonical and independent of cwd, TMPDIR, and IRONCURTAIN_HOME', () => {
    const before = getPreloadedCatalogBuildLockPath();
    const oldTmpdir = process.env.TMPDIR;
    const oldHome = process.env.IRONCURTAIN_HOME;
    process.env.TMPDIR = '/untrusted/alternate-tmp';
    process.env.IRONCURTAIN_HOME = '/untrusted/alternate-home';
    try {
      expect(getPreloadedCatalogBuildLockPath()).toBe(before);
    } finally {
      if (oldTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = oldTmpdir;
      if (oldHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = oldHome;
    }
    expect(before).toBe(join(realpathSync('/tmp'), `.ironcurtain-build-preloaded-catalog-${process.getuid?.()}.lock`));
  });
});
