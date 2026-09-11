import { nestedDaemonSeccompProfile } from '../../src/docker-workload/nested-daemon-profile.js';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOCKER_DESKTOP_RUNC_SHIM_PATH,
  DOCKER_DESKTOP_SIDECAR_API_ROOT,
  DOCKER_DESKTOP_SIDECAR_PRIVATE_API_ROOT,
  DOCKER_DESKTOP_SIDECAR_ENTRYPOINT,
  DOCKER_DESKTOP_SIDECAR_DATA_ROOT,
  DOCKER_DESKTOP_SIDECAR_DOCKER_HOST,
  DOCKER_DESKTOP_SIDECAR_HOME_STATE_ROOT,
  loadDockerDesktopP2SeccompProfile,
  startDockerDesktopSidecar,
  type DockerDesktopSidecarCreateAuthority,
  type DockerDesktopSidecarEgress,
  type DockerDesktopSidecarRuntime,
  type StartDockerDesktopSidecarOptions,
} from '../../src/docker-workload/docker-desktop-sidecar.js';
import type {
  DockerContainerConfig,
  DockerExecResult,
  DockerImageInfo,
  DockerVolumeInfo,
} from '../../src/docker/types.js';
import { computeHash } from '../../src/hash.js';
import type { ExpandedOuterCreate } from '../../src/docker-workload/lifecycle-evidence.js';
import { loadClientToolchainManifest } from '../../src/docker-workload/client-toolchain.js';
import { getFrozenClientToolchainManifestPath } from '../../src/docker/docker-workload-paths.js';
import {
  DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY,
  DOCKER_BUILD_TRUST_WRAPPER_PATH,
} from '../../src/docker/docker-build-shim.js';
import type { PrivateDockerBootstrapObservation } from '../../src/docker-workload/private-docker.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function hostDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sidecar-config-')));
  temporaryDirectories.push(directory);
  return directory;
}

const SIDECAR_IMAGE_ID = `sha256:${'d'.repeat(64)}`;
const SIDECAR_CONTAINER_ID = 'c'.repeat(64);
const DESKTOP_GENERATION = 'gen-desktop-test';
const RESOURCE_SUFFIX = computeHash({ generation: DESKTOP_GENERATION }).slice(0, 16);
const API_VOLUME_NAME = `ic-dw-daemon-api-${RESOURCE_SUFFIX}`;
const SIDECAR_NAME = `ic-dw-nested-daemon-${RESOURCE_SUFFIX}`;
const OWNERSHIP_LABELS = { 'com.ironcurtain.docker-workload.generation': 'gen-test' } as const;
const OUTER_AGENT_IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const WORKSPACE_ROOT = '/host/project';
const WORKSPACE_MOUNT = { source: WORKSPACE_ROOT, target: '/workspace', readonly: false } as const;
const CANARY_IMAGE_ID = `sha256:${'e'.repeat(64)}`;
const INNER_NETWORK_ID = 'f'.repeat(64);
const LOADED_CLIENT_MANIFEST = loadClientToolchainManifest(getFrozenClientToolchainManifestPath(), 'arm64');
const CLIENT_MANIFEST = LOADED_CLIENT_MANIFEST.manifest;
const REGISTRY_PROXY_URL = 'http://172.31.44.2:8443';
const CA_MOUNT = {
  source: '/host/ironcurtain/ca-bundle.pem',
  target: '/opt/ironcurtain/ca-bundle.pem',
  readonly: true,
} as const;
const BUILD_TRUST_MOUNTS = [
  {
    source: '/host/ironcurtain/build-trust',
    target: DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY,
    readonly: true,
  },
] as const;

function egressOptions(buildTrustMounts?: DockerDesktopSidecarEgress['buildTrustMounts']): DockerDesktopSidecarEgress {
  return {
    networkName: 'ic-dw-egress-test',
    ipv4Address: '172.31.44.10',
    registryProxyUrl: REGISTRY_PROXY_URL,
    caMount: CA_MOUNT,
    ...(buildTrustMounts === undefined ? {} : { buildTrustMounts }),
  };
}

function respondHealthyPrivateDocker(operation: readonly string[]): DockerExecResult {
  if (operation.includes('info')) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        Driver: 'vfs',
        SecurityOptions: ['name=rootless'],
        ServerVersion: CLIENT_MANIFEST.docker.daemonVersion,
      }),
      stderr: '',
    };
  }
  if (operation.includes('version') && operation.includes('{{json .}}')) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        Client: {
          Version: CLIENT_MANIFEST.docker.cliVersion,
          ApiVersion: CLIENT_MANIFEST.docker.clientApiVersion,
          Os: 'linux',
          Arch: CLIENT_MANIFEST.architecture,
        },
        Server: {
          Version: CLIENT_MANIFEST.docker.daemonVersion,
          ApiVersion: CLIENT_MANIFEST.docker.daemonApiVersion,
          MinAPIVersion: CLIENT_MANIFEST.docker.minimumDaemonApiVersion,
          Os: 'linux',
          Arch: CLIENT_MANIFEST.architecture,
        },
      }),
      stderr: '',
    };
  }
  if (operation.includes('buildx')) {
    return { exitCode: 0, stdout: `github.com/docker/buildx v${CLIENT_MANIFEST.buildxVersion}\n`, stderr: '' };
  }
  if (operation.includes('compose')) {
    return { exitCode: 0, stdout: `${CLIENT_MANIFEST.composeVersion}\n`, stderr: '' };
  }
  if (operation.includes('network') && operation.includes('create')) {
    return { exitCode: 0, stdout: `${INNER_NETWORK_ID}\n`, stderr: '' };
  }
  if (operation.includes('network') && operation.includes('inspect')) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        Id: INNER_NETWORK_ID,
        Name: 'ironcurtain',
        Driver: 'bridge',
        Scope: 'local',
        Internal: true,
        Labels: { 'com.ironcurtain.managed-workload': 'true' },
        Containers: {},
      }),
      stderr: '',
    };
  }
  return { exitCode: 0, stdout: '', stderr: '' };
}

interface RuntimeFixture {
  readonly runtime: DockerDesktopSidecarRuntime;
  readonly events: string[];
  readonly configs: DockerContainerConfig[];
  readonly execs: (readonly string[])[];
  readonly execUsers: (string | null | undefined)[];
  readonly volumeLabels: Map<string, Readonly<Record<string, string>>>;
  readonly expandedCreates: ExpandedOuterCreate[];
  readonly bootstrapObservations: PrivateDockerBootstrapObservation[];
}

function runtimeFixture(
  options: {
    readonly failBuild?: boolean;
    readonly failShim?: boolean;
    readonly wrongApiOwner?: boolean;
    readonly wrongVolumeLabels?: boolean;
    readonly observedWorkspaceBind?: string;
    readonly observedHostConfig?: Readonly<Record<string, unknown>>;
    readonly observedNetworks?: Readonly<Record<string, unknown>>;
    readonly observedDevices?: readonly {
      readonly PathOnHost: string;
      readonly PathInContainer: string;
      readonly CgroupPermissions: string;
    }[];
  } = {},
): RuntimeFixture {
  const events: string[] = [];
  const configs: DockerContainerConfig[] = [];
  const execs: (readonly string[])[] = [];
  const execUsers: (string | null | undefined)[] = [];
  const volumeLabels = new Map<string, Readonly<Record<string, string>>>();
  const expandedCreates: ExpandedOuterCreate[] = [];
  const bootstrapObservations: PrivateDockerBootstrapObservation[] = [];
  let canaryImageId: string | undefined;
  const runtime: DockerDesktopSidecarRuntime = {
    async inspectImage(reference): Promise<DockerImageInfo | undefined> {
      events.push(`outer-image-inspect:${reference}`);
      return {
        id: SIDECAR_IMAGE_ID,
        repoTags: [reference],
        labels: { 'com.ironcurtain.docker-workload.image-role': 'nested-daemon' },
        created: '2026-08-25T00:00:00.000Z',
      };
    },
    async create(config) {
      events.push('container:create');
      configs.push(config);
      return SIDECAR_CONTAINER_ID;
    },
    async inspectContainerRaw(id) {
      events.push(`container:inspect:${id}`);
      const config = configs.at(-1);
      if (config === undefined) return undefined;
      const trusted = config.trustedCreateOptions;
      const namedMounts = trusted?.namedVolumeMounts ?? [];
      const tmpfs = Object.fromEntries(
        (trusted?.tmpfs ?? []).map((specification) => {
          const separator = specification.indexOf(':');
          return [specification.slice(0, separator), specification.slice(separator + 1)];
        }),
      );
      return {
        Id: id,
        Name: `/${config.name}`,
        Image: config.image,
        State: { Status: 'created', Running: false },
        Config: {
          Image: config.image,
          User: '0:0',
          WorkingDir: '/home/rootless',
          Entrypoint: [DOCKER_DESKTOP_SIDECAR_ENTRYPOINT],
          Cmd: config.command,
          Env: [
            'HOME=/home/rootless',
            `DOCKER_VERSION=${CLIENT_MANIFEST.docker.cliVersion}`,
            `DOCKER_BUILDX_VERSION=${CLIENT_MANIFEST.buildxVersion}`,
            `DOCKER_COMPOSE_VERSION=${CLIENT_MANIFEST.composeVersion}`,
            ...Object.entries(config.env).map(([key, value]) => `${key}=${value}`),
          ],
          Labels: {
            'com.ironcurtain.docker-workload.image-role': 'nested-daemon',
            ...config.labels,
          },
        },
        HostConfig: {
          NetworkMode: config.network,
          Privileged: false,
          ReadonlyRootfs: trusted?.readOnlyRootfs === true,
          Init: true,
          PidMode: '',
          IpcMode: 'private',
          UTSMode: '',
          UsernsMode: '',
          CgroupnsMode: 'private',
          CapDrop: ['CAP_ALL'],
          CapAdd: (config.capAdd ?? []).map((capability) => `CAP_${capability}`),
          Memory: (config.resources?.memoryMb ?? 0) * 1024 * 1024,
          NanoCpus: (config.resources?.cpus ?? 0) * 1_000_000_000,
          PidsLimit: trusted?.pidsLimit,
          PortBindings: {},
          RestartPolicy: { Name: 'no' },
          Binds: config.mounts.map((mount) =>
            mount.target === WORKSPACE_MOUNT.target && options.observedWorkspaceBind !== undefined
              ? options.observedWorkspaceBind
              : `${mount.source}:${mount.target}${mount.readonly ? ':ro' : ''}`,
          ),
          Mounts: namedMounts.map((mount) => ({
            Type: 'volume',
            Source: mount.name,
            Target: mount.target,
            ReadOnly: mount.readonly === true,
            VolumeOptions: { NoCopy: mount.noCopy === true },
          })),
          Tmpfs: tmpfs,
          MaskedPaths: [],
          ReadonlyPaths: [],
          SecurityOpt: [`seccomp=${readFileSync(trusted?.seccompProfile ?? '', 'utf8')}`],
          Devices:
            options.observedDevices ??
            (trusted?.devices ?? []).map((device) => ({
              PathOnHost: device.source,
              PathInContainer: device.target,
              CgroupPermissions: device.permissions,
            })),
          ExtraHosts: config.extraHosts ?? null,
          ...options.observedHostConfig,
        },
        NetworkSettings: {
          Networks:
            options.observedNetworks ??
            ({
              [config.network]: {
                IPAMConfig: config.ipv4Address === undefined ? null : { IPv4Address: config.ipv4Address },
              },
            } as const),
        },
        Mounts: [
          ...config.mounts.map((mount) => ({
            Type: 'bind',
            Source: mount.source,
            Destination: mount.target,
            RW: !mount.readonly,
          })),
          ...namedMounts.map((mount) => ({
            Type: 'volume',
            Name: mount.name,
            Destination: mount.target,
            RW: mount.readonly !== true,
          })),
        ],
      };
    },
    async start(id) {
      events.push(`container:start:${id}`);
    },
    async exec(_id, argv, _timeout, execUser): Promise<DockerExecResult> {
      execs.push([...argv]);
      execUsers.push(execUser);
      if (argv[0] === 'stat')
        return { exitCode: 0, stdout: `0:0:755\n${options.wrongApiOwner ? '1000:1000' : execUser}:710\n`, stderr: '' };
      if (argv[0] === '/bin/sh' && argv[1] === '-c' && argv[2] === 'command -v runc') {
        events.push('shim:path');
        return {
          exitCode: 0,
          stdout: `${options.failShim === true ? '/usr/local/bin/runc' : configs[0].env.PATH.split(':')[0] + '/runc'}\n`,
          stderr: '',
        };
      }
      if (
        [DOCKER_DESKTOP_RUNC_SHIM_PATH, DOCKER_BUILD_TRUST_WRAPPER_PATH].includes(argv[0]) &&
        argv[1] === '--version'
      ) {
        events.push('shim:version');
        return { exitCode: 0, stdout: 'runc version 1.3.4\ncommit: d6d73eb\n', stderr: '' };
      }
      if (
        argv[0] === '/usr/local/bin/docker' &&
        argv[1] === '--host' &&
        argv[2] === DOCKER_DESKTOP_SIDECAR_DOCKER_HOST
      ) {
        const operation = argv.slice(3);
        if (operation[0] === 'container' && operation[1] === 'inspect') {
          return { exitCode: 1, stdout: '', stderr: `Error: No such container: ${operation.at(-1) ?? ''}` };
        }
        if (operation[0] === 'image' && operation[1] === 'inspect') {
          const reference = operation.at(-1);
          const exists =
            canaryImageId !== undefined &&
            (reference === canaryImageId || reference?.startsWith('ironcurtain-desktop-build:') === true);
          return exists
            ? { exitCode: 0, stdout: `${canaryImageId}\n`, stderr: '' }
            : { exitCode: 1, stdout: '', stderr: `Error: No such image: ${reference ?? ''}` };
        }
        if (operation[0] === 'image' && operation[1] === 'rm') {
          canaryImageId = undefined;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (operation[0] === 'run') events.push('canary:run');
        if (operation[0] === 'build') {
          events.push('canary:build');
          if (options.failBuild === true) {
            return { exitCode: 1, stdout: '', stderr: 'runc create failed: keyring denied' };
          }
          canaryImageId = CANARY_IMAGE_ID;
        }
        return respondHealthyPrivateDocker(operation);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async stop(id) {
      events.push(`container:stop:${id}`);
    },
    async remove(id) {
      events.push(`container:remove:${id}`);
    },
    async createVolume(name, createOptions) {
      events.push(`volume:create:${name}`);
      volumeLabels.set(name, createOptions?.labels ?? {});
      return name;
    },
    async inspectVolume(name): Promise<DockerVolumeInfo | undefined> {
      events.push(`volume:inspect:${name}`);
      const labels = volumeLabels.get(name);
      return labels === undefined
        ? undefined
        : {
            id: name,
            name,
            created: '2026-08-25T00:00:00.000Z',
            labels: options.wrongVolumeLabels === true ? { unexpected: 'owner' } : labels,
            driver: 'local',
            mountpoint: `/var/lib/docker/volumes/${name}/_data`,
          };
    },
    async removeVolume(name) {
      events.push(`volume:remove:${name}`);
      volumeLabels.delete(name);
    },
  };
  return { runtime, events, configs, execs, execUsers, volumeLabels, expandedCreates, bootstrapObservations };
}

function resourceAuthority(
  events: string[],
  expandedCreates: ExpandedOuterCreate[],
): DockerDesktopSidecarCreateAuthority {
  return async (spec, create) => {
    events.push(`ledger:${spec.kind}:${spec.role}:${spec.launchesNestedDaemon === true}`);
    const requestedName = spec.requestedName;
    const created = await create(requestedName, OWNERSHIP_LABELS);
    if (created.expanded !== undefined) expandedCreates.push(created.expanded);
    events.push(`observed:${spec.kind}:${created.id}`);
    await spec.adjudicateObserved?.(created.id);
    return { id: created.id };
  };
}

function startOptions(fixture: RuntimeFixture): StartDockerDesktopSidecarOptions {
  const events = fixture.events;
  return {
    runtime: fixture.runtime,
    sidecarImage: 'ironcurtain-nested-daemon:latest',
    outerAgentImageId: OUTER_AGENT_IMAGE_ID,
    workspaceRoot: WORKSPACE_ROOT,
    identity: { uid: 1000, gid: 1000 },
    hostConfigDirectory: hostDirectory(),
    clientManifest: LOADED_CLIENT_MANIFEST,
    resources: { memoryMb: 4096, cpus: 2, pidsLimit: 512 },
    createOuterResource: resourceAuthority(events, fixture.expandedCreates),
    activation: {
      generation: DESKTOP_GENERATION,
      recordDaemonReady() {
        events.push('record:daemon-ready');
      },
      recordPrivateDockerBootstrap(observation) {
        fixture.bootstrapObservations.push(observation);
        events.push('record:private-docker');
      },
    },
  };
}

async function expectStoppedProfileRejection(fixture: RuntimeFixture, field: string): Promise<void> {
  await expect(startDockerDesktopSidecar(startOptions(fixture))).rejects.toThrow(
    `Docker Desktop sidecar effective profile mismatch: ${field}`,
  );
  expect(fixture.events).not.toContain(`container:start:${SIDECAR_CONTAINER_ID}`);
  expect(fixture.events.slice(-3)).toEqual([
    `container:stop:${SIDECAR_CONTAINER_ID}`,
    `container:remove:${SIDECAR_CONTAINER_ID}`,
    `volume:remove:${API_VOLUME_NAME}`,
  ]);
}

describe('Docker Desktop sidecar frozen artifacts', () => {
  it('renders the complete P2 profile with the measured sethostname rule and no keyctl allowance', () => {
    const profile = loadDockerDesktopP2SeccompProfile(hostDirectory());
    const bytes = readFileSync(profile.path);
    const parsed = JSON.parse(bytes.toString('utf8')) as {
      readonly syscalls: readonly { readonly names: readonly string[]; readonly action: string }[];
    };

    expect(parsed).toEqual(profile.definition);
    expect(profile.systemPathsSecurityOption).toBe('systempaths=unconfined');
    expect(profile.path).toMatch(/seccomp\.json$/u);
    expect(parsed.syscalls).toContainEqual(
      expect.objectContaining({ names: ['sethostname'], action: 'SCMP_ACT_ALLOW' }),
    );
    expect(parsed.syscalls).not.toContainEqual(
      expect.objectContaining({ names: ['keyctl'], action: 'SCMP_ACT_ALLOW' }),
    );
  });
});

describe('Docker Desktop sidecar lifecycle', () => {
  it.each(['syscall', 'argument', 'architecture', 'capability', 'default-action'])(
    'rejects a changed %s even when the old canary rules are retained',
    async (change) => {
      const profile = JSON.parse(JSON.stringify(nestedDaemonSeccompProfile())) as {
        defaultAction: string;
        archMap: { subArchitectures: string[] | null }[];
        syscalls: { names: string[]; action: string; args?: { value: number }[]; includes?: { caps?: string[] } }[];
      };
      if (change === 'syscall') profile.syscalls.push({ names: ['bpf'], action: 'SCMP_ACT_ALLOW' });
      if (change === 'argument') profile.syscalls.find((rule) => rule.args !== undefined)!.args![0].value += 1;
      if (change === 'architecture') profile.archMap[0].subArchitectures!.push('SCMP_ARCH_AARCH64');
      if (change === 'capability') delete profile.syscalls.find((rule) => rule.includes?.caps !== undefined)!.includes;
      if (change === 'default-action') profile.defaultAction = 'SCMP_ACT_ALLOW';
      const fixture = runtimeFixture({ observedHostConfig: { SecurityOpt: [`seccomp=${JSON.stringify(profile)}`] } });
      await expectStoppedProfileRejection(fixture, 'seccomp profile');
    },
  );
  it.each(['workspace', '/'])(
    'rejects a non-canonical workspace source %s before provisioning',
    async (workspaceRoot) => {
      const fixture = runtimeFixture();

      await expect(startDockerDesktopSidecar({ ...startOptions(fixture), workspaceRoot })).rejects.toThrow(
        /workspace source must be a canonical absolute directory below root/u,
      );
      expect(fixture.events).toEqual([]);
    },
  );

  it('keeps the offline sidecar on network none with RootlessKit networking disabled', async () => {
    const fixture = runtimeFixture();
    const options = startOptions(fixture);
    const result = await startDockerDesktopSidecar(options);

    expect(result).toMatchObject({
      containerId: SIDECAR_CONTAINER_ID,
      apiVolumeName: API_VOLUME_NAME,
      dockerHost: DOCKER_DESKTOP_SIDECAR_DOCKER_HOST,
      agentApiMount: {
        name: API_VOLUME_NAME,
        target: DOCKER_DESKTOP_SIDECAR_API_ROOT,
        readonly: true,
        noCopy: true,
      },
      readiness: { driver: 'vfs', serverVersion: '29.2.1' },
      network: { name: 'ironcurtain' },
    });
    expect(fixture.bootstrapObservations).toEqual([
      expect.objectContaining({
        image: { transport: 'docker-desktop-direct', outerImageId: OUTER_AGENT_IMAGE_ID },
        network: { name: 'ironcurtain', id: INNER_NETWORK_ID },
      }),
    ]);
    expect(fixture.configs).toHaveLength(1);
    const config = fixture.configs[0];
    expect(config).toMatchObject({
      image: SIDECAR_IMAGE_ID,
      name: SIDECAR_NAME,
      network: 'none',
      capAdd: ['SETUID', 'SETGID'],
      resources: { memoryMb: 4096, cpus: 2 },
      trustedCreateOptions: {
        namedVolumeMounts: [
          { name: API_VOLUME_NAME, target: DOCKER_DESKTOP_SIDECAR_API_ROOT, readonly: false, noCopy: false },
          {
            name: API_VOLUME_NAME,
            target: dirname(DOCKER_DESKTOP_SIDECAR_HOME_STATE_ROOT),
            readonly: false,
            noCopy: true,
          },
          { name: API_VOLUME_NAME, target: dirname(DOCKER_DESKTOP_SIDECAR_DATA_ROOT), readonly: false, noCopy: true },
        ],
        readOnlyRootfs: true,
        securityOptions: ['systempaths=unconfined'],
        pidsLimit: 512,
      },
    });
    expect(config.trustedCreateOptions?.seccompProfile).toBe(result.seccompProfile.path);
    expect(config.trustedCreateOptions?.tmpfs).toEqual([
      '/run:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000',
      '/tmp:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000',
      '/home/rootless/.docker:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000',
    ]);
    expect(config.mounts).toEqual([
      WORKSPACE_MOUNT,
      ...['passwd', 'group', 'subuid', 'subgid'].map((name) => ({
        source: join(options.hostConfigDirectory, name),
        target: `/etc/${name}`,
        readonly: true,
      })),
    ]);
    expect(fixture.expandedCreates).toHaveLength(1);
    expect(fixture.expandedCreates[0]?.mounts).toEqual([
      { source: API_VOLUME_NAME, target: DOCKER_DESKTOP_SIDECAR_API_ROOT, readonly: false },
      { source: API_VOLUME_NAME, target: dirname(DOCKER_DESKTOP_SIDECAR_HOME_STATE_ROOT), readonly: false },
      { source: API_VOLUME_NAME, target: dirname(DOCKER_DESKTOP_SIDECAR_DATA_ROOT), readonly: false },
      ...config.mounts,
    ]);
    expect(config.env).toEqual({
      DOCKER_TLS_CERTDIR: '',
      DOCKERD_ROOTLESS_ROOTLESSKIT_NET: 'none',
      XDG_RUNTIME_DIR: DOCKER_DESKTOP_SIDECAR_PRIVATE_API_ROOT,
      PATH: '/usr/local/lib/ironcurtain:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    });
    expect(config.command).toEqual([
      'dockerd',
      `--add-runtime=ic-no-new-keyring=${DOCKER_DESKTOP_RUNC_SHIM_PATH}`,
      '--default-runtime=ic-no-new-keyring',
      `--host=${DOCKER_DESKTOP_SIDECAR_DOCKER_HOST}`,
      '--storage-driver=vfs',
      `--data-root=${DOCKER_DESKTOP_SIDECAR_DATA_ROOT}`,
      `--exec-root=${DOCKER_DESKTOP_SIDECAR_PRIVATE_API_ROOT}/exec`,
      `--pidfile=${DOCKER_DESKTOP_SIDECAR_PRIVATE_API_ROOT}/docker.pid`,
      '--iptables=false',
      '--bridge=none',
      '--ip-forward=false',
      '--ip-masq=false',
    ]);
    expect(config.ports).toBeUndefined();
    expect(config.extraHosts).toEqual([]);
    expect(config.ipv4Address).toBeUndefined();
    expect(config.trustedCreateOptions?.devices).toBeUndefined();

    const build = fixture.events.indexOf('canary:build');
    const privateEvidence = fixture.events.indexOf('record:private-docker');
    expect(build).toBeGreaterThan(fixture.events.indexOf('record:daemon-ready'));
    expect(fixture.events.indexOf('canary:run')).toBeGreaterThan(build);
    expect(privateEvidence).toBeGreaterThan(fixture.events.indexOf('canary:run'));
    expect(fixture.events).not.toContain(`container:stop:${SIDECAR_CONTAINER_ID}`);
    expect(fixture.events.slice(0, 10)).toEqual([
      'outer-image-inspect:ironcurtain-nested-daemon:latest',
      'ledger:volume:daemon-api:false',
      `volume:create:${API_VOLUME_NAME}`,
      `volume:inspect:${API_VOLUME_NAME}`,
      `observed:volume:${API_VOLUME_NAME}`,
      'ledger:container:nested-daemon:true',
      'container:create',
      `observed:container:${SIDECAR_CONTAINER_ID}`,
      `container:inspect:${SIDECAR_CONTAINER_ID}`,
      `container:start:${SIDECAR_CONTAINER_ID}`,
    ]);
    expect(fixture.execs).toContainEqual(['/bin/sh', '-c', 'command -v runc']);
    expect(fixture.execs).toContainEqual([DOCKER_DESKTOP_RUNC_SHIM_PATH, '--version']);
    expect(
      fixture.execs.some((argv) =>
        argv.includes(
          'FROM scratch\nCOPY lib/ /lib/\nCOPY --chmod=0555 runc /runc\nRUN ["/runc","--version"]\nENTRYPOINT ["/runc"]\nCMD ["--version"]\n',
        ),
      ),
    ).toBe(true);
    expect(fixture.execs.some((argv) => argv.some((arg) => arg.includes('selected-agent')))).toBe(false);
    expect(fixture.execs.some((argv) => argv.includes('load') || argv.includes('save') || argv.includes('pull'))).toBe(
      false,
    );
  });

  it('uses the configured numeric identity for every daemon exec and matching writable tmpfs', async () => {
    const fixture = runtimeFixture();
    const handle = await startDockerDesktopSidecar({ ...startOptions(fixture), identity: { uid: 1101, gid: 1102 } });
    expect(handle.execUser).toBe('1101:1102');
    expect(new Set(fixture.execUsers)).toEqual(new Set(['1101:1102']));
    expect(fixture.configs[0].trustedCreateOptions?.tmpfs?.every((spec) => spec.endsWith('uid=1101,gid=1102'))).toBe(
      true,
    );
    expect(fixture.configs[0].capAdd).toEqual(['SETUID', 'SETGID']);
  });

  it('rejects an API child left with the image UID rather than the configured host identity', async () => {
    const fixture = runtimeFixture({ wrongApiOwner: true });
    await expect(
      startDockerDesktopSidecar({ ...startOptions(fixture), identity: { uid: 1101, gid: 1102 } }),
    ).rejects.toThrow(/ownership differs/);
    expect(fixture.events).toContain(`container:remove:${SIDECAR_CONTAINER_ID}`);
    expect(fixture.events).toContain(`volume:remove:${API_VOLUME_NAME}`);
  });

  it('attaches image mode to the isolated relay network with a static address, slirp4netns, and public CA', async () => {
    const fixture = runtimeFixture();
    await startDockerDesktopSidecar({ ...startOptions(fixture), egress: egressOptions() });

    const config = fixture.configs[0];
    expect(config).toMatchObject({
      network: 'ic-dw-egress-test',
      ipv4Address: '172.31.44.10',
      mounts: [
        WORKSPACE_MOUNT,
        ...['passwd', 'group', 'subuid', 'subgid'].map((name) => ({
          source: expect.any(String),
          target: `/etc/${name}`,
          readonly: true,
        })),
        CA_MOUNT,
      ],
      env: {
        DOCKERD_ROOTLESS_ROOTLESSKIT_NET: 'slirp4netns',
        HTTP_PROXY: REGISTRY_PROXY_URL,
        HTTPS_PROXY: REGISTRY_PROXY_URL,
        http_proxy: REGISTRY_PROXY_URL,
        https_proxy: REGISTRY_PROXY_URL,
        SSL_CERT_FILE: CA_MOUNT.target,
      },
    });
    expect(config.command).toContain(`--add-runtime=ic-no-new-keyring=${DOCKER_DESKTOP_RUNC_SHIM_PATH}`);
    expect(config.command).toContain('--default-runtime=ic-no-new-keyring');
    expect(config.trustedCreateOptions?.devices).toEqual([
      { source: '/dev/net/tun', target: '/dev/net/tun', permissions: 'rwm' },
    ]);
    expect(config.ports).toBeUndefined();
    expect(config.extraHosts).toEqual([]);
    expect(fixture.expandedCreates[0]?.mounts).toEqual([
      { source: API_VOLUME_NAME, target: DOCKER_DESKTOP_SIDECAR_API_ROOT, readonly: false },
      { source: API_VOLUME_NAME, target: dirname(DOCKER_DESKTOP_SIDECAR_HOME_STATE_ROOT), readonly: false },
      { source: API_VOLUME_NAME, target: dirname(DOCKER_DESKTOP_SIDECAR_DATA_ROOT), readonly: false },
      ...config.mounts,
    ]);
  });

  it('rejects a host-gateway alias in the online daemon before start', async () => {
    const fixture = runtimeFixture({ observedHostConfig: { ExtraHosts: ['host.docker.internal:host-gateway'] } });
    await expect(startDockerDesktopSidecar({ ...startOptions(fixture), egress: egressOptions() })).rejects.toThrow(
      /effective profile mismatch: extra hosts/u,
    );
    expect(fixture.events).not.toContain(`container:start:${SIDECAR_CONTAINER_ID}`);
  });

  it.each([
    { label: 'missing', devices: [] },
    {
      label: 'extra',
      devices: [
        { PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' },
        { PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' },
      ],
    },
    {
      label: 'wrong path',
      devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' }],
    },
    {
      label: 'wrong permissions',
      devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rw' }],
    },
  ])('rejects $label effective online device access before sidecar start', async ({ devices }) => {
    const fixture = runtimeFixture({ observedDevices: devices });

    await expect(startDockerDesktopSidecar({ ...startOptions(fixture), egress: egressOptions() })).rejects.toThrow(
      /device mappings/u,
    );
    expect(fixture.events).not.toContain(`container:start:${SIDECAR_CONTAINER_ID}`);
    expect(fixture.events.slice(-2)).toEqual([
      `container:remove:${SIDECAR_CONTAINER_ID}`,
      `volume:remove:${API_VOLUME_NAME}`,
    ]);
  });

  it.each([
    { label: 'substituted source', bind: '/host/other:/workspace' },
    { label: 'substituted target', bind: `${WORKSPACE_ROOT}:/other` },
    { label: 'read-only mode', bind: `${WORKSPACE_ROOT}:/workspace:ro` },
  ])('rejects a $label for the shared workspace before sidecar start', async ({ bind }) => {
    const fixture = runtimeFixture({ observedWorkspaceBind: bind });

    await expect(startDockerDesktopSidecar(startOptions(fixture))).rejects.toThrow(
      /effective profile mismatch: bind mounts/u,
    );
    expect(fixture.events).not.toContain(`container:start:${SIDECAR_CONTAINER_ID}`);
    expect(fixture.events.slice(-3)).toEqual([
      `container:stop:${SIDECAR_CONTAINER_ID}`,
      `container:remove:${SIDECAR_CONTAINER_ID}`,
      `volume:remove:${API_VOLUME_NAME}`,
    ]);
  });

  it('mounts the shared package build-trust contract over the default runtime path', async () => {
    const fixture = runtimeFixture();
    await startDockerDesktopSidecar({
      ...startOptions(fixture),
      egress: egressOptions(BUILD_TRUST_MOUNTS),
    });

    const config = fixture.configs[0];
    expect(config.mounts).toEqual([
      WORKSPACE_MOUNT,
      ...['passwd', 'group', 'subuid', 'subgid'].map((name) => ({
        source: expect.any(String),
        target: `/etc/${name}`,
        readonly: true,
      })),
      CA_MOUNT,
      ...BUILD_TRUST_MOUNTS,
    ]);
    expect(config.command).toContain(`--add-runtime=ic-no-new-keyring=${DOCKER_BUILD_TRUST_WRAPPER_PATH}`);
    expect(config.mounts).toContainEqual({
      source: '/host/ironcurtain/build-trust',
      target: DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY,
      readonly: true,
    });
    expect(config.command).toContain('--default-runtime=ic-no-new-keyring');
    expect(config.env).toMatchObject({
      DOCKERD_ROOTLESS_ROOTLESSKIT_NET: 'slirp4netns',
      HTTP_PROXY: REGISTRY_PROXY_URL,
      SSL_CERT_FILE: CA_MOUNT.target,
    });
    expect(fixture.expandedCreates[0]?.mounts).toEqual([
      { source: API_VOLUME_NAME, target: DOCKER_DESKTOP_SIDECAR_API_ROOT, readonly: false },
      { source: API_VOLUME_NAME, target: dirname(DOCKER_DESKTOP_SIDECAR_HOME_STATE_ROOT), readonly: false },
      { source: API_VOLUME_NAME, target: dirname(DOCKER_DESKTOP_SIDECAR_DATA_ROOT), readonly: false },
      ...config.mounts,
    ]);
  });

  it('bypasses a Docker wrapper in the package runtime PATH for every private-daemon command', async () => {
    const fixture = runtimeFixture();
    const exec = fixture.runtime.exec.bind(fixture.runtime);
    fixture.runtime.exec = async (id, command, timeout, user) => {
      if (command[0] === 'docker' || command[0] === `${DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY}/docker`) {
        throw new Error('package runtime Docker wrapper must not run in the daemon sidecar');
      }
      return exec(id, command, timeout, user);
    };
    await startDockerDesktopSidecar({ ...startOptions(fixture), egress: egressOptions(BUILD_TRUST_MOUNTS) });
    expect(fixture.configs[0].env.PATH.split(':')[0]).toBe(DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY);
    const commands = fixture.execs.filter((command) => command[1] === '--host');
    expect(commands.some((command) => command.includes('info'))).toBe(true);
    expect(commands.some((command) => command.includes('version'))).toBe(true);
    expect(commands.some((command) => command.includes('network'))).toBe(true);
    expect(commands.some((command) => command.includes('build'))).toBe(true);
    expect(commands.every((command) => command[0] === '/usr/local/bin/docker')).toBe(true);
  });

  it('fails closed and rolls back when PATH does not select the baked no-new-keyring shim', async () => {
    const fixture = runtimeFixture({ failShim: true });

    await expect(startDockerDesktopSidecar(startOptions(fixture))).rejects.toThrow(
      /PATH did not select the protected runc shim/u,
    );
    expect(fixture.events).not.toContain('record:private-docker');
    expect(fixture.events.slice(-3)).toEqual([
      `container:stop:${SIDECAR_CONTAINER_ID}`,
      `container:remove:${SIDECAR_CONTAINER_ID}`,
      `volume:remove:${API_VOLUME_NAME}`,
    ]);
  });

  it('rejects a mutable outer-agent image reference before provisioning', async () => {
    const fixture = runtimeFixture();

    await expect(
      startDockerDesktopSidecar({ ...startOptions(fixture), outerAgentImageId: 'ironcurtain-agent:latest' }),
    ).rejects.toThrow(/outer agent image ID is not immutable/u);
    expect(fixture.events).toEqual([]);
  });

  it('removes an API volume whose post-create inspection does not preserve exact ownership', async () => {
    const fixture = runtimeFixture({ wrongVolumeLabels: true });

    await expect(startDockerDesktopSidecar(startOptions(fixture))).rejects.toThrow(
      /did not inspect as the exact owned local volume/u,
    );
    expect(fixture.events).not.toContain('container:create');
    expect(fixture.events.slice(-2)).toEqual([`volume:inspect:${API_VOLUME_NAME}`, `volume:remove:${API_VOLUME_NAME}`]);
  });

  it('removes the exact created objects when ledger observation rejects after container create', async () => {
    const fixture = runtimeFixture();
    const options = startOptions(fixture);
    const createOuterResource: DockerDesktopSidecarCreateAuthority = async (spec, create) => {
      const requestedName = spec.requestedName;
      const created = await create(requestedName, OWNERSHIP_LABELS);
      if (spec.kind === 'container') throw new Error('ledger observation rejected');
      return { id: created.id };
    };

    await expect(startDockerDesktopSidecar({ ...options, createOuterResource })).rejects.toThrow(
      /ledger observation rejected/u,
    );
    expect(fixture.events.slice(-3)).toEqual([
      `container:stop:${SIDECAR_CONTAINER_ID}`,
      `container:remove:${SIDECAR_CONTAINER_ID}`,
      `volume:remove:${API_VOLUME_NAME}`,
    ]);
  });

  it.each([
    { label: 'memory', hostConfig: { Memory: 1024 }, field: 'memory limit' },
    { label: 'CPU', hostConfig: { NanoCpus: 1 }, field: 'CPU limit' },
    { label: 'PID', hostConfig: { PidsLimit: 16 }, field: 'PID limit' },
  ])('rejects $label limit drift before sidecar start', async ({ hostConfig, field }) => {
    await expectStoppedProfileRejection(runtimeFixture({ observedHostConfig: hostConfig }), field);
  });

  it.each([
    { label: 'default bridge', hostConfig: { NetworkMode: 'bridge' }, field: 'network mode' },
    {
      label: 'published port',
      hostConfig: { PortBindings: { '2375/tcp': [{ HostIp: '127.0.0.1', HostPort: '2375' }] } },
      field: 'published ports',
    },
    {
      label: 'host Docker socket bind',
      hostConfig: {
        Binds: [`${WORKSPACE_ROOT}:/workspace`, '/var/run/docker.sock:/docker.sock'],
      },
      field: 'bind mounts',
    },
    { label: 'writable root filesystem', hostConfig: { ReadonlyRootfs: false }, field: 'read-only root filesystem' },
    { label: 'missing capability drop', hostConfig: { CapDrop: [] }, field: 'dropped capabilities' },
    {
      label: 'extra capability',
      hostConfig: { CapAdd: ['CAP_SETUID', 'CAP_SETGID', 'CAP_SYS_ADMIN'] },
      field: 'added capabilities',
    },
    { label: 'security option', hostConfig: { SecurityOpt: ['no-new-privileges'] }, field: 'security options' },
    {
      label: 'offline host-gateway alias',
      hostConfig: { ExtraHosts: ['host.docker.internal:host-gateway'] },
      field: 'extra hosts',
    },
  ])('rejects $label isolation drift before sidecar start', async ({ hostConfig, field }) => {
    await expectStoppedProfileRejection(runtimeFixture({ observedHostConfig: hostConfig }), field);
  });

  it('rejects an extra effective network attachment before sidecar start', async () => {
    await expectStoppedProfileRejection(
      runtimeFixture({
        observedNetworks: {
          none: { IPAMConfig: null },
          bridge: { IPAMConfig: null },
        },
      }),
      'attached networks',
    );
  });

  it.each([
    { fieldName: 'PidMode', field: 'PID namespace mode' },
    { fieldName: 'IpcMode', field: 'IPC namespace mode' },
    { fieldName: 'UTSMode', field: 'UTS namespace mode' },
    { fieldName: 'UsernsMode', field: 'user namespace mode' },
    { fieldName: 'CgroupnsMode', field: 'cgroup namespace mode' },
  ])('rejects host $fieldName before sidecar start', async ({ fieldName, field }) => {
    await expectStoppedProfileRejection(runtimeFixture({ observedHostConfig: { [fieldName]: 'host' } }), field);
  });

  it('rejects an unknown effective namespace mode before sidecar start', async () => {
    await expectStoppedProfileRejection(
      runtimeFixture({ observedHostConfig: { PidMode: 'unexpected-mode' } }),
      'PID namespace mode',
    );
  });

  it.each([
    { fieldName: 'PidMode', value: undefined, field: 'PID namespace mode' },
    { fieldName: 'IpcMode', value: null, field: 'IPC namespace mode' },
  ])('rejects missing $fieldName evidence before sidecar start', async ({ fieldName, value, field }) => {
    await expectStoppedProfileRejection(runtimeFixture({ observedHostConfig: { [fieldName]: value } }), field);
  });

  it('adjudicates the stopped effective profile before starting the sidecar', async () => {
    await expectStoppedProfileRejection(
      runtimeFixture({ observedHostConfig: { Privileged: true } }),
      'privileged mode',
    );
  });

  it('does not record qualified bootstrap evidence and removes the exact objects when BuildKit fails', async () => {
    const fixture = runtimeFixture({ failBuild: true });

    await expect(startDockerDesktopSidecar(startOptions(fixture))).rejects.toThrow(
      /integrated BuildKit RUN activation canary failed/u,
    );
    expect(fixture.events).not.toContain('record:private-docker');
    expect(fixture.events.slice(-3)).toEqual([
      `container:stop:${SIDECAR_CONTAINER_ID}`,
      `container:remove:${SIDECAR_CONTAINER_ID}`,
      `volume:remove:${API_VOLUME_NAME}`,
    ]);
  });
});
