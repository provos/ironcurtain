/** Trusted host staging for one preloaded image across concrete Mac runtimes. */

import { chmodSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { assertCanonicalHostPath } from '../hardened-fs.js';
import type { ExecFileFn } from './docker-manager.js';
import { canonicalizeDockerSaveArchive } from './oci-image-archive-canonicalizer.js';
import {
  buildPreloadedImageLabels,
  createPreloadedImageCatalogEntry,
  type CreatePreloadedImageCatalogEntryOptions,
  type PreloadedImageCatalogEntry,
} from './preloaded-image-catalog.js';
import type { ContainerRuntime, DockerImageInfo } from './types.js';

export interface StagePreloadedImageOptions {
  readonly logicalName: string;
  readonly outputArchivePath: string;
  readonly catalogGeneration: string;
  readonly buildHash: string;
  readonly architecture: 'amd64' | 'arm64';
  readonly dockerApi: CreatePreloadedImageCatalogEntryOptions['dockerApi'];
  readonly toolchain: CreatePreloadedImageCatalogEntryOptions['toolchain'];
  readonly provenance: CreatePreloadedImageCatalogEntryOptions['provenance'];
}

export interface StagedPreloadedImage {
  readonly docker: PreloadedImageCatalogEntry;
  readonly appleContainer?: PreloadedImageCatalogEntry;
}

/**
 * The source image must already carry the frozen catalog labels. Staging never
 * changes image configuration or retags an arbitrary source; that would alter
 * the config digest after authorization.
 */
export async function stagePreloadedImage(options: {
  readonly exec: ExecFileFn;
  readonly dockerRuntime: Pick<ContainerRuntime, 'inspectImage'>;
  readonly appleRuntime?: Pick<ContainerRuntime, 'inspectImage' | 'loadImageArchive' | 'removeImage'>;
  readonly image: StagePreloadedImageOptions;
}): Promise<StagedPreloadedImage> {
  validateStageOptions(options.image);
  const provisional = createPreloadedImageCatalogEntry({
    runtimeKind: 'docker',
    logicalName: options.image.logicalName,
    runtimeImageId: `sha256:${'0'.repeat(64)}`,
    manifestDigest: `sha256:${'0'.repeat(64)}`,
    configDigest: `sha256:${'0'.repeat(64)}`,
    buildHash: options.image.buildHash,
    architecture: options.image.architecture,
    dockerApi: options.image.dockerApi,
    toolchain: options.image.toolchain,
    provenance: options.image.provenance,
    archive: { fileName: basename(options.image.outputArchivePath), sha256: '0'.repeat(64), sizeBytes: 1 },
  });
  const expectedLabels = buildPreloadedImageLabels(provisional, options.image.catalogGeneration);
  const sourceImage = await options.dockerRuntime.inspectImage(options.image.logicalName);
  if (sourceImage === undefined)
    throw new Error(`preloaded staging source image is absent: ${options.image.logicalName}`);
  assertImageLabels(sourceImage, expectedLabels, 'Docker staging source');

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'ironcurtain-image-save-'));
  let outputCreated = false;
  try {
    const sourceArchivePath = join(temporaryDirectory, 'docker-save.tar');
    await options.exec('docker', ['image', 'save', '--output', sourceArchivePath, options.image.logicalName], {
      timeout: 30 * 60_000,
      maxBuffer: 1024 * 1024,
    });
    chmodSync(sourceArchivePath, 0o400);
    const canonical = await canonicalizeDockerSaveArchive({
      sourceArchivePath,
      outputArchivePath: options.image.outputArchivePath,
      logicalName: options.image.logicalName,
      architecture: options.image.architecture,
      expectedLabels,
    });
    outputCreated = true;
    if (sourceImage.id !== canonical.configDigest) {
      throw new Error(
        `Docker staging source ID/config mismatch: expected ${sourceImage.id}, archive ${canonical.configDigest}`,
      );
    }
    const common = {
      logicalName: options.image.logicalName,
      manifestDigest: canonical.manifestDigest,
      configDigest: canonical.configDigest,
      buildHash: options.image.buildHash,
      architecture: options.image.architecture,
      dockerApi: options.image.dockerApi,
      toolchain: options.image.toolchain,
      provenance: options.image.provenance,
      archive: {
        fileName: basename(options.image.outputArchivePath),
        sha256: canonical.archiveSha256,
        sizeBytes: canonical.sizeBytes,
      },
    } as const;
    const docker = createPreloadedImageCatalogEntry({
      ...common,
      runtimeKind: 'docker',
      runtimeImageId: canonical.configDigest,
    });

    let appleContainer: PreloadedImageCatalogEntry | undefined;
    if (options.appleRuntime !== undefined) {
      await removeAndAssertAbsent(options.appleRuntime, options.image.logicalName);
      try {
        await options.appleRuntime.loadImageArchive(options.image.outputArchivePath);
        const appleImage = await options.appleRuntime.inspectImage(options.image.logicalName);
        if (appleImage === undefined) throw new Error('Apple staging load did not create the catalog ref');
        assertImageLabels(appleImage, expectedLabels, 'Apple staging result');
        appleContainer = createPreloadedImageCatalogEntry({
          ...common,
          runtimeKind: 'apple-container',
          runtimeImageId: appleImage.id,
        });
      } finally {
        await removeAndAssertAbsent(options.appleRuntime, options.image.logicalName);
      }
    }
    return { docker, ...(appleContainer === undefined ? {} : { appleContainer }) };
  } catch (error) {
    if (outputCreated) rmSync(options.image.outputArchivePath, { force: true });
    throw error;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function validateStageOptions(options: StagePreloadedImageOptions): void {
  assertCanonicalHostPath(options.outputArchivePath, 'preloaded staging output path');
  const parent = lstatSync(resolve(options.outputArchivePath, '..'));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0) {
    throw new Error('preloaded staging output directory must be a private real directory');
  }
  if (!/^[a-f0-9]{64}$/u.test(options.buildHash)) throw new Error('preloaded staging build hash is invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.catalogGeneration)) {
    throw new Error('preloaded staging catalog generation is invalid');
  }
}

function assertImageLabels(
  image: DockerImageInfo,
  expectedLabels: Readonly<Record<string, string>>,
  label: string,
): void {
  for (const [name, expected] of Object.entries(expectedLabels)) {
    if (image.labels[name] !== expected) throw new Error(`${label} label mismatch: ${name}`);
  }
}

async function removeAndAssertAbsent(
  runtime: Pick<ContainerRuntime, 'inspectImage' | 'removeImage'>,
  logicalName: string,
): Promise<void> {
  await runtime.removeImage(logicalName);
  if ((await runtime.inspectImage(logicalName)) !== undefined) {
    throw new Error(`preloaded staging could not remove exact runtime ref: ${logicalName}`);
  }
}
