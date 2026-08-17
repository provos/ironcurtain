import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalizeDockerSaveArchive } from '../../src/docker/oci-image-archive-canonicalizer.js';
import { writeOciArchiveFixture } from '../helpers/oci-archive-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Docker-save archive canonicalizer', () => {
  it('removes unreferenced Docker metadata and emits the exact verified shared graph', async () => {
    const directory = tempDirectory();
    const legacy = Buffer.from('{"legacy":true}');
    const entry = writeOciArchiveFixture({
      directory,
      logicalName: 'localhost/ironcurtain-canonical:fixture',
      buildHash: '9'.repeat(64),
      architecture: 'arm64',
      extraFiles: [{ name: `blobs/sha256/${sha256(legacy)}`, content: legacy }],
    });
    const source = join(directory, entry.archive.fileName);
    const output = join(directory, 'canonical.tar');
    const canonical = await canonicalizeDockerSaveArchive({
      sourceArchivePath: source,
      outputArchivePath: output,
      logicalName: entry.logicalName,
      architecture: entry.architecture,
      expectedLabels: entry.labels,
    });
    expect(canonical).toMatchObject({
      manifestDigest: entry.manifestDigest,
      configDigest: entry.configDigest,
      archivePath: output,
    });
    expect(readFileSync(output).includes(legacy)).toBe(false);
  });

  it('rejects source mutation and removes a partial output', async () => {
    const directory = tempDirectory();
    const entry = writeOciArchiveFixture({
      directory,
      logicalName: 'localhost/ironcurtain-canonical:fixture',
      buildHash: '9'.repeat(64),
      architecture: 'arm64',
    });
    const source = join(directory, entry.archive.fileName);
    const bytes = readFileSync(source);
    bytes[700] ^= 0xff;
    chmodSync(source, 0o600);
    writeFileSync(source, bytes);
    chmodSync(source, 0o400);
    const output = join(directory, 'canonical.tar');
    await expect(
      canonicalizeDockerSaveArchive({
        sourceArchivePath: source,
        outputArchivePath: output,
        logicalName: entry.logicalName,
        architecture: entry.architecture,
        expectedLabels: entry.labels,
      }),
    ).rejects.toThrow(/digest|checksum|JSON|padding/u);
    expect(() => readFileSync(output)).toThrow();
  });

  it.each([
    [{ indexMediaType: 'application/json' }, /OCI manifest/u],
    [{ descriptorMediaType: 'application/json' }, /index descriptor/u],
  ] as const)('rejects an ambiguous source graph %#', async (mutation, expectedError) => {
    const directory = tempDirectory();
    const entry = writeOciArchiveFixture({
      directory,
      logicalName: 'localhost/ironcurtain-canonical:fixture',
      buildHash: '9'.repeat(64),
      architecture: 'arm64',
      ...mutation,
    });
    await expect(
      canonicalizeDockerSaveArchive({
        sourceArchivePath: join(directory, entry.archive.fileName),
        outputArchivePath: join(directory, 'canonical.tar'),
        logicalName: entry.logicalName,
        architecture: entry.architecture,
        expectedLabels: entry.labels,
      }),
    ).rejects.toThrow(expectedError);
  });

  it('canonicalizes a graph that reuses one layer descriptor', async () => {
    const directory = tempDirectory();
    const entry = writeOciArchiveFixture({
      directory,
      logicalName: 'localhost/ironcurtain-canonical:fixture',
      buildHash: '9'.repeat(64),
      architecture: 'arm64',
      duplicateLayer: true,
    });

    const canonical = await canonicalizeDockerSaveArchive({
      sourceArchivePath: join(directory, entry.archive.fileName),
      outputArchivePath: join(directory, 'canonical.tar'),
      logicalName: entry.logicalName,
      architecture: entry.architecture,
      expectedLabels: entry.labels,
    });

    expect(canonical.layerDigests).toHaveLength(2);
    expect(new Set(canonical.layerDigests).size).toBe(1);
  });

  it('canonicalizes Apple platform-save output with a nested OCI index', async () => {
    const directory = tempDirectory();
    const entry = writeOciArchiveFixture({
      directory,
      logicalName: 'localhost/ironcurtain-canonical:fixture',
      buildHash: '9'.repeat(64),
      architecture: 'arm64',
      nestedIndex: true,
    });

    const canonical = await canonicalizeDockerSaveArchive({
      sourceArchivePath: join(directory, entry.archive.fileName),
      outputArchivePath: join(directory, 'canonical.tar'),
      logicalName: entry.logicalName,
      architecture: entry.architecture,
      expectedLabels: entry.labels,
    });

    expect(canonical.manifestDigest).toBe(entry.manifestDigest);
    expect(canonical.configDigest).toBe(entry.configDigest);
  });
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'image-canonicalizer-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
