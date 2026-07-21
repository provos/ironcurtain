import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildPreloadedImageLabels,
  catalogTupleDigest,
  createPreloadedImageCatalogEntry,
  loadPreloadedImageCatalog,
  resolvePreloadedImage,
  type PreloadedImageCatalog,
  type PreloadedImageCatalogEntry,
} from '../../src/docker/preloaded-image-catalog.js';
import type { DockerImageInfo } from '../../src/docker/types.js';
import { writeOciArchiveFixture } from '../helpers/oci-archive-fixture.js';

const temporaryDirectories: string[] = [];
const logicalName = 'ironcurtain-claude-code:latest';
const buildHash = '4'.repeat(64);
const dockerRuntime = { runtimeKind: 'docker' as const };

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('preloaded image catalog', () => {
  it('constructs a self-consistent entry without caller-supplied tuple digests', () => {
    const toolchain = { dockerCli: '29.2.1', dockerDaemon: '29.2.1', buildx: '0.30.1', compose: '5.0.2' };
    const provenance = {
      source: 'docker/nested-relay/Dockerfile',
      sourceDigest: `sha256:${'1'.repeat(64)}`,
      createdAt: '2026-07-20T12:00:00.000Z',
    };
    const entry = createPreloadedImageCatalogEntry({
      runtimeKind: 'docker',
      logicalName: 'localhost/ironcurtain-fixed-relay:catalog',
      runtimeImageId: `sha256:${'2'.repeat(64)}`,
      manifestDigest: `sha256:${'3'.repeat(64)}`,
      configDigest: `sha256:${'2'.repeat(64)}`,
      buildHash: '4'.repeat(64),
      architecture: 'arm64',
      dockerApi: { min: '1.44', max: '1.52' },
      toolchain,
      provenance,
      archive: { fileName: 'relay.tar', sha256: '5'.repeat(64), sizeBytes: 4096 },
    });
    expect(entry.toolchainDigest).toBe(catalogTupleDigest(toolchain));
    expect(entry.provenanceDigest).toBe(catalogTupleDigest(provenance));
    expect(buildPreloadedImageLabels(entry, 'catalog.1')).toMatchObject({
      'ironcurtain.build-hash': '4'.repeat(64),
      'ironcurtain.toolchain-digest': entry.toolchainDigest,
      'ironcurtain.provenance-digest': entry.provenanceDigest,
    });
  });

  it('returns an immutable ID only after the complete catalog tuple matches', async () => {
    const fixture = writeCatalog();
    const image = matchingImage(fixture.catalog.images[0], fixture.catalog.generation);
    const runtime = { inspectImage: async () => image, loadImageArchive: async () => {} };

    const resolved = await resolvePreloadedImage(runtime, {
      ...dockerRuntime,
      catalogPath: fixture.path,
      logicalName,
      expectedBuildHash: buildHash,
      architecture: 'arm64',
      dockerApiVersion: '1.45',
    });

    expect(resolved).toMatchObject({
      mode: 'preloaded-catalog',
      logicalName,
      immutableImageId: fixture.catalog.images[0].runtimeImageId,
      buildHash,
      catalogGeneration: fixture.catalog.generation,
    });
    expect(resolved.catalogSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('verifies and loads a missing archive before accepting the post-load immutable ID', async () => {
    const fixture = writeCatalog();
    const image = matchingImage(fixture.catalog.images[0], fixture.catalog.generation);
    let loaded = false;
    let loadedPath = '';
    const resolved = await resolvePreloadedImage(
      {
        inspectImage: async () => (loaded ? image : undefined),
        loadImageArchive: async (path) => {
          loaded = true;
          loadedPath = path;
        },
      },
      {
        ...dockerRuntime,
        catalogPath: fixture.path,
        logicalName,
        expectedBuildHash: buildHash,
        architecture: 'arm64',
      },
    );

    expect(loadedPath).toBe(join(fixture.directory, fixture.catalog.images[0].archive.fileName));
    expect(resolved.immutableImageId).toBe(fixture.catalog.images[0].runtimeImageId);
  });

  it('fails closed when verified archive loading does not produce the catalog ref', async () => {
    const fixture = writeCatalog();
    let loadCalls = 0;
    await expect(
      resolvePreloadedImage(
        {
          inspectImage: async () => undefined,
          loadImageArchive: async () => {
            loadCalls++;
          },
        },
        {
          ...dockerRuntime,
          catalogPath: fixture.path,
          logicalName,
          expectedBuildHash: buildHash,
          architecture: 'arm64',
        },
      ),
    ).rejects.toThrow(/load did not create the catalog ref/u);
    expect(loadCalls).toBe(1);
  });

  it.each([
    ['immutable ID', (image: DockerImageInfo) => ({ ...image, id: `sha256:${'9'.repeat(64)}` })],
    [
      'metadata label',
      (image: DockerImageInfo) => ({
        ...image,
        labels: { ...image.labels, 'ironcurtain.runtime-trust-schema': 'runtime-trust-v2' },
      }),
    ],
  ])('rejects a mismatched loaded %s', async (_label, mutate) => {
    const fixture = writeCatalog();
    const image = mutate(matchingImage(fixture.catalog.images[0], fixture.catalog.generation));
    await expect(
      resolvePreloadedImage(
        { inspectImage: async () => image, loadImageArchive: async () => {} },
        {
          ...dockerRuntime,
          catalogPath: fixture.path,
          logicalName,
          expectedBuildHash: buildHash,
          architecture: 'arm64',
        },
      ),
    ).rejects.toThrow(/mismatch/u);
  });

  it('rejects build-hash, architecture, and API-range mismatches before use', async () => {
    const fixture = writeCatalog();
    const image = matchingImage(fixture.catalog.images[0], fixture.catalog.generation);
    const runtime = { inspectImage: async () => image, loadImageArchive: async () => {} };
    const common = { ...dockerRuntime, catalogPath: fixture.path, logicalName };

    await expect(
      resolvePreloadedImage(runtime, { ...common, expectedBuildHash: '8'.repeat(64), architecture: 'arm64' }),
    ).rejects.toThrow(/build hash mismatch/u);
    await expect(
      resolvePreloadedImage(runtime, { ...common, expectedBuildHash: buildHash, architecture: 'amd64' }),
    ).rejects.toThrow(/architecture mismatch/u);
    await expect(
      resolvePreloadedImage(runtime, {
        ...common,
        expectedBuildHash: buildHash,
        architecture: 'arm64',
        dockerApiVersion: '1.50',
      }),
    ).rejects.toThrow(/does not support Docker API/u);
  });

  it('rejects symlink and group/world-writable catalog files', () => {
    const fixture = writeCatalog();
    chmodSync(fixture.path, 0o666);
    expect(() => loadPreloadedImageCatalog(fixture.path)).toThrow(/group\/world writable/u);

    chmodSync(fixture.path, 0o444);
    const linkPath = join(fixture.directory, 'catalog-link.json');
    symlinkSync(fixture.path, linkPath);
    expect(() => loadPreloadedImageCatalog(linkPath)).toThrow(/non-symlink/u);
  });

  it('rejects duplicate names and internally inconsistent tuple digests', () => {
    const duplicateFixture = writeCatalog((catalog) => catalog.images.push({ ...catalog.images[0] }));
    expect(() => loadPreloadedImageCatalog(duplicateFixture.path)).toThrow(/duplicate/u);

    const inconsistentFixture = writeCatalog((catalog) => {
      catalog.images[0] = { ...catalog.images[0], toolchainDigest: '0'.repeat(64) };
    });
    expect(() => loadPreloadedImageCatalog(inconsistentFixture.path)).toThrow(/toolchain digest mismatch/u);
  });
});

function writeCatalog(mutate?: (catalog: PreloadedImageCatalog) => void): {
  directory: string;
  path: string;
  catalog: PreloadedImageCatalog;
} {
  const directory = mkdtempSync(join(tmpdir(), 'preloaded-catalog-'));
  temporaryDirectories.push(directory);
  const generation = 'catalog-2026-07-19.1';
  const entry = writeOciArchiveFixture({
    directory,
    logicalName,
    buildHash,
    architecture: 'arm64',
    catalogGeneration: generation,
  });
  const catalog: PreloadedImageCatalog = {
    schemaVersion: 1,
    runtimeKind: 'docker',
    generation,
    createdAt: '2026-07-19T12:00:00.000Z',
    images: [entry],
  };
  mutate?.(catalog);
  const path = join(directory, 'catalog.json');
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o444 });
  return { directory, path, catalog };
}

function matchingImage(entry: PreloadedImageCatalogEntry, catalogGeneration: string): DockerImageInfo {
  return {
    id: entry.runtimeImageId,
    repoTags: [entry.logicalName],
    created: entry.provenance.createdAt,
    labels: {
      ...buildPreloadedImageLabels(entry, catalogGeneration),
    },
  };
}
