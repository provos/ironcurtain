/** Streaming, pre-load verification for a single-platform OCI image archive. */

import { createHash } from 'node:crypto';
import { closeSync, constants, createReadStream, fstatSync, openSync } from 'node:fs';
import { posix } from 'node:path';

const TAR_BLOCK_BYTES = 512;
const STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;

export interface VerifyOciImageArchiveOptions {
  readonly archivePath: string;
  readonly expectedArchiveSha256: string;
  readonly expectedSizeBytes: number;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly logicalName: string;
  readonly architecture: 'amd64' | 'arm64';
  readonly expectedLabels: Readonly<Record<string, string>>;
}

export interface VerifiedOciImageArchive {
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly sizeBytes: number;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly layerDigests: readonly string[];
}

interface ArchiveEntry {
  readonly size: number;
  readonly digest?: string;
  readonly content?: Buffer;
}

/**
 * Verify the complete archive byte stream and every OCI blob before invoking
 * a container runtime loader. Symlinks, special tar entries, traversal,
 * duplicate paths, unlisted blob hashes, and tuple mismatches fail closed.
 */
export async function verifyOciImageArchive(options: VerifyOciImageArchiveOptions): Promise<VerifiedOciImageArchive> {
  assertSha256(options.expectedArchiveSha256, 'archive sha256');
  assertDigest(options.manifestDigest, 'manifest digest');
  assertDigest(options.configDigest, 'config digest');
  if (!options.archivePath.startsWith('/')) throw new Error('OCI image archive path must be absolute');
  if (!Number.isSafeInteger(options.expectedSizeBytes) || options.expectedSizeBytes < TAR_BLOCK_BYTES * 3) {
    throw new Error('OCI image archive expected size is invalid');
  }

  let descriptor: number;
  let stream: ReturnType<typeof createReadStream> | undefined;
  try {
    descriptor = openSync(options.archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`OCI image archive must be a readable regular non-symlink file: ${options.archivePath}`, {
      cause: error,
    });
  }

  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`OCI image archive must be a regular file: ${options.archivePath}`);
    if ((stats.mode & 0o022) !== 0) {
      throw new Error(`OCI image archive must not be group/world writable: ${options.archivePath}`);
    }
    if (stats.size !== options.expectedSizeBytes) {
      throw new Error(`OCI image archive size mismatch: expected ${options.expectedSizeBytes}, got ${stats.size}`);
    }

    stream = createReadStream(options.archivePath, {
      fd: descriptor,
      autoClose: true,
      highWaterMark: STREAM_CHUNK_BYTES,
    });
    const reader = new HashedStreamReader(stream);
    const entries = new Map<string, ArchiveEntry>();
    for (;;) {
      const header = await reader.readExact(TAR_BLOCK_BYTES);
      if (header === null) throw new Error('OCI image archive ended before the tar end marker');
      if (isZeroBlock(header)) {
        const second = await reader.readExact(TAR_BLOCK_BYTES);
        if (second === null || !isZeroBlock(second)) {
          throw new Error('OCI image archive has an invalid tar end marker');
        }
        await reader.consumeZeroRemainder();
        break;
      }

      verifyTarChecksum(header);
      const name = parseTarPath(header);
      if (entries.has(name)) throw new Error(`OCI image archive contains duplicate path: ${name}`);
      if (entries.size >= MAX_ARCHIVE_ENTRIES) throw new Error('OCI image archive has too many entries');
      const size = parseTarOctal(header.subarray(124, 136), 'size');
      const type = header[156];
      if (type === 53) {
        // Directory. It carries no payload in canonical OCI archives.
        if (size !== 0) throw new Error(`OCI image archive directory has payload: ${name}`);
        assertAllowedArchivePath(name, true);
        entries.set(name, { size: 0 });
        continue;
      }
      if (type !== 0 && type !== 48) {
        throw new Error(`OCI image archive contains unsupported tar entry type ${type}: ${name}`);
      }
      assertAllowedArchivePath(name, false);

      const shouldCapture =
        name === 'oci-layout' ||
        name === 'index.json' ||
        name === 'manifest.json' ||
        name === blobPath(options.manifestDigest) ||
        name === blobPath(options.configDigest);
      if (shouldCapture && size > MAX_METADATA_BYTES) {
        throw new Error(`OCI image archive metadata entry is too large: ${name}`);
      }
      const contentChunks: Buffer[] = [];
      const entryHash = createHash('sha256');
      let remaining = size;
      while (remaining > 0) {
        const chunk = await reader.readExact(Math.min(remaining, STREAM_CHUNK_BYTES));
        if (chunk === null) throw new Error(`OCI image archive truncated in entry: ${name}`);
        entryHash.update(chunk);
        if (shouldCapture) contentChunks.push(chunk);
        remaining -= chunk.length;
      }
      const padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      if (padding > 0) {
        const paddingBytes = await reader.readExact(padding);
        if (paddingBytes === null || !isZeroBlock(paddingBytes)) {
          throw new Error(`OCI image archive has non-zero or missing padding: ${name}`);
        }
      }
      const digest = entryHash.digest('hex');
      if (name.startsWith('blobs/sha256/')) {
        const pathDigest = name.slice('blobs/sha256/'.length);
        if (digest !== pathDigest) throw new Error(`OCI image archive blob digest mismatch: ${name}`);
      }
      entries.set(name, {
        size,
        digest,
        ...(shouldCapture ? { content: Buffer.concat(contentChunks) } : {}),
      });
    }

    const archiveSha256 = reader.digest();
    if (reader.bytesRead !== options.expectedSizeBytes) {
      throw new Error(
        `OCI image archive read-size mismatch: expected ${options.expectedSizeBytes}, got ${reader.bytesRead}`,
      );
    }
    if (archiveSha256 !== options.expectedArchiveSha256) {
      throw new Error('OCI image archive sha256 mismatch');
    }

    return validateOciMetadata(entries, options, archiveSha256);
  } finally {
    if (stream) stream.destroy();
    else closeSync(descriptor);
  }
}

function validateOciMetadata(
  entries: ReadonlyMap<string, ArchiveEntry>,
  options: VerifyOciImageArchiveOptions,
  archiveSha256: string,
): VerifiedOciImageArchive {
  const layout = parseJsonEntry(entries, 'oci-layout') as { imageLayoutVersion?: unknown };
  if (layout.imageLayoutVersion !== '1.0.0') throw new Error('OCI image archive layout version must be 1.0.0');

  const index = parseJsonEntry(entries, 'index.json');
  if (
    !isRecord(index) ||
    index.schemaVersion !== 2 ||
    index.mediaType !== 'application/vnd.oci.image.index.v1+json' ||
    !Array.isArray(index.manifests) ||
    index.manifests.length !== 1
  ) {
    throw new Error('OCI image archive index is invalid');
  }
  const manifests = Array.from(index.manifests as unknown[]);
  const descriptor = manifests.find((value: unknown) => {
    if (
      !isRecord(value) ||
      value.mediaType !== 'application/vnd.oci.image.manifest.v1+json' ||
      value.digest !== options.manifestDigest ||
      !isRecord(value.annotations) ||
      value.annotations['org.opencontainers.image.ref.name'] !== options.logicalName
    ) {
      return false;
    }
    const platform = value.platform;
    return isRecord(platform) && platform.os === 'linux' && platform.architecture === options.architecture;
  });
  if (!isRecord(descriptor)) throw new Error('OCI image archive index does not contain the authorized platform');
  const manifestEntry = entries.get(blobPath(options.manifestDigest));
  if (!manifestEntry || descriptor.size !== manifestEntry.size) {
    throw new Error('OCI image archive manifest descriptor size mismatch');
  }

  const manifest = parseJsonEntry(entries, blobPath(options.manifestDigest));
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== 'application/vnd.oci.image.manifest.v1+json' ||
    !isRecord(manifest.config) ||
    !Array.isArray(manifest.layers)
  ) {
    throw new Error('OCI image archive manifest is invalid');
  }
  if (
    manifest.config.mediaType !== 'application/vnd.oci.image.config.v1+json' ||
    manifest.config.digest !== options.configDigest
  ) {
    throw new Error('OCI image archive config digest does not match the catalog');
  }
  const configEntry = entries.get(blobPath(options.configDigest));
  if (!configEntry || manifest.config.size !== configEntry.size) {
    throw new Error('OCI image archive config descriptor size mismatch');
  }

  const layerDigests: string[] = [];
  for (const layer of manifest.layers) {
    if (
      !isRecord(layer) ||
      layer.mediaType !== 'application/vnd.oci.image.layer.v1.tar' ||
      typeof layer.digest !== 'string' ||
      typeof layer.size !== 'number'
    ) {
      throw new Error('OCI image archive layer descriptor is invalid');
    }
    assertDigest(layer.digest, 'layer digest');
    const entry = entries.get(blobPath(layer.digest));
    if (!entry || entry.size !== layer.size) {
      throw new Error(`OCI image archive layer descriptor mismatch: ${layer.digest}`);
    }
    layerDigests.push(layer.digest);
  }
  if (layerDigests.length === 0) throw new Error('OCI image archive manifest has no layers');

  const config = parseJsonEntry(entries, blobPath(options.configDigest));
  if (!isRecord(config) || config.architecture !== options.architecture || config.os !== 'linux') {
    throw new Error('OCI image archive config platform does not match the catalog');
  }
  const configSection = config.config;
  if (!isRecord(configSection) || !isRecord(configSection.Labels)) {
    throw new Error('OCI image archive config labels are missing');
  }
  for (const [name, expected] of Object.entries(options.expectedLabels)) {
    if (configSection.Labels[name] !== expected) {
      throw new Error(`OCI image archive config label mismatch: ${name}`);
    }
  }

  validateDockerLoadMetadata(entries, options, config, layerDigests);
  const exactPaths = new Set([
    'oci-layout',
    'index.json',
    'manifest.json',
    blobPath(options.manifestDigest),
    blobPath(options.configDigest),
    ...layerDigests.map(blobPath),
  ]);
  const actualPaths = new Set(entries.keys());
  const unexpected = [...actualPaths].filter((path) => !exactPaths.has(path));
  const missing = [...exactPaths].filter((path) => !actualPaths.has(path));
  if (unexpected.length > 0 || missing.length > 0 || actualPaths.size !== exactPaths.size) {
    throw new Error(
      `OCI image archive path set mismatch: unexpected=${unexpected.sort().join(',') || '(none)'} ` +
        `missing=${missing.sort().join(',') || '(none)'}`,
    );
  }

  return {
    archivePath: options.archivePath,
    archiveSha256,
    sizeBytes: options.expectedSizeBytes,
    manifestDigest: options.manifestDigest,
    configDigest: options.configDigest,
    layerDigests,
  };
}

/**
 * Docker Engine's `image load` still consumes the Docker-save manifest even
 * when the same tar contains an OCI layout. Require a single-image
 * compatibility view whose config and uncompressed layers are byte-identical
 * to the OCI image, so supporting both loaders cannot widen what is staged.
 */
function validateDockerLoadMetadata(
  entries: ReadonlyMap<string, ArchiveEntry>,
  options: VerifyOciImageArchiveOptions,
  config: Record<string, unknown>,
  ociLayerDigests: readonly string[],
): void {
  const dockerManifest = parseJsonEntry(entries, 'manifest.json');
  if (!Array.isArray(dockerManifest) || dockerManifest.length !== 1 || !isRecord(dockerManifest[0])) {
    throw new Error('OCI image archive Docker compatibility manifest must contain exactly one image');
  }
  const item = dockerManifest[0];
  const expectedConfigPath = blobPath(options.configDigest);
  if (item.Config !== expectedConfigPath) {
    throw new Error('OCI image archive Docker compatibility config does not match the OCI config');
  }
  if (!Array.isArray(item.RepoTags) || item.RepoTags.length !== 1 || item.RepoTags[0] !== options.logicalName) {
    throw new Error('OCI image archive Docker compatibility tag does not match the catalog logical name');
  }

  const rootfs = config.rootfs;
  if (!isRecord(rootfs) || rootfs.type !== 'layers' || !Array.isArray(rootfs.diff_ids)) {
    throw new Error('OCI image archive config rootfs diff IDs are invalid');
  }
  const diffIds = Array.from(rootfs.diff_ids as unknown[]);
  if (
    diffIds.length !== ociLayerDigests.length ||
    !Array.isArray(item.Layers) ||
    item.Layers.length !== diffIds.length
  ) {
    throw new Error('OCI image archive Docker compatibility layer count does not match OCI layers');
  }
  if (!isRecord(item.LayerSources) || Object.keys(item.LayerSources).length !== ociLayerDigests.length) {
    throw new Error('OCI image archive Docker compatibility layer sources are invalid');
  }
  for (let index = 0; index < diffIds.length; index++) {
    const diffId = diffIds[index];
    if (typeof diffId !== 'string') throw new Error('OCI image archive config contains an invalid diff ID');
    assertDigest(diffId, 'rootfs diff ID');
    const layerDigest = ociLayerDigests[index];
    if (diffId !== layerDigest) {
      throw new Error('OCI image archive uncompressed layer digest does not match the config diff ID');
    }
    const expectedLayerPath = blobPath(layerDigest);
    if (item.Layers[index] !== expectedLayerPath) {
      throw new Error('OCI image archive Docker compatibility layer path does not match the config diff ID');
    }
    const layerEntry = entries.get(expectedLayerPath);
    if (layerEntry?.digest !== diffId.slice('sha256:'.length)) {
      throw new Error('OCI image archive Docker compatibility layer bytes do not match the config diff ID');
    }
    const source = item.LayerSources[layerDigest];
    if (
      !isRecord(source) ||
      source.mediaType !== 'application/vnd.oci.image.layer.v1.tar' ||
      source.digest !== layerDigest ||
      source.size !== layerEntry.size
    ) {
      throw new Error('OCI image archive Docker compatibility layer source differs from the OCI descriptor');
    }
  }
}

class HashedStreamReader {
  private readonly iterator: AsyncIterator<string | Buffer>;
  private pending = Buffer.alloc(0);
  private ended = false;
  private readonly hash = createHash('sha256');
  private finalized = false;
  bytesRead = 0;

  constructor(stream: NodeJS.ReadableStream & AsyncIterable<string | Buffer>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async readExact(length: number): Promise<Buffer | null> {
    if (length === 0) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      if (this.pending.length === 0) {
        if (this.ended) return chunks.length === 0 ? null : this.truncated();
        const next = await this.iterator.next();
        if (next.done) {
          this.ended = true;
          return chunks.length === 0 ? null : this.truncated();
        }
        this.pending = Buffer.from(next.value);
        continue;
      }
      const take = Math.min(remaining, this.pending.length);
      const chunk = this.pending.subarray(0, take);
      chunks.push(chunk);
      this.hash.update(chunk);
      this.bytesRead += take;
      this.pending = this.pending.subarray(take);
      remaining -= take;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
  }

  async consumeZeroRemainder(): Promise<void> {
    for (;;) {
      const chunk = await this.readExact(Math.min(STREAM_CHUNK_BYTES, Math.max(1, this.pending.length)));
      if (chunk === null) return;
      if (!isZeroBlock(chunk)) throw new Error('OCI image archive contains data after the tar end marker');
    }
  }

  digest(): string {
    if (this.finalized) throw new Error('OCI image archive hash was already finalized');
    this.finalized = true;
    return this.hash.digest('hex');
  }

  private truncated(): never {
    throw new Error('OCI image archive is truncated');
  }
}

function parseJsonEntry(entries: ReadonlyMap<string, ArchiveEntry>, path: string): unknown {
  const content = entries.get(path)?.content;
  if (!content) throw new Error(`OCI image archive is missing metadata: ${path}`);
  try {
    return JSON.parse(content.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`OCI image archive contains invalid JSON: ${path}`, { cause: error });
  }
}

function parseTarPath(header: Buffer): string {
  const name = readTarString(header.subarray(0, 100));
  const prefix = readTarString(header.subarray(345, 500));
  const path = prefix ? `${prefix}/${name}` : name;
  if (path === '' || path.includes('\\') || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`OCI image archive contains unsafe path: ${path}`);
  }
  const normalized = posix.normalize(path).replace(/\/$/u, '');
  if (normalized !== path.replace(/\/$/u, '')) {
    throw new Error(`OCI image archive contains non-canonical path: ${path}`);
  }
  return normalized;
}

function assertAllowedArchivePath(path: string, directory: boolean): void {
  const allowedFile =
    path === 'oci-layout' ||
    path === 'index.json' ||
    path === 'manifest.json' ||
    /^blobs\/sha256\/[a-f0-9]{64}$/u.test(path);
  const allowedDirectory = path === 'blobs' || path === 'blobs/sha256' || /^[a-f0-9]{64}$/u.test(path);
  if ((directory && !allowedDirectory) || (!directory && !allowedFile)) {
    throw new Error(`OCI image archive contains unexpected path: ${path}`);
  }
}

function verifyTarChecksum(header: Buffer): void {
  const expected = parseTarOctal(header.subarray(148, 156), 'checksum');
  let actual = 0;
  for (let index = 0; index < header.length; index++) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) throw new Error('OCI image archive tar header checksum mismatch');
}

function parseTarOctal(value: Buffer, label: string): number {
  const text = readTarString(value).trim();
  if (!/^[0-7]+$/u.test(text)) throw new Error(`OCI image archive tar ${label} is invalid`);
  const parsed = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`OCI image archive tar ${label} is unsafe`);
  return parsed;
}

function readTarString(value: Buffer): string {
  const end = value.indexOf(0);
  const text = value.subarray(0, end === -1 ? value.length : end).toString('utf8');
  if (text.includes('\uFFFD')) throw new Error('OCI image archive tar header is not valid UTF-8');
  return text;
}

function blobPath(digest: string): string {
  return `blobs/sha256/${digest.slice('sha256:'.length)}`;
}

function assertDigest(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`OCI image archive ${label} is invalid`);
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`OCI image archive ${label} is invalid`);
}

function isZeroBlock(value: Buffer): boolean {
  return value.every((byte) => byte === 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
