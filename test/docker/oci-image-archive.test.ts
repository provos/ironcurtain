import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyOciImageArchive } from '../../src/docker/oci-image-archive.js';
import { buildPreloadedImageLabels } from '../../src/docker/preloaded-image-catalog.js';
import { writeOciArchiveFixture } from '../helpers/oci-archive-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('OCI image archive verification', () => {
  it('streams and verifies the archive, index, manifest, config, layers, platform, and labels', async () => {
    const fixture = makeFixture();
    const verified = await verify(fixture.directory, fixture.entry);
    expect(verified).toMatchObject({
      archiveSha256: fixture.entry.archive.sha256,
      sizeBytes: fixture.entry.archive.sizeBytes,
      manifestDigest: fixture.entry.manifestDigest,
      configDigest: fixture.entry.configDigest,
    });
    expect(verified.layerDigests).toHaveLength(1);
  });

  it('rejects archive mutation before any runtime loader is called', async () => {
    const fixture = makeFixture();
    const path = join(fixture.directory, fixture.entry.archive.fileName);
    const bytes = readFileSync(path);
    bytes[600] ^= 0xff;
    chmodSync(path, 0o644);
    writeFileSync(path, bytes);
    chmodSync(path, 0o444);
    await expect(verify(fixture.directory, fixture.entry)).rejects.toThrow(/mismatch|checksum|padding/u);
  });

  it('rejects symlink and group/world-writable archives', async () => {
    const fixture = makeFixture();
    const path = join(fixture.directory, fixture.entry.archive.fileName);
    chmodSync(path, 0o666);
    await expect(verify(fixture.directory, fixture.entry)).rejects.toThrow(/group\/world writable/u);

    chmodSync(path, 0o444);
    const link = join(fixture.directory, 'linked.oci.tar');
    symlinkSync(path, link);
    await expect(
      verifyOciImageArchive({
        ...verifyOptions(fixture.directory, fixture.entry),
        archivePath: link,
      }),
    ).rejects.toThrow(/non-symlink/u);
  });

  it('rejects a catalog label tuple that is absent from the image config', async () => {
    const fixture = makeFixture();
    await expect(
      verifyOciImageArchive({
        ...verifyOptions(fixture.directory, fixture.entry),
        expectedLabels: {
          ...buildPreloadedImageLabels(fixture.entry, 'catalog-fixture.1'),
          'ironcurtain.unstamped': 'required',
        },
      }),
    ).rejects.toThrow(/config label mismatch/u);
  });

  it('rejects correctly hashed but unreferenced blobs and all other extra paths', async () => {
    const extra = Buffer.from('unreferenced');
    const fixture = makeFixture([
      {
        name: `blobs/sha256/${createHash('sha256').update(extra).digest('hex')}`,
        content: extra,
      },
    ]);
    await expect(verify(fixture.directory, fixture.entry)).rejects.toThrow(/path set mismatch/u);
  });
});

function makeFixture(extraFiles?: readonly { readonly name: string; readonly content: Buffer }[]) {
  const directory = mkdtempSync(join(tmpdir(), 'oci-archive-'));
  temporaryDirectories.push(directory);
  const entry = writeOciArchiveFixture({
    directory,
    logicalName: 'ironcurtain-claude-code:latest',
    buildHash: '4'.repeat(64),
    architecture: 'arm64',
    catalogGeneration: 'catalog-fixture.1',
    extraFiles,
  });
  return { directory, entry };
}

function verify(directory: string, entry: ReturnType<typeof writeOciArchiveFixture>) {
  return verifyOciImageArchive(verifyOptions(directory, entry));
}

function verifyOptions(directory: string, entry: ReturnType<typeof writeOciArchiveFixture>) {
  return {
    archivePath: join(directory, entry.archive.fileName),
    expectedArchiveSha256: entry.archive.sha256,
    expectedSizeBytes: entry.archive.sizeBytes,
    manifestDigest: entry.manifestDigest,
    configDigest: entry.configDigest,
    logicalName: entry.logicalName,
    architecture: entry.architecture,
    expectedLabels: buildPreloadedImageLabels(entry, 'catalog-fixture.1'),
  } as const;
}
