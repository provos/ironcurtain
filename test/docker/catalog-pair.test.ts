import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDockerWorkloadCatalogPair } from '../../src/docker-workload/catalog-pair.js';
import {
  catalogTupleDigest,
  type PreloadedImageCatalog,
  type PreloadedImageCatalogEntry,
} from '../../src/docker/preloaded-image-catalog.js';
import { getFrozenCatalogPath } from '../../src/docker/preloaded-catalog-paths.js';

let directory: string;

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'catalog-pair-')));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('Apple/Docker catalog-pair authority boundary', () => {
  it('accepts the qualified pair whose entries differ only by runtime kind and runtime image ID', () => {
    const paths = writePair();
    const pair = loadDockerWorkloadCatalogPair(paths);

    expect(pair.apple.catalog.generation).toBe(pair.docker.catalog.generation);
    expect(pair.apple.catalog.images.map((entry) => entry.logicalName)).toEqual(
      pair.docker.catalog.images.map((entry) => entry.logicalName),
    );
    expect(
      pair.apple.catalog.images.every((entry, index) => {
        const docker = pair.docker.catalog.images[index];
        return entry.runtimeKind !== docker.runtimeKind && entry.runtimeImageId !== docker.runtimeImageId;
      }),
    ).toBe(true);
  });

  it('rejects generation and creation-time drift', () => {
    expect(() =>
      loadDockerWorkloadCatalogPair(
        writePair((_apple, docker) => {
          docker.generation = `${docker.generation}-drift`;
        }),
      ),
    ).toThrow(/different generations/u);

    expect(() =>
      loadDockerWorkloadCatalogPair(
        writePair((_apple, docker) => {
          docker.createdAt = '2026-07-21T12:00:00.000Z';
        }),
      ),
    ).toThrow(/different creation times/u);
  });

  it('rejects missing and extra logical image roles', () => {
    expect(() =>
      loadDockerWorkloadCatalogPair(
        writePair((_apple, docker) => {
          docker.images = docker.images.slice(1);
        }),
      ),
    ).toThrow(/different logical image sets/u);

    expect(() =>
      loadDockerWorkloadCatalogPair(
        writePair((_apple, docker) => {
          const extra = structuredClone(requiredEntry(docker));
          extra.logicalName = 'ironcurtain-extra:latest';
          docker.images.push(extra);
        }),
      ),
    ).toThrow(/different logical image sets/u);
  });

  for (const [field, mutate] of [
    ['manifest digest', (entry: PreloadedImageCatalogEntry) => (entry.manifestDigest = `sha256:${'1'.repeat(64)}`)],
    [
      'config digest',
      (entry: PreloadedImageCatalogEntry) => {
        entry.configDigest = `sha256:${'2'.repeat(64)}`;
        entry.runtimeImageId = entry.configDigest;
      },
    ],
    ['build hash', (entry: PreloadedImageCatalogEntry) => (entry.buildHash = '3'.repeat(64))],
    ['architecture', (entry: PreloadedImageCatalogEntry) => (entry.architecture = 'amd64')],
    ['Docker API range', (entry: PreloadedImageCatalogEntry) => (entry.dockerApi.max = '1.52')],
    [
      'toolchain',
      (entry: PreloadedImageCatalogEntry) => {
        entry.toolchain.compose = '5.1.1';
        entry.toolchainDigest = catalogTupleDigest(entry.toolchain);
      },
    ],
    [
      'provenance',
      (entry: PreloadedImageCatalogEntry) => {
        entry.provenance.source = 'drifted source';
        entry.provenanceDigest = catalogTupleDigest(entry.provenance);
      },
    ],
    ['archive identity', (entry: PreloadedImageCatalogEntry) => (entry.archive.sha256 = '4'.repeat(64))],
  ] as const) {
    it(`rejects shared ${field} drift`, () => {
      expect(() =>
        loadDockerWorkloadCatalogPair(
          writePair((_apple, docker) => {
            mutate(requiredEntry(docker));
          }),
        ),
      ).toThrow(/metadata differs/u);
    });
  }
});

function writePair(mutate?: (apple: PreloadedImageCatalog, docker: PreloadedImageCatalog) => void): {
  readonly appleCatalogPath: string;
  readonly dockerCatalogPath: string;
} {
  const apple = readCatalog('apple-container');
  const docker = readCatalog('docker');
  mutate?.(apple, docker);
  const appleCatalogPath = resolve(directory, 'preloaded-catalog.apple-container.json');
  const dockerCatalogPath = resolve(directory, 'preloaded-catalog.docker.json');
  for (const [path, catalog] of [
    [appleCatalogPath, apple],
    [dockerCatalogPath, docker],
  ] as const) {
    writeFileSync(path, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return { appleCatalogPath, dockerCatalogPath };
}

function readCatalog(runtimeKind: 'apple-container' | 'docker'): PreloadedImageCatalog {
  return JSON.parse(readFileSync(getFrozenCatalogPath(runtimeKind), 'utf8')) as PreloadedImageCatalog;
}

function requiredEntry(catalog: PreloadedImageCatalog): PreloadedImageCatalogEntry {
  return catalog.images[0];
}
