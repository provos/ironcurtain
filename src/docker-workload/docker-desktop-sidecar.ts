/**
 * Rootless nested-Docker daemon sidecar for the macOS Docker Desktop backend.
 *
 * The outer runtime remains the authority for isolation: the sidecar has no
 * host runtime socket, host namespace, broad bind, or generic device access.
 * Online mode alone maps `/dev/net/tun:rwm` so rootless slirp4netns can create
 * its tap; the outer network is still the isolated fixed-relay network.
 * Its only writable shared authority is a generation-scoped API volume, mounted
 * read-only into the agent before final lease activation. The runc compatibility
 * wrapper is part of the immutable daemon image and selected from one fixed
 * PATH prefix. Qualification builds a tiny `FROM scratch` image from stock runc
 * already in that image; it never exports or loads the outer agent image and
 * never pulls from a registry. Stock runc is dynamically linked only to the
 * image's musl loader, so the context copies that one local file too.
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
  DockerMount,
  DockerNamedVolumeMount,
  DockerTrustedDeviceMapping,
  DockerVolumeInfo,
} from '../docker/types.js';
import {
  getFrozenClientToolchainManifestPath,
  getFrozenProfileCeilingPath,
  getIronCurtainPackageRoot,
} from '../docker/docker-workload-paths.js';
import { computeHash, sha256HexSchema } from '../hash.js';
import { loadImmutableHostJson } from '../hardened-fs.js';
import {
  createPrivateDockerClient,
  createPrivateDockerWorkloadNetwork,
  preflightPrivateDockerClient,
  waitForPrivateDockerDaemonReady,
  PRIVATE_DOCKER_API_DIR,
  PRIVATE_DOCKER_HOST,
  type PrivateDockerBootstrapObservation,
  type PrivateDockerClient,
  type PrivateDockerDaemonReadiness,
  type PrivateDockerWorkloadNetwork,
} from './private-docker.js';
import {
  loadClientToolchainManifest,
  type ClientToolchainPreflight,
  type ClientToolchainManifest,
} from './client-toolchain.js';
import type { LedgeredOuterCreateAuthority } from './infrastructure.js';

export const DOCKER_DESKTOP_SIDECAR_API_ROOT = PRIVATE_DOCKER_API_DIR;
export const DOCKER_DESKTOP_SIDECAR_DOCKER_HOST = PRIVATE_DOCKER_HOST;
export const DOCKER_DESKTOP_SIDECAR_HOME_STATE_ROOT = '/home/rootless/.local/share/docker';
// Keep BuildKit's executor tree at the common path consumed by the existing
// build-trust runtime on both macOS backends.
export const DOCKER_DESKTOP_SIDECAR_DATA_ROOT = '/home/codespace/.local/share/docker';
export const DOCKER_DESKTOP_RUNC_SHIM_PATH = '/usr/local/lib/ironcurtain/runc';
export const DOCKER_DESKTOP_RUNC_VERSION_PREFIX = 'runc version 1.3.4';

const DAEMON_IMAGE_ROLE_LABEL = 'com.ironcurtain.docker-workload.image-role';
const DAEMON_IMAGE_ROLE = 'nested-daemon';
const ROOTLESS_USER = 'rootless';
const STOCK_RUNC_PATH = '/usr/local/bin/runc';
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
const ONLINE_TUN_DEVICE = {
  source: '/dev/net/tun',
  target: '/dev/net/tun',
  permissions: 'rwm',
} as const satisfies DockerTrustedDeviceMapping;
const TUN_DEVICE_SCOPE = 'docker-desktop-online-nested-daemon-sidecar-only';
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
        deviceAccess: z
          .object({
            additions: z.tuple([
              z
                .object({
                  source: z.literal(ONLINE_TUN_DEVICE.source),
                  target: z.literal(ONLINE_TUN_DEVICE.target),
                  permissions: z.literal(ONLINE_TUN_DEVICE.permissions),
                  scope: z.literal(TUN_DEVICE_SCOPE),
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
  'inspectImage' | 'create' | 'start' | 'exec' | 'stop' | 'remove'
> & {
  readonly inspectContainerRaw: NonNullable<ContainerRuntime['inspectContainerRaw']>;
  readonly createVolume: NonNullable<ContainerRuntime['createVolume']>;
  readonly inspectVolume: NonNullable<ContainerRuntime['inspectVolume']>;
  readonly removeVolume: NonNullable<ContainerRuntime['removeVolume']>;
};

export function requireDockerDesktopSidecarRuntime(runtime: ContainerRuntime): DockerDesktopSidecarRuntime {
  if (
    runtime.createVolume === undefined ||
    runtime.inspectVolume === undefined ||
    runtime.removeVolume === undefined ||
    runtime.inspectContainerRaw === undefined
  ) {
    throw new Error('Docker Desktop nested-Docker requires exact named-volume and raw container-inspect runtime APIs');
  }
  return runtime as DockerDesktopSidecarRuntime;
}

export type DockerDesktopSidecarCreateAuthority = LedgeredOuterCreateAuthority<
  'container' | 'volume',
  'nested-daemon' | 'daemon-api'
>;

export interface DockerDesktopSidecarResources {
  readonly memoryMb: number;
  readonly cpus: number;
  readonly pidsLimit: number;
}

interface DockerDesktopActivationHandle {
  readonly generation: string;
  recordDaemonReady(readiness: PrivateDockerDaemonReadiness): void;
  recordPrivateDockerBootstrap(observation: PrivateDockerBootstrapObservation): void;
}

export interface StartDockerDesktopSidecarOptions {
  readonly runtime: DockerDesktopSidecarRuntime;
  readonly sidecarImage: string;
  /** Immutable image ID that the outer agent create will consume directly. */
  readonly outerAgentImageId: string;
  readonly resources: DockerDesktopSidecarResources;
  /** Backend-specific exposure of the common host egress authorities. */
  readonly egress?: DockerDesktopSidecarEgress;
  readonly createOuterResource: DockerDesktopSidecarCreateAuthority;
  readonly activation: DockerDesktopActivationHandle;
  readonly readinessTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Test-only deterministic readiness clock. */
  readonly now?: () => number;
  /** Test-only deterministic readiness sleeper. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface DockerDesktopSidecarEgress {
  readonly networkName: string;
  readonly ipv4Address: string;
  readonly registryProxyUrl: string;
  readonly caMount: DockerMount;
  /** Package mode uses the shared build-trust runtime, which preserves no-new-keyring compatibility. */
  readonly buildTrustMounts?: readonly DockerMount[];
}

export interface DockerDesktopSidecarHandle {
  readonly containerId: string;
  readonly apiVolumeName: string;
  readonly dockerHost: typeof DOCKER_DESKTOP_SIDECAR_DOCKER_HOST;
  /** Exact read-only capability mounted into the agent container. */
  readonly agentApiMount: DockerNamedVolumeMount;
  readonly readiness: PrivateDockerDaemonReadiness;
  readonly preflight: ClientToolchainPreflight;
  readonly network: PrivateDockerWorkloadNetwork;
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
  if (!IMMUTABLE_ID.test(options.outerAgentImageId)) {
    throw new Error('Docker Desktop outer agent image ID is not immutable');
  }
  const profile = loadDockerDesktopP2SeccompProfile();
  const clientManifest = loadClientToolchainManifest(getFrozenClientToolchainManifestPath());
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
  let expectedSidecarConfig: DockerContainerConfig | undefined;
  const resourceSuffix = computeHash({ generation: options.activation.generation }).slice(0, 16);
  const requestedApiVolumeName = `ic-dw-daemon-api-${resourceSuffix}`;
  const requestedSidecarName = `ic-dw-nested-daemon-${resourceSuffix}`;
  try {
    const volume = await options.createOuterResource(
      { kind: 'volume', role: 'daemon-api', requestedName: requestedApiVolumeName },
      async (name, labels) => {
        const id = await options.runtime.createVolume(name, { labels });
        if (id !== name) throw new Error('Docker Desktop API volume returned an unexpected runtime identity');
        // Retain the exact runtime-confirmed identity before post-create
        // inspection/ledger observation so either failure can roll it back.
        apiVolumeName = name;
        const inspected = await options.runtime.inspectVolume(id);
        assertApiVolume(inspected, name, labels);
        return { id };
      },
    );
    if (apiVolumeName === undefined || volume.id !== apiVolumeName) {
      throw new Error('Docker Desktop API volume identity changed');
    }
    const ownedApiVolumeName = apiVolumeName;

    const sidecar = await options.createOuterResource(
      {
        kind: 'container',
        role: 'nested-daemon',
        requestedName: requestedSidecarName,
        launchesNestedDaemon: true,
        adjudicateObserved: async (id) => {
          if (expectedSidecarConfig === undefined) {
            throw new Error('Docker Desktop sidecar create did not retain its expected profile');
          }
          assertStoppedSidecarProfile(
            await options.runtime.inspectContainerRaw(id),
            id,
            expectedSidecarConfig,
            clientManifest.manifest,
            profile,
          );
        },
      },
      async (name, labels) => {
        const config = buildSidecarConfig({
          imageId: inspectedSidecarImage.id,
          name,
          labels,
          apiVolumeName: ownedApiVolumeName,
          egress: options.egress,
          profile,
          resources: options.resources,
        });
        const id = await options.runtime.create(config);
        if (!CONTAINER_ID.test(id)) throw new Error('Docker Desktop sidecar create returned an invalid container ID');
        // As with the volume, keep the immutable runtime identity before the
        // outer ledger records it so an observation failure cannot leak it.
        containerId = id;
        expectedSidecarConfig = config;
        return {
          id,
          expanded: {
            mounts: [
              ...(config.trustedCreateOptions?.namedVolumeMounts ?? []).map((mount) => ({
                source: mount.name,
                target: mount.target,
                readonly: mount.readonly ?? false,
              })),
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
      throw new Error('Docker Desktop sidecar identity changed');
    }
    await options.runtime.start(containerId);

    const client = createPrivateDockerClient({
      runtime: options.runtime,
      containerId,
      dockerCommand: 'docker',
      dockerHost: DOCKER_DESKTOP_SIDECAR_DOCKER_HOST,
      execUser: ROOTLESS_USER,
      defaultTimeoutMs: EXEC_TIMEOUT_MS,
    });
    const readiness = await waitForPrivateDockerDaemonReady(client, {
      timeoutMs: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs,
      now: options.now,
      sleep: options.sleep,
      label: 'Docker Desktop private daemon',
    });
    options.activation.recordDaemonReady(readiness);
    await preflightRuntimeShim(options.runtime, containerId);

    const preflight = await preflightPrivateDockerClient({
      client,
      manifest: clientManifest,
    });
    const network = await createPrivateDockerWorkloadNetwork(client);
    await runDockerDesktopActivationCanary({
      runtime: options.runtime,
      client,
      networkName: network.name,
      generation: options.activation.generation,
    });

    options.activation.recordPrivateDockerBootstrap({
      preflight,
      image: { transport: 'docker-desktop-direct', outerImageId: options.outerAgentImageId },
      network,
    });
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
      preflight,
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
  readonly egress?: DockerDesktopSidecarEgress;
  readonly profile: DockerDesktopP2SeccompProfile;
  readonly resources: DockerDesktopSidecarResources;
}): DockerContainerConfig {
  const egress = options.egress;
  return {
    image: options.imageId,
    name: options.name,
    mounts: egress === undefined ? [] : [egress.caMount, ...(egress.buildTrustMounts ?? [])],
    network: egress?.networkName ?? 'none',
    ...(egress === undefined ? {} : { ipv4Address: egress.ipv4Address }),
    env: {
      DOCKER_TLS_CERTDIR: '',
      DOCKERD_ROOTLESS_ROOTLESSKIT_NET: egress === undefined ? 'none' : 'slirp4netns',
      XDG_RUNTIME_DIR: DOCKER_DESKTOP_SIDECAR_API_ROOT,
      PATH: `${dirname(DOCKER_DESKTOP_RUNC_SHIM_PATH)}:${DEFAULT_PATH}`,
      ...(egress === undefined
        ? {}
        : {
            HTTP_PROXY: egress.registryProxyUrl,
            HTTPS_PROXY: egress.registryProxyUrl,
            http_proxy: egress.registryProxyUrl,
            https_proxy: egress.registryProxyUrl,
            SSL_CERT_FILE: egress.caMount.target,
          }),
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
          target: DOCKER_DESKTOP_SIDECAR_HOME_STATE_ROOT,
          readonly: false,
          // The API-root mount already initialized this same volume. Do not
          // copy stock daemon state into it again through the second target.
          noCopy: true,
        },
        {
          name: options.apiVolumeName,
          target: DOCKER_DESKTOP_SIDECAR_DATA_ROOT,
          readonly: false,
          noCopy: true,
        },
      ],
      ...(egress === undefined ? {} : { devices: [ONLINE_TUN_DEVICE] }),
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

function assertStoppedSidecarProfile(
  inspected: Readonly<Record<string, unknown>> | undefined,
  expectedId: string,
  config: DockerContainerConfig,
  manifest: ClientToolchainManifest,
  profile: DockerDesktopP2SeccompProfile,
): void {
  const mismatch = (field: string): never => {
    throw new Error(`Docker Desktop sidecar effective profile mismatch: ${field}`);
  };
  const effectiveInspect = inspected ?? mismatch('container disappeared before start');
  const state = recordField(effectiveInspect, 'State', mismatch);
  const effectiveConfig = recordField(effectiveInspect, 'Config', mismatch);
  const hostConfig = recordField(effectiveInspect, 'HostConfig', mismatch);
  const networkSettings = recordField(effectiveInspect, 'NetworkSettings', mismatch);

  if (effectiveInspect.Id !== expectedId) mismatch('immutable container ID');
  if (effectiveInspect.Name !== `/${config.name}`) mismatch('container name');
  if (effectiveInspect.Image !== config.image || effectiveConfig.Image !== config.image) mismatch('immutable image ID');
  if (state.Status !== 'created' || state.Running !== false) mismatch('container is not stopped in created state');
  if (effectiveConfig.User !== ROOTLESS_USER || effectiveConfig.WorkingDir !== '/home/rootless') {
    mismatch('image user or working directory');
  }
  assertExactValue(effectiveConfig.Entrypoint, ['dockerd-entrypoint.sh'], 'image entrypoint', mismatch);
  assertExactValue(effectiveConfig.Cmd, config.command, 'daemon command', mismatch);

  const expectedEnv = {
    HOME: '/home/rootless',
    DOCKER_VERSION: manifest.docker.cliVersion,
    DOCKER_BUILDX_VERSION: manifest.buildxVersion,
    DOCKER_COMPOSE_VERSION: manifest.composeVersion,
    ...config.env,
  };
  assertExactValue(parseEnvironment(effectiveConfig.Env, mismatch), expectedEnv, 'environment', mismatch);
  const labels = recordField(effectiveConfig, 'Labels', mismatch);
  if (labels[DAEMON_IMAGE_ROLE_LABEL] !== DAEMON_IMAGE_ROLE) mismatch('daemon image role label');
  for (const [key, value] of Object.entries(config.labels ?? {})) {
    if (labels[key] !== value) mismatch(`ownership label ${key}`);
  }

  if (hostConfig.NetworkMode !== config.network) mismatch('network mode');
  if (hostConfig.Privileged !== false) mismatch('privileged mode');
  if (hostConfig.ReadonlyRootfs !== true) mismatch('read-only root filesystem');
  if (hostConfig.Init !== true) mismatch('init process');
  assertCapabilitySet(hostConfig.CapDrop, ['ALL'], 'dropped capabilities', mismatch);
  assertCapabilitySet(hostConfig.CapAdd, config.capAdd ?? [], 'added capabilities', mismatch);
  if (hostConfig.Memory !== (config.resources?.memoryMb ?? 0) * 1024 * 1024) mismatch('memory limit');
  if (hostConfig.NanoCpus !== (config.resources?.cpus ?? 0) * 1_000_000_000) mismatch('CPU limit');
  if (hostConfig.PidsLimit !== config.trustedCreateOptions?.pidsLimit) mismatch('PID limit');
  const portBindings = hostConfig.PortBindings;
  if (portBindings !== null && (!isRecord(portBindings) || Object.keys(portBindings).length !== 0)) {
    mismatch('published ports');
  }
  const restartPolicy = recordField(hostConfig, 'RestartPolicy', mismatch);
  if (restartPolicy.Name !== 'no') mismatch('restart policy');

  const expectedBinds = config.mounts.map((mount) => `${mount.source}:${mount.target}${mount.readonly ? ':ro' : ''}`);
  assertStringSet(hostConfig.Binds, expectedBinds, 'bind mounts', mismatch);
  const expectedNamedMounts = (config.trustedCreateOptions?.namedVolumeMounts ?? []).map((mount) => ({
    Type: 'volume',
    Source: mount.name,
    Target: mount.target,
    ReadOnly: mount.readonly === true,
    NoCopy: mount.noCopy === true,
  }));
  const actualNamedMounts = arrayField(hostConfig.Mounts, 'named-volume mounts', mismatch).map((value) => {
    const mount = asRecord(value, 'named-volume mount', mismatch);
    const volumeOptions = isRecord(mount.VolumeOptions) ? mount.VolumeOptions : {};
    return {
      Type: mount.Type,
      Source: mount.Source,
      Target: mount.Target,
      ReadOnly: mount.ReadOnly === true,
      NoCopy: volumeOptions.NoCopy === true,
    };
  });
  assertExactValue(
    sortedObjects(actualNamedMounts),
    sortedObjects(expectedNamedMounts),
    'named-volume mounts',
    mismatch,
  );
  assertResolvedMounts(effectiveInspect.Mounts, config, mismatch);

  const expectedTmpfs = Object.fromEntries(
    (config.trustedCreateOptions?.tmpfs ?? []).map((specification) => {
      const separator = specification.indexOf(':');
      return [specification.slice(0, separator), normalizeCommaOptions(specification.slice(separator + 1))];
    }),
  );
  const actualTmpfs = Object.fromEntries(
    Object.entries(recordField(hostConfig, 'Tmpfs', mismatch)).map(([target, specification]) => [
      target,
      normalizeCommaOptions(typeof specification === 'string' ? specification : mismatch(`tmpfs ${target}`)),
    ]),
  );
  assertExactValue(actualTmpfs, expectedTmpfs, 'tmpfs mounts', mismatch);

  if (!Array.isArray(hostConfig.MaskedPaths) || hostConfig.MaskedPaths.length !== 0) mismatch('masked paths');
  if (!Array.isArray(hostConfig.ReadonlyPaths) || hostConfig.ReadonlyPaths.length !== 0) mismatch('read-only paths');
  const securityOptions = stringArray(hostConfig.SecurityOpt, 'security options', mismatch);
  if (securityOptions.length !== 1 || !securityOptions[0]?.startsWith('seccomp=')) mismatch('security options');
  let effectiveSeccomp: unknown;
  try {
    effectiveSeccomp = JSON.parse(securityOptions[0].slice('seccomp='.length)) as unknown;
  } catch {
    mismatch('seccomp profile');
  }
  const expectedSeccomp = loadImmutableHostJson(profile.path, {
    label: 'Docker Desktop P2 seccomp profile adjudication',
    schema: seccompProfileSchema,
    maxBytes: PROFILE_MAX_BYTES,
  }).value;
  assertExactValue(effectiveSeccomp, expectedSeccomp, 'seccomp profile', mismatch);

  const expectedDevices = (config.trustedCreateOptions?.devices ?? []).map((device) => ({
    PathOnHost: device.source,
    PathInContainer: device.target,
    CgroupPermissions: device.permissions,
  }));
  const actualDevices = arrayField(hostConfig.Devices, 'device mappings', mismatch).map((value) => {
    const device = asRecord(value, 'device mapping', mismatch);
    return {
      PathOnHost: device.PathOnHost,
      PathInContainer: device.PathInContainer,
      CgroupPermissions: device.CgroupPermissions,
    };
  });
  assertExactValue(actualDevices, expectedDevices, 'device mappings', mismatch);

  const expectedExtraHosts = config.network === 'none' ? [] : ['host.docker.internal:host-gateway'];
  assertStringSet(hostConfig.ExtraHosts, expectedExtraHosts, 'extra hosts', mismatch);
  const networks = recordField(networkSettings, 'Networks', mismatch);
  if (Object.keys(networks).length !== 1) mismatch('attached networks');
  const endpoint = asRecord(networks[config.network], 'attached networks', mismatch);
  if (config.ipv4Address === undefined) {
    const ipam = isRecord(endpoint.IPAMConfig) ? endpoint.IPAMConfig : undefined;
    if (ipam !== undefined && ipam.IPv4Address !== '' && ipam.IPv4Address !== undefined) mismatch('static IPv4');
  } else {
    const ipam = asRecord(endpoint.IPAMConfig, 'network IPAM', mismatch);
    if (ipam.IPv4Address !== config.ipv4Address) mismatch('static IPv4');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(
  value: unknown,
  field: string,
  mismatch: (field: string) => never,
): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : mismatch(field);
}

function recordField(
  record: Readonly<Record<string, unknown>>,
  field: string,
  mismatch: (field: string) => never,
): Readonly<Record<string, unknown>> {
  return asRecord(record[field], field, mismatch);
}

function arrayField(value: unknown, field: string, mismatch: (field: string) => never): readonly unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : mismatch(field);
}

function stringArray(value: unknown, field: string, mismatch: (field: string) => never): readonly string[] {
  const values = arrayField(value, field, mismatch);
  return values.every((entry): entry is string => typeof entry === 'string') ? values : mismatch(field);
}

function assertExactValue(actual: unknown, expected: unknown, field: string, mismatch: (field: string) => never): void {
  if (computeHash(actual) !== computeHash(expected)) mismatch(field);
}

function assertStringSet(
  actual: unknown,
  expected: readonly string[],
  field: string,
  mismatch: (field: string) => never,
): void {
  assertExactValue([...stringArray(actual, field, mismatch)].sort(), [...expected].sort(), field, mismatch);
}

function assertCapabilitySet(
  actual: unknown,
  expected: readonly string[],
  field: string,
  mismatch: (field: string) => never,
): void {
  const normalize = (capability: string): string => capability.replace(/^CAP_/u, '');
  assertExactValue(
    stringArray(actual, field, mismatch).map(normalize).sort(),
    expected.map(normalize).sort(),
    field,
    mismatch,
  );
}

function parseEnvironment(value: unknown, mismatch: (field: string) => never): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of stringArray(value, 'environment', mismatch)) {
    const separator = entry.indexOf('=');
    if (separator <= 0) mismatch('environment');
    const key = entry.slice(0, separator);
    if (key in result) mismatch(`duplicate environment variable ${key}`);
    result[key] = entry.slice(separator + 1);
  }
  return result;
}

function normalizeCommaOptions(value: string): string {
  return value.split(',').sort().join(',');
}

function sortedObjects<T>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1));
}

function assertResolvedMounts(value: unknown, config: DockerContainerConfig, mismatch: (field: string) => never): void {
  const actual = arrayField(value, 'resolved mounts', mismatch).map((entry) => {
    const mount = asRecord(entry, 'resolved mount', mismatch);
    return mount.Type === 'volume'
      ? { type: mount.Type, source: mount.Name, target: mount.Destination, readonly: mount.RW === false }
      : { type: mount.Type, source: mount.Source, target: mount.Destination, readonly: mount.RW === false };
  });
  const expected = [
    ...config.mounts.map((mount) => ({
      type: 'bind',
      source: mount.source,
      target: mount.target,
      readonly: mount.readonly,
    })),
    ...(config.trustedCreateOptions?.namedVolumeMounts ?? []).map((mount) => ({
      type: 'volume',
      source: mount.name,
      target: mount.target,
      readonly: mount.readonly === true,
    })),
  ];
  assertExactValue(sortedObjects(actual), sortedObjects(expected), 'resolved mounts', mismatch);
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
  readonly client: PrivateDockerClient;
  readonly networkName: string;
  readonly generation: string;
}

/** Prove both ordinary inner OCI start and an integrated BuildKit RUN before activation. */
async function runDockerDesktopActivationCanary(options: ActivationCanaryOptions): Promise<void> {
  const suffix = computeHash({ containerId: options.client.containerId, generation: options.generation }).slice(0, 16);
  const runName = `ironcurtain-desktop-run-${suffix}`;
  const outputTag = `ironcurtain-desktop-build:${suffix}`;
  const contextRoot = `/tmp/ironcurtain-desktop-build-${suffix}`;
  const contextRuncPath = `${contextRoot}/runc`;
  const dockerfilePath = `${contextRoot}/Dockerfile`;
  const execDocker = (args: readonly string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<DockerExecResult> =>
    options.client.execute(args, timeoutMs);

  let failure: unknown;
  let outputImageId: string | undefined;
  try {
    if ((await inspectImage(execDocker, outputTag)) !== undefined) {
      throw new Error('Docker Desktop activation canary reserved image tag already exists');
    }
    if ((await inspectContainer(execDocker, runName)) !== undefined) {
      throw new Error('Docker Desktop activation canary reserved container already exists');
    }
    const prepare = await options.runtime.exec(
      options.client.containerId,
      [
        '/bin/sh',
        '-c',
        'set -eu; umask 077; root=$1; source=$2; target=$3; dockerfile=$4; dockerfile_path=$5; ' +
          'mkdir -p "$root/lib"; /bin/cp "$source" "$target"; /bin/chmod 0555 "$target"; ' +
          'set -- /lib/ld-musl-*.so.1; [ "$#" -eq 1 ] && [ -f "$1" ]; /bin/cp "$1" "$root/lib/"; ' +
          'printf "%s" "$dockerfile" > "$dockerfile_path"',
        'ironcurtain-desktop-build-canary',
        contextRoot,
        STOCK_RUNC_PATH,
        contextRuncPath,
        'FROM scratch\nCOPY lib/ /lib/\nCOPY --chmod=0555 runc /runc\nRUN ["/runc","--version"]\nENTRYPOINT ["/runc"]\nCMD ["--version"]\n',
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
    if (outputImageId === undefined)
      throw new Error('Docker Desktop BuildKit canary did not create an immutable image');

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
      outputImageId,
    ]);
    assertDockerSuccess(run, 'ordinary inner-container activation canary');
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
    assertDockerSuccess(await execDocker(['image', 'rm', '--force', current]), 'activation output image cleanup');
  });
  await cleanup('Docker Desktop activation context cleanup failed', async () => {
    const removed = await options.runtime.exec(
      options.client.containerId,
      ['/bin/rm', '-rf', contextRoot],
      EXEC_TIMEOUT_MS,
      ROOTLESS_USER,
    );
    assertDockerSuccess(removed, 'activation context cleanup');
  });
  await cleanup('Docker Desktop activation residue check failed', async () => {
    const [runResidue, outputResidue] = await Promise.all([
      inspectContainer(execDocker, runName),
      inspectImage(execDocker, outputTag),
    ]);
    if (runResidue !== undefined || outputResidue !== undefined) {
      throw new Error('Docker Desktop activation canary left container or image residue');
    }
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
