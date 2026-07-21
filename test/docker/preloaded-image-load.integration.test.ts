import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContainerRuntime, type ContainerRuntimeKind } from '../../src/docker/container-runtime.js';
import {
  buildPreloadedImageLabels,
  resolvePreloadedImage,
  type PreloadedImageCatalog,
} from '../../src/docker/preloaded-image-catalog.js';
import { verifyOciImageArchive } from '../../src/docker/oci-image-archive.js';
import { isRuntimeAvailable } from '../helpers/container-runtimes.js';
import { writeOciArchiveFixture } from '../helpers/oci-archive-fixture.js';

const enabled = process.env.PRELOADED_IMAGE_INTEGRATION === '1';
const runtimeKinds: readonly ContainerRuntimeKind[] = ['docker', 'apple-container'];

for (const runtimeKind of runtimeKinds) {
  const ready = enabled && isRuntimeAvailable(runtimeKind);

  describe.skipIf(!ready)(`verified preloaded image loading (${runtimeKind})`, () => {
    it('loads a verified OCI archive and proves the backend-specific immutable ID and labels', async () => {
      const runtime = createContainerRuntime(runtimeKind);
      const directory = mkdtempSync(join(tmpdir(), `ironcurtain-preloaded-${runtimeKind}-`));
      const logicalName = `localhost/ironcurtain-preloaded-${runtimeKind}-${process.pid}:itest`;
      const generation = `integration-${runtimeKind}-${process.pid}`;

      await runtime.removeImage(logicalName);
      try {
        let entry = writeOciArchiveFixture({
          directory,
          logicalName,
          buildHash: '6'.repeat(64),
          architecture: 'arm64',
          catalogGeneration: generation,
          runtimeImageIdKind: runtimeKind === 'apple-container' ? 'index' : 'config',
        });
        const archivePath = join(directory, entry.archive.fileName);
        const expectedLabels = buildPreloadedImageLabels(entry, generation);
        await verifyOciImageArchive({
          archivePath,
          expectedArchiveSha256: entry.archive.sha256,
          expectedSizeBytes: entry.archive.sizeBytes,
          manifestDigest: entry.manifestDigest,
          configDigest: entry.configDigest,
          logicalName: entry.logicalName,
          architecture: entry.architecture,
          expectedLabels,
        });

        if (runtimeKind === 'apple-container') {
          // Apple Container deterministically synthesizes a local top-level
          // descriptor when importing OCI layout. A trusted staging job
          // records that backend ID in the catalog after the archive itself
          // has passed the same verifier used by the product.
          await runtime.loadImageArchive(archivePath);
          const staged = await runtime.inspectImage(logicalName);
          if (staged === undefined) throw new Error('Apple staging load did not create the logical image ref');
          entry = { ...entry, runtimeImageId: staged.id };
          await runtime.removeImage(logicalName);
        }
        const catalog: PreloadedImageCatalog = {
          schemaVersion: 1,
          runtimeKind,
          generation,
          createdAt: '2026-07-20T12:00:00.000Z',
          images: [entry],
        };
        const catalogPath = join(directory, 'catalog.json');
        writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o444 });

        const resolved = await resolvePreloadedImage(runtime, {
          catalogPath,
          runtimeKind,
          logicalName,
          expectedBuildHash: entry.buildHash,
          architecture: 'arm64',
        });
        expect(resolved.immutableImageId).toBe(entry.runtimeImageId);
        expect(resolved.archiveSha256).toBe(entry.archive.sha256);

        const inspected = await runtime.inspectImage(logicalName);
        expect(inspected?.id).toBe(entry.runtimeImageId);
        expect(inspected?.labels).toMatchObject(expectedLabels);
      } finally {
        await runtime.removeImage(logicalName);
        rmSync(directory, { recursive: true, force: true });
      }
    }, 120_000);
  });
}
