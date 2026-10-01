/** Read the one package runtime executable without extracting an image rootfs. */
import { createReadStream } from 'node:fs';
import { posix } from 'node:path';
import { createGunzip } from 'node:zlib';
import { validateToolchainExecutable } from './toolchain-executable.js';
import { verifyOciImageArchive } from './oci-image-archive.js';
import {
  StreamReader,
  parseTarPath,
  parseTarOctal,
  verifyTarChecksum,
  isZero,
} from './oci-image-archive-canonicalizer.js';
import type { SelectedAgentArtifact } from './selected-agent-artifact.js';

const RUNC_PATH = 'usr/local/lib/ironcurtain-docker/bin/runc';
const MAX_RUNC_BYTES = 128 << 20;
const MAX_LAYER_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_LAYER_ENTRIES = 1_000_000;

/**
 * The archive is selected by the coordinator before any agent runs. OCI digest
 * validation belongs to that archive format, not an executable allowlist.
 * Only file bytes are returned; layer paths are never written to the host.
 */
export async function readSelectedImageRealRunc(artifact: SelectedAgentArtifact): Promise<Buffer> {
  const verified = await verifyOciImageArchive({
    archivePath: artifact.archivePath,
    expectedSizeBytes: artifact.archiveSizeBytes,
    manifestDigest: artifact.manifestDigest,
    configDigest: artifact.dockerImageId,
    logicalName: artifact.logicalName,
    architecture: artifact.architecture,
    expectedLabels: { 'ironcurtain.build-hash': artifact.buildHash },
  });
  const ancestors = new Set<string>();
  for (let path = posix.dirname(RUNC_PATH); path !== '.'; path = posix.dirname(path)) ancestors.add(path);
  const resolvedDirectories = new Set<string>();
  let selected: Buffer | undefined;
  for (const layer of [...verified.layerEntries].reverse()) {
    const input = createReadStream(artifact.archivePath, { start: layer.offset, end: layer.offset + layer.size - 1 });
    const expanded = layer.mediaType.endsWith('+gzip') ? input.pipe(createGunzip()) : input;
    if (expanded !== input) input.on('error', (error) => expanded.destroy(error));
    const reader = new StreamReader(expanded, MAX_LAYER_BYTES);
    const entries = new Map<string, number>();
    const whiteouts = new Set<string>();
    let candidate: Buffer | undefined;
    let paxPath: string | undefined;
    let paxPending = false;
    try {
      for (let count = 0; ; count += 1) {
        if (count >= MAX_LAYER_ENTRIES) throw new Error('image layer has too many entries');
        const header = await reader.readExact(512);
        if (header === null) throw new Error('image layer has no tar end marker');
        if (isZero(header)) {
          if (paxPending) throw new Error('dangling image-layer PAX metadata');
          const second = await reader.readExact(512);
          if (second === null || !isZero(second)) throw new Error('image layer has invalid tar end marker');
          await reader.consumeZeroRemainder();
          break;
        }
        verifyTarChecksum(header);
        const headerPath = parseTarPath(header);
        const size = parseTarOctal(header.subarray(124, 136), 'size');
        const type = header[156];
        if (![0, 48, 49, 50, 51, 52, 53, 54, 120].includes(type))
          throw new Error('unsupported image-layer tar extension');
        if (type === 120 && paxPending) throw new Error('consecutive image-layer PAX metadata');
        const path = paxPath ?? headerPath;
        paxPending = type === 120;
        paxPath = undefined;
        if (type === 120) {
          if (size > 64 * 1024) throw new Error('image layer PAX metadata exceeds bounds');
          const bytes = await reader.readExact(size);
          if (bytes === null) throw new Error('truncated PAX metadata');
          paxPath = parsePaxPath(bytes);
        } else {
          const relevant = path === RUNC_PATH || ancestors.has(path);
          if (relevant) {
            if (entries.has(path)) throw new Error(`duplicate runtime path in image layer: ${path}`);
            entries.set(path, type);
          }
          const base = posix.basename(path);
          if (base.startsWith('.wh.')) {
            if (size !== 0 || (type !== 0 && type !== 48)) throw new Error('invalid image whiteout');
            whiteouts.add(
              base === '.wh..wh..opq' ? posix.dirname(path) : posix.join(posix.dirname(path), base.slice(4)),
            );
          }
          if (path === RUNC_PATH && selected === undefined) {
            if ((type !== 0 && type !== 48) || size === 0 || size > MAX_RUNC_BYTES)
              throw new Error('selected real-runc is not a bounded regular file');
            const mode = parseTarOctal(header.subarray(100, 108), 'mode');
            if ((mode & 0o111) === 0 || (mode & 0o022) !== 0)
              throw new Error('selected real-runc has unsafe executable metadata');
            candidate = (await reader.readExact(size)) ?? undefined;
            if (candidate === undefined) throw new Error('truncated selected real-runc');
          } else {
            for (let remaining = size; remaining > 0; ) {
              const chunk = await reader.readExact(Math.min(remaining, 256 * 1024));
              if (chunk === null) throw new Error('truncated image layer entry');
              remaining -= chunk.length;
            }
          }
        }
        const padding = (512 - (size % 512)) % 512;
        if (padding !== 0 && (await reader.readExact(padding)) === null) throw new Error('truncated layer padding');
      }
      for (const ancestor of ancestors) {
        if (resolvedDirectories.has(ancestor)) continue;
        const type = entries.get(ancestor);
        if (type !== undefined) {
          if (type !== 53) throw new Error(`selected runtime ancestor is not a directory: ${ancestor}`);
          resolvedDirectories.add(ancestor);
        } else if (
          [...whiteouts].some((path) => path === '.' || ancestor === path || ancestor.startsWith(`${path}/`))
        ) {
          throw new Error(`selected runtime ancestor was removed: ${ancestor}`);
        }
      }
      if (selected === undefined) {
        selected = candidate;
        if (
          selected === undefined &&
          [...whiteouts].some((path) => path === '.' || RUNC_PATH === path || RUNC_PATH.startsWith(`${path}/`))
        ) {
          throw new Error('selected real-runc was removed by an image whiteout');
        }
      }
      if (selected !== undefined && resolvedDirectories.size === ancestors.size) break;
    } finally {
      expanded.destroy();
      input.destroy();
    }
  }
  if (selected === undefined || resolvedDirectories.size !== ancestors.size)
    throw new Error('selected image has no regular real-runc with directory ancestors');
  validateToolchainExecutable(selected, artifact.architecture, 'selected real-runc');
  return selected;
}

function parsePaxPath(bytes: Buffer): string | undefined {
  let offset = 0;
  let path: string | undefined;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error('invalid PAX record');
    const lengthText = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/u.test(lengthText)) throw new Error('invalid PAX length');
    const length = Number(lengthText);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset + 1 ||
      offset + length > bytes.length ||
      bytes[offset + length - 1] !== 10
    )
      throw new Error('invalid PAX record length');
    const record = bytes.subarray(space + 1, offset + length - 1).toString('utf8');
    const separator = record.indexOf('=');
    if (separator < 1) throw new Error('invalid PAX key');
    const key = record.slice(0, separator);
    if (key === 'path') {
      if (path !== undefined) throw new Error('duplicate PAX path');
      path = record.slice(separator + 1).replace(/\/$/u, '');
      if (
        path === '' ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.includes('\0') ||
        path.includes('\uFFFD') ||
        posix.normalize(path) !== path ||
        path.split('/').includes('..')
      )
        throw new Error('unsafe PAX path');
    } else if (!['mtime', 'atime', 'ctime', 'linkpath', 'SCHILY.xattr.security.capability'].includes(key)) {
      throw new Error(`unsupported image-layer PAX key: ${key}`);
    }
    offset += length;
  }
  return path;
}
