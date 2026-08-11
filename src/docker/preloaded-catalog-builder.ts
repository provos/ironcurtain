/** Trusted all-or-nothing builder for complete backend-bound image catalogs. */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { assertCanonicalHostPath, writeStableJsonAtomic } from '../hardened-fs.js';
import type { ExecFileFn } from './docker-manager.js';
import {
  loadPreloadedImageCatalog,
  type LoadedPreloadedImageCatalog,
  type PreloadedImageCatalog,
} from './preloaded-image-catalog.js';
import {
  stagePreloadedImage,
  type StagePreloadedImageOptions,
  type StagedPreloadedImage,
} from './preloaded-image-staging.js';
import type { ContainerRuntime } from './types.js';

/**
 * The trusted infrastructure image class (plan §6.4): base, the per-harness
 * agents, and the fixed nested-runtime support images. Their identity is bound
 * into qualification evidence and they only ever arrive through the preloaded
 * catalog. Untrusted workload images (registry pulls, archives, local builds)
 * and the pinned target/scanner qualification fixtures are deliberately NOT
 * catalog roles.
 */
export const REQUIRED_PRELOADED_IMAGE_ROLES = [
  'base',
  'agent-claude-code',
  'agent-codex',
  'agent-goose',
  'nested-daemon',
  'helper',
  'fixed-relay',
  'socat',
] as const;
export type PreloadedImageRole = (typeof REQUIRED_PRELOADED_IMAGE_ROLES)[number];

export interface PreloadedCatalogBuilderImage extends Omit<
  StagePreloadedImageOptions,
  'outputArchivePath' | 'catalogGeneration'
> {
  readonly role: PreloadedImageRole;
}

export interface BuildPreloadedCatalogsOptions {
  readonly exec: ExecFileFn;
  readonly dockerRuntime: Pick<ContainerRuntime, 'inspectImage'>;
  readonly appleRuntime?: Pick<ContainerRuntime, 'inspectImage' | 'loadImageArchive' | 'removeImage'>;
  readonly outputDirectory: string;
  readonly generation: string;
  readonly createdAt: string;
  readonly images: readonly PreloadedCatalogBuilderImage[];
  readonly stage?: (options: {
    readonly exec: ExecFileFn;
    readonly dockerRuntime: Pick<ContainerRuntime, 'inspectImage'>;
    readonly appleRuntime?: Pick<ContainerRuntime, 'inspectImage' | 'loadImageArchive' | 'removeImage'>;
    readonly image: StagePreloadedImageOptions;
  }) => Promise<StagedPreloadedImage>;
}

export interface BuiltPreloadedCatalogs {
  readonly docker: LoadedPreloadedImageCatalog;
  readonly appleContainer?: LoadedPreloadedImageCatalog;
}

/** Stage every required role before publishing either catalog file. */
export async function buildPreloadedCatalogs(options: BuildPreloadedCatalogsOptions): Promise<BuiltPreloadedCatalogs> {
  validateBuilderOptions(options);
  const stage = options.stage ?? stagePreloadedImage;
  const createdArtifacts: string[] = [];
  const dockerEntries = [];
  const appleEntries = [];
  const dockerCatalogPath = join(options.outputDirectory, 'preloaded-catalog.docker.json');
  const appleCatalogPath = join(options.outputDirectory, 'preloaded-catalog.apple-container.json');
  try {
    for (const image of [...options.images].sort((left, right) => left.role.localeCompare(right.role))) {
      const archivePath = join(options.outputDirectory, `${image.role}.tar`);
      if (existsSync(archivePath))
        throw new Error(`preloaded catalog artifact already exists: ${basename(archivePath)}`);
      const staged = await stage({
        exec: options.exec,
        dockerRuntime: options.dockerRuntime,
        ...(options.appleRuntime === undefined ? {} : { appleRuntime: options.appleRuntime }),
        image: {
          ...image,
          catalogGeneration: options.generation,
          outputArchivePath: archivePath,
        },
      });
      createdArtifacts.push(archivePath);
      if (staged.docker.archive.fileName !== basename(archivePath)) {
        throw new Error(`Docker staged archive name differs for role: ${image.role}`);
      }
      dockerEntries.push(staged.docker);
      if (options.appleRuntime !== undefined) {
        if (staged.appleContainer === undefined) {
          throw new Error(`Apple Container staging result is missing for role: ${image.role}`);
        }
        if (
          staged.appleContainer.archive.fileName !== staged.docker.archive.fileName ||
          staged.appleContainer.archive.sha256 !== staged.docker.archive.sha256 ||
          staged.appleContainer.archive.sizeBytes !== staged.docker.archive.sizeBytes
        ) {
          throw new Error(`backend catalog entries do not share one sealed archive for role: ${image.role}`);
        }
        appleEntries.push(staged.appleContainer);
      }
    }

    const common = {
      schemaVersion: 1 as const,
      generation: options.generation,
      createdAt: options.createdAt,
    };
    writeCatalogAtomic(dockerCatalogPath, {
      ...common,
      runtimeKind: 'docker',
      images: dockerEntries,
    });
    createdArtifacts.push(dockerCatalogPath);
    const docker = loadPreloadedImageCatalog(dockerCatalogPath);

    let appleContainer: LoadedPreloadedImageCatalog | undefined;
    if (options.appleRuntime !== undefined) {
      writeCatalogAtomic(appleCatalogPath, {
        ...common,
        runtimeKind: 'apple-container',
        images: appleEntries,
      });
      createdArtifacts.push(appleCatalogPath);
      appleContainer = loadPreloadedImageCatalog(appleCatalogPath);
    }
    return { docker, ...(appleContainer === undefined ? {} : { appleContainer }) };
  } catch (error) {
    for (const path of createdArtifacts.reverse()) rmSync(path, { force: true });
    throw error;
  }
}

function validateBuilderOptions(options: BuildPreloadedCatalogsOptions): void {
  assertCanonicalHostPath(options.outputDirectory, 'preloaded catalog output directory');
  const stats = lstatSync(options.outputDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new Error('preloaded catalog output directory must be a private real directory');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.generation)) {
    throw new Error('preloaded catalog generation is invalid');
  }
  if (Number.isNaN(Date.parse(options.createdAt)) || new Date(options.createdAt).toISOString() !== options.createdAt) {
    throw new Error('preloaded catalog createdAt must be a canonical ISO timestamp');
  }
  const roles = options.images.map((image) => image.role);
  const names = options.images.map((image) => image.logicalName);
  if (new Set(roles).size !== roles.length) throw new Error('preloaded catalog contains a duplicate image role');
  if (new Set(names).size !== names.length)
    throw new Error('preloaded catalog contains a duplicate logical image name');
  const missing = REQUIRED_PRELOADED_IMAGE_ROLES.filter((role) => !roles.includes(role));
  const extra = roles.filter((role) => !REQUIRED_PRELOADED_IMAGE_ROLES.includes(role));
  if (missing.length !== 0 || extra.length !== 0 || roles.length !== REQUIRED_PRELOADED_IMAGE_ROLES.length) {
    throw new Error(`preloaded catalog role coverage mismatch: missing=${missing.join(',') || '(none)'}`);
  }
  for (const image of options.images) {
    if (image.provenance.createdAt !== options.createdAt) {
      throw new Error(`preloaded catalog provenance time differs for role: ${image.role}`);
    }
  }
  for (const path of [
    join(options.outputDirectory, 'preloaded-catalog.docker.json'),
    join(options.outputDirectory, 'preloaded-catalog.apple-container.json'),
  ]) {
    if (existsSync(path)) throw new Error(`preloaded catalog output already exists: ${basename(path)}`);
  }
}

function writeCatalogAtomic(path: string, catalog: PreloadedImageCatalog): void {
  writeStableJsonAtomic(path, catalog, { mode: 0o400 });
}

export interface PublishCatalogGenerationOptions<T> {
  /**
   * Live staging directory every consumer resolves through
   * (`getPreloadedCatalogStagingDir()`). It is only ever replaced wholesale.
   */
  readonly liveDirectory: string;
  /** Builds one complete generation into the private directory it is handed. */
  readonly build: (stagingDirectory: string) => Promise<T>;
}

/**
 * Extend the builder's all-or-nothing guarantee to the *live* staging tree:
 * build the new generation into a private sibling directory and only replace
 * the live one once the build has fully succeeded.
 *
 * Consumers resolve archives relative to their catalog's own directory (see
 * `resolvePreloadedImage`) and re-derive the live path per session, so no
 * published artifact records the temporary path — swapping directories cannot
 * invalidate a catalog.
 */
export async function publishCatalogGeneration<T>(options: PublishCatalogGenerationOptions<T>): Promise<T> {
  assertCanonicalHostPath(options.liveDirectory, 'preloaded catalog staging directory');
  mkdirSync(dirname(options.liveDirectory), { recursive: true });
  // `mkdtemp` claims a unique sibling atomically, so concurrent runs (and any
  // abandoned tree from an earlier crash) can never collide on the build path.
  const pendingDirectory = mkdtempSync(`${options.liveDirectory}.pending-`);
  chmodSync(pendingDirectory, 0o700);
  let built: T;
  try {
    built = await options.build(pendingDirectory);
  } catch (error) {
    rmSync(pendingDirectory, { recursive: true, force: true });
    throw error;
  }
  swapGenerationIntoPlace(pendingDirectory, options.liveDirectory);
  return built;
}

/**
 * Two renames inside one parent directory, so the live path never names a
 * half-populated tree. A crash *between* the renames leaves the live path
 * absent but the previous generation intact under its `.retired-*` sibling: an
 * operator recovers the old generation with a single rename instead of paying
 * for a full rebuild.
 */
function swapGenerationIntoPlace(pendingDirectory: string, liveDirectory: string): void {
  const retiredDirectory = existsSync(liveDirectory)
    ? `${liveDirectory}.retired-${randomBytes(6).toString('hex')}`
    : undefined;
  if (retiredDirectory !== undefined) renameSync(liveDirectory, retiredDirectory);
  try {
    renameSync(pendingDirectory, liveDirectory);
  } catch (error) {
    rmSync(pendingDirectory, { recursive: true, force: true });
    if (retiredDirectory !== undefined) restoreRetiredGeneration(retiredDirectory, liveDirectory);
    throw error;
  }
  if (retiredDirectory === undefined) return;
  try {
    rmSync(retiredDirectory, { recursive: true, force: true });
  } catch {
    // Best effort only. The new generation is already live, so failing the
    // publication here would misreport a successful freeze; what is left behind
    // is a complete previous generation the operator can delete.
  }
}

function restoreRetiredGeneration(retiredDirectory: string, liveDirectory: string): void {
  try {
    renameSync(retiredDirectory, liveDirectory);
  } catch (error) {
    throw new Error(
      `preloaded catalog publication failed and the previous generation is parked at ${retiredDirectory}; ` +
        `restore it by renaming that directory back to ${liveDirectory}`,
      { cause: error },
    );
  }
}
