/**
 * Hardened host-filesystem I/O shared by the Docker-workload security kernel.
 *
 * These primitives centralize the fail-closed idioms that were duplicated across
 * `src/docker/` and `src/docker-workload/`: reading a host-owned immutable file
 * through a single no-follow descriptor, atomically writing a durable canonical
 * JSON record, and rejecting non-canonical host paths. Error-message text is
 * load-bearing (tests assert it, and some hashed bytes feed frozen digests), so
 * callers thread a `label` that reproduces their exact message prefix.
 *
 * This is a top-level leaf (imports only Node built-ins, zod, and `./hash.js`)
 * so both `src/docker/` and `src/docker-workload/` can depend on it without a
 * layering violation.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

import { sha256Hex, stableStringify } from './hash.js';

export interface ReadHardenedFileOptions {
  /** Message prefix reproducing the caller's exact error strings. */
  readonly label: string;
  /** Reject files smaller than this many bytes. */
  readonly minBytes: number;
  /** Reject files larger than this many bytes. */
  readonly maxBytes: number;
}

/**
 * Read a host-owned regular file through one `O_RDONLY | O_NOFOLLOW` descriptor,
 * rejecting symlinks, non-regular files, group/world-writable modes, and sizes
 * outside `[minBytes, maxBytes]`. The descriptor is used for both the stat and
 * the read so a rename or symlink swap between checks cannot change the bytes.
 * Callers own any absolute/canonical path check (see {@link assertCanonicalHostPath}).
 */
export function readHardenedFile(path: string, options: ReadHardenedFileOptions): Buffer {
  const { label, minBytes, maxBytes } = options;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be a readable regular non-symlink file: ${path}`, { cause: error });
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
    if ((stats.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable: ${path}`);
    if (stats.size < minBytes || stats.size > maxBytes) {
      throw new Error(`${label} size is outside the allowed range: ${stats.size}`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export interface LoadImmutableHostJsonOptions<T> {
  /** Message prefix reproducing the caller's exact error strings. */
  readonly label: string;
  /** Schema the parsed JSON must satisfy; a mismatch fails closed. */
  readonly schema: z.ZodType<T>;
  /** Reject files larger than this many bytes. */
  readonly maxBytes: number;
  /** Reject files smaller than this many bytes (default 2). */
  readonly minBytes?: number;
}

export interface LoadedImmutableHostJson<T> {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly value: T;
}

/**
 * Load, bound, hash, parse, and schema-validate one host-owned immutable JSON
 * file. Returns the absolute path, the SHA-256 of the exact bytes, the byte
 * length, and the validated value. Any ambiguity fails closed.
 */
export function loadImmutableHostJson<T>(
  path: string,
  options: LoadImmutableHostJsonOptions<T>,
): LoadedImmutableHostJson<T> {
  const { label, schema, maxBytes, minBytes = 2 } = options;
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const bytes = readHardenedFile(path, { label, minBytes, maxBytes });
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`${label} is invalid: ${validated.error.issues[0]?.message ?? 'schema mismatch'}`);
  }
  return { path, sha256: sha256Hex(bytes), sizeBytes: bytes.length, value: validated.data };
}

export interface WriteStableJsonAtomicOptions {
  /** Final file mode applied before the atomic rename (default 0o600). */
  readonly mode?: number;
}

/**
 * Durably write a canonically serialized JSON record via a temp file in the same
 * directory, fsync + rename, then fsync the parent directory. The serialization
 * is {@link stableStringify} with a trailing newline so the on-disk bytes are
 * stable across writers.
 */
export function writeStableJsonAtomic(path: string, value: unknown, options: WriteStableJsonAtomicOptions = {}): void {
  const { mode = 0o600 } = options;
  const directory = dirname(path);
  const temporary = resolve(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${stableStringify(value)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

/** Reject a host path that is not absolute and already canonical (`resolve(path) === path`). */
export function assertCanonicalHostPath(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be canonical and absolute`);
}
