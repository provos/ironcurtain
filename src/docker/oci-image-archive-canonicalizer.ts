/** Trusted staging canonicalizer for Docker-save archives. */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix } from 'node:path';
import { sha256Hex } from '../hash.js';
import { assertCanonicalHostPath } from '../hardened-fs.js';
import { verifyOciImageArchive, type VerifiedOciImageArchive } from './oci-image-archive.js';

const TAR_BLOCK_BYTES = 512;
const COPY_CHUNK_BYTES = 256 * 1024;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_ENTRIES = 100_000;

export interface CanonicalizeDockerSaveArchiveOptions {
  readonly sourceArchivePath: string;
  readonly outputArchivePath: string;
  readonly logicalName: string;
  readonly architecture: 'amd64' | 'arm64';
  readonly expectedLabels: Readonly<Record<string, string>>;
  /**
   * Exact mutable references the source runtime may retain in its OCI
   * annotation after a unique capture alias is created. These names are only
   * structural metadata; the caller pins and inspects the alias before save.
   */
  readonly acceptedSourceReferences?: readonly string[];
}

export interface CanonicalizedDockerSaveArchive extends VerifiedOciImageArchive {
  readonly indexDigest: string;
}

interface SourceEntry {
  readonly size: number;
  readonly digest: string;
  readonly path?: string;
  readonly content?: Buffer;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Convert Docker's current save output into the exact single-image archive
 * accepted by both Docker and Apple Container. Docker's legacy `repositories`
 * and unreferenced compatibility metadata are deliberately not copied.
 */
export async function canonicalizeDockerSaveArchive(
  options: CanonicalizeDockerSaveArchiveOptions,
): Promise<CanonicalizedDockerSaveArchive> {
  validateOptions(options);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'ironcurtain-image-canonicalize-'));
  let outputCreated = false;
  try {
    const source = await extractSourceArchive(options.sourceArchivePath, temporaryDirectory);
    const graph = validateSourceGraph(source, options);
    const layout = Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' }));
    const index = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [
          {
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            digest: graph.manifestDigest,
            size: graph.manifest.size,
            platform: { architecture: options.architecture, os: 'linux' },
            annotations: { 'org.opencontainers.image.ref.name': options.logicalName },
          },
        ],
      }),
    );
    const dockerManifest = Buffer.from(
      JSON.stringify([
        {
          Config: blobPath(graph.configDigest),
          RepoTags: [options.logicalName],
          Layers: graph.layers.map((layer) => blobPath(layer.digest)),
          LayerSources: Object.fromEntries(
            graph.layers.map((layer) => [
              layer.digest,
              { mediaType: layer.mediaType, size: layer.size, digest: layer.digest },
            ]),
          ),
        },
      ]),
    );

    const archive = writeCanonicalArchive(options.outputArchivePath, [
      { name: 'oci-layout', content: layout },
      { name: 'index.json', content: index },
      { name: blobPath(graph.configDigest), filePath: requiredPath(graph.config) },
      ...uniqueByDigest(graph.layers).map((layer) => ({ name: blobPath(layer.digest), filePath: requiredPath(layer) })),
      { name: blobPath(graph.manifestDigest), filePath: requiredPath(graph.manifest) },
      { name: 'manifest.json', content: dockerManifest },
    ]);
    outputCreated = true;
    chmodSync(options.outputArchivePath, 0o400);

    const verified = await verifyOciImageArchive({
      archivePath: options.outputArchivePath,
      expectedArchiveSha256: archive.sha256,
      expectedSizeBytes: archive.sizeBytes,
      manifestDigest: graph.manifestDigest,
      configDigest: graph.configDigest,
      logicalName: options.logicalName,
      architecture: options.architecture,
      expectedLabels: options.expectedLabels,
    });
    return { ...verified, indexDigest: digest(index) };
  } catch (error) {
    if (outputCreated) rmSync(options.outputArchivePath, { force: true });
    throw error;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function validateOptions(options: CanonicalizeDockerSaveArchiveOptions): void {
  assertCanonicalHostPath(options.sourceArchivePath, 'Docker-save source path');
  assertCanonicalHostPath(options.outputArchivePath, 'canonical image archive output path');
  if (options.sourceArchivePath === options.outputArchivePath)
    throw new Error('source and output image archives must differ');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u.test(options.logicalName) || !options.logicalName.includes(':')) {
    throw new Error('canonical image logical name must be one explicit tagged reference');
  }
  if (!basename(options.outputArchivePath).endsWith('.tar'))
    throw new Error('canonical image archive must end in .tar');
  const outputParent = statSync(dirname(options.outputArchivePath));
  if (!outputParent.isDirectory()) throw new Error('canonical image archive parent must be a directory');
  for (const [name, value] of Object.entries(options.expectedLabels)) {
    if (name.length === 0 || name.length > 512 || value.length > 4096)
      throw new Error('canonical image label is invalid');
  }
  for (const reference of options.acceptedSourceReferences ?? []) {
    if (!validLogicalName(reference)) throw new Error('accepted Docker-save source reference is invalid');
  }
}

async function extractSourceArchive(sourcePath: string, directory: string): Promise<ReadonlyMap<string, SourceEntry>> {
  let descriptor: number;
  try {
    descriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`Docker-save source must be a readable regular non-symlink file: ${sourcePath}`, { cause: error });
  }
  let stream: ReturnType<typeof createReadStream> | undefined;
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('Docker-save source must be a regular file');
    if ((stats.mode & 0o022) !== 0) throw new Error('Docker-save source must not be group/world writable');
    stream = createReadStream(sourcePath, { fd: descriptor, autoClose: true, highWaterMark: COPY_CHUNK_BYTES });
    const reader = new StreamReader(stream);
    const entries = new Map<string, SourceEntry>();
    for (;;) {
      const header = await reader.readExact(TAR_BLOCK_BYTES);
      if (header === null) throw new Error('Docker-save source ended before the tar end marker');
      if (isZero(header)) {
        const second = await reader.readExact(TAR_BLOCK_BYTES);
        if (second === null || !isZero(second)) throw new Error('Docker-save source has an invalid tar end marker');
        await reader.consumeZeroRemainder();
        break;
      }
      verifyTarChecksum(header);
      const name = parseTarPath(header);
      if (entries.has(name)) throw new Error(`Docker-save source contains duplicate path: ${name}`);
      if (entries.size >= MAX_SOURCE_ENTRIES) throw new Error('Docker-save source has too many entries');
      const size = parseTarOctal(header.subarray(124, 136), 'size');
      const type = header[156];
      if (type === 53) {
        if (size !== 0 || (name !== '.' && name !== 'blobs' && name !== 'blobs/sha256')) {
          throw new Error(`Docker-save source contains unexpected directory: ${name}`);
        }
        entries.set(name, { size: 0, digest: digest(Buffer.alloc(0)) });
        continue;
      }
      if (type === 120) {
        if (!/(?:^|\/)PaxHeader\/[A-Za-z0-9._-]+$/u.test(name) || size > 4096) {
          throw new Error(`Docker-save source contains unsupported PAX metadata: ${name}`);
        }
        const content = await reader.readExact(size);
        if (content === null || !validApplePaxMetadata(content.toString('utf8'))) {
          throw new Error(`Docker-save source contains invalid PAX metadata: ${name}`);
        }
        const padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
        if (padding > 0) {
          const bytes = await reader.readExact(padding);
          if (bytes === null || !isZero(bytes)) throw new Error(`Docker-save source has invalid padding: ${name}`);
        }
        continue;
      }
      if (type !== 0 && type !== 48) throw new Error(`Docker-save source contains special entry: ${name}`);
      const metadata = name === 'oci-layout' || name === 'index.json' || name === 'manifest.json';
      const blob = /^blobs\/sha256\/[a-f0-9]{64}$/u.test(name);
      const ignoredLegacy = name === 'repositories';
      if (!metadata && !blob && !ignoredLegacy) throw new Error(`Docker-save source contains unexpected path: ${name}`);
      if ((metadata || ignoredLegacy) && size > MAX_METADATA_BYTES) {
        throw new Error(`Docker-save source metadata is too large: ${name}`);
      }

      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      const extractedPath = blob ? join(directory, name.slice('blobs/sha256/'.length)) : undefined;
      const output =
        extractedPath === undefined
          ? undefined
          : openSync(extractedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400);
      try {
        let remaining = size;
        while (remaining > 0) {
          const chunk = await reader.readExact(Math.min(remaining, COPY_CHUNK_BYTES));
          if (chunk === null) throw new Error(`Docker-save source is truncated in ${name}`);
          hash.update(chunk);
          if (metadata) chunks.push(chunk);
          if (output !== undefined) writeAll(output, chunk);
          remaining -= chunk.length;
        }
      } finally {
        if (output !== undefined) closeSync(output);
      }
      const padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      if (padding > 0) {
        const bytes = await reader.readExact(padding);
        if (bytes === null || !isZero(bytes)) throw new Error(`Docker-save source has invalid padding: ${name}`);
      }
      const hashHex = hash.digest('hex');
      if (blob && hashHex !== name.slice('blobs/sha256/'.length)) {
        throw new Error(`Docker-save source blob digest mismatch: ${name}`);
      }
      entries.set(name, {
        size,
        digest: `sha256:${hashHex}`,
        ...(extractedPath === undefined ? {} : { path: extractedPath }),
        ...(metadata ? { content: Buffer.concat(chunks) } : {}),
      });
    }
    return entries;
  } finally {
    if (stream) stream.destroy();
    else closeSync(descriptor);
  }
}

function validApplePaxMetadata(value: string): boolean {
  let offset = 0;
  while (offset < value.length) {
    const separator = value.indexOf(' ', offset);
    if (separator === -1) return false;
    const length = Number.parseInt(value.slice(offset, separator), 10);
    if (!Number.isSafeInteger(length) || length <= separator - offset + 1) return false;
    const record = value.slice(offset, offset + length);
    if (record.length !== length || !/^\d+ (?:atime|ctime)=\d+\n$/u.test(record)) return false;
    offset += length;
  }
  return offset === value.length;
}

function validateSourceGraph(entries: ReadonlyMap<string, SourceEntry>, options: CanonicalizeDockerSaveArchiveOptions) {
  const layout = parseJson(entries, 'oci-layout');
  if (!isObject(layout) || layout.imageLayoutVersion !== '1.0.0') throw new Error('Docker-save OCI layout is invalid');
  const index = parseJson(entries, 'index.json');
  if (
    !isObject(index) ||
    index.schemaVersion !== 2 ||
    index.mediaType !== 'application/vnd.oci.image.index.v1+json' ||
    !Array.isArray(index.manifests) ||
    index.manifests.length !== 1
  ) {
    throw new Error('Docker-save source must contain exactly one OCI manifest');
  }
  const topLevelDescriptor: unknown = index.manifests[0];
  if (!isObject(topLevelDescriptor) || typeof topLevelDescriptor.digest !== 'string') {
    throw new Error('Docker-save index descriptor is invalid');
  }
  assertDigest(topLevelDescriptor.digest, 'Docker-save index descriptor digest');
  if (isObject(topLevelDescriptor.annotations)) {
    const sourceName = topLevelDescriptor.annotations['org.opencontainers.image.ref.name'];
    const acceptedSourceReferences = options.acceptedSourceReferences ?? [options.logicalName];
    if (
      sourceName !== undefined &&
      !acceptedSourceReferences.some((reference) => sameLogicalImageReference(sourceName, reference))
    ) {
      throw new Error('Docker-save index logical name differs from the requested image');
    }
  }
  let descriptor = topLevelDescriptor;
  if (topLevelDescriptor.mediaType === 'application/vnd.oci.image.index.v1+json') {
    const nestedEntry = requiredEntry(entries, blobPath(topLevelDescriptor.digest));
    if (topLevelDescriptor.size !== nestedEntry.size) {
      throw new Error('Docker-save nested index size does not match its descriptor');
    }
    const nested = parseJson(entries, blobPath(topLevelDescriptor.digest));
    if (
      !isObject(nested) ||
      nested.schemaVersion !== 2 ||
      nested.mediaType !== 'application/vnd.oci.image.index.v1+json' ||
      !Array.isArray(nested.manifests)
    ) {
      throw new Error('Docker-save nested OCI index is invalid');
    }
    const matches = nested.manifests.filter(
      (candidate): candidate is JsonObject =>
        isObject(candidate) &&
        isObject(candidate.platform) &&
        candidate.platform.os === 'linux' &&
        candidate.platform.architecture === options.architecture,
    );
    if (matches.length !== 1) {
      throw new Error('Docker-save nested OCI index must contain exactly one requested platform');
    }
    descriptor = matches[0];
  }
  if (descriptor.mediaType !== 'application/vnd.oci.image.manifest.v1+json' || typeof descriptor.digest !== 'string') {
    throw new Error('Docker-save index descriptor is invalid');
  }
  assertDigest(descriptor.digest, 'Docker-save manifest digest');
  const manifestDigest = descriptor.digest;
  const manifest = requiredEntry(entries, blobPath(manifestDigest));
  if (descriptor.size !== manifest.size) throw new Error('Docker-save manifest size does not match its descriptor');
  const manifestJson = parseJson(entries, blobPath(manifestDigest));
  if (
    !isObject(manifestJson) ||
    manifestJson.schemaVersion !== 2 ||
    manifestJson.mediaType !== 'application/vnd.oci.image.manifest.v1+json' ||
    !isObject(manifestJson.config) ||
    !Array.isArray(manifestJson.layers)
  ) {
    throw new Error('Docker-save OCI manifest is invalid');
  }
  if (manifestJson.config.mediaType !== 'application/vnd.oci.image.config.v1+json') {
    throw new Error('Docker-save config media type is invalid');
  }
  const configDigest = manifestJson.config.digest;
  if (typeof configDigest !== 'string') throw new Error('Docker-save config digest is missing');
  assertDigest(configDigest, 'Docker-save config digest');
  const config = requiredEntry(entries, blobPath(configDigest));
  if (manifestJson.config.size !== config.size)
    throw new Error('Docker-save config size does not match its descriptor');
  const configJson = parseJson(entries, blobPath(configDigest));
  if (!isObject(configJson) || configJson.os !== 'linux' || configJson.architecture !== options.architecture) {
    throw new Error('Docker-save config platform mismatch');
  }
  const configSection = configJson.config;
  if (Object.keys(options.expectedLabels).length > 0 && (!isObject(configSection) || !isObject(configSection.Labels)))
    throw new Error('Docker-save config labels are missing');
  for (const [name, expected] of Object.entries(options.expectedLabels)) {
    if (!isObject(configSection) || !isObject(configSection.Labels) || configSection.Labels[name] !== expected) {
      throw new Error(`Docker-save config label mismatch: ${name}`);
    }
  }
  const rootfs = configJson.rootfs;
  if (!isObject(rootfs) || rootfs.type !== 'layers') {
    throw new Error('Docker-save config rootfs is invalid');
  }
  const diffIds = rootfs.diff_ids;
  if (!Array.isArray(diffIds)) throw new Error('Docker-save config rootfs diff IDs are invalid');
  if (diffIds.length !== manifestJson.layers.length || manifestJson.layers.length === 0) {
    throw new Error('Docker-save layer count is invalid');
  }
  const layers = manifestJson.layers.map((value) => {
    if (
      !isObject(value) ||
      (value.mediaType !== 'application/vnd.oci.image.layer.v1.tar' &&
        value.mediaType !== 'application/vnd.oci.image.layer.v1.tar+gzip') ||
      typeof value.digest !== 'string' ||
      typeof value.size !== 'number'
    ) {
      throw new Error('Docker-save source contains an unsupported OCI layer');
    }
    assertDigest(value.digest, 'Docker-save layer digest');
    const entry = requiredEntry(entries, blobPath(value.digest));
    if (entry.size !== value.size) throw new Error('Docker-save layer size mismatch');
    return { ...entry, digest: value.digest, mediaType: value.mediaType };
  });
  if (entries.has('manifest.json')) {
    const dockerManifest = parseJson(entries, 'manifest.json');
    if (!Array.isArray(dockerManifest) || dockerManifest.length !== 1 || !isObject(dockerManifest[0])) {
      throw new Error('Docker-save compatibility manifest must contain one image');
    }
    const dockerItem = dockerManifest[0];
    if (
      dockerItem.Config !== blobPath(configDigest) ||
      !Array.isArray(dockerItem.RepoTags) ||
      dockerItem.RepoTags.length !== 1 ||
      dockerItem.RepoTags[0] !== options.logicalName ||
      !Array.isArray(dockerItem.Layers) ||
      JSON.stringify(dockerItem.Layers) !== JSON.stringify(layers.map((layer) => blobPath(layer.digest)))
    ) {
      throw new Error('Docker-save compatibility manifest differs from the OCI graph/logical name');
    }
  }
  return {
    manifestDigest,
    configDigest,
    manifest,
    config,
    layers,
  };
}

function sameLogicalImageReference(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const normalize = (value: string): string => {
    for (const prefix of ['docker.io/library/', 'localhost/']) {
      if (value.startsWith(prefix)) return value.slice(prefix.length);
    }
    return value;
  };
  return normalize(actual) === normalize(expected);
}

function validLogicalName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u.test(value) && value.includes(':');
}

function requiredEntry(entries: ReadonlyMap<string, SourceEntry>, name: string): SourceEntry {
  const entry = entries.get(name);
  if (entry === undefined) throw new Error(`Docker-save source is missing ${name}`);
  return entry;
}

function requiredPath(entry: SourceEntry): string {
  if (entry.path === undefined) throw new Error('Docker-save source blob was not extracted');
  return entry.path;
}

function parseJson(entries: ReadonlyMap<string, SourceEntry>, name: string): unknown {
  const entry = entries.get(name);
  if (entry === undefined) throw new Error(`Docker-save source is missing JSON entry ${name}`);
  if (entry.content === undefined) {
    const path = entry.path;
    if (path === undefined) throw new Error(`Docker-save source is missing JSON entry ${name}`);
    if (entry.size > MAX_METADATA_BYTES) throw new Error(`Docker-save JSON blob is too large: ${name}`);
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Docker-save source contains invalid JSON: ${name}`, { cause: error });
    }
  }
  try {
    return JSON.parse(entry.content.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`Docker-save source contains invalid JSON: ${name}`, { cause: error });
  }
}

function uniqueByDigest<T extends { readonly digest: string }>(values: readonly T[]): readonly T[] {
  return [...new Map(values.map((value) => [value.digest, value])).values()];
}

function writeCanonicalArchive(
  path: string,
  entries: readonly (
    | { readonly name: string; readonly content: Buffer }
    | { readonly name: string; readonly filePath: string }
  )[],
): { readonly sha256: string; readonly sizeBytes: number } {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let failed = false;
  const write = (bytes: Buffer): void => {
    writeAll(descriptor, bytes);
    hash.update(bytes);
    sizeBytes += bytes.length;
  };
  try {
    for (const entry of entries) {
      const size = 'content' in entry ? entry.content.length : regularFileSize(entry.filePath);
      write(tarHeader(entry.name, size));
      if ('content' in entry) {
        write(entry.content);
      } else {
        const input = openSync(entry.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
          for (;;) {
            const length = readSync(input, buffer, 0, buffer.length, null);
            if (length === 0) break;
            write(buffer.subarray(0, length));
          }
        } finally {
          closeSync(input);
        }
      }
      const padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      if (padding > 0) write(Buffer.alloc(padding));
    }
    write(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    closeSync(descriptor);
    if (failed) rmSync(path, { force: true });
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

function regularFileSize(path: string): number {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`canonicalizer source blob is not a regular file: ${path}`);
    return stats.size;
  } finally {
    closeSync(descriptor);
  }
}

function tarHeader(name: string, size: number): Buffer {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/u.test(name)) throw new Error(`canonical tar path is invalid: ${name}`);
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  header.write(name, 0, 'utf8');
  writeOctal(header, 100, 8, 0o444);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0'), 148, 'ascii');
  header[154] = 0;
  header[155] = 32;
  return header;
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('canonical tar numeric field is unsafe');
  const encoded = value.toString(8);
  if (encoded.length > length - 1) throw new Error('canonical tar numeric field is too large');
  target.write(encoded.padStart(length - 1, '0'), offset, 'ascii');
  target[offset + length - 1] = 0;
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
}

class StreamReader {
  private readonly iterator: AsyncIterator<string | Buffer>;
  private pending = Buffer.alloc(0);
  private ended = false;

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
      const lengthToTake = Math.min(remaining, this.pending.length);
      chunks.push(this.pending.subarray(0, lengthToTake));
      this.pending = this.pending.subarray(lengthToTake);
      remaining -= lengthToTake;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
  }

  async consumeZeroRemainder(): Promise<void> {
    for (;;) {
      const bytes = await this.readExact(Math.min(COPY_CHUNK_BYTES, Math.max(1, this.pending.length)));
      if (bytes === null) return;
      if (!isZero(bytes)) throw new Error('Docker-save source contains data after the tar end marker');
    }
  }

  private truncated(): never {
    throw new Error('Docker-save source is truncated');
  }
}

function parseTarPath(header: Buffer): string {
  const name = readTarString(header.subarray(0, 100));
  const prefix = readTarString(header.subarray(345, 500));
  const path = prefix ? `${prefix}/${name}` : name;
  if (path === '' || path.includes('\\') || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`Docker-save source contains unsafe path: ${path}`);
  }
  if (posix.normalize(path).replace(/\/$/u, '') !== path.replace(/\/$/u, '')) {
    throw new Error(`Docker-save source contains non-canonical path: ${path}`);
  }
  return path.replace(/\/$/u, '');
}

function verifyTarChecksum(header: Buffer): void {
  const expected = parseTarOctal(header.subarray(148, 156), 'checksum');
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) actual += index >= 148 && index < 156 ? 32 : header[index];
  if (actual !== expected) throw new Error('Docker-save source tar checksum mismatch');
}

function parseTarOctal(value: Buffer, field: string): number {
  const text = readTarString(value).trim();
  if (!/^[0-7]+$/u.test(text)) throw new Error(`Docker-save source tar ${field} is invalid`);
  const parsed = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Docker-save source tar ${field} is unsafe`);
  return parsed;
}

function readTarString(value: Buffer): string {
  const end = value.indexOf(0);
  const text = value.subarray(0, end === -1 ? value.length : end).toString('utf8');
  if (text.includes('\uFFFD')) throw new Error('Docker-save source tar header is not UTF-8');
  return text;
}

function isZero(value: Buffer): boolean {
  return value.every((byte) => byte === 0);
}

function blobPath(value: string): string {
  return `blobs/sha256/${value.slice('sha256:'.length)}`;
}

function assertDigest(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} is invalid`);
}

function digest(value: Uint8Array): string {
  return `sha256:${sha256Hex(value)}`;
}
