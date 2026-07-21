import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContainerRuntime } from '../../src/docker/container-runtime.js';
import { defaultExecFile } from '../../src/docker/docker-manager.js';
import {
  buildPreloadedImageLabels,
  createPreloadedImageCatalogEntry,
  resolvePreloadedImage,
  type PreloadedImageCatalog,
} from '../../src/docker/preloaded-image-catalog.js';
import { stagePreloadedImage } from '../../src/docker/preloaded-image-staging.js';
import { isRuntimeAvailable } from '../helpers/container-runtimes.js';

const enabled = process.env.PRELOADED_STAGING_INTEGRATION === '1';
const ready = enabled && isRuntimeAvailable('docker') && isRuntimeAvailable('apple-container');

describe.skipIf(!ready)('preloaded image staging across Mac runtimes', () => {
  it('stamps, canonicalizes, records backend IDs, and resolves one relay archive independently', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ironcurtain-preloaded-stage-'));
    chmodSync(directory, 0o700);
    const logicalName = `localhost/ironcurtain-relay-stage-${process.pid}:itest`;
    const generation = `stage-itest.${process.pid}`;
    const buildHash = 'a'.repeat(64);
    const toolchain = { dockerCli: '29.2.1', dockerDaemon: '29.2.1', buildx: '0.30.1', compose: '5.0.2' };
    const provenance = {
      source: 'docker/nested-relay',
      sourceDigest: `sha256:${'b'.repeat(64)}`,
      createdAt: '2026-07-20T12:00:00.000Z',
    };
    const dockerApi = { min: '1.44', max: '1.52' };
    const archivePath = join(directory, 'relay.tar');
    const docker = createContainerRuntime('docker');
    const apple = createContainerRuntime('apple-container');
    const provisional = createPreloadedImageCatalogEntry({
      runtimeKind: 'docker',
      logicalName,
      runtimeImageId: `sha256:${'0'.repeat(64)}`,
      manifestDigest: `sha256:${'0'.repeat(64)}`,
      configDigest: `sha256:${'0'.repeat(64)}`,
      buildHash,
      architecture: 'arm64',
      dockerApi,
      toolchain,
      provenance,
      archive: { fileName: 'relay.tar', sha256: '0'.repeat(64), sizeBytes: 1 },
    });
    const labels = buildPreloadedImageLabels(provisional, generation);

    try {
      const buildArgs = Object.entries({
        IRONCURTAIN_BUILD_HASH_SCHEMA: labels['ironcurtain.build-hash-schema'],
        IRONCURTAIN_BUILD_HASH: labels['ironcurtain.build-hash'],
        IRONCURTAIN_ARCHITECTURE: labels['ironcurtain.architecture'],
        IRONCURTAIN_DOCKER_API_MIN: labels['ironcurtain.docker-api-min'],
        IRONCURTAIN_DOCKER_API_MAX: labels['ironcurtain.docker-api-max'],
        IRONCURTAIN_RUNTIME_TRUST_SCHEMA: labels['ironcurtain.runtime-trust-schema'],
        IRONCURTAIN_TOOLCHAIN_DIGEST: labels['ironcurtain.toolchain-digest'],
        IRONCURTAIN_PROVENANCE_DIGEST: labels['ironcurtain.provenance-digest'],
        IRONCURTAIN_CATALOG_GENERATION: labels['ironcurtain.catalog-generation'],
      }).flatMap(([name, value]) => ['--build-arg', `${name}=${value}`]);
      await defaultExecFile(
        'docker',
        ['build', '--pull=false', '--tag', logicalName, ...buildArgs, 'docker/nested-relay'],
        { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      );
      const staged = await stagePreloadedImage({
        exec: defaultExecFile,
        dockerRuntime: docker,
        appleRuntime: apple,
        image: {
          logicalName,
          outputArchivePath: archivePath,
          catalogGeneration: generation,
          buildHash,
          architecture: 'arm64',
          dockerApi,
          toolchain,
          provenance,
        },
      });
      expect(staged.docker.runtimeKind).toBe('docker');
      expect(staged.docker.runtimeImageId).toBe(staged.docker.configDigest);
      expect(staged.appleContainer?.runtimeKind).toBe('apple-container');

      for (const [runtimeKind, runtime, entry] of [
        ['docker', docker, staged.docker],
        ['apple-container', apple, staged.appleContainer],
      ] as const) {
        if (entry === undefined) throw new Error('staging did not create both backend entries');
        const catalog: PreloadedImageCatalog = {
          schemaVersion: 1,
          runtimeKind,
          generation,
          createdAt: provenance.createdAt,
          images: [entry],
        };
        const catalogPath = join(directory, `${runtimeKind}-catalog.json`);
        writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o400 });
        await runtime.removeImage(logicalName);
        const resolved = await resolvePreloadedImage(runtime, {
          runtimeKind,
          catalogPath,
          logicalName,
          expectedBuildHash: buildHash,
          architecture: 'arm64',
          dockerApiVersion: '1.52',
        });
        expect(resolved.immutableImageId).toBe(entry.runtimeImageId);
      }
    } finally {
      await docker.removeImage(logicalName);
      await apple.removeImage(logicalName);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
