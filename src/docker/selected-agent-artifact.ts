/** Automatic, content-verified transport for one selected Apple agent image. */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { arch } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { getIronCurtainHome } from '../config/paths.js';
import { computeHash, sha256HexSchema } from '../hash.js';
import { loadImmutableHostJson, writeStableJsonAtomic } from '../hardened-fs.js';
import { verifyOciImageArchive } from './oci-image-archive.js';
import { canonicalizeDockerSaveArchive } from './oci-image-archive-canonicalizer.js';
import { withProvisionLock } from './provision-lock.js';
import type { ContainerRuntime } from './types.js';

export const SELECTED_AGENT_ARTIFACT_SCHEMA_VERSION = 1;
const METADATA_FILE = 'artifact.json';
const ARCHIVE_FILE = 'selected-agent.oci.tar';
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_UNSTAGED_CACHE_ENTRIES = 2;
const CACHE_ENTRY_EVICTION_GRACE_MS = 60 * 60_000;
const CAPTURE_ALIAS_RECONCILIATION_GRACE_MS = 60 * 60_000;
const PREPARE_DIRECTORY_PATTERN = /^\.prepare-[A-Za-z0-9]{6}$/u;
const CAPTURE_ALIAS_PATTERN =
  /^(?:localhost\/|docker\.io\/library\/)?ironcurtain-capture-p([1-9]\d{0,9})-t(\d{13})-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}):latest$/u;
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

const metadataSchema = z
  .object({
    schemaVersion: z.literal(SELECTED_AGENT_ARTIFACT_SCHEMA_VERSION),
    logicalName: z.string().min(1).max(255),
    buildHash: sha256HexSchema,
    architecture: z.enum(['amd64', 'arm64']),
    appleImageId: digestSchema,
    dockerImageId: digestSchema,
    manifestDigest: digestSchema,
    archive: z
      .object({
        fileName: z.literal(ARCHIVE_FILE),
        sha256: sha256HexSchema,
        sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();

type SelectedAgentArtifactMetadata = z.infer<typeof metadataSchema>;

/** One resolved outer-image identity and its exact inner-Docker transport. */
export interface SelectedAgentArtifact {
  readonly logicalName: string;
  readonly buildHash: string;
  readonly architecture: 'amd64' | 'arm64';
  readonly appleImageId: string;
  readonly dockerImageId: string;
  readonly manifestDigest: string;
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly archiveSizeBytes: number;
}

export interface PrepareSelectedAgentArtifactOptions {
  readonly runtime: Pick<ContainerRuntime, 'inspectImage' | 'listImages' | 'removeImage'> &
    Pick<ContainerRuntime, 'saveImageArchive' | 'tagImage'>;
  readonly logicalName: string;
  readonly buildHash: string;
  readonly cacheRoot?: string;
  readonly architecture?: 'amd64' | 'arm64';
}

const preparedArtifactPromises = new Map<string, Promise<SelectedAgentArtifact>>();

/** Return whether a runtime image reference is one of IronCurtain's capture aliases. */
export function isSelectedAgentCaptureAlias(reference: string): boolean {
  return CAPTURE_ALIAS_PATTERN.test(reference);
}

/**
 * Resolve the current checked-in build once, export it from Apple Container,
 * and cache one Docker-loadable canonical archive. The cache is observational:
 * the current Apple immutable ID is inspected before every lookup and is part
 * of the key, so replacing a mutable tag cannot reuse an older artifact.
 */
export function prepareSelectedAgentArtifact(
  options: PrepareSelectedAgentArtifactOptions,
): Promise<SelectedAgentArtifact> {
  if (!/^[a-f0-9]{64}$/u.test(options.buildHash)) throw new Error('selected agent build hash is invalid');
  const architecture = options.architecture ?? hostArchitecture();
  const cacheRoot = options.cacheRoot ?? resolve(getIronCurtainHome(), 'docker-workload', 'agent-artifacts');
  return resolveCurrentArtifact({ ...options, architecture, cacheRoot });
}

async function resolveCurrentArtifact(
  options: PrepareSelectedAgentArtifactOptions & {
    readonly architecture: 'amd64' | 'arm64';
    readonly cacheRoot: string;
  },
): Promise<SelectedAgentArtifact> {
  const inspected = await options.runtime.inspectImage(options.logicalName);
  if (inspected === undefined) throw new Error(`selected Apple agent image is absent: ${options.logicalName}`);
  if (!/^sha256:[a-f0-9]{64}$/u.test(inspected.id)) {
    throw new Error(`selected Apple agent image has an invalid immutable ID: ${inspected.id}`);
  }
  if (inspected.labels['ironcurtain.build-hash'] !== options.buildHash) {
    throw new Error(`selected Apple agent image build hash changed after preparation: ${options.logicalName}`);
  }

  // A mutable tag can be replaced with the same build-hash label. Include the
  // freshly inspected immutable Apple ID so only concurrent work for that
  // exact image is coalesced. Completed promises are removed: a later session
  // always re-captures the selected tag before consulting the disk cache.
  const preparationKey = computeHash({
    cacheRoot: options.cacheRoot,
    logicalName: options.logicalName,
    appleImageId: inspected.id,
    buildHash: options.buildHash,
    architecture: options.architecture,
  });
  const existing = preparedArtifactPromises.get(preparationKey);
  if (existing !== undefined) return existing;
  const pending = prepareSelectedAgentArtifactUncached(options, inspected);
  preparedArtifactPromises.set(preparationKey, pending);
  try {
    return await pending;
  } finally {
    if (preparedArtifactPromises.get(preparationKey) === pending) preparedArtifactPromises.delete(preparationKey);
  }
}

async function prepareSelectedAgentArtifactUncached(
  options: PrepareSelectedAgentArtifactOptions & {
    readonly architecture: 'amd64' | 'arm64';
    readonly cacheRoot: string;
  },
  inspected: NonNullable<Awaited<ReturnType<ContainerRuntime['inspectImage']>>>,
): Promise<SelectedAgentArtifact> {
  if (options.runtime.saveImageArchive === undefined) {
    throw new Error('selected Apple agent runtime cannot export an OCI image archive');
  }
  if (options.runtime.tagImage === undefined) {
    throw new Error('selected Apple agent runtime cannot pin an image reference for export');
  }
  const saveImageArchive = options.runtime.saveImageArchive;
  const tagImage = options.runtime.tagImage;
  const architecture = options.architecture;
  const cacheRoot = options.cacheRoot;
  ensurePrivateDirectory(cacheRoot);
  const cacheKey = computeHash({
    logicalName: options.logicalName,
    appleImageId: inspected.id,
    buildHash: options.buildHash,
  });
  const artifactDirectory = resolve(cacheRoot, cacheKey);

  // One cache-global lock prevents a cross-ID sweep from deleting another
  // process's in-progress publication. Retain the current artifact plus one
  // prior unstaged artifact; lease-staged archives have nlink > 1 and are
  // never removed until their lease releases the hardlink.
  return withProvisionLock(
    resolve(cacheRoot, '.selected-agent-artifacts'),
    async () => {
      await reconcileStaleCaptureAliases(options.runtime);
      reclaimStalePrepareDirectories(cacheRoot);
      const cached = tryLoadCachedArtifact(artifactDirectory, {
        logicalName: options.logicalName,
        appleImageId: inspected.id,
        buildHash: options.buildHash,
        architecture,
      });
      if (cached !== undefined) {
        try {
          await verifySelectedAgentArtifactArchive(cached);
          const now = new Date();
          utimesSync(artifactDirectory, now, now);
          pruneSelectedAgentArtifactCache(cacheRoot, artifactDirectory);
          return cached;
        } catch {
          // Metadata and size alone cannot detect same-size byte poisoning.
          // Unlink this cache entry and rebuild from a freshly pinned image.
          rmSync(artifactDirectory, { recursive: true, force: true });
        }
      }

      rmSync(artifactDirectory, { recursive: true, force: true });
      const temporaryDirectory = mkdtempSync(resolve(cacheRoot, '.prepare-'));
      chmodSync(temporaryDirectory, 0o700);
      let published = false;
      try {
        const sourceArchivePath = resolve(temporaryDirectory, 'apple-image.oci.tar');
        const archivePath = resolve(temporaryDirectory, ARCHIVE_FILE);
        const canonical = await captureSelectedImageArchive({
          runtime: options.runtime,
          saveImageArchive,
          tagImage,
          logicalName: options.logicalName,
          buildHash: options.buildHash,
          architecture,
          inspected,
          sourceArchivePath,
          archivePath,
        });
        rmSync(sourceArchivePath, { force: true });
        chmodSync(archivePath, 0o400);

        const metadata: SelectedAgentArtifactMetadata = {
          schemaVersion: SELECTED_AGENT_ARTIFACT_SCHEMA_VERSION,
          logicalName: options.logicalName,
          buildHash: options.buildHash,
          architecture,
          appleImageId: inspected.id,
          dockerImageId: canonical.configDigest,
          manifestDigest: canonical.manifestDigest,
          archive: {
            fileName: ARCHIVE_FILE,
            sha256: canonical.archiveSha256,
            sizeBytes: canonical.sizeBytes,
          },
        };
        writeStableJsonAtomic(resolve(temporaryDirectory, METADATA_FILE), metadata, { mode: 0o400 });
        renameSync(temporaryDirectory, artifactDirectory);
        published = true;
        const artifact = artifactFromMetadata(artifactDirectory, metadata);
        pruneSelectedAgentArtifactCache(cacheRoot, artifactDirectory);
        return artifact;
      } finally {
        if (!published) rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    },
    { maxWaitMs: 60 * 60_000, staleMs: 60 * 60_000 },
  );
}

async function captureSelectedImageArchive(options: {
  readonly runtime: PrepareSelectedAgentArtifactOptions['runtime'];
  readonly saveImageArchive: NonNullable<ContainerRuntime['saveImageArchive']>;
  readonly tagImage: NonNullable<ContainerRuntime['tagImage']>;
  readonly logicalName: string;
  readonly buildHash: string;
  readonly architecture: 'amd64' | 'arm64';
  readonly inspected: NonNullable<Awaited<ReturnType<ContainerRuntime['inspectImage']>>>;
  readonly sourceArchivePath: string;
  readonly archivePath: string;
}): Promise<Awaited<ReturnType<typeof canonicalizeDockerSaveArchive>>> {
  const captureReference = `ironcurtain-capture-p${process.pid}-t${Date.now()}-${randomUUID()}:latest`;
  await options.tagImage(options.logicalName, captureReference);

  let result: Awaited<ReturnType<typeof canonicalizeDockerSaveArchive>> | undefined;
  let captureError: unknown;
  try {
    const captured = await options.runtime.inspectImage(captureReference);
    if (captured === undefined || captured.id !== options.inspected.id) {
      throw new Error('selected Apple agent image changed while pinning its capture reference');
    }
    if (captured.labels['ironcurtain.build-hash'] !== options.buildHash) {
      throw new Error('selected Apple agent capture reference has an unexpected build hash');
    }
    await options.saveImageArchive(
      captureReference,
      options.sourceArchivePath,
      options.architecture === 'arm64' ? 'linux/arm64' : 'linux/amd64',
    );
    result = await canonicalizeDockerSaveArchive({
      sourceArchivePath: options.sourceArchivePath,
      outputArchivePath: options.archivePath,
      logicalName: options.logicalName,
      architecture: options.architecture,
      expectedLabels: { 'ironcurtain.build-hash': options.buildHash },
    });
  } catch (error) {
    captureError = error;
  }

  let cleanupError: unknown;
  try {
    if (!(await options.runtime.removeImage(captureReference))) {
      throw new Error(`failed to remove selected agent capture reference: ${captureReference}`);
    }
  } catch (error) {
    cleanupError = error;
  }
  if (captureError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([captureError, cleanupError], 'selected agent image capture and cleanup both failed');
  }
  if (captureError !== undefined) throw asError(captureError, 'selected agent image capture failed');
  if (cleanupError !== undefined) throw asError(cleanupError, 'selected agent capture cleanup failed');
  if (result === undefined) throw new Error('selected agent image capture produced no archive');
  return result;
}

async function reconcileStaleCaptureAliases(runtime: PrepareSelectedAgentArtifactOptions['runtime']): Promise<void> {
  const now = Date.now();
  const aliases = new Set(
    (await runtime.listImages())
      .flatMap((image) => image.repoTags)
      .filter((reference) => captureAliasIsStale(reference, now)),
  );
  for (const alias of aliases) await runtime.removeImage(alias);
}

function captureAliasIsStale(reference: string, now: number): boolean {
  const match = CAPTURE_ALIAS_PATTERN.exec(reference);
  if (match === null) return false;
  const ownerPid = Number.parseInt(match[1], 10);
  const createdAtMs = Number.parseInt(match[2], 10);
  if (createdAtMs > now || now - createdAtMs < CAPTURE_ALIAS_RECONCILIATION_GRACE_MS) return false;
  return !processIsAlive(ownerPid);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') return false;
    // EPERM means a process exists but is owned by another user. Preserve the
    // alias for any ambiguous error so reconciliation cannot race a live
    // capture merely because liveness could not be established.
    return true;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

function reclaimStalePrepareDirectories(cacheRoot: string): void {
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PREPARE_DIRECTORY_PATTERN.test(entry.name)) continue;
    const directory = resolve(cacheRoot, entry.name);
    try {
      assertPrivateDirectory(directory, 'stale selected agent preparation directory');
    } catch {
      continue;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function pruneSelectedAgentArtifactCache(cacheRoot: string, currentDirectory: string): void {
  const complete = readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name))
    .map((entry) => resolve(cacheRoot, entry.name))
    .flatMap((directory) => {
      try {
        assertPrivateDirectory(directory, 'selected agent artifact directory');
        const metadata = loadImmutableHostJson(resolve(directory, METADATA_FILE), {
          label: 'selected agent artifact metadata',
          schema: metadataSchema,
          maxBytes: MAX_METADATA_BYTES,
        }).value;
        const artifact = tryLoadCachedArtifact(directory, metadata);
        if (artifact === undefined) return [];
        const archive = lstatSync(artifact.archivePath);
        return [{ directory, modifiedMs: lstatSync(directory).mtimeMs, staged: archive.nlink > 1 }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.modifiedMs - left.modifiedMs);

  let retainedUnstaged = 0;
  const now = Date.now();
  for (const candidate of complete) {
    if (candidate.directory === currentDirectory || candidate.staged) {
      if (!candidate.staged) retainedUnstaged += 1;
      continue;
    }
    if (retainedUnstaged < MAX_UNSTAGED_CACHE_ENTRIES) {
      retainedUnstaged += 1;
      continue;
    }
    // A preparation result is returned just before its per-lease hardlink is
    // created. Keep fresh entries through that handoff window; later
    // preparations can collect old entries that still have no staged link.
    if (now - candidate.modifiedMs < CACHE_ENTRY_EVICTION_GRACE_MS) continue;
    rmSync(candidate.directory, { recursive: true, force: true });
  }
}

/** Re-read and fully verify the exact archive bytes immediately before load. */
export async function verifySelectedAgentArtifactArchive(artifact: SelectedAgentArtifact): Promise<void> {
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
  if (verified.configDigest !== artifact.dockerImageId) {
    throw new Error('selected agent archive resolved a different inner Docker image ID');
  }
}

function tryLoadCachedArtifact(
  directory: string,
  expected: Pick<SelectedAgentArtifact, 'logicalName' | 'appleImageId' | 'buildHash' | 'architecture'>,
): SelectedAgentArtifact | undefined {
  if (!existsSync(resolve(directory, METADATA_FILE))) return undefined;
  try {
    assertPrivateDirectory(directory, 'selected agent artifact directory');
    const loaded = loadImmutableHostJson(resolve(directory, METADATA_FILE), {
      label: 'selected agent artifact metadata',
      schema: metadataSchema,
      maxBytes: MAX_METADATA_BYTES,
    });
    const metadata = loaded.value;
    if (
      metadata.logicalName !== expected.logicalName ||
      metadata.appleImageId !== expected.appleImageId ||
      metadata.buildHash !== expected.buildHash ||
      metadata.architecture !== expected.architecture
    ) {
      return undefined;
    }
    const archivePath = resolve(directory, metadata.archive.fileName);
    const archive = lstatSync(archivePath);
    const uid = process.getuid?.();
    if (
      !archive.isFile() ||
      archive.isSymbolicLink() ||
      (uid !== undefined && archive.uid !== uid) ||
      (archive.mode & 0o222) !== 0 ||
      archive.size !== metadata.archive.sizeBytes
    ) {
      return undefined;
    }
    return artifactFromMetadata(directory, metadata);
  } catch {
    return undefined;
  }
}

function artifactFromMetadata(directory: string, metadata: SelectedAgentArtifactMetadata): SelectedAgentArtifact {
  return {
    logicalName: metadata.logicalName,
    buildHash: metadata.buildHash,
    architecture: metadata.architecture,
    appleImageId: metadata.appleImageId,
    dockerImageId: metadata.dockerImageId,
    manifestDigest: metadata.manifestDigest,
    archivePath: resolve(directory, metadata.archive.fileName),
    archiveSha256: metadata.archive.sha256,
    archiveSizeBytes: metadata.archive.sizeBytes,
  };
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  assertPrivateDirectory(path, 'selected agent artifact cache');
}

function assertPrivateDirectory(path: string, label: string): void {
  const stats = lstatSync(path);
  const uid = process.getuid?.();
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (uid !== undefined && stats.uid !== uid) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error(`${label} must be a private, owner-owned real directory`);
  }
}

function hostArchitecture(): 'amd64' | 'arm64' {
  const value = arch();
  if (value === 'arm64') return 'arm64';
  if (value === 'x64') return 'amd64';
  throw new Error(`unsupported selected agent architecture: ${value}`);
}
