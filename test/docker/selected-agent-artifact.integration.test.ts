import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContainerRuntime } from '../../src/docker/container-runtime.js';
import { verifyOciImageArchive } from '../../src/docker/oci-image-archive.js';
import {
  prepareSelectedAgentArtifact,
  verifySelectedAgentArtifactArchive,
} from '../../src/docker/selected-agent-artifact.js';
import { isRuntimeAvailable } from '../helpers/container-runtimes.js';

const enabled = process.env.SELECTED_AGENT_ARTIFACT_INTEGRATION === '1';
const ready = enabled && isRuntimeAvailable('apple-container');

describe.skipIf(!ready)('selected Apple agent artifact', () => {
  it(
    'pins and canonicalizes the actual selected image, including repeated layers',
    async () => {
      const cacheRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-selected-agent-artifact-')));
      const logicalName = process.env.SELECTED_AGENT_IMAGE ?? 'ironcurtain-claude-code:latest';
      const apple = createContainerRuntime('apple-container');
      try {
        const inspected = await apple.inspectImage(logicalName);
        if (inspected === undefined) throw new Error(`selected Apple image is missing: ${logicalName}`);
        const buildHash = inspected.labels['ironcurtain.build-hash'];

        const artifact = await prepareSelectedAgentArtifact({
          runtime: apple,
          logicalName,
          buildHash,
          architecture: 'arm64',
          cacheRoot,
        });
        expect(artifact.appleImageId).toBe(inspected.id);
        await expect(verifySelectedAgentArtifactArchive(artifact)).resolves.toBeUndefined();

        const verified = await verifyOciImageArchive({
          archivePath: artifact.archivePath,
          expectedArchiveSha256: artifact.archiveSha256,
          expectedSizeBytes: artifact.archiveSizeBytes,
          manifestDigest: artifact.manifestDigest,
          configDigest: artifact.dockerImageId,
          logicalName: artifact.logicalName,
          architecture: artifact.architecture,
          expectedLabels: { 'ironcurtain.build-hash': artifact.buildHash },
        });
        expect(verified.layerDigests.length).toBeGreaterThan(0);
        expect(verified.layerDigests.length).toBeGreaterThan(new Set(verified.layerDigests).size);
      } finally {
        rmSync(cacheRoot, { recursive: true, force: true });
      }
    },
    10 * 60_000,
  );
});
