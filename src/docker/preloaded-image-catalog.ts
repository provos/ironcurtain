/**
 * Fail-closed resolver for trusted, preloaded container images.
 *
 * The catalog is host-owned input outside the workspace. This module never
 * builds, pulls, or retags an image: it verifies the complete OCI archive,
 * loads it only when the authorized logical ref is absent, then proves that
 * the ref resolves to the exact immutable image and metadata tuple authorized
 * by the catalog.
 */

import { arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { readHardenedFile } from '../hardened-fs.js';
import { computeHash, sha256Hex, sha256HexSchema } from '../hash.js';
import type { ContainerRuntime, DockerImageInfo } from './types.js';
import { RUNTIME_TRUST_SCHEMA } from './runtime-trust.js';
import { verifyOciImageArchive } from './oci-image-archive.js';
import type { ContainerRuntimeKind } from './container-runtime.js';
import { compareDockerApiVersions } from './docker-api-version.js';

export { RUNTIME_TRUST_SCHEMA } from './runtime-trust.js';

export const PRELOADED_IMAGE_CATALOG_SCHEMA_VERSION = 1;
export const IMAGE_BUILD_HASH_SCHEMA = 'ironcurtain-build-v1';
export const MAX_PRELOADED_CATALOG_BYTES = 1024 * 1024;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const apiVersionSchema = z.string().regex(/^\d{1,3}\.\d{1,3}$/u);
const nonEmptySchema = z.string().min(1).max(512);

const toolchainSchema = z
  .object({
    dockerCli: z.string().min(1).max(128).nullable(),
    dockerDaemon: z.string().min(1).max(128).nullable(),
    buildx: z.string().min(1).max(128).nullable(),
    compose: z.string().min(1).max(128).nullable(),
  })
  .strict();

const imageCatalogEntrySchema = z
  .object({
    runtimeKind: z.enum(['docker', 'apple-container']),
    logicalName: z.string().min(1).max(255),
    runtimeImageId: digestSchema,
    manifestDigest: digestSchema,
    configDigest: digestSchema,
    buildHashSchema: z.literal(IMAGE_BUILD_HASH_SCHEMA),
    buildHash: sha256HexSchema,
    architecture: z.enum(['amd64', 'arm64']),
    dockerApi: z.object({ min: apiVersionSchema, max: apiVersionSchema }).strict(),
    runtimeTrustSchema: z.literal(RUNTIME_TRUST_SCHEMA),
    toolchain: toolchainSchema,
    toolchainDigest: sha256HexSchema,
    provenance: z
      .object({
        source: nonEmptySchema,
        sourceDigest: digestSchema,
        createdAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
    provenanceDigest: sha256HexSchema,
    archive: z
      .object({
        fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.tar$/u),
        sha256: sha256HexSchema,
        sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();

const imageCatalogSchema = z
  .object({
    schemaVersion: z.literal(PRELOADED_IMAGE_CATALOG_SCHEMA_VERSION),
    runtimeKind: z.enum(['docker', 'apple-container']),
    generation: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    createdAt: z.iso.datetime({ offset: true }),
    images: z.array(imageCatalogEntrySchema).min(1).max(512),
  })
  .strict();

export type PreloadedImageCatalogEntry = z.infer<typeof imageCatalogEntrySchema>;
export type PreloadedImageCatalog = z.infer<typeof imageCatalogSchema>;

export interface LoadedPreloadedImageCatalog {
  readonly path: string;
  readonly sha256: string;
  readonly catalog: PreloadedImageCatalog;
}

export interface ResolvePreloadedImageOptions {
  readonly catalogPath: string;
  readonly runtimeKind: ContainerRuntimeKind;
  readonly logicalName: string;
  readonly expectedBuildHash: string;
  readonly architecture?: 'amd64' | 'arm64';
  /** Actual daemon API version, when the caller has already probed it. */
  readonly dockerApiVersion?: string;
}

export interface ResolvedPreloadedImage {
  readonly mode: 'preloaded-catalog';
  readonly runtimeKind: ContainerRuntimeKind;
  readonly logicalName: string;
  readonly immutableImageId: string;
  readonly buildHash: string;
  readonly catalogGeneration: string;
  readonly catalogSha256: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly toolchainDigest: string;
  readonly provenanceDigest: string;
  readonly archivePath: string;
  readonly archiveSha256: string;
}

export interface CreatePreloadedImageCatalogEntryOptions {
  readonly runtimeKind: ContainerRuntimeKind;
  readonly logicalName: string;
  readonly runtimeImageId: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly buildHash: string;
  readonly architecture: 'amd64' | 'arm64';
  readonly dockerApi: { readonly min: string; readonly max: string };
  readonly toolchain: PreloadedImageCatalogEntry['toolchain'];
  readonly provenance: PreloadedImageCatalogEntry['provenance'];
  readonly archive: PreloadedImageCatalogEntry['archive'];
}

const IMAGE_LABELS = {
  buildHashSchema: 'ironcurtain.build-hash-schema',
  buildHash: 'ironcurtain.build-hash',
  architecture: 'ironcurtain.architecture',
  dockerApiMin: 'ironcurtain.docker-api-min',
  dockerApiMax: 'ironcurtain.docker-api-max',
  runtimeTrustSchema: 'ironcurtain.runtime-trust-schema',
  toolchainDigest: 'ironcurtain.toolchain-digest',
  provenanceDigest: 'ironcurtain.provenance-digest',
  catalogGeneration: 'ironcurtain.catalog-generation',
} as const;

/** Read, bound, parse, and internally validate one trusted catalog file. */
export function loadPreloadedImageCatalog(catalogPath: string): LoadedPreloadedImageCatalog {
  if (!catalogPath.startsWith('/')) throw new Error('preloaded image catalog path must be absolute');
  // Validate and read through one no-follow descriptor so a rename or symlink
  // swap between path checks cannot change the bytes we authorize.
  const bytes = readHardenedFile(catalogPath, {
    label: 'preloaded image catalog',
    minBytes: 2,
    maxBytes: MAX_PRELOADED_CATALOG_BYTES,
  });
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`invalid preloaded image catalog JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const parsed = imageCatalogSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`invalid preloaded image catalog: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
  }

  const names = new Set<string>();
  for (const entry of parsed.data.images) {
    if (names.has(entry.logicalName)) throw new Error(`duplicate preloaded image entry: ${entry.logicalName}`);
    names.add(entry.logicalName);
    assertVersionRange(entry.dockerApi.min, entry.dockerApi.max, entry.logicalName);
    assertDigestMatches('toolchain', entry.toolchainDigest, entry.toolchain, entry.logicalName);
    assertDigestMatches('provenance', entry.provenanceDigest, entry.provenance, entry.logicalName);
    if (entry.runtimeKind === 'docker' && entry.runtimeImageId !== entry.configDigest) {
      throw new Error(`Docker preloaded image runtime ID must equal its config digest: ${entry.logicalName}`);
    }
    if (entry.runtimeKind !== parsed.data.runtimeKind) {
      throw new Error(`preloaded image entry runtime differs from catalog runtime: ${entry.logicalName}`);
    }
  }

  return {
    path: catalogPath,
    sha256: sha256Hex(bytes),
    catalog: parsed.data,
  };
}

/**
 * Resolve a logical ref from a verified archive and return only its immutable
 * ID. Mutable/mismatched images are terminal; there is no build/pull fallback
 * in this API.
 */
export async function resolvePreloadedImage(
  runtime: Pick<ContainerRuntime, 'inspectImage' | 'loadImageArchive'>,
  options: ResolvePreloadedImageOptions,
): Promise<ResolvedPreloadedImage> {
  if (!/^[a-f0-9]{64}$/u.test(options.expectedBuildHash)) {
    throw new Error('expected preloaded image build hash must be lowercase sha256 hex');
  }
  const loaded = loadPreloadedImageCatalog(options.catalogPath);
  if (loaded.catalog.runtimeKind !== options.runtimeKind) {
    throw new Error(
      `preloaded catalog runtime mismatch: expected ${options.runtimeKind}, got ${loaded.catalog.runtimeKind}`,
    );
  }
  const entry = loaded.catalog.images.find((candidate) => candidate.logicalName === options.logicalName);
  if (!entry) throw new Error(`preloaded image is not present in catalog: ${options.logicalName}`);
  if (entry.runtimeKind !== options.runtimeKind) {
    throw new Error(
      `preloaded image runtime mismatch for ${options.logicalName}: expected ${options.runtimeKind}, got ${entry.runtimeKind}`,
    );
  }

  const expectedArchitecture = options.architecture ?? hostArchitecture();
  if (entry.architecture !== expectedArchitecture) {
    throw new Error(
      `preloaded image architecture mismatch for ${options.logicalName}: expected ${expectedArchitecture}, got ${entry.architecture}`,
    );
  }
  if (entry.buildHash !== options.expectedBuildHash) {
    throw new Error(`preloaded image build hash mismatch for ${options.logicalName}`);
  }
  if (
    options.dockerApiVersion !== undefined &&
    !versionInRange(options.dockerApiVersion, entry.dockerApi.min, entry.dockerApi.max)
  ) {
    throw new Error(
      `preloaded image ${options.logicalName} does not support Docker API ${options.dockerApiVersion} ` +
        `(supported ${entry.dockerApi.min}-${entry.dockerApi.max})`,
    );
  }

  const archivePath = resolve(dirname(loaded.path), entry.archive.fileName);
  const expectedLabels = buildPreloadedImageLabels(entry, loaded.catalog.generation);
  let inspected = await runtime.inspectImage(options.logicalName);
  if (!inspected) {
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
    await runtime.loadImageArchive(archivePath);
    inspected = await runtime.inspectImage(options.logicalName);
    if (!inspected) {
      throw new Error(`preloaded image load did not create the catalog ref: ${options.logicalName}`);
    }
  }
  assertLoadedImageMatches(inspected, entry, loaded.catalog.generation);

  return {
    mode: 'preloaded-catalog',
    runtimeKind: entry.runtimeKind,
    logicalName: entry.logicalName,
    immutableImageId: entry.runtimeImageId,
    buildHash: entry.buildHash,
    catalogGeneration: loaded.catalog.generation,
    catalogSha256: loaded.sha256,
    manifestDigest: entry.manifestDigest,
    configDigest: entry.configDigest,
    toolchainDigest: entry.toolchainDigest,
    provenanceDigest: entry.provenanceDigest,
    archivePath,
    archiveSha256: entry.archive.sha256,
  };
}

export function catalogTupleDigest(value: unknown): string {
  return computeHash(value);
}

/** Build one fully self-consistent catalog tuple; staging never hand-writes digests. */
export function createPreloadedImageCatalogEntry(
  options: CreatePreloadedImageCatalogEntryOptions,
): PreloadedImageCatalogEntry {
  return imageCatalogEntrySchema.parse({
    runtimeKind: options.runtimeKind,
    logicalName: options.logicalName,
    runtimeImageId: options.runtimeImageId,
    manifestDigest: options.manifestDigest,
    configDigest: options.configDigest,
    buildHashSchema: IMAGE_BUILD_HASH_SCHEMA,
    buildHash: options.buildHash,
    architecture: options.architecture,
    dockerApi: options.dockerApi,
    runtimeTrustSchema: RUNTIME_TRUST_SCHEMA,
    toolchain: options.toolchain,
    toolchainDigest: catalogTupleDigest(options.toolchain),
    provenance: options.provenance,
    provenanceDigest: catalogTupleDigest(options.provenance),
    archive: options.archive,
  });
}

function assertLoadedImageMatches(
  image: DockerImageInfo,
  entry: PreloadedImageCatalogEntry,
  catalogGeneration: string,
): void {
  if (image.id !== entry.runtimeImageId) {
    throw new Error(
      `preloaded image ID mismatch for ${entry.logicalName}: expected ${entry.runtimeImageId}, got ${image.id}`,
    );
  }
  const expectedLabels = buildPreloadedImageLabels(entry, catalogGeneration);
  for (const [label, expected] of Object.entries(expectedLabels)) {
    if (image.labels[label] !== expected) {
      throw new Error(`preloaded image label mismatch for ${entry.logicalName}: ${label}`);
    }
  }
}

/** Exact labels a catalog builder must stamp into a staged image. */
export function buildPreloadedImageLabels(
  entry: PreloadedImageCatalogEntry,
  catalogGeneration: string,
): Readonly<Record<string, string>> {
  return {
    [IMAGE_LABELS.buildHashSchema]: entry.buildHashSchema,
    [IMAGE_LABELS.buildHash]: entry.buildHash,
    [IMAGE_LABELS.architecture]: entry.architecture,
    [IMAGE_LABELS.dockerApiMin]: entry.dockerApi.min,
    [IMAGE_LABELS.dockerApiMax]: entry.dockerApi.max,
    [IMAGE_LABELS.runtimeTrustSchema]: entry.runtimeTrustSchema,
    [IMAGE_LABELS.toolchainDigest]: entry.toolchainDigest,
    [IMAGE_LABELS.provenanceDigest]: entry.provenanceDigest,
    [IMAGE_LABELS.catalogGeneration]: catalogGeneration,
  };
}

function assertDigestMatches(label: string, expected: string, value: unknown, image: string): void {
  const actual = catalogTupleDigest(value);
  if (actual !== expected) throw new Error(`${label} digest mismatch in preloaded image entry: ${image}`);
}

function assertVersionRange(minimum: string, maximum: string, image: string): void {
  if (compareDockerApiVersions(minimum, maximum) > 0) {
    throw new Error(`invalid Docker API range in preloaded image entry: ${image}`);
  }
}

function versionInRange(value: string, minimum: string, maximum: string): boolean {
  if (!apiVersionSchema.safeParse(value).success) throw new Error(`invalid Docker API version: ${value}`);
  return compareDockerApiVersions(value, minimum) >= 0 && compareDockerApiVersions(value, maximum) <= 0;
}

function hostArchitecture(): 'amd64' | 'arm64' {
  const value = arch();
  if (value === 'x64') return 'amd64';
  if (value === 'arm64') return 'arm64';
  throw new Error(`unsupported host architecture for preloaded image catalog: ${value}`);
}
