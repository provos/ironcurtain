import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSelectedImageRealRunc } from '../../src/docker/selected-image-file.js';
import { tarFile, writeOciArchiveFixture } from '../helpers/oci-archive-fixture.js';

const target = 'usr/local/lib/ironcurtain-docker/bin/runc';
const parents = [
  'usr',
  'usr/local',
  'usr/local/lib',
  'usr/local/lib/ironcurtain-docker',
  'usr/local/lib/ironcurtain-docker/bin',
];
function elf(architecture: 'amd64' | 'arm64' = 'amd64'): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(architecture === 'amd64' ? 62 : 183, 18);
  return bytes;
}
function layer(...entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}
function directories(): Buffer[] {
  return parents.map((path) => tarFile(path, Buffer.alloc(0), 53, 0o755));
}
function runtime(bytes = elf(), type = 48): Buffer {
  return tarFile(target, bytes, type, 0o755);
}

describe('selected image protected real-runc extraction', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ic-runc-extraction-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  function extract(layers: Buffer[], gzipLayers = false, architecture: 'amd64' | 'arm64' = 'amd64') {
    rmSync(join(directory, 'fixture.oci.tar'), { force: true });
    const fixture = writeOciArchiveFixture({
      directory,
      logicalName: 'fixture:latest',
      buildHash: 'a'.repeat(64),
      architecture,
      layers,
      gzipLayers,
    });
    return readSelectedImageRealRunc({
      logicalName: fixture.logicalName,
      buildHash: fixture.buildHash,
      architecture,
      appleImageId: fixture.runtimeImageId,
      dockerImageId: fixture.configDigest,
      manifestDigest: fixture.manifestDigest,
      archivePath: join(directory, fixture.archive.fileName),
      archiveSizeBytes: fixture.archive.sizeBytes,
    });
  }
  it.each([false, true])('reads only selected regular executable bytes (gzip=%s)', async (gzip) => {
    await expect(extract([layer(...directories(), runtime())], gzip)).resolves.toEqual(elf());
  });
  it('supports Apple arm64 without a byte allowlist', async () => {
    await expect(extract([layer(...directories(), runtime(elf('arm64')))], false, 'arm64')).resolves.toEqual(
      elf('arm64'),
    );
  });
  it('uses an upper replacement even when the overwritten lower leaf is a symlink', async () => {
    const replacement = elf();
    replacement[63] = 42;
    await expect(
      extract([layer(...directories(), runtime(Buffer.alloc(0), 50)), layer(runtime(replacement))]),
    ).resolves.toEqual(replacement);
  });
  it.each([49, 50, 53])('rejects a selected nonregular leaf (type %s)', async (type) => {
    await expect(extract([layer(...directories(), runtime(elf(), type))])).rejects.toThrow(/regular file/u);
  });
  it('rejects a symlink ancestor', async () => {
    await expect(
      extract([layer(...directories().slice(0, -1), tarFile(parents[4], Buffer.alloc(0), 50), runtime())]),
    ).rejects.toThrow(/ancestor is not a directory/u);
  });
  it.each([
    'usr/local/lib/ironcurtain-docker/bin/.wh.runc',
    'usr/local/lib/ironcurtain-docker/bin/.wh..wh..opq',
    '.wh..wh..opq',
  ])('respects upper whiteout %s', async (path) => {
    await expect(extract([layer(...directories(), runtime()), layer(tarFile(path, Buffer.alloc(0)))])).rejects.toThrow(
      /removed/u,
    );
  });
  it('allows a same-layer replacement beside a whiteout', async () => {
    await expect(
      extract([
        layer(...directories(), runtime()),
        layer(tarFile('usr/local/lib/ironcurtain-docker/bin/.wh.runc', Buffer.alloc(0)), runtime()),
      ]),
    ).resolves.toEqual(elf());
  });
  it('rejects a duplicate selected path', async () => {
    await expect(extract([layer(...directories(), runtime(), runtime())])).rejects.toThrow(/duplicate/u);
  });
  it('rejects the wrong executable platform', async () => {
    await expect(extract([layer(...directories(), runtime(elf('arm64')))])).rejects.toThrow(/architecture/u);
  });
  it('rejects group-writable executable metadata', async () => {
    await expect(extract([layer(...directories(), tarFile(target, elf(), 48, 0o775))])).rejects.toThrow(
      /unsafe executable/u,
    );
  });
  it('rejects traversal without extracting any host paths', async () => {
    await expect(
      extract([layer(tarFile('../escape', Buffer.from('bad')), ...directories(), runtime())]),
    ).rejects.toThrow(/path/u);
  });
  it('honors a bounded PAX path for a regular executable', async () => {
    const record = pax('path', target);
    await expect(
      extract([layer(...directories(), tarFile('PaxHeader', record, 120), tarFile('placeholder', elf(), 48, 0o755))]),
    ).resolves.toEqual(elf());
  });
  it('rejects unsafe PAX paths and dangling PAX metadata', async () => {
    await expect(extract([layer(tarFile('PaxHeader', pax('path', '../outside'), 120), runtime())])).rejects.toThrow(
      /unsafe PAX/u,
    );
    await expect(extract([layer(tarFile('PaxHeader', pax('mtime', '0'), 120))])).rejects.toThrow(/dangling/u);
  });
  it('rejects oversized executable headers before allocating their payload', async () => {
    const entry = runtime();
    entry.write((129 << 20).toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    entry.fill(32, 148, 156);
    const sum = entry.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    entry.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    await expect(extract([layer(...directories(), entry)])).rejects.toThrow(/bounded regular/u);
  });
  it('fails when the selected executable is absent', async () => {
    await expect(extract([layer(...directories())])).rejects.toThrow(/no regular real-runc/u);
  });
});

function pax(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length)
    length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`);
}
