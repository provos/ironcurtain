/** Trusted bootstrap access to the private Docker Engine inside an Apple VM. */

import { linkSync, lstatSync, mkdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { ContainerRuntime, DockerExecResult, DockerImageInfo, DockerMount } from '../docker/types.js';
import { parseDockerImageInfo } from '../docker/docker-image-inspect.js';
import {
  loadPreloadedImageCatalog,
  resolvePreloadedImage,
  type ResolvedPreloadedImage,
} from '../docker/preloaded-image-catalog.js';
import { getPreloadedCatalogStagingDir, preloadedCatalogFileName } from '../docker/preloaded-catalog-paths.js';
import { getFrozenClientToolchainManifestPath } from '../docker/docker-workload-paths.js';
import {
  CLIENT_TOOLCHAIN_PREFLIGHT_ARGVS,
  loadClientToolchainManifest,
  preflightClientToolchain,
  type ClientToolchainPreflight,
} from './client-toolchain.js';
import { APPLE_VM_DAEMON_DOCKER_HOST, APPLE_VM_DAEMON_TOOLCHAIN_DIR } from './apple-vm-daemon.js';
import {
  assertIronCurtainAgentRuntimeImage,
  loadDockerWorkloadCatalogPair,
  type IronCurtainAgentRuntimeImage,
} from './catalog-pair.js';
import type { DockerWorkloadAdmissionBindings } from './infrastructure.js';

/** Guest-visible, read-only view of the trusted host catalog staging tree. */
export const APPLE_VM_INNER_DOCKER_CATALOG_DIR = '/opt/ironcurtain/preloaded-catalog';

const DOCKER_CLIENT = `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`;
const RUNTIME_USER = 'codespace';
const INSPECT_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 60 * 60_000;
const MAX_ERROR_DETAIL = 2048;

/** Trusted host and guest paths needed by both container assembly and bootstrap. */
export interface AppleVmDockerWorkloadBootstrapConfig {
  readonly hostCatalogDirectory: string;
  readonly guestCatalogDirectory: string;
  readonly outerAppleCatalogPath: string;
  readonly innerDockerCatalogPath: string;
  readonly selectedImageLogicalName: IronCurtainAgentRuntimeImage;
  readonly clientToolchainManifestPath: string;
}

export interface AppleVmDockerWorkloadProvisioning {
  readonly preflight: ClientToolchainPreflight;
  readonly image: ResolvedPreloadedImage;
}

/**
 * Freeze the live catalog pair into one admitted lease's private staging root.
 * Hard links keep an active session independent from publication-time rename
 * and deletion while preserving the exact bytes whose hashes admission bound.
 */
export function stageAppleVmDockerWorkloadBootstrap(options: {
  readonly leaseStagingRoot: string;
  readonly bindings: Pick<DockerWorkloadAdmissionBindings, 'catalogSha256' | 'innerDockerCatalogSha256'>;
  readonly selectedImageLogicalName: string;
  readonly sourceCatalogDirectory?: string;
}): AppleVmDockerWorkloadBootstrapConfig {
  assertIronCurtainAgentRuntimeImage(options.selectedImageLogicalName);
  const sourceDirectory = options.sourceCatalogDirectory ?? getPreloadedCatalogStagingDir();
  assertPrivateOwnerDirectory(sourceDirectory, 'preloaded catalog staging directory');
  assertPrivateOwnerDirectory(options.leaseStagingRoot, 'Docker-workload lease staging root');

  const sourceCatalogs = loadDockerWorkloadCatalogPair({
    appleCatalogPath: resolve(sourceDirectory, preloadedCatalogFileName('apple-container')),
    dockerCatalogPath: resolve(sourceDirectory, preloadedCatalogFileName('docker')),
  });
  if (sourceCatalogs.apple.sha256 !== options.bindings.catalogSha256) {
    throw new Error('Apple catalog changed after Docker-workload admission');
  }
  if (sourceCatalogs.docker.sha256 !== options.bindings.innerDockerCatalogSha256) {
    throw new Error('Docker catalog changed after Docker-workload admission');
  }

  const hostCatalogDirectory = resolve(options.leaseStagingRoot, 'preloaded-catalog');
  mkdirSync(hostCatalogDirectory, { mode: 0o700 });
  try {
    hardLinkExactOwnerFile(
      sourceCatalogs.apple.path,
      resolve(hostCatalogDirectory, basename(sourceCatalogs.apple.path)),
    );
    hardLinkExactOwnerFile(
      sourceCatalogs.docker.path,
      resolve(hostCatalogDirectory, basename(sourceCatalogs.docker.path)),
    );
    const selectedEntry = sourceCatalogs.docker.catalog.images.find(
      (candidate) => candidate.logicalName === options.selectedImageLogicalName,
    );
    if (selectedEntry === undefined) {
      throw new Error(`inner Docker catalog is missing selected image: ${options.selectedImageLogicalName}`);
    }
    hardLinkExactOwnerFile(
      resolve(sourceDirectory, selectedEntry.archive.fileName),
      resolve(hostCatalogDirectory, selectedEntry.archive.fileName),
    );

    const outerAppleCatalogPath = resolve(hostCatalogDirectory, preloadedCatalogFileName('apple-container'));
    const innerDockerCatalogPath = resolve(hostCatalogDirectory, preloadedCatalogFileName('docker'));
    const stagedCatalogs = loadDockerWorkloadCatalogPair({
      appleCatalogPath: outerAppleCatalogPath,
      dockerCatalogPath: innerDockerCatalogPath,
    });
    if (
      stagedCatalogs.apple.sha256 !== options.bindings.catalogSha256 ||
      stagedCatalogs.docker.sha256 !== options.bindings.innerDockerCatalogSha256
    ) {
      throw new Error('bundle-staged catalog hashes do not match Docker-workload admission');
    }
    return {
      hostCatalogDirectory,
      guestCatalogDirectory: APPLE_VM_INNER_DOCKER_CATALOG_DIR,
      outerAppleCatalogPath,
      innerDockerCatalogPath,
      selectedImageLogicalName: options.selectedImageLogicalName,
      clientToolchainManifestPath: getFrozenClientToolchainManifestPath(),
    };
  } catch (error) {
    rmSync(hostCatalogDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** The catalog staging tree is exposed only for an admitted Docker workload. */
export function appleVmDockerWorkloadCatalogMount(config: AppleVmDockerWorkloadBootstrapConfig): DockerMount {
  return {
    source: config.hostCatalogDirectory,
    target: config.guestCatalogDirectory,
    readonly: true,
  };
}

/**
 * Preflight the pinned client/daemon/plugin tuple, then make the selected outer
 * agent image available to inner IronCurtain in the VM-local Docker Engine.
 *
 * `resolvePreloadedImage` remains the sole catalog/archive verifier and loaded
 * image adjudicator. This module supplies only an exec-backed runtime adapter
 * and the host-to-guest archive path translation required by Apple VirtioFS.
 */
export async function provisionAppleVmDockerWorkload(options: {
  readonly outerRuntime: Pick<ContainerRuntime, 'exec'>;
  readonly containerId: string;
  readonly config: AppleVmDockerWorkloadBootstrapConfig;
}): Promise<AppleVmDockerWorkloadProvisioning> {
  const catalog = loadPreloadedImageCatalog(options.config.innerDockerCatalogPath);
  if (catalog.catalog.runtimeKind !== 'docker') {
    throw new Error(`inner Docker catalog has wrong runtime kind: ${catalog.catalog.runtimeKind}`);
  }
  const selectedEntry = catalog.catalog.images.find(
    (candidate) => candidate.logicalName === options.config.selectedImageLogicalName,
  );
  if (selectedEntry === undefined) {
    throw new Error(`inner Docker catalog is missing selected image: ${options.config.selectedImageLogicalName}`);
  }

  const runtime = createAppleVmPrivateDockerRuntime({
    outerRuntime: options.outerRuntime,
    containerId: options.containerId,
    hostCatalogDirectory: options.config.hostCatalogDirectory,
    guestCatalogDirectory: options.config.guestCatalogDirectory,
  });
  const preflight = await preflightClientToolchain({
    runtime,
    containerId: options.containerId,
    manifest: loadClientToolchainManifest(options.config.clientToolchainManifestPath),
    expectedToolchainDigest: selectedEntry.toolchainDigest,
  });

  const image = await resolvePreloadedImage(runtime, {
    catalogPath: options.config.innerDockerCatalogPath,
    runtimeKind: 'docker',
    logicalName: selectedEntry.logicalName,
    expectedBuildHash: selectedEntry.buildHash,
    architecture: preflight.architecture,
    dockerApiVersion: preflight.dockerApi.actual,
  });
  // The archive is needed only through verification/load/reinspection. Retire
  // the lease hard link before agent release so watchdog disk accounting does
  // not keep charging the multi-gigabyte catalog artifact to the live bundle.
  unlinkSync(resolve(options.config.hostCatalogDirectory, selectedEntry.archive.fileName));
  return { preflight, image };
}

/** Narrow adapter over the pinned in-VM Docker client and one fixed private API. */
export function createAppleVmPrivateDockerRuntime(options: {
  readonly outerRuntime: Pick<ContainerRuntime, 'exec'>;
  readonly containerId: string;
  readonly hostCatalogDirectory: string;
  readonly guestCatalogDirectory: string;
}): Pick<ContainerRuntime, 'exec' | 'inspectImage' | 'loadImageArchive'> {
  const execute = (args: readonly string[], timeoutMs: number): Promise<DockerExecResult> =>
    options.outerRuntime.exec(
      options.containerId,
      [DOCKER_CLIENT, '--host', APPLE_VM_DAEMON_DOCKER_HOST, ...args],
      timeoutMs,
      RUNTIME_USER,
    );

  return {
    async exec(containerId, command, timeoutMs) {
      if (containerId !== options.containerId) throw new Error('private Docker adapter container ID mismatch');
      if (!CLIENT_TOOLCHAIN_PREFLIGHT_ARGVS.some((allowed) => exactArgv(command, allowed))) {
        throw new Error('private Docker adapter accepts only exact client-toolchain preflight commands');
      }
      return execute(command.slice(1), timeoutMs ?? INSPECT_TIMEOUT_MS);
    },

    async inspectImage(ref): Promise<DockerImageInfo | undefined> {
      const result = await execute(['image', 'inspect', ref], INSPECT_TIMEOUT_MS);
      if (result.exitCode !== 0) {
        if (/not found|no such image/i.test(result.stderr)) return undefined;
        throw privateDockerCommandError('image inspect', result);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout) as unknown;
      } catch (error) {
        throw new Error('private Docker image inspect returned invalid JSON', { cause: error });
      }
      if (!Array.isArray(parsed) || parsed.length !== 1) {
        throw new Error('private Docker image inspect must return exactly one image');
      }
      return parseDockerImageInfo(parsed[0]);
    },

    async loadImageArchive(archivePath): Promise<void> {
      const guestPath = translateCatalogArchivePath(
        archivePath,
        options.hostCatalogDirectory,
        options.guestCatalogDirectory,
      );
      const result = await execute(['image', 'load', '--input', guestPath], LOAD_TIMEOUT_MS);
      if (result.exitCode !== 0) throw privateDockerCommandError('image load', result);
    },
  };
}

function exactArgv(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function translateCatalogArchivePath(archivePath: string, hostDirectory: string, guestDirectory: string): string {
  const normalized = resolve(archivePath);
  if (dirname(normalized) !== resolve(hostDirectory) || !normalized.endsWith('.tar')) {
    throw new Error('private Docker image load path must be a direct child of the trusted catalog directory');
  }
  return `${guestDirectory}/${basename(normalized)}`;
}

function privateDockerCommandError(operation: string, result: DockerExecResult): Error {
  const detail = (result.stderr.trim() || result.stdout.trim() || 'no diagnostic output').slice(-MAX_ERROR_DETAIL);
  return new Error(`private Docker ${operation} failed with exit code ${result.exitCode}: ${detail}`);
}

function assertPrivateOwnerDirectory(path: string, label: string): void {
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

/** Link one source file, then prove the published name preserved its exact inode. */
function hardLinkExactOwnerFile(sourcePath: string, targetPath: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Docker-workload catalog staging requires a Unix process identity');
  const before = lstatSync(sourcePath);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o222) !== 0) {
    throw new Error(`trusted catalog source must be an owner-owned, non-writable regular file: ${sourcePath}`);
  }
  linkSync(sourcePath, targetPath);
  const source = lstatSync(sourcePath);
  const target = lstatSync(targetPath);
  if (
    !target.isFile() ||
    target.isSymbolicLink() ||
    target.uid !== uid ||
    (target.mode & 0o222) !== 0 ||
    source.dev !== before.dev ||
    source.ino !== before.ino ||
    target.dev !== before.dev ||
    target.ino !== before.ino ||
    target.size !== before.size
  ) {
    throw new Error(`hard-linked catalog file did not preserve source identity: ${sourcePath}`);
  }
}
