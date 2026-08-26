import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOCKER_DESKTOP_RUNC_SHIM_PATH,
  DOCKER_DESKTOP_SIDECAR_API_ROOT,
  DOCKER_DESKTOP_SIDECAR_DATA_MOUNT_ROOT,
  DOCKER_DESKTOP_SIDECAR_DATA_ROOT,
  DOCKER_DESKTOP_SIDECAR_DOCKER_HOST,
  loadDockerDesktopP2SeccompProfile,
  parseDockerDesktopProfileCeiling,
  startDockerDesktopSidecar,
  type DockerDesktopSidecarCreateAuthority,
  type DockerDesktopSidecarRuntime,
  type StartDockerDesktopSidecarOptions,
} from '../../src/docker-workload/docker-desktop-sidecar.js';
import {
  APPLE_VM_DAEMON_DOCKER_HOST,
  APPLE_VM_DAEMON_TOOLCHAIN_DIR,
} from '../../src/docker-workload/apple-vm-daemon.js';
import type {
  DockerContainerConfig,
  DockerExecResult,
  DockerImageInfo,
  DockerVolumeInfo,
} from '../../src/docker/types.js';
import { sha256Hex } from '../../src/hash.js';
import type { ExpandedOuterCreate } from '../../src/docker-workload/lifecycle-evidence.js';
import {
  createTestAppleVmDockerWorkloadBootstrap,
  respondHealthyAppleVmDaemon,
} from './helpers/infrastructure-harness.js';

const SIDECAR_IMAGE_ID = `sha256:${'d'.repeat(64)}`;
const SIDECAR_CONTAINER_ID = 'c'.repeat(64);
const API_VOLUME_NAME = 'ic-desktop-api-test';
const SIDECAR_NAME = 'ic-desktop-daemon-test';
const OWNERSHIP_LABELS = { 'com.ironcurtain.docker-workload.generation': 'gen-test' } as const;

let tempDirectory: string;

beforeEach(() => {
  tempDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-sidecar-')));
});

afterEach(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

interface RuntimeFixture {
  readonly runtime: DockerDesktopSidecarRuntime;
  readonly events: string[];
  readonly configs: DockerContainerConfig[];
  readonly execs: (readonly string[])[];
  readonly volumeLabels: Map<string, Readonly<Record<string, string>>>;
  readonly expandedCreates: ExpandedOuterCreate[];
}

function runtimeFixture(
  options: { readonly failBuild?: boolean; readonly failShim?: boolean; readonly wrongVolumeLabels?: boolean } = {},
): RuntimeFixture {
  const events: string[] = [];
  const configs: DockerContainerConfig[] = [];
  const execs: (readonly string[])[] = [];
  const volumeLabels = new Map<string, Readonly<Record<string, string>>>();
  const expandedCreates: ExpandedOuterCreate[] = [];
  const runtime: DockerDesktopSidecarRuntime = {
    async preflight(image) {
      events.push(`preflight:${image}`);
    },
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
    async start(id) {
      events.push(`container:start:${id}`);
    },
    async exec(_id, argv): Promise<DockerExecResult> {
      execs.push([...argv]);
      if (argv[0] === '/bin/sh' && argv[1] === '-c' && argv[2] === 'command -v runc') {
        events.push('shim:path');
        return {
          exitCode: 0,
          stdout: `${options.failShim === true ? '/usr/local/bin/runc' : DOCKER_DESKTOP_RUNC_SHIM_PATH}\n`,
          stderr: '',
        };
      }
      if (argv[0] === DOCKER_DESKTOP_RUNC_SHIM_PATH && argv[1] === '--version') {
        events.push('shim:version');
        return { exitCode: 0, stdout: 'runc version 1.3.4\ncommit: d6d73eb\n', stderr: '' };
      }
      if (argv[0] === 'docker' && argv[1] === '--host' && argv[2] === DOCKER_DESKTOP_SIDECAR_DOCKER_HOST) {
        const operation = argv.slice(3);
        if (operation[0] === 'container' && operation[1] === 'inspect') {
          return { exitCode: 1, stdout: '', stderr: `Error: No such container: ${operation.at(-1) ?? ''}` };
        }
        if (operation[0] === 'run') events.push('canary:run');
        if (operation[0] === 'build') {
          events.push('canary:build');
          if (options.failBuild === true) {
            return { exitCode: 1, stdout: '', stderr: 'runc create failed: keyring denied' };
          }
        }
        return respondHealthyAppleVmDaemon([
          `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
          '--host',
          APPLE_VM_DAEMON_DOCKER_HOST,
          ...operation,
        ]);
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
  return { runtime, events, configs, execs, volumeLabels, expandedCreates };
}

function resourceAuthority(
  events: string[],
  expandedCreates: ExpandedOuterCreate[],
): DockerDesktopSidecarCreateAuthority {
  return async (spec, create) => {
    events.push(`ledger:${spec.kind}:${spec.role}:${spec.launchesNestedDaemon === true}`);
    const requestedName = spec.kind === 'volume' ? API_VOLUME_NAME : SIDECAR_NAME;
    const created = await create(requestedName, OWNERSHIP_LABELS);
    if (created.expanded !== undefined) expandedCreates.push(created.expanded);
    events.push(`observed:${spec.kind}:${created.id}`);
    return { id: created.id, requestedName };
  };
}

function startOptions(fixture: RuntimeFixture): StartDockerDesktopSidecarOptions {
  const bootstrap = createTestAppleVmDockerWorkloadBootstrap(tempDirectory);
  const events = fixture.events;
  return {
    runtime: fixture.runtime,
    sidecarImage: 'ironcurtain-nested-daemon:latest',
    bootstrap,
    resources: { memoryMb: 4096, cpus: 2, pidsLimit: 512 },
    createOuterResource: resourceAuthority(events, fixture.expandedCreates),
    activation: {
      generation: 'gen-desktop-test',
      recordDaemonReady() {
        events.push('record:daemon-ready');
      },
      recordPrivateDockerBootstrap() {
        events.push('record:private-docker');
      },
    },
  };
}

describe('Docker Desktop sidecar frozen artifacts', () => {
  it('loads the hash-bound P2 profile with the measured sethostname rule and no keyctl allowance', () => {
    const profile = loadDockerDesktopP2SeccompProfile();
    const bytes = readFileSync(profile.path);
    const parsed = JSON.parse(bytes.toString('utf8')) as {
      readonly syscalls: readonly { readonly names: readonly string[]; readonly action: string }[];
    };

    expect(profile.sha256).toBe(sha256Hex(bytes));
    expect(profile.systemPathsSecurityOption).toBe('systempaths=unconfined');
    expect(profile.path).toMatch(/config\/docker-workload\/seccomp\/desktop-p2-userns\.json$/u);
    expect(parsed.syscalls).toContainEqual(
      expect.objectContaining({ names: ['sethostname'], action: 'SCMP_ACT_ALLOW' }),
    );
    expect(parsed.syscalls).not.toContainEqual(
      expect.objectContaining({ names: ['keyctl'], action: 'SCMP_ACT_ALLOW' }),
    );
  });

  it('fails closed when the reviewed sidecar-only mount-mask exception drifts', () => {
    const ceiling = JSON.parse(
      readFileSync(join(process.cwd(), 'config/docker-workload/profile-ceiling.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(() => parseDockerDesktopProfileCeiling(ceiling)).not.toThrow();

    const wrongScope = structuredClone(ceiling) as {
      categories: { mountMask: { additions: Array<{ scope: string }> } };
    };
    wrongScope.categories.mountMask.additions[0].scope = 'all-containers';
    expect(() => parseDockerDesktopProfileCeiling(wrongScope)).toThrow();

    const wrongStatus = structuredClone(ceiling) as { status: string };
    wrongStatus.status = 'qualified';
    expect(() => parseDockerDesktopProfileCeiling(wrongStatus)).toThrow();
  });
});

describe('Docker Desktop sidecar lifecycle', () => {
  it('creates the exact bounded profile and returns only after run and BuildKit canaries', async () => {
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
          { name: API_VOLUME_NAME, target: DOCKER_DESKTOP_SIDECAR_DATA_MOUNT_ROOT, readonly: false, noCopy: true },
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
      {
        source: options.bootstrap.hostArtifactDirectory,
        target: options.bootstrap.guestArtifactDirectory,
        readonly: true,
      },
    ]);
    expect(fixture.expandedCreates).toHaveLength(1);
    expect(fixture.expandedCreates[0]?.mounts).toEqual([
      { source: API_VOLUME_NAME, target: DOCKER_DESKTOP_SIDECAR_API_ROOT, readonly: false },
      { source: API_VOLUME_NAME, target: DOCKER_DESKTOP_SIDECAR_DATA_MOUNT_ROOT, readonly: false },
      {
        source: options.bootstrap.hostArtifactDirectory,
        target: options.bootstrap.guestArtifactDirectory,
        readonly: true,
      },
    ]);
    expect(config.env).toEqual({
      DOCKER_TLS_CERTDIR: '',
      DOCKERD_ROOTLESS_ROOTLESSKIT_NET: 'none',
      XDG_RUNTIME_DIR: DOCKER_DESKTOP_SIDECAR_API_ROOT,
      PATH: '/usr/local/lib/ironcurtain:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    });
    expect(config.command).toEqual([
      'dockerd',
      `--add-runtime=ic-no-new-keyring=${DOCKER_DESKTOP_RUNC_SHIM_PATH}`,
      '--default-runtime=ic-no-new-keyring',
      `--host=${DOCKER_DESKTOP_SIDECAR_DOCKER_HOST}`,
      '--storage-driver=vfs',
      `--data-root=${DOCKER_DESKTOP_SIDECAR_DATA_ROOT}`,
      `--exec-root=${DOCKER_DESKTOP_SIDECAR_API_ROOT}/exec`,
      `--pidfile=${DOCKER_DESKTOP_SIDECAR_API_ROOT}/docker.pid`,
      '--iptables=false',
      '--bridge=none',
      '--ip-forward=false',
      '--ip-masq=false',
    ]);
    expect(config.ports).toBeUndefined();
    expect(config.extraHosts).toBeUndefined();

    const build = fixture.events.indexOf('canary:build');
    const privateEvidence = fixture.events.indexOf('record:private-docker');
    expect(fixture.events.indexOf('canary:run')).toBeGreaterThan(fixture.events.indexOf('record:daemon-ready'));
    expect(build).toBeGreaterThan(fixture.events.indexOf('canary:run'));
    expect(privateEvidence).toBeGreaterThan(build);
    expect(fixture.events).not.toContain(`container:stop:${SIDECAR_CONTAINER_ID}`);
    expect(fixture.events.slice(0, 10)).toEqual([
      'preflight:ironcurtain-nested-daemon:latest',
      'outer-image-inspect:ironcurtain-nested-daemon:latest',
      'ledger:volume:daemon-api:false',
      `volume:create:${API_VOLUME_NAME}`,
      `volume:inspect:${API_VOLUME_NAME}`,
      `observed:volume:${API_VOLUME_NAME}`,
      'ledger:container:nested-daemon:true',
      'container:create',
      `observed:container:${SIDECAR_CONTAINER_ID}`,
      `container:start:${SIDECAR_CONTAINER_ID}`,
    ]);
    expect(fixture.execs).toContainEqual(['/bin/sh', '-c', 'command -v runc']);
    expect(fixture.execs).toContainEqual([DOCKER_DESKTOP_RUNC_SHIM_PATH, '--version']);
  });

  it('fails closed and rolls back when PATH does not select the baked no-new-keyring shim', async () => {
    const fixture = runtimeFixture({ failShim: true });

    await expect(startDockerDesktopSidecar(startOptions(fixture))).rejects.toThrow(
      /PATH did not select the baked runc shim/u,
    );
    expect(fixture.events).not.toContain('record:private-docker');
    expect(fixture.events.slice(-3)).toEqual([
      `container:stop:${SIDECAR_CONTAINER_ID}`,
      `container:remove:${SIDECAR_CONTAINER_ID}`,
      `volume:remove:${API_VOLUME_NAME}`,
    ]);
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
      const requestedName = spec.kind === 'volume' ? API_VOLUME_NAME : SIDECAR_NAME;
      const created = await create(requestedName, OWNERSHIP_LABELS);
      if (spec.kind === 'container') throw new Error('ledger observation rejected');
      return { id: created.id, requestedName };
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
