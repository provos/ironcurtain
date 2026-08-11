import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPreloadedCatalogs,
  publishCatalogGeneration,
  REQUIRED_PRELOADED_IMAGE_ROLES,
  type BuildPreloadedCatalogsOptions,
} from '../../src/docker/preloaded-catalog-builder.js';
import { createPreloadedImageCatalogEntry } from '../../src/docker/preloaded-image-catalog.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('complete preloaded catalog builder', () => {
  it('publishes complete backend-bound catalogs only after every role stages', async () => {
    const fixture = builderFixture();
    const stage = vi.fn(stageFixture);
    const result = await buildPreloadedCatalogs({ ...fixture.options, stage });
    expect(stage).toHaveBeenCalledTimes(REQUIRED_PRELOADED_IMAGE_ROLES.length);
    expect(result.docker.catalog).toMatchObject({
      runtimeKind: 'docker',
      generation: fixture.options.generation,
    });
    expect(result.docker.catalog.images).toHaveLength(REQUIRED_PRELOADED_IMAGE_ROLES.length);
    expect(result.appleContainer?.catalog.runtimeKind).toBe('apple-container');
    expect(result.appleContainer?.catalog.images).toHaveLength(REQUIRED_PRELOADED_IMAGE_ROLES.length);
    for (const entry of result.docker.catalog.images) {
      const apple = result.appleContainer?.catalog.images.find(
        (candidate) => candidate.logicalName === entry.logicalName,
      );
      expect(apple?.archive).toEqual(entry.archive);
      expect(apple?.runtimeImageId).not.toBe(entry.runtimeImageId);
    }
  });

  it('rejects missing or duplicate role coverage before staging', async () => {
    const fixture = builderFixture();
    const stage = vi.fn(stageFixture);
    await expect(
      buildPreloadedCatalogs({ ...fixture.options, images: fixture.options.images.slice(1), stage }),
    ).rejects.toThrow(/role coverage mismatch/u);
    const duplicate = [...fixture.options.images.slice(0, -1), fixture.options.images[0]];
    await expect(buildPreloadedCatalogs({ ...fixture.options, images: duplicate, stage })).rejects.toThrow(
      /duplicate image role/u,
    );
    expect(stage).not.toHaveBeenCalled();
  });

  it('removes every earlier archive and publishes no partial catalog after a later staging failure', async () => {
    const fixture = builderFixture();
    let calls = 0;
    const stage = vi.fn<typeof stageFixture>(async (options) => {
      calls += 1;
      if (calls === 3) throw new Error('injected stage failure');
      return stageFixture(options);
    });
    await expect(buildPreloadedCatalogs({ ...fixture.options, stage })).rejects.toThrow(/injected stage failure/u);
    expect(readDirectoryFiles(fixture.directory)).toEqual([]);
  });

  it('fails closed when the two backend entries do not bind the same archive', async () => {
    const fixture = builderFixture();
    const stage = vi.fn<typeof stageFixture>(async (options) => {
      const staged = await stageFixture(options);
      return {
        ...staged,
        appleContainer: {
          ...staged.appleContainer,
          archive: { ...staged.appleContainer.archive, sha256: '9'.repeat(64) },
        },
      };
    });
    await expect(buildPreloadedCatalogs({ ...fixture.options, stage })).rejects.toThrow(
      /do not share one sealed archive/u,
    );
    expect(readDirectoryFiles(fixture.directory)).toEqual([]);
  });
});

describe('live staging generation publication', () => {
  it('replaces the previous generation and leaves no retired sibling behind', async () => {
    const parent = privateParent();
    const live = join(parent, 'preloaded-catalog');
    mkdirSync(live, { mode: 0o700 });
    writeFileSync(join(live, 'base.tar'), 'old-generation');

    const built = await publishCatalogGeneration({
      liveDirectory: live,
      build: async (pending) => {
        expect(pending).not.toBe(live);
        expect(readFileSync(join(live, 'base.tar'), 'utf8')).toBe('old-generation');
        writeFileSync(join(pending, 'base.tar'), 'new-generation');
        return 'published';
      },
    });

    expect(built).toBe('published');
    expect(readFileSync(join(live, 'base.tar'), 'utf8')).toBe('new-generation');
    expect(readDirectoryFiles(parent)).toEqual(['preloaded-catalog']);
  });

  it('leaves the live generation untouched when the build throws', async () => {
    const parent = privateParent();
    const live = join(parent, 'preloaded-catalog');
    mkdirSync(live, { mode: 0o700 });
    writeFileSync(join(live, 'base.tar'), 'old-generation');
    writeFileSync(join(live, 'preloaded-catalog.docker.json'), '{"generation":"old"}');

    await expect(
      publishCatalogGeneration({
        liveDirectory: live,
        build: async (pending) => {
          writeFileSync(join(pending, 'base.tar'), 'half-built');
          throw new Error('injected build failure');
        },
      }),
    ).rejects.toThrow(/injected build failure/u);

    expect(readDirectoryFiles(live)).toEqual(['base.tar', 'preloaded-catalog.docker.json']);
    expect(readFileSync(join(live, 'base.tar'), 'utf8')).toBe('old-generation');
    // The half-built tree is gone: no pending sibling survives a failed build.
    expect(readDirectoryFiles(parent)).toEqual(['preloaded-catalog']);
  });

  it('provisions the first generation when no live directory exists yet', async () => {
    const parent = privateParent();
    const live = join(parent, 'nested', 'preloaded-catalog');

    await publishCatalogGeneration({
      liveDirectory: live,
      build: async (pending) => {
        writeFileSync(join(pending, 'base.tar'), 'first-generation');
      },
    });

    expect(readFileSync(join(live, 'base.tar'), 'utf8')).toBe('first-generation');
    expect(readDirectoryFiles(dirname(live))).toEqual(['preloaded-catalog']);
  });

  it('hands the build a private directory the catalog builder accepts', async () => {
    const parent = privateParent();
    const live = join(parent, 'preloaded-catalog');

    const result = await publishCatalogGeneration({
      liveDirectory: live,
      build: async (pending) => {
        const fixture = builderFixture();
        return buildPreloadedCatalogs({ ...fixture.options, outputDirectory: pending, stage: stageFixture });
      },
    });

    expect(result.docker.catalog.images).toHaveLength(REQUIRED_PRELOADED_IMAGE_ROLES.length);
    expect(readDirectoryFiles(live)).toContain('preloaded-catalog.docker.json');
    expect(existsSync(join(live, 'base.tar'))).toBe(true);
  });
});

function privateParent(): string {
  const directory = mkdtempSync(join(tmpdir(), 'preloaded-catalog-live-'));
  temporaryDirectories.push(directory);
  return directory;
}

function builderFixture(): { readonly directory: string; readonly options: BuildPreloadedCatalogsOptions } {
  const directory = mkdtempSync(join(tmpdir(), 'preloaded-catalog-builder-'));
  temporaryDirectories.push(directory);
  const createdAt = '2026-07-20T12:00:00.000Z';
  return {
    directory,
    options: {
      exec: async () => ({ stdout: '', stderr: '' }),
      dockerRuntime: { inspectImage: async () => undefined },
      appleRuntime: {
        inspectImage: async () => undefined,
        loadImageArchive: async () => {},
        removeImage: async () => false,
      },
      outputDirectory: directory,
      generation: 'catalog-builder-fixture-001',
      createdAt,
      images: REQUIRED_PRELOADED_IMAGE_ROLES.map((role, index) => ({
        role,
        logicalName: `localhost/ironcurtain-${role}:fixture`,
        buildHash: index.toString(16).padStart(64, '0'),
        architecture: 'arm64' as const,
        dockerApi: { min: '1.44', max: '1.52' },
        toolchain: { dockerCli: '29.2.1', dockerDaemon: '29.2.1', buildx: '0.30.1', compose: '5.0.2' },
        provenance: {
          source: `fixture/${role}`,
          sourceDigest: `sha256:${(index + 20).toString(16).padStart(64, '0')}`,
          createdAt,
        },
      })),
    },
  };
}

async function stageFixture(options: Parameters<NonNullable<BuildPreloadedCatalogsOptions['stage']>>[0]) {
  const role = basename(options.image.outputArchivePath, '.tar');
  const archiveBytes = Buffer.from(`archive:${role}`);
  writeFileSync(options.image.outputArchivePath, archiveBytes, { mode: 0o400 });
  const digestHex = roleDigest(role);
  const common = {
    logicalName: options.image.logicalName,
    manifestDigest: `sha256:${roleDigest(`manifest:${role}`)}`,
    configDigest: `sha256:${digestHex}`,
    buildHash: options.image.buildHash,
    architecture: options.image.architecture,
    dockerApi: options.image.dockerApi,
    toolchain: options.image.toolchain,
    provenance: options.image.provenance,
    archive: {
      fileName: basename(options.image.outputArchivePath),
      sha256: roleDigest(`archive:${role}`),
      sizeBytes: archiveBytes.length,
    },
  } as const;
  return {
    docker: createPreloadedImageCatalogEntry({
      ...common,
      runtimeKind: 'docker',
      runtimeImageId: `sha256:${digestHex}`,
    }),
    appleContainer: createPreloadedImageCatalogEntry({
      ...common,
      runtimeKind: 'apple-container',
      runtimeImageId: `sha256:${roleDigest(`apple:${role}`)}`,
    }),
  };
}

function roleDigest(value: string): string {
  return Buffer.from(value).toString('hex').slice(0, 64).padEnd(64, '0');
}

function readDirectoryFiles(directory: string): readonly string[] {
  return readdirSync(directory).sort();
}
