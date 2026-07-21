/**
 * Operator-facing freeze entry point for the preloaded image catalog.
 *
 * `ironcurtain build-preloaded-catalog` builds every required role image on the
 * trusted host's Docker, stamps the frozen catalog labels, stages one sealed
 * archive per role under the private staging directory, and publishes the
 * backend-bound catalogs — both a runtime-resolvable copy next to the archives
 * and a committed frozen record under `config/docker-workload/`.
 *
 * This is trusted-host preparation, not a session action, so it does not consult
 * the runtime admission fuse. Running a real build is a supervised validation
 * step; the core orchestration takes injected runtimes/build/stage functions so
 * it is exercisable without Docker.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkHelp, type CommandSpec } from '../cli-help.js';
import type { ContainerRuntime } from './types.js';
import { defaultExecFile, type ExecFileFn } from './docker-manager.js';
import {
  buildPreloadedCatalogs,
  type BuildPreloadedCatalogsOptions,
  type PreloadedCatalogBuilderImage,
} from './preloaded-catalog-builder.js';
import {
  buildPreloadedImageLabels,
  createPreloadedImageCatalogEntry,
  type LoadedPreloadedImageCatalog,
} from './preloaded-image-catalog.js';
import {
  getFrozenCatalogDir,
  getPreloadedCatalogStagingDir,
  getStagedCatalogPath,
  preloadedCatalogFileName,
} from './preloaded-catalog-paths.js';
import {
  CATALOG_DOCKER_API_RANGE,
  catalogImageSources,
  computeContentBuildHash,
  dockerfileSourceDigest,
  hostCatalogArchitecture,
  type CatalogImageSource,
} from './preloaded-catalog-sources.js';

export interface FreezeCatalogRuntimes {
  readonly dockerRuntime: Pick<ContainerRuntime, 'inspectImage' | 'buildImage'>;
  readonly appleRuntime?: Pick<ContainerRuntime, 'inspectImage' | 'loadImageArchive' | 'removeImage'>;
  readonly exec: ExecFileFn;
}

export interface RunBuildPreloadedCatalogOptions {
  readonly runtimes: FreezeCatalogRuntimes;
  readonly sources: readonly CatalogImageSource[];
  /** Private (0700), empty staging directory that will hold archives + catalogs. */
  readonly stagingDir: string;
  /** Committed frozen-record directory (`config/docker-workload`). */
  readonly frozenCatalogDir: string;
  readonly generation: string;
  readonly createdAt: string;
  readonly architecture: 'amd64' | 'arm64';
  /** Exact build hash for agent roles (matches the live agent build). */
  readonly agentBuildHash: (logicalName: string) => string;
  /** Overridable build step (defaults to `dockerRuntime.buildImage`). */
  readonly buildImage?: (source: CatalogImageSource, labels: Record<string, string>) => Promise<void>;
  /** Overridable stage step (test seam mirroring the builder's own hook). */
  readonly stage?: BuildPreloadedCatalogsOptions['stage'];
  readonly onProgress?: (message: string) => void;
}

export interface FrozenCatalogResult {
  readonly docker: LoadedPreloadedImageCatalog;
  readonly appleContainer?: LoadedPreloadedImageCatalog;
  readonly stagedDockerPath: string;
  readonly stagedApplePath?: string;
  readonly frozenDockerPath: string;
  readonly frozenApplePath?: string;
}

/** Build every role, stage sealed archives, and publish both catalog copies. */
export async function runBuildPreloadedCatalog(options: RunBuildPreloadedCatalogOptions): Promise<FrozenCatalogResult> {
  const buildImage = options.buildImage ?? defaultBuildImage(options.runtimes.dockerRuntime);
  const builderImages: PreloadedCatalogBuilderImage[] = [];
  for (const source of orderBaseFirst(options.sources)) {
    const image = resolveBuilderImage(source, options);
    options.onProgress?.(`building ${source.role} (${source.logicalName})`);
    await buildImage(source, catalogImageLabels(image, options.generation));
    builderImages.push(image);
  }

  options.onProgress?.('staging sealed archives and publishing catalogs');
  const built = await buildPreloadedCatalogs({
    exec: options.runtimes.exec,
    dockerRuntime: options.runtimes.dockerRuntime,
    ...(options.runtimes.appleRuntime === undefined ? {} : { appleRuntime: options.runtimes.appleRuntime }),
    outputDirectory: options.stagingDir,
    generation: options.generation,
    createdAt: options.createdAt,
    images: builderImages,
    ...(options.stage === undefined ? {} : { stage: options.stage }),
  });

  const frozenDockerPath = join(options.frozenCatalogDir, preloadedCatalogFileName('docker'));
  copyFrozenCatalog(built.docker.path, frozenDockerPath);
  const apple = built.appleContainer;
  const frozenApplePath =
    apple === undefined ? undefined : join(options.frozenCatalogDir, preloadedCatalogFileName('apple-container'));
  if (apple !== undefined && frozenApplePath !== undefined) copyFrozenCatalog(apple.path, frozenApplePath);

  return {
    docker: built.docker,
    ...(apple === undefined ? {} : { appleContainer: apple }),
    stagedDockerPath: built.docker.path,
    ...(apple === undefined ? {} : { stagedApplePath: apple.path }),
    frozenDockerPath,
    ...(frozenApplePath === undefined ? {} : { frozenApplePath }),
  };
}

function resolveBuilderImage(
  source: CatalogImageSource,
  options: RunBuildPreloadedCatalogOptions,
): PreloadedCatalogBuilderImage {
  const buildHash =
    source.hashKind === 'agent'
      ? assertBuildHash(options.agentBuildHash(source.logicalName), source.role)
      : computeContentBuildHash(source.dockerfile, source.contextDir);
  return {
    role: source.role,
    logicalName: source.logicalName,
    buildHash,
    architecture: options.architecture,
    dockerApi: { min: CATALOG_DOCKER_API_RANGE.min, max: CATALOG_DOCKER_API_RANGE.max },
    toolchain: source.toolchain,
    provenance: {
      source: source.provenanceSource,
      sourceDigest: dockerfileSourceDigest(source.dockerfile),
      createdAt: options.createdAt,
    },
  };
}

/**
 * Exact labels the source image must carry so trusted staging accepts it. This
 * mirrors `stagePreloadedImage`'s expected-label derivation: only the build
 * hash, architecture, API range, toolchain/provenance digests, and generation
 * feed the labels, so the placeholder identity digests are irrelevant.
 */
function catalogImageLabels(image: PreloadedCatalogBuilderImage, generation: string): Record<string, string> {
  const zeroDigest = `sha256:${'0'.repeat(64)}`;
  const provisional = createPreloadedImageCatalogEntry({
    runtimeKind: 'docker',
    logicalName: image.logicalName,
    runtimeImageId: zeroDigest,
    manifestDigest: zeroDigest,
    configDigest: zeroDigest,
    buildHash: image.buildHash,
    architecture: image.architecture,
    dockerApi: image.dockerApi,
    toolchain: image.toolchain,
    provenance: image.provenance,
    archive: { fileName: `${image.role}.tar`, sha256: '0'.repeat(64), sizeBytes: 1 },
  });
  return { ...buildPreloadedImageLabels(provisional, generation) };
}

function defaultBuildImage(
  dockerRuntime: Pick<ContainerRuntime, 'buildImage'>,
): (source: CatalogImageSource, labels: Record<string, string>) => Promise<void> {
  return (source, labels) => dockerRuntime.buildImage(source.logicalName, source.dockerfile, source.contextDir, labels);
}

// Agents inherit `FROM ironcurtain-base:latest`, so base must be built and
// tagged first; the remaining roles are independent.
function orderBaseFirst(sources: readonly CatalogImageSource[]): readonly CatalogImageSource[] {
  return [...sources].sort((left, right) => Number(right.role === 'base') - Number(left.role === 'base'));
}

function assertBuildHash(value: string, role: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`agent build hash for role ${role} is not lowercase sha256 hex`);
  return value;
}

function copyFrozenCatalog(stagedPath: string, frozenPath: string): void {
  mkdirSync(dirname(frozenPath), { recursive: true });
  writeFileSync(frozenPath, readFileSync(stagedPath), { mode: 0o644 });
}

const buildPreloadedCatalogSpec: CommandSpec = {
  name: 'ironcurtain build-preloaded-catalog',
  description: 'Freeze the trusted preloaded image catalog for the secure nested Docker runtime',
  usage: ['ironcurtain build-preloaded-catalog [options]'],
  options: [
    { flag: 'generation', description: 'Catalog generation label (default: ironcurtain-preloaded-<arch>-v1)' },
    { flag: 'docker-only', description: 'Skip the Apple `container` backend even when it is available' },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
};

/** CLI wrapper: wires the real host runtimes and prints a freeze summary. */
export async function runBuildPreloadedCatalogCommand(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      generation: { type: 'string' },
      'docker-only': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
    strict: true,
  });
  if (checkHelp({ help: values.help === true }, buildPreloadedCatalogSpec)) return;

  const architecture = hostCatalogArchitecture();
  const generation = values.generation ?? `ironcurtain-preloaded-${architecture}-v1`;

  const { createDockerManager } = await import('./docker-manager.js');
  const { computeAgentImageBuildHash } = await import('./docker-infrastructure.js');
  const dockerRuntime = createDockerManager();
  const appleRuntime = values['docker-only'] === true ? undefined : await resolveAppleRuntime();

  const stagingDir = getPreloadedCatalogStagingDir();
  prepareStagingDir(stagingDir);

  const result = await runBuildPreloadedCatalog({
    runtimes: { dockerRuntime, ...(appleRuntime === undefined ? {} : { appleRuntime }), exec: defaultExecFile },
    sources: catalogImageSources(),
    stagingDir,
    frozenCatalogDir: getFrozenCatalogDir(),
    generation,
    createdAt: new Date().toISOString(),
    architecture,
    agentBuildHash: computeAgentImageBuildHash,
    onProgress: (message) => process.stderr.write(`[build-preloaded-catalog] ${message}\n`),
  });

  process.stdout.write(
    [
      `Preloaded catalog frozen (generation ${generation}, ${result.docker.catalog.images.length} images).`,
      `  docker  staged: ${getStagedCatalogPath('docker')}`,
      `  docker  frozen: ${result.frozenDockerPath}`,
      ...(result.frozenApplePath === undefined
        ? ['  apple-container: skipped (runtime unavailable or --docker-only)']
        : [
            `  apple   staged: ${getStagedCatalogPath('apple-container')}`,
            `  apple   frozen: ${result.frozenApplePath}`,
          ]),
    ].join('\n') + '\n',
  );
}

async function resolveAppleRuntime(): Promise<
  Pick<ContainerRuntime, 'inspectImage' | 'loadImageArchive' | 'removeImage'> | undefined
> {
  const { checkAppleContainerAvailable, createAppleContainerManager } = await import('./apple-container-manager.js');
  const availability = await checkAppleContainerAvailable();
  if (!availability.available) {
    process.stderr.write(
      `[build-preloaded-catalog] apple-container unavailable (${availability.reason}); building docker catalog only\n`,
    );
    return undefined;
  }
  return createAppleContainerManager();
}

function prepareStagingDir(stagingDir: string): void {
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  chmodSync(stagingDir, 0o700);
}
