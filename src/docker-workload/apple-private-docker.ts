/** Trusted bootstrap access to the private Docker Engine inside an Apple VM. */

import { linkSync, lstatSync, mkdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { ContainerRuntime, DockerExecResult, DockerImageInfo, DockerMount } from '../docker/types.js';
import { parseDockerImageInfo } from '../docker/docker-image-inspect.js';
import { verifySelectedAgentArtifactArchive, type SelectedAgentArtifact } from '../docker/selected-agent-artifact.js';
import { getFrozenClientToolchainManifestPath } from '../docker/docker-workload-paths.js';
import {
  CLIENT_TOOLCHAIN_PREFLIGHT_ARGVS,
  loadClientToolchainManifest,
  preflightClientToolchain,
  type ClientToolchainPreflight,
} from './client-toolchain.js';
import { APPLE_VM_DAEMON_DOCKER_HOST, APPLE_VM_DAEMON_TOOLCHAIN_DIR } from './apple-vm-daemon.js';

/** Guest-visible, read-only view of this lease's selected agent archive. */
export const APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR = '/opt/ironcurtain/selected-agent-artifact';

/**
 * Fixed agent-facing network inside each bundle's private Docker Engine. The
 * name can be constant because every admitted bundle owns a distinct VM-local
 * daemon; it therefore cannot collide across sessions or name a host resource.
 */
export const APPLE_VM_DOCKER_WORKLOAD_NETWORK = 'ironcurtain';

/** Agent environment key naming the precreated inner workload bridge. */
export const APPLE_VM_DOCKER_WORKLOAD_NETWORK_ENV = 'IRONCURTAIN_DOCKER_NETWORK';

const DOCKER_CLIENT = `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`;
const RUNTIME_USER = 'codespace';
const INSPECT_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 60 * 60_000;
const MAX_ERROR_DETAIL = 2048;
const MANAGED_NETWORK_LABEL_KEY = 'com.ironcurtain.managed-workload';
const MANAGED_NETWORK_LABEL_VALUE = 'true';
const MANAGED_NETWORK_LABEL = `${MANAGED_NETWORK_LABEL_KEY}=${MANAGED_NETWORK_LABEL_VALUE}`;
const MAX_NETWORK_INSPECT_BYTES = 16 * 1024;

/** Trusted host and guest paths needed by both container assembly and bootstrap. */
export interface AppleVmDockerWorkloadBootstrapConfig {
  readonly hostArtifactDirectory: string;
  readonly guestArtifactDirectory: string;
  readonly artifact: SelectedAgentArtifact;
  readonly clientToolchainManifestPath: string;
}

export interface AppleVmDockerWorkloadImageObservation {
  readonly logicalName: string;
  readonly immutableImageId: string;
  readonly outerAppleImageId: string;
  readonly buildHash: string;
  readonly archiveSha256: string;
}

export interface AppleVmDockerWorkloadProvisioning {
  readonly preflight: ClientToolchainPreflight;
  readonly image: AppleVmDockerWorkloadImageObservation;
}

export interface AppleVmDockerWorkloadNetwork {
  readonly name: typeof APPLE_VM_DOCKER_WORKLOAD_NETWORK;
  readonly id: string;
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
  const execute = (args: readonly string[]): Promise<DockerExecResult> =>
    options.outerRuntime.exec(
      options.containerId,
      [DOCKER_CLIENT, '--host', APPLE_VM_DAEMON_DOCKER_HOST, ...args],
      INSPECT_TIMEOUT_MS,
      RUNTIME_USER,
    );
  const created = await execute([
    'network',
    'create',
    '--driver',
    'bridge',
    '--internal',
    '--label',
    MANAGED_NETWORK_LABEL,
    APPLE_VM_DOCKER_WORKLOAD_NETWORK,
  ]);
  if (created.exitCode !== 0) throw privateDockerCommandError('managed network create', created);
  const createdId = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(createdId)) {
    throw new Error('private Docker managed network create returned an invalid network ID');
  }

  const inspected = await execute(['network', 'inspect', '--format', '{{json .}}', APPLE_VM_DOCKER_WORKLOAD_NETWORK]);
  if (inspected.exitCode !== 0) throw privateDockerCommandError('managed network inspect', inspected);
  if (Buffer.byteLength(inspected.stdout, 'utf8') > MAX_NETWORK_INSPECT_BYTES) {
    throw new Error('private Docker managed network inspection exceeded the response limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspected.stdout) as unknown;
  } catch (error) {
    throw new Error('private Docker managed network inspect returned invalid JSON', { cause: error });
  }
  const labels = (parsed as { Labels?: unknown } | null)?.Labels;
  const containers = (parsed as { Containers?: unknown } | null)?.Containers;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { Id?: unknown }).Id !== createdId ||
    (parsed as { Name?: unknown }).Name !== APPLE_VM_DOCKER_WORKLOAD_NETWORK ||
    (parsed as { Driver?: unknown }).Driver !== 'bridge' ||
    (parsed as { Scope?: unknown }).Scope !== 'local' ||
    (parsed as { Internal?: unknown }).Internal !== true ||
    typeof labels !== 'object' ||
    labels === null ||
    Array.isArray(labels) ||
    Object.keys(labels).length !== 1 ||
    (labels as Record<string, unknown>)[MANAGED_NETWORK_LABEL_KEY] !== MANAGED_NETWORK_LABEL_VALUE ||
    typeof containers !== 'object' ||
    containers === null ||
    Array.isArray(containers) ||
    Object.keys(containers).length !== 0
  ) {
    throw new Error('private Docker managed network did not resolve to the required empty labeled internal bridge');
  }
  return { name: APPLE_VM_DOCKER_WORKLOAD_NETWORK, id: createdId };
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
  const runtime = createAppleVmPrivateDockerRuntime({
    outerRuntime: options.outerRuntime,
    containerId: options.containerId,
    hostArtifactDirectory: options.config.hostArtifactDirectory,
    guestArtifactDirectory: options.config.guestArtifactDirectory,
  });
  const preflight = await preflightClientToolchain({
    runtime,
    containerId: options.containerId,
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
      logicalName: artifact.logicalName,
      immutableImageId: artifact.dockerImageId,
      outerAppleImageId: artifact.appleImageId,
      buildHash: artifact.buildHash,
      archiveSha256: artifact.archiveSha256,
    },
  };
}

/** Narrow adapter over the pinned in-VM Docker client and one fixed private API. */
export function createAppleVmPrivateDockerRuntime(options: {
  readonly outerRuntime: Pick<ContainerRuntime, 'exec'>;
  readonly containerId: string;
  readonly hostArtifactDirectory: string;
  readonly guestArtifactDirectory: string;
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
      const guestPath = translateArtifactArchivePath(
        archivePath,
        options.hostArtifactDirectory,
        options.guestArtifactDirectory,
      );
      const result = await execute(['image', 'load', '--input', guestPath], LOAD_TIMEOUT_MS);
      if (result.exitCode !== 0) throw privateDockerCommandError('image load', result);
    },
  };
}

function exactArgv(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
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
