import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContainerRuntime } from '../../src/docker/container-runtime.js';
import { defaultExecFile } from '../../src/docker/docker-manager.js';
import { canonicalizeDockerSaveArchive } from '../../src/docker/oci-image-archive-canonicalizer.js';
import { isRuntimeAvailable } from '../helpers/container-runtimes.js';

const enabled = process.env.CANONICAL_IMAGE_INTEGRATION === '1';
const ready = enabled && isRuntimeAvailable('docker') && isRuntimeAvailable('apple-container');

describe.skipIf(!ready)('canonical Docker-save image archive', () => {
  it('strips Docker legacy entries and loads through both Mac runtimes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ironcurtain-canonical-image-'));
    const logicalName = `localhost/ironcurtain-relay-canonical-${process.pid}:itest`;
    const sourceArchivePath = join(directory, 'docker-save.tar');
    const outputArchivePath = join(directory, 'canonical.tar');
    const docker = createContainerRuntime('docker');
    const apple = createContainerRuntime('apple-container');
    try {
      await defaultExecFile('docker', ['image', 'tag', 'ironcurtain-fixed-relay:phase0f-spike', logicalName], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      await defaultExecFile('docker', ['image', 'save', '--output', sourceArchivePath, logicalName], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      const canonical = await canonicalizeDockerSaveArchive({
        sourceArchivePath,
        outputArchivePath,
        logicalName,
        architecture: 'arm64',
        expectedLabels: { 'com.ironcurtain.docker-workload.component': 'fixed-relay' },
      });
      expect(canonical.configDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

      await docker.removeImage(logicalName);
      await docker.loadImageArchive(outputArchivePath);
      expect((await docker.inspectImage(logicalName))?.id).toBe(canonical.configDigest);
      await docker.removeImage(logicalName);

      await apple.removeImage(logicalName);
      await apple.loadImageArchive(outputArchivePath);
      const appleImage = await apple.inspectImage(logicalName);
      expect(appleImage?.id).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(appleImage?.labels['com.ironcurtain.docker-workload.component']).toBe('fixed-relay');
    } finally {
      await docker.removeImage(logicalName);
      await apple.removeImage(logicalName);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
