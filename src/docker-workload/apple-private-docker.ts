/** Trusted bootstrap access to the private Docker Engine inside an Apple VM. */

import { linkSync, lstatSync, mkdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { ContainerRuntime, DockerExecResult, DockerImageInfo, DockerMount } from '../docker/types.js';
import { parseDockerImageInfo } from '../docker/docker-image-inspect.js';
import { verifySelectedAgentArtifactArchive, type SelectedAgentArtifact } from '../docker/selected-agent-artifact.js';
import { getFrozenClientToolchainManifestPath } from '../docker/docker-workload-paths.js';
import { loadClientToolchainManifest, type ClientToolchainPreflight } from './client-toolchain.js';
import { createAppleVmDaemonPrivateDockerClient, type AppleVmDaemonExec } from './apple-vm-daemon.js';
import {
  PRIVATE_DOCKER_WORKLOAD_NETWORK,
  PRIVATE_DOCKER_WORKLOAD_NETWORK_ENV,
  createPrivateDockerWorkloadNetwork,
  preflightPrivateDockerClient,
  type ApplePrivateDockerImageObservation,
  type PrivateDockerClient,
  type PrivateDockerWorkloadNetwork,
} from './private-docker.js';

/** Guest-visible, read-only view of this lease's selected agent archive. */
export const APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR = '/opt/ironcurtain/selected-agent-artifact';

/**
 * Fixed agent-facing network inside each bundle's private Docker Engine. The
 * name can be constant because every admitted bundle owns a distinct VM-local
 * daemon; it therefore cannot collide across sessions or name a host resource.
 */
export const APPLE_VM_DOCKER_WORKLOAD_NETWORK = PRIVATE_DOCKER_WORKLOAD_NETWORK;

/** Agent environment key naming the precreated inner workload bridge. */
export const APPLE_VM_DOCKER_WORKLOAD_NETWORK_ENV = PRIVATE_DOCKER_WORKLOAD_NETWORK_ENV;

const INSPECT_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 60 * 60_000;
const MAX_ERROR_DETAIL = 2048;

/** Trusted host and guest paths needed by both container assembly and bootstrap. */
export interface AppleVmDockerWorkloadBootstrapConfig {
  readonly hostArtifactDirectory: string;
  readonly guestArtifactDirectory: string;
  readonly artifact: SelectedAgentArtifact;
  readonly clientToolchainManifestPath: string;
}

export type AppleVmDockerWorkloadImageObservation = ApplePrivateDockerImageObservation;

export interface AppleVmDockerWorkloadProvisioning {
  readonly preflight: ClientToolchainPreflight;
  readonly image: AppleVmDockerWorkloadImageObservation;
}

export type AppleVmDockerWorkloadNetwork = PrivateDockerWorkloadNetwork;

/** Apple adapter for the backend-neutral private-Docker command seam. */
export function createAppleVmPrivateDockerClient(options: {
  readonly outerRuntime: Pick<ContainerRuntime, 'exec'>;
  readonly containerId: string;
}): PrivateDockerClient {
  const exec: AppleVmDaemonExec = async (argv, commandOptions) =>
    options.outerRuntime.exec(options.containerId, argv, commandOptions.timeoutMs, commandOptions.user);
  return createAppleVmDaemonPrivateDockerClient(exec, options.containerId);
}

/**
 * Create and adjudicate the bundle-local user-defined bridge. This must be
 * called only after daemon readiness and before the agent is released. The
 * daemon-wide default bridge remains disabled; this named `--internal` bridge
 * initially supplies sibling connectivity and Docker's embedded DNS. This is
 * advisory setup for a Docker-admin agent, not an enforcement boundary: the
 * outer VM network isolation remains authoritative.
 */
export async function createAppleVmDockerWorkloadNetwork(options: {
  readonly outerRuntime: Pick<ContainerRuntime, 'exec'>;
  readonly containerId: string;
}): Promise<AppleVmDockerWorkloadNetwork> {
  return createPrivateDockerWorkloadNetwork(createAppleVmPrivateDockerClient(options));
}

/**
 * Freeze one resolved selected-agent archive into an admitted lease's private
 * staging root. The exact inode is hard-linked, then the staged bytes are
 * re-verified immediately before the private daemon loads them.
 */
export function stageAppleVmDockerWorkloadBootstrap(options: {
  readonly leaseStagingRoot: string;
  readonly artifact: SelectedAgentArtifact;
}): AppleVmDockerWorkloadBootstrapConfig {
  const sourceDirectory = dirname(options.artifact.archivePath);
  assertPrivateOwnerDirectory(sourceDirectory, 'selected agent artifact directory');
  assertPrivateOwnerDirectory(options.leaseStagingRoot, 'Docker-workload lease staging root');

  const hostArtifactDirectory = resolve(options.leaseStagingRoot, 'selected-agent-artifact');
  mkdirSync(hostArtifactDirectory, { mode: 0o700 });
  try {
    const stagedArchivePath = resolve(hostArtifactDirectory, basename(options.artifact.archivePath));
    hardLinkExactOwnerFile(options.artifact.archivePath, stagedArchivePath);
    return {
      hostArtifactDirectory,
      guestArtifactDirectory: APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR,
      artifact: { ...options.artifact, archivePath: stagedArchivePath },
      clientToolchainManifestPath: getFrozenClientToolchainManifestPath(),
    };
  } catch (error) {
    rmSync(hostArtifactDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** The selected archive is exposed only for an admitted Docker workload. */
export function appleVmDockerWorkloadArtifactMount(config: AppleVmDockerWorkloadBootstrapConfig): DockerMount {
  return {
    source: config.hostArtifactDirectory,
    target: config.guestArtifactDirectory,
    readonly: true,
  };
}

/**
 * Preflight the pinned client/daemon/plugin tuple, then make the selected outer
 * agent image available to inner IronCurtain in the VM-local Docker Engine.
 *
 * The selected artifact verifier re-reads every archive byte through a
 * no-follow descriptor immediately before load. The private runtime adapter
 * supplies only the pinned client and host-to-guest path translation.
 */
export async function provisionAppleVmDockerWorkload(options: {
  readonly outerRuntime: Pick<ContainerRuntime, 'exec'>;
  readonly containerId: string;
  readonly config: AppleVmDockerWorkloadBootstrapConfig;
}): Promise<AppleVmDockerWorkloadProvisioning> {
  const client = createAppleVmPrivateDockerClient(options);
  const runtime = createAppleVmPrivateDockerRuntime({
    client,
    hostArtifactDirectory: options.config.hostArtifactDirectory,
    guestArtifactDirectory: options.config.guestArtifactDirectory,
  });
  const preflight = await preflightPrivateDockerClient({
    client,
    manifest: loadClientToolchainManifest(options.config.clientToolchainManifestPath),
  });

  const artifact = options.config.artifact;
  if (preflight.architecture !== artifact.architecture) {
    throw new Error('selected agent artifact architecture differs from the private Docker daemon');
  }
  await verifySelectedAgentArtifactArchive(artifact);
  let inspected = await runtime.inspectImage(artifact.logicalName);
  if (inspected === undefined) {
    await runtime.loadImageArchive(artifact.archivePath);
    inspected = await runtime.inspectImage(artifact.logicalName);
  }
  if (inspected === undefined) throw new Error(`selected agent image load did not create ${artifact.logicalName}`);
  if (inspected.id !== artifact.dockerImageId) {
    throw new Error(
      `selected agent inner Docker image mismatch: expected ${artifact.dockerImageId}, got ${inspected.id}`,
    );
  }
  if (inspected.labels['ironcurtain.build-hash'] !== artifact.buildHash) {
    throw new Error('selected agent inner Docker build hash differs from the prepared artifact');
  }
  // The archive is needed only through verification/load/reinspection. Retire
  // the lease hard link before agent release so watchdog disk accounting does
  // not keep charging the multi-gigabyte artifact to the live bundle.
  unlinkSync(artifact.archivePath);
  return {
    preflight,
    image: {
      transport: 'apple-archive',
      logicalName: artifact.logicalName,
      buildHash: artifact.buildHash,
      archiveSha256: artifact.archiveSha256,
      outerImageId: artifact.appleImageId,
      innerImageId: artifact.dockerImageId,
    },
  };
}

/** Narrow adapter over the pinned in-VM Docker client and one fixed private API. */
export function createAppleVmPrivateDockerRuntime(options: {
  readonly client: PrivateDockerClient;
  readonly hostArtifactDirectory: string;
  readonly guestArtifactDirectory: string;
}): Pick<ContainerRuntime, 'inspectImage' | 'loadImageArchive'> {
  return {
    async inspectImage(ref): Promise<DockerImageInfo | undefined> {
      const result = await options.client.execute(['image', 'inspect', ref], INSPECT_TIMEOUT_MS);
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
      const guestPath = translateArtifactArchivePath(
        archivePath,
        options.hostArtifactDirectory,
        options.guestArtifactDirectory,
      );
      const result = await options.client.execute(['image', 'load', '--input', guestPath], LOAD_TIMEOUT_MS);
      if (result.exitCode !== 0) throw privateDockerCommandError('image load', result);
    },
  };
}

function translateArtifactArchivePath(archivePath: string, hostDirectory: string, guestDirectory: string): string {
  const normalized = resolve(archivePath);
  if (dirname(normalized) !== resolve(hostDirectory) || !normalized.endsWith('.tar')) {
    throw new Error('private Docker image load path must be a direct child of the selected artifact directory');
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
  if (uid === undefined) throw new Error('Docker-workload artifact staging requires a Unix process identity');
  const before = lstatSync(sourcePath);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o222) !== 0) {
    throw new Error(`trusted artifact source must be an owner-owned, non-writable regular file: ${sourcePath}`);
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
    throw new Error(`hard-linked artifact file did not preserve source identity: ${sourcePath}`);
  }
}
