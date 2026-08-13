import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  runBuildPreloadedCatalog,
  runBuildPreloadedCatalogCommand,
  runPreloadedCatalogBuildSingleFlight,
  type RunBuildPreloadedCatalogOptions,
} from '../../src/docker/build-preloaded-catalog-command.js';
import { acquireProcessLock, ProcessLockBusyError } from '../../src/docker-workload/process-lock.js';
import { publishCatalogGeneration } from '../../src/docker/preloaded-catalog-builder.js';
import { catalogImageSources, type CatalogImageSource } from '../../src/docker/preloaded-catalog-sources.js';
import {
  createPreloadedImageCatalogEntry,
  type PreloadedImageCatalogEntry,
} from '../../src/docker/preloaded-image-catalog.js';
import type { BuildPreloadedCatalogsOptions } from '../../src/docker/preloaded-catalog-builder.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function privateDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

async function stageFixture(options: Parameters<NonNullable<BuildPreloadedCatalogsOptions['stage']>>[0]) {
  const role = basename(options.image.outputArchivePath, '.tar');
  const bytes = Buffer.from(`archive:${role}`);
  writeFileSync(options.image.outputArchivePath, bytes, { mode: 0o400 });
  const common = {
    logicalName: options.image.logicalName,
    manifestDigest: `sha256:${roleDigest(`manifest:${role}`)}`,
    configDigest: `sha256:${roleDigest(role)}`,
    buildHash: options.image.buildHash,
    architecture: options.image.architecture,
    dockerApi: options.image.dockerApi,
    toolchain: options.image.toolchain,
    provenance: options.image.provenance,
    archive: {
      fileName: basename(options.image.outputArchivePath),
      sha256: roleDigest(`archive:${role}`),
      sizeBytes: bytes.length,
    },
  } as const;
  return {
    docker: createPreloadedImageCatalogEntry({
      ...common,
      runtimeKind: 'docker',
      runtimeImageId: `sha256:${roleDigest(role)}`,
    }),
    appleContainer: createPreloadedImageCatalogEntry({
      ...common,
      runtimeKind: 'apple-container',
      runtimeImageId: `sha256:${roleDigest(`apple:${role}`)}`,
    }),
  } satisfies { docker: PreloadedImageCatalogEntry; appleContainer: PreloadedImageCatalogEntry };
}

function roleDigest(value: string): string {
  return Buffer.from(value).toString('hex').slice(0, 64).padEnd(64, '0');
}

/** A live staging path inside a private parent, mirroring the real layout. */
function liveStagingPath(): string {
  return join(privateDir('preloaded-live-'), 'preloaded-catalog');
}

function baseOptions(overrides: Partial<RunBuildPreloadedCatalogOptions>): RunBuildPreloadedCatalogOptions {
  return {
    runtimes: {
      dockerRuntime: { inspectImage: async () => undefined, buildImage: async () => {} },
      appleRuntime: {
        inspectImage: async () => undefined,
        loadImageArchive: async () => {},
        removeImage: async () => false,
      },
      exec: async () => ({ stdout: '', stderr: '' }),
    },
    sources: catalogImageSources(),
    stagingDir: privateDir('preloaded-staging-'),
    frozenCatalogDir: privateDir('preloaded-frozen-'),
    generation: 'freeze-command-fixture.1',
    createdAt: '2026-07-20T12:00:00.000Z',
    architecture: 'arm64',
    agentBuildHash: (logicalName: string) => roleDigest(`agent:${logicalName}`),
    stage: stageFixture,
    ...overrides,
  };
}

describe('runBuildPreloadedCatalog', () => {
  it('builds every role base-first and publishes both staged and frozen catalogs', async () => {
    const buildOrder: string[] = [];
    const buildImage = vi.fn(async (source: CatalogImageSource) => {
      buildOrder.push(source.role);
    });
    const options = baseOptions({ buildImage });

    const result = await runBuildPreloadedCatalog(options);

    expect(buildImage).toHaveBeenCalledTimes(catalogImageSources().length);
    expect(buildOrder[0]).toBe('base');
    expect(result.docker.catalog.images).toHaveLength(catalogImageSources().length);
    expect(result.appleContainer?.catalog.images).toHaveLength(catalogImageSources().length);

    // Runtime-resolvable copy lives beside the sealed archives.
    expect(existsSync(join(options.stagingDir, 'preloaded-catalog.docker.json'))).toBe(true);
    expect(existsSync(join(options.stagingDir, 'base.tar'))).toBe(true);
    // Committed frozen record mirrors the staged catalog exactly.
    const frozenDocker = join(options.frozenCatalogDir, 'preloaded-catalog.docker.json');
    expect(result.frozenDockerPath).toBe(frozenDocker);
    expect(readFileSync(frozenDocker, 'utf8')).toBe(readFileSync(result.stagedDockerPath, 'utf8'));
    expect(result.frozenApplePath).toBe(join(options.frozenCatalogDir, 'preloaded-catalog.apple-container.json'));
    expect(readFileSync(result.frozenApplePath as string, 'utf8')).toBe(
      readFileSync(result.stagedApplePath as string, 'utf8'),
    );
  });

  it('publishes a docker-only catalog when no Apple runtime is provided', async () => {
    const options = baseOptions({
      runtimes: {
        dockerRuntime: { inspectImage: async () => undefined, buildImage: async () => {} },
        exec: async () => ({ stdout: '', stderr: '' }),
      },
    });

    const result = await runBuildPreloadedCatalog(options);

    expect(result.appleContainer).toBeUndefined();
    expect(result.frozenApplePath).toBeUndefined();
    expect(existsSync(join(options.frozenCatalogDir, 'preloaded-catalog.apple-container.json'))).toBe(false);
    expect(existsSync(join(options.frozenCatalogDir, 'preloaded-catalog.docker.json'))).toBe(true);
  });

  it('swaps a completed freeze into the live staging path', async () => {
    const live = liveStagingPath();
    mkdirSync(live, { mode: 0o700 });
    writeFileSync(join(live, 'preloaded-catalog.docker.json'), '{"generation":"previous"}');

    const result = await publishCatalogGeneration({
      liveDirectory: live,
      build: (stagingDir) => runBuildPreloadedCatalog(baseOptions({ stagingDir })),
    });

    // Readers resolve archives relative to the live catalog's own directory, so
    // the rename must have carried both the catalog and its sealed archives.
    expect(readFileSync(join(live, 'preloaded-catalog.docker.json'), 'utf8')).toBe(
      readFileSync(result.frozenDockerPath, 'utf8'),
    );
    expect(existsSync(join(live, 'base.tar'))).toBe(true);
    expect(readdirSync(dirname(live))).toEqual(['preloaded-catalog']);
  });

  it('preserves the previous live generation when the freeze build fails', async () => {
    const live = liveStagingPath();
    mkdirSync(live, { mode: 0o700 });
    writeFileSync(join(live, 'preloaded-catalog.docker.json'), '{"generation":"previous"}');
    const buildImage = vi.fn(async (source: CatalogImageSource) => {
      if (source.role !== 'base') throw new Error('injected docker build failure');
    });

    await expect(
      publishCatalogGeneration({
        liveDirectory: live,
        build: (stagingDir) => runBuildPreloadedCatalog(baseOptions({ stagingDir, buildImage })),
      }),
    ).rejects.toThrow(/injected docker build failure/u);

    expect(readdirSync(live)).toEqual(['preloaded-catalog.docker.json']);
    expect(readFileSync(join(live, 'preloaded-catalog.docker.json'), 'utf8')).toBe('{"generation":"previous"}');
    expect(readdirSync(dirname(live))).toEqual(['preloaded-catalog']);
  });

  it('rejects a non-hex agent build hash before staging', async () => {
    const buildImage = vi.fn(async () => {});
    await expect(
      runBuildPreloadedCatalog(baseOptions({ buildImage, agentBuildHash: () => 'not-a-hash' })),
    ).rejects.toThrow(/not lowercase sha256 hex/u);
  });
});

describe('catalog-freeze command single-flight', () => {
  const acquireTestLock = (path: string) =>
    acquireProcessLock(path, {
      processIdentityForPid: (pid) => (pid === process.pid ? 'catalog-command-test-process' : undefined),
    });

  it('returns help before acquiring the build lock', async () => {
    const runSingleFlight = vi.fn(async () => {
      throw new Error('help attempted to acquire the build lock');
    });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runBuildPreloadedCatalogCommand(['--help'], { runSingleFlight });
    } finally {
      output.mockRestore();
    }
    expect(runSingleFlight).not.toHaveBeenCalled();
  });

  it('holds one process lock before generation resolution and through build completion', async () => {
    const lock = join(privateDir('preloaded-command-lock-'), 'build.lock');
    const stages: string[] = [];
    const result = await runPreloadedCatalogBuildSingleFlight({
      lockPath: lock,
      acquireLock: acquireTestLock,
      resolveGeneration: () => {
        stages.push('resolve');
        expect(() => acquireTestLock(lock)).toThrow(ProcessLockBusyError);
        return { architecture: 'arm64', generation: 'ironcurtain-preloaded-arm64-v4' };
      },
      build: async (resolved) => {
        stages.push(`build:${resolved.generation}`);
        expect(() => acquireTestLock(lock)).toThrow(ProcessLockBusyError);
        return 'published';
      },
    });

    expect(result).toBe('published');
    expect(stages).toEqual(['resolve', 'build:ironcurtain-preloaded-arm64-v4']);
    const reacquired = acquireTestLock(lock);
    reacquired.release();
  });

  it('rejects a concurrent freeze and releases after build failure', async () => {
    const lock = join(privateDir('preloaded-command-lock-'), 'build.lock');
    let releaseBuild!: () => void;
    const buildBlocked = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const first = runPreloadedCatalogBuildSingleFlight({
      lockPath: lock,
      acquireLock: acquireTestLock,
      resolveGeneration: () => ({ architecture: 'arm64', generation: 'ironcurtain-preloaded-arm64-v4' }),
      build: async () => {
        await buildBlocked;
        throw new Error('injected build failure');
      },
    });

    await expect(
      runPreloadedCatalogBuildSingleFlight({
        lockPath: lock,
        acquireLock: acquireTestLock,
        resolveGeneration: () => ({ architecture: 'arm64', generation: 'ironcurtain-preloaded-arm64-v5' }),
        build: async () => 'must-not-run',
      }),
    ).rejects.toBeInstanceOf(ProcessLockBusyError);
    releaseBuild();
    await expect(first).rejects.toThrow(/injected build failure/u);

    const afterFailure = await runPreloadedCatalogBuildSingleFlight({
      lockPath: lock,
      acquireLock: acquireTestLock,
      resolveGeneration: () => ({ architecture: 'arm64', generation: 'ironcurtain-preloaded-arm64-v4' }),
      build: async () => 'recovered',
    });
    expect(afterFailure).toBe('recovered');
  });
});
