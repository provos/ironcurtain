/**
 * Rootless nested-Docker daemon sidecar for the macOS Docker Desktop backend.
 *
 * The outer runtime remains the authority for isolation: the sidecar has no
 * outer network, host runtime socket, host namespace, device, or broad bind.
 * Its only writable shared authority is a randomly named API volume, mounted
 * read-only into the agent before final lease activation. The selected agent archive
 * arrives through one lease-private, read-only staging directory. The runc
 * compatibility wrapper is part of the immutable daemon image and selected
 * from one fixed PATH prefix.
 *
 * This module deliberately does not own lease implementation details. The
 * caller supplies one ledgered-create capability so volume/container
 * precommit, watchdog freshness, immutable-ID observation, and crash recovery
 * remain in the common Docker-workload lifecycle.
 */

import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type {
  ContainerRuntime,
  DockerContainerConfig,
  DockerExecResult,
  DockerNamedVolumeMount,
  DockerVolumeInfo,
} from '../docker/types.js';
import { getFrozenProfileCeilingPath, getIronCurtainPackageRoot } from '../docker/docker-workload-paths.js';
import { computeHash, sha256HexSchema } from '../hash.js';
import { loadImmutableHostJson } from '../hardened-fs.js';
import {
  APPLE_VM_DAEMON_API_DIR,
  APPLE_VM_DAEMON_DOCKER_HOST,
  APPLE_VM_DAEMON_LOG_TAIL_ARGV,
  APPLE_VM_DAEMON_TOOLCHAIN_DIR,
  waitForAppleVmDaemonReady,
  type AppleVmDaemonExec,
  type AppleVmDaemonReadiness,
} from './apple-vm-daemon.js';
import {
  appleVmDockerWorkloadArtifactMount,
  createAppleVmDockerWorkloadNetwork,
  provisionAppleVmDockerWorkload,
  type AppleVmDockerWorkloadBootstrapConfig,
  type AppleVmDockerWorkloadNetwork,
  type AppleVmDockerWorkloadProvisioning,
} from './apple-private-docker.js';
import type { DockerWorkloadBundleHandle } from './infrastructure.js';
import type { ExpandedOuterCreate } from './lifecycle-evidence.js';

export const DOCKER_DESKTOP_SIDECAR_API_ROOT = APPLE_VM_DAEMON_API_DIR;
export const DOCKER_DESKTOP_SIDECAR_DOCKER_HOST = APPLE_VM_DAEMON_DOCKER_HOST;
export const DOCKER_DESKTOP_SIDECAR_DATA_MOUNT_ROOT = '/home/rootless/.local/share/docker';
export const DOCKER_DESKTOP_SIDECAR_DATA_ROOT = `${DOCKER_DESKTOP_SIDECAR_DATA_MOUNT_ROOT}/data`;
export const DOCKER_DESKTOP_RUNC_SHIM_PATH = '/usr/local/lib/ironcurtain/runc';
export const DOCKER_DESKTOP_RUNC_VERSION_PREFIX = 'runc version 1.3.4';

const DAEMON_IMAGE_ROLE_LABEL = 'com.ironcurtain.docker-workload.image-role';
const DAEMON_IMAGE_ROLE = 'nested-daemon';
const ROOTLESS_USER = 'rootless';
const APPLE_RUNTIME_USER = 'codespace';
const RUNC_SHIM_RUNTIME_NAME = 'ic-no-new-keyring';
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const EXEC_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const MAX_DIAGNOSTIC_BYTES = 2048;
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const PROFILE_RELATIVE_PATH = 'config/docker-workload/seccomp/desktop-p2-userns.json';
const DESKTOP_CEILING_STATUS = 'reviewed-dd-h3-sidecar-supported-not-qualified';
const SYSTEM_PATHS_SECURITY_OPTION = 'systempaths=unconfined';
const SYSTEM_PATHS_SCOPE = 'docker-desktop-nested-daemon-sidecar-only';
const PROFILE_MAX_BYTES = 1024 * 1024;
const IMMUTABLE_ID = /^sha256:[a-f0-9]{64}$/u;
const CONTAINER_ID = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTERS = /[^\P{Cc}\n\t]/gu;

const profileCeilingSchema = z
  .object({
    status: z.literal(DESKTOP_CEILING_STATUS),
    categories: z
      .object({
        seccomp: z
          .object({
            artifact: z
              .object({
                path: z.literal(PROFILE_RELATIVE_PATH),
                sha256: sha256HexSchema,
              })
              .strict(),
          })
          .loose(),
        mountMask: z
          .object({
            additions: z.tuple([
              z
                .object({
                  option: z.literal(SYSTEM_PATHS_SECURITY_OPTION),
                  scope: z.literal(SYSTEM_PATHS_SCOPE),
                })
                .loose(),
            ]),
          })
          .loose(),
      })
      .loose(),
  })
  .loose();

const seccompRuleSchema = z
  .object({
    names: z.array(z.string().min(1)),
    action: z.string().min(1),
    args: z.unknown().optional(),
    includes: z.unknown().optional(),
    excludes: z.unknown().optional(),
  })
  .loose();

const seccompProfileSchema = z
  .object({
    defaultAction: z.string().min(1),
    syscalls: z.array(seccompRuleSchema).min(1),
  })
  .loose();

export interface DockerDesktopP2SeccompProfile {
  readonly path: string;
  readonly sha256: string;
  readonly systemPathsSecurityOption: typeof SYSTEM_PATHS_SECURITY_OPTION;
}

export function parseDockerDesktopProfileCeiling(value: unknown): z.infer<typeof profileCeilingSchema> {
  return profileCeilingSchema.parse(value);
}

/** The minimal runtime surface the focused sidecar lifecycle consumes. */
export type DockerDesktopSidecarRuntime = Pick<
  ContainerRuntime,
  'preflight' | 'inspectImage' | 'create' | 'start' | 'exec' | 'stop' | 'remove'
> & {
  readonly createVolume: NonNullable<ContainerRuntime['createVolume']>;
  readonly inspectVolume: NonNullable<ContainerRuntime['inspectVolume']>;
  readonly removeVolume: NonNullable<ContainerRuntime['removeVolume']>;
};

export function requireDockerDesktopSidecarRuntime(runtime: ContainerRuntime): DockerDesktopSidecarRuntime {
  if (runtime.createVolume === undefined || runtime.inspectVolume === undefined || runtime.removeVolume === undefined) {
    throw new Error('Docker Desktop nested-Docker requires exact named-volume create/inspect/remove runtime APIs');
  }
  return runtime as DockerDesktopSidecarRuntime;
}

export interface DockerDesktopSidecarOuterCreateSpec {
  readonly kind: 'container' | 'volume';
  readonly role: 'nested-daemon' | 'daemon-api';
  readonly launchesNestedDaemon?: boolean;
}

export type DockerDesktopSidecarCreateAuthority = (
  spec: DockerDesktopSidecarOuterCreateSpec,
  create: (
    requestedName: string,
    ownershipLabels: Readonly<Record<string, string>>,
  ) => Promise<{ readonly id: string; readonly expanded?: ExpandedOuterCreate }>,
) => Promise<{ readonly id: string; readonly requestedName: string }>;

export interface DockerDesktopSidecarResources {
  readonly memoryMb: number;
  readonly cpus: number;
  readonly pidsLimit: number;
}

type DockerDesktopActivationHandle = Pick<
  DockerWorkloadBundleHandle,
  'generation' | 'recordDaemonReady' | 'recordPrivateDockerBootstrap'
>;

export interface StartDockerDesktopSidecarOptions {
  readonly runtime: DockerDesktopSidecarRuntime;
  readonly sidecarImage: string;
  readonly bootstrap: AppleVmDockerWorkloadBootstrapConfig;
  readonly resources: DockerDesktopSidecarResources;
  readonly createOuterResource: DockerDesktopSidecarCreateAuthority;
  readonly activation: DockerDesktopActivationHandle;
  readonly readinessTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Test-only deterministic readiness clock. */
  readonly now?: () => number;
  /** Test-only deterministic readiness sleeper. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface DockerDesktopSidecarHandle {
  readonly containerId: string;
  readonly apiVolumeName: string;
  readonly dockerHost: typeof DOCKER_DESKTOP_SIDECAR_DOCKER_HOST;
  /** Exact read-only capability mounted into the agent container. */
  readonly agentApiMount: DockerNamedVolumeMount;
  readonly readiness: AppleVmDaemonReadiness;
  readonly provisioning: AppleVmDockerWorkloadProvisioning;
  readonly network: AppleVmDockerWorkloadNetwork;
  readonly seccompProfile: DockerDesktopP2SeccompProfile;
}

/** Load and bind the one reviewed P2 artifact named by the frozen ceiling. */
export function loadDockerDesktopP2SeccompProfile(): DockerDesktopP2SeccompProfile {
  const loadedCeiling = loadImmutableHostJson(getFrozenProfileCeilingPath(), {
    label: 'Docker-workload profile ceiling',
    schema: z.unknown(),
    maxBytes: PROFILE_MAX_BYTES,
  });
  const ceiling = parseDockerDesktopProfileCeiling(loadedCeiling.value);
  const artifact = ceiling.categories.seccomp.artifact;
  const profilePath = resolve(getIronCurtainPackageRoot(), artifact.path);
  const expectedPath = resolve(getIronCurtainPackageRoot(), PROFILE_RELATIVE_PATH);
  if (profilePath !== expectedPath)
    throw new Error('Docker Desktop P2 seccomp artifact resolved outside its fixed path');
  const profile = loadImmutableHostJson(profilePath, {
    label: 'Docker Desktop P2 seccomp profile',
    schema: seccompProfileSchema,
    maxBytes: PROFILE_MAX_BYTES,
  });
  if (profile.sha256 !== artifact.sha256) {
    throw new Error(
      `Docker Desktop P2 seccomp artifact hash mismatch: expected ${artifact.sha256}, got ${profile.sha256}`,
    );
  }
  const unconditionalAllows = (name: string): boolean =>
    profile.value.syscalls.some(
      (rule) =>
        rule.action === 'SCMP_ACT_ALLOW' &&
        rule.names.includes(name) &&
        rule.args === undefined &&
        rule.includes === undefined &&
        rule.excludes === undefined,
    );
  if (!unconditionalAllows('sethostname')) {
    throw new Error('Docker Desktop P2 seccomp profile lacks the denial-proven sethostname allowance');
  }
  if (unconditionalAllows('keyctl')) {
    throw new Error('Docker Desktop P2 seccomp profile must not admit keyctl; use the pinned runc compatibility shim');
  }
  return {
    path: profile.path,
    sha256: profile.sha256,
    systemPathsSecurityOption: ceiling.categories.mountMask.additions[0].option,
  };
}

/**
 * Create, adjudicate, and qualify one sidecar. Every failure before a successful
 * handoff removes the exact sidecar and API volume best-effort; the common lease
 * remains the crash-recovery authority and performs final activation only after
 * the agent has been ledgered and created with the returned API mount.
 */
export async function startDockerDesktopSidecar(
  options: StartDockerDesktopSidecarOptions,
): Promise<DockerDesktopSidecarHandle> {
  validateResources(options.resources);
  const profile = loadDockerDesktopP2SeccompProfile();
  await options.runtime.preflight(options.sidecarImage);
  const inspectedSidecarImage = await options.runtime.inspectImage(options.sidecarImage);
  if (inspectedSidecarImage === undefined)
    throw new Error(`Docker Desktop daemon image is absent: ${options.sidecarImage}`);
  if (!IMMUTABLE_ID.test(inspectedSidecarImage.id)) {
    throw new Error('Docker Desktop daemon image resolved to an invalid immutable ID');
  }
  if (inspectedSidecarImage.labels[DAEMON_IMAGE_ROLE_LABEL] !== DAEMON_IMAGE_ROLE) {
    throw new Error('Docker Desktop daemon image is missing its exact nested-daemon role label');
  }

  let apiVolumeName: string | undefined;
  let containerId: string | undefined;
  try {
    const volume = await options.createOuterResource({ kind: 'volume', role: 'daemon-api' }, async (name, labels) => {
      const id = await options.runtime.createVolume(name, { labels });
      if (id !== name) throw new Error('Docker Desktop API volume returned an unexpected runtime identity');
      // Retain the exact runtime-confirmed identity before post-create
      // inspection/ledger observation so either failure can roll it back.
      apiVolumeName = name;
      const inspected = await options.runtime.inspectVolume(id);
      assertApiVolume(inspected, name, labels);
      return { id };
    });
    if (apiVolumeName === undefined || volume.id !== apiVolumeName || volume.requestedName !== apiVolumeName) {
      throw new Error('Docker Desktop API volume grant identity changed');
    }
    const ownedApiVolumeName = apiVolumeName;

    const sidecar = await options.createOuterResource(
      { kind: 'container', role: 'nested-daemon', launchesNestedDaemon: true },
      async (name, labels) => {
        const config = buildSidecarConfig({
          imageId: inspectedSidecarImage.id,
          name,
          labels,
          apiVolumeName: ownedApiVolumeName,
          bootstrap: options.bootstrap,
          profile,
          resources: options.resources,
        });
        const id = await options.runtime.create(config);
        if (!CONTAINER_ID.test(id)) throw new Error('Docker Desktop sidecar create returned an invalid container ID');
        // As with the volume, keep the immutable runtime identity before the
        // outer ledger records it so an observation failure cannot leak it.
        containerId = id;
        return {
          id,
          expanded: {
            mounts: [
              { source: ownedApiVolumeName, target: DOCKER_DESKTOP_SIDECAR_API_ROOT, readonly: false },
              { source: ownedApiVolumeName, target: DOCKER_DESKTOP_SIDECAR_DATA_MOUNT_ROOT, readonly: false },
              ...config.mounts,
            ],
            limits: {
              memoryMb: options.resources.memoryMb,
              cpus: options.resources.cpus,
              pidsLimit: options.resources.pidsLimit,
            },
            profileRef: `${profile.path}#sha256=${profile.sha256}`,
          },
        };
      },
    );
    if (containerId === undefined || sidecar.id !== containerId) {
      throw new Error('Docker Desktop sidecar grant identity changed');
    }
    await options.runtime.start(containerId);

    const appleCompatibleExec = appleCompatibleSidecarExec(options.runtime, containerId);
    const readiness = await waitForAppleVmDaemonReady(appleCompatibleExec, {
      timeoutMs: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs,
      now: options.now,
      sleep: options.sleep,
    });
    options.activation.recordDaemonReady(readiness);
    await preflightRuntimeShim(options.runtime, containerId);

    const translatedRuntime: Pick<ContainerRuntime, 'exec'> = {
      exec: async (_containerId, argv, timeoutMs, execUser) => {
        if (_containerId !== containerId) throw new Error('Docker Desktop private-Docker container ID mismatch');
        if (execUser !== APPLE_RUNTIME_USER) throw new Error('Docker Desktop private-Docker adapter user mismatch');
        const result = await appleCompatibleExec(argv, {
          user: APPLE_RUNTIME_USER,
          timeoutMs: timeoutMs ?? EXEC_TIMEOUT_MS,
        });
        return { stdout: result.stdout, stderr: result.stderr ?? '', exitCode: result.exitCode };
      },
    };
    const provisioning = await provisionAppleVmDockerWorkload({
      outerRuntime: translatedRuntime,
      containerId,
      config: options.bootstrap,
    });
    const network = await createAppleVmDockerWorkloadNetwork({
      outerRuntime: translatedRuntime,
      containerId,
    });
    await runDockerDesktopActivationCanary({
      runtime: options.runtime,
      containerId,
      selectedImageId: provisioning.image.immutableImageId,
      networkName: network.name,
      generation: options.activation.generation,
    });

    options.activation.recordPrivateDockerBootstrap(provisioning, network);
    return {
      containerId,
      apiVolumeName,
      dockerHost: DOCKER_DESKTOP_SIDECAR_DOCKER_HOST,
      agentApiMount: {
        name: apiVolumeName,
        target: DOCKER_DESKTOP_SIDECAR_API_ROOT,
        readonly: true,
        noCopy: true,
      },
      readiness,
      provisioning,
      network,
      seccompProfile: profile,
    };
  } catch (error) {
    const cleanupFailures = await rollbackSidecar(options.runtime, containerId, apiVolumeName);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Docker Desktop sidecar qualification and rollback failed',
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

function buildSidecarConfig(options: {
  readonly imageId: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly apiVolumeName: string;
  readonly bootstrap: AppleVmDockerWorkloadBootstrapConfig;
  readonly profile: DockerDesktopP2SeccompProfile;
  readonly resources: DockerDesktopSidecarResources;
}): DockerContainerConfig {
  return {
    image: options.imageId,
    name: options.name,
    mounts: [appleVmDockerWorkloadArtifactMount(options.bootstrap)],
    network: 'none',
    env: {
      DOCKER_TLS_CERTDIR: '',
      DOCKERD_ROOTLESS_ROOTLESSKIT_NET: 'none',
      XDG_RUNTIME_DIR: DOCKER_DESKTOP_SIDECAR_API_ROOT,
      PATH: `${dirname(DOCKER_DESKTOP_RUNC_SHIM_PATH)}:${DEFAULT_PATH}`,
    },
    command: [
      'dockerd',
      `--add-runtime=${RUNC_SHIM_RUNTIME_NAME}=${DOCKER_DESKTOP_RUNC_SHIM_PATH}`,
      `--default-runtime=${RUNC_SHIM_RUNTIME_NAME}`,
      `--host=${DOCKER_DESKTOP_SIDECAR_DOCKER_HOST}`,
      '--storage-driver=vfs',
      `--data-root=${DOCKER_DESKTOP_SIDECAR_DATA_ROOT}`,
      `--exec-root=${DOCKER_DESKTOP_SIDECAR_API_ROOT}/exec`,
      `--pidfile=${DOCKER_DESKTOP_SIDECAR_API_ROOT}/docker.pid`,
      '--iptables=false',
      '--bridge=none',
      '--ip-forward=false',
      '--ip-masq=false',
    ],
    labels: options.labels,
    resources: { memoryMb: options.resources.memoryMb, cpus: options.resources.cpus },
    capAdd: ['SETUID', 'SETGID'],
    trustedCreateOptions: {
      namedVolumeMounts: [
        {
          name: options.apiVolumeName,
          target: DOCKER_DESKTOP_SIDECAR_API_ROOT,
          readonly: false,
          // Copy-up is required: the image supplies this directory as
          // uid/gid 1000, mode 0700 without CAP_CHOWN.
          noCopy: false,
        },
        {
          name: options.apiVolumeName,
          target: DOCKER_DESKTOP_SIDECAR_DATA_MOUNT_ROOT,
          readonly: false,
          // The API-root mount already initialized this same volume. Do not
          // copy stock daemon state into it again through the second target.
          noCopy: true,
        },
      ],
      tmpfs: [
        '/run:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000',
        '/tmp:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000',
        '/home/rootless/.docker:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000',
      ],
      readOnlyRootfs: true,
      securityOptions: [options.profile.systemPathsSecurityOption],
      seccompProfile: options.profile.path,
      pidsLimit: options.resources.pidsLimit,
    },
  };
}

function validateResources(resources: DockerDesktopSidecarResources): void {
  if (!Number.isSafeInteger(resources.memoryMb) || resources.memoryMb < 512) {
    throw new Error('Docker Desktop sidecar memory must be an integer of at least 512 MiB');
  }
  if (!Number.isFinite(resources.cpus) || resources.cpus < 0.25) {
    throw new Error('Docker Desktop sidecar CPUs must be at least 0.25');
  }
  if (!Number.isSafeInteger(resources.pidsLimit) || resources.pidsLimit < 16) {
    throw new Error('Docker Desktop sidecar PID limit must be an integer of at least 16');
  }
}

function assertApiVolume(
  volume: DockerVolumeInfo | undefined,
  expectedName: string,
  expectedLabels: Readonly<Record<string, string>>,
): asserts volume is DockerVolumeInfo {
  if (
    volume === undefined ||
    volume.id !== expectedName ||
    volume.name !== expectedName ||
    volume.driver !== 'local' ||
    volume.mountpoint === '' ||
    Object.keys(volume.labels).length !== Object.keys(expectedLabels).length ||
    Object.entries(expectedLabels).some(([key, value]) => volume.labels[key] !== value)
  ) {
    throw new Error('Docker Desktop API volume did not inspect as the exact owned local volume');
  }
}

/** Translate only the fixed Apple private-Docker command prefix to the stock sidecar client path. */
function appleCompatibleSidecarExec(runtime: DockerDesktopSidecarRuntime, containerId: string): AppleVmDaemonExec {
  const appleDockerClient = `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`;
  return async (argv, execOptions) => {
    if (execOptions.user !== APPLE_RUNTIME_USER) throw new Error('Docker Desktop daemon exec user mismatch');
    const translated =
      argv[0] === appleDockerClient && argv[1] === '--host' && argv[2] === APPLE_VM_DAEMON_DOCKER_HOST
        ? ['docker', '--host', DOCKER_DESKTOP_SIDECAR_DOCKER_HOST, ...argv.slice(3)]
        : exactArgv(argv, APPLE_VM_DAEMON_LOG_TAIL_ARGV)
          ? argv
          : (() => {
              throw new Error('Docker Desktop daemon adapter rejected an unknown Apple command');
            })();
    return runtime.exec(containerId, translated, execOptions.timeoutMs, ROOTLESS_USER);
  };
}

async function preflightRuntimeShim(runtime: DockerDesktopSidecarRuntime, containerId: string): Promise<void> {
  const resolved = await runtime.exec(
    containerId,
    ['/bin/sh', '-c', 'command -v runc'],
    EXEC_TIMEOUT_MS,
    ROOTLESS_USER,
  );
  if (resolved.exitCode !== 0 || resolved.stdout.trim() !== DOCKER_DESKTOP_RUNC_SHIM_PATH) {
    throw new Error(
      `Docker Desktop daemon PATH did not select the baked runc shim at ${DOCKER_DESKTOP_RUNC_SHIM_PATH}`,
    );
  }
  const version = await runtime.exec(
    containerId,
    [DOCKER_DESKTOP_RUNC_SHIM_PATH, '--version'],
    EXEC_TIMEOUT_MS,
    ROOTLESS_USER,
  );
  if (version.exitCode !== 0 || !version.stdout.startsWith(DOCKER_DESKTOP_RUNC_VERSION_PREFIX)) {
    throw new Error('Docker Desktop baked runc shim did not hand off to the pinned runc version');
  }
}

interface ActivationCanaryOptions {
  readonly runtime: DockerDesktopSidecarRuntime;
  readonly containerId: string;
  readonly selectedImageId: string;
  readonly networkName: string;
  readonly generation: string;
}

/** Prove both ordinary inner OCI start and an integrated BuildKit RUN before activation. */
async function runDockerDesktopActivationCanary(options: ActivationCanaryOptions): Promise<void> {
  if (!IMMUTABLE_ID.test(options.selectedImageId))
    throw new Error('Docker Desktop canary received an invalid image ID');
  const suffix = computeHash({ containerId: options.containerId, generation: options.generation }).slice(0, 16);
  const runName = `ironcurtain-desktop-run-${suffix}`;
  const baseTag = `ironcurtain-desktop-base:${suffix}`;
  const outputTag = `ironcurtain-desktop-build:${suffix}`;
  const contextRoot = `/tmp/ironcurtain-desktop-build-${suffix}`;
  const dockerfilePath = `${contextRoot}/Dockerfile`;
  const execDocker = (args: readonly string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<DockerExecResult> =>
    options.runtime.exec(
      options.containerId,
      ['docker', '--host', DOCKER_DESKTOP_SIDECAR_DOCKER_HOST, ...args],
      timeoutMs,
      ROOTLESS_USER,
    );

  let failure: unknown;
  let baseTagged = false;
  let outputImageId: string | undefined;
  try {
    if (
      (await inspectImage(execDocker, baseTag)) !== undefined ||
      (await inspectImage(execDocker, outputTag)) !== undefined
    ) {
      throw new Error('Docker Desktop activation canary reserved image tag already exists');
    }
    if ((await inspectContainer(execDocker, runName)) !== undefined) {
      throw new Error('Docker Desktop activation canary reserved container already exists');
    }
    const run = await execDocker([
      'run',
      '--rm',
      '--name',
      runName,
      '--network',
      options.networkName,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--entrypoint',
      '/bin/true',
      options.selectedImageId,
    ]);
    assertDockerSuccess(run, 'ordinary inner-container activation canary');
    if ((await inspectContainer(execDocker, runName)) !== undefined) {
      throw new Error('Docker Desktop ordinary activation canary container remained after --rm');
    }

    assertDockerSuccess(await execDocker(['image', 'tag', options.selectedImageId, baseTag]), 'activation base tag');
    baseTagged = true;
    if ((await inspectImage(execDocker, baseTag)) !== options.selectedImageId) {
      throw new Error('Docker Desktop activation canary base tag changed immutable identity');
    }
    const prepare = await options.runtime.exec(
      options.containerId,
      [
        '/bin/sh',
        '-c',
        'set -eu; umask 077; mkdir -p "$1"; printf "%s" "$2" > "$3"',
        'ironcurtain-desktop-build-canary',
        contextRoot,
        `FROM ${baseTag}\nRUN /bin/true\n`,
        dockerfilePath,
      ],
      EXEC_TIMEOUT_MS,
      ROOTLESS_USER,
    );
    assertDockerSuccess(prepare, 'activation canary context preparation');
    const built = await execDocker(
      [
        'build',
        '--pull=false',
        '--network=none',
        '--no-cache',
        '--progress=plain',
        '--tag',
        outputTag,
        '--file',
        dockerfilePath,
        contextRoot,
      ],
      BUILD_TIMEOUT_MS,
    );
    assertDockerSuccess(built, 'integrated BuildKit RUN activation canary');
    outputImageId = await inspectImage(execDocker, outputTag);
    if (outputImageId === undefined || outputImageId === options.selectedImageId) {
      throw new Error('Docker Desktop BuildKit canary did not create a distinct immutable image');
    }
  } catch (error) {
    failure = error;
  }

  const cleanupFailures: Error[] = [];
  const cleanup = async (description: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      cleanupFailures.push(new Error(description, { cause: error }));
    }
  };
  await cleanup('Docker Desktop BuildKit canary output cleanup failed', async () => {
    const current = await inspectImage(execDocker, outputTag);
    if (current === undefined) return;
    if (outputImageId !== undefined && current !== outputImageId) {
      throw new Error('reserved BuildKit output tag was replaced; refusing deletion');
    }
    if (current === options.selectedImageId) throw new Error('BuildKit output tag aliases the selected image');
    assertDockerSuccess(await execDocker(['image', 'rm', '--force', current]), 'activation output image cleanup');
  });
  await cleanup('Docker Desktop activation base-tag cleanup failed', async () => {
    const current = await inspectImage(execDocker, baseTag);
    if (current === undefined) return;
    if (!baseTagged || current !== options.selectedImageId) {
      throw new Error('reserved activation base tag was replaced; refusing deletion');
    }
    assertDockerSuccess(await execDocker(['image', 'rm', baseTag]), 'activation base tag cleanup');
  });
  await cleanup('Docker Desktop activation context cleanup failed', async () => {
    const removed = await options.runtime.exec(
      options.containerId,
      ['/bin/rm', '-rf', contextRoot],
      EXEC_TIMEOUT_MS,
      ROOTLESS_USER,
    );
    assertDockerSuccess(removed, 'activation context cleanup');
  });
  await cleanup('Docker Desktop activation residue check failed', async () => {
    const [runResidue, baseResidue, outputResidue, selected] = await Promise.all([
      inspectContainer(execDocker, runName),
      inspectImage(execDocker, baseTag),
      inspectImage(execDocker, outputTag),
      inspectImage(execDocker, options.selectedImageId),
    ]);
    if (runResidue !== undefined || baseResidue !== undefined || outputResidue !== undefined) {
      throw new Error('Docker Desktop activation canary left container or image residue');
    }
    if (selected !== options.selectedImageId)
      throw new Error('Docker Desktop activation canary changed the selected image');
  });

  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure]), ...cleanupFailures],
      'Docker Desktop activation canary cleanup verification failed',
      { cause: failure },
    );
  }
  if (failure !== undefined) {
    throw failure instanceof Error ? failure : new Error('Docker Desktop activation canary failed', { cause: failure });
  }
}

async function inspectImage(
  execDocker: (args: readonly string[], timeoutMs?: number) => Promise<DockerExecResult>,
  reference: string,
): Promise<string | undefined> {
  const result = await execDocker(['image', 'inspect', '--format', '{{.Id}}', reference]);
  return parseInspectIdentity(result, 'image', reference);
}

async function inspectContainer(
  execDocker: (args: readonly string[], timeoutMs?: number) => Promise<DockerExecResult>,
  reference: string,
): Promise<string | undefined> {
  const result = await execDocker(['container', 'inspect', '--format', '{{.Id}}', reference]);
  const parsed = parseInspectIdentity(result, 'container', reference);
  if (parsed === undefined) return undefined;
  return parsed.slice('sha256:'.length);
}

function parseInspectIdentity(result: DockerExecResult, kind: string, reference: string): string | undefined {
  if (result.exitCode === 0) {
    const value = result.stdout.trim();
    const normalized = kind === 'container' && CONTAINER_ID.test(value) ? `sha256:${value}` : value;
    if (!IMMUTABLE_ID.test(normalized)) throw new Error(`Docker Desktop ${kind} inspect returned an invalid ID`);
    return normalized;
  }
  if (result.exitCode === 1 && /(?:no such|not found)/iu.test(`${result.stdout}\n${result.stderr}`)) return undefined;
  throw new Error(
    `Docker Desktop ${kind} inspect failed for ${reference} with exit code ${result.exitCode}: ${boundedDiagnostic(
      result,
    )}`,
  );
}

function assertDockerSuccess(result: DockerExecResult, operation: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed with exit code ${result.exitCode}: ${boundedDiagnostic(result)}`);
  }
}

function boundedDiagnostic(result: Pick<DockerExecResult, 'stdout' | 'stderr'>): string {
  const text = (result.stderr.trim() || result.stdout.trim() || 'no diagnostic output')
    .replace(CONTROL_CHARACTERS, '')
    .replace(/[\n\t]/gu, ' ');
  const bytes = Buffer.from(text, 'utf8');
  return bytes.byteLength <= MAX_DIAGNOSTIC_BYTES
    ? text
    : `${bytes.subarray(0, MAX_DIAGNOSTIC_BYTES).toString('utf8')}…`;
}

async function rollbackSidecar(
  runtime: DockerDesktopSidecarRuntime,
  containerId: string | undefined,
  apiVolumeName: string | undefined,
): Promise<readonly Error[]> {
  const failures: Error[] = [];
  if (containerId !== undefined) {
    try {
      await runtime.stop(containerId);
    } catch (error) {
      failures.push(new Error('Docker Desktop sidecar rollback stop failed', { cause: error }));
    }
    try {
      await runtime.remove(containerId);
    } catch (error) {
      failures.push(new Error('Docker Desktop sidecar rollback removal failed', { cause: error }));
    }
  }
  if (apiVolumeName !== undefined) {
    try {
      await runtime.removeVolume(apiVolumeName);
    } catch (error) {
      failures.push(new Error('Docker Desktop API volume rollback removal failed', { cause: error }));
    }
  }
  return failures;
}

function exactArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
