/**
 * Shared fixtures for the Docker-workload infrastructure tests: a per-file
 * host override, an advancing fake clock, an event-recording fake
 * ContainerRuntime, and an injectable fake watchdog supervisor. Everything runs
 * without a real container runtime, real daemon, or the implementation fuse.
 */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach } from 'vitest';
import { loadResourceWatchdogPolicy } from '../../../src/docker/resource-watchdog.js';
import { closeDockerWorkloadLease, loadDockerWorkloadLease } from '../../../src/docker-workload/bundle-lease.js';
import { acquireProcessLock, type ProcessLockHandle } from '../../../src/docker-workload/process-lock.js';
import {
  APPLE_VM_DAEMON_API_DIR_EXPECTED_STAT,
  APPLE_VM_DAEMON_API_DIR_STAT_ARGV,
} from '../../../src/docker-workload/apple-vm-daemon.js';
import {
  APPLE_VM_DOCKER_WORKLOAD_NETWORK,
  APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR,
  type AppleVmDockerWorkloadBootstrapConfig,
} from '../../../src/docker-workload/apple-private-docker.js';
import { loadClientToolchainManifest } from '../../../src/docker-workload/client-toolchain.js';
import type { WatchdogSupervisorController } from '../../../src/docker-workload/infrastructure.js';
import type { ResourceWatchdogSupervisorStatus } from '../../../src/docker-workload/resource-watchdog-supervisor.js';
import { createMockDocker } from '../../helpers/docker-mocks.js';
import type {
  ContainerRuntime,
  DockerContainerConfig,
  DockerContainerInfo,
  DockerExecResult,
  DockerNetworkInfo,
} from '../../../src/docker/types.js';
import { writeOciArchiveFixture } from '../../helpers/oci-archive-fixture.js';

export const WATCHDOG_TEMPLATE_PATH = resolve('config/docker-workload/resource-watchdog-policy.json');
export const WATCHDOG_ENTRYPOINT_PATH = resolve('dist/docker-workload/resource-watchdog-supervisor-main.js');

const FROZEN_CLIENT_TOOLCHAIN = loadClientToolchainManifest(
  resolve('config/docker-workload/client-toolchain.arm64.json'),
);

export const TEST_CLIENT_TOOLCHAIN_MANIFEST_PATH = FROZEN_CLIENT_TOOLCHAIN.path;

let activeTestArtifact: AppleVmDockerWorkloadBootstrapConfig['artifact'] | undefined;

/** Isolated per-test lease view whose selected archive can be safely retired. */
export function createTestAppleVmDockerWorkloadBootstrap(
  parentDirectory: string,
): AppleVmDockerWorkloadBootstrapConfig {
  const hostArtifactDirectory = mkdtempSync(join(parentDirectory, 'selected-agent-artifact-'));
  chmodSync(hostArtifactDirectory, 0o700);
  const logicalName = 'ironcurtain-claude-code:latest';
  const buildHash = 'a'.repeat(64);
  const selected = writeOciArchiveFixture({
    directory: hostArtifactDirectory,
    logicalName,
    buildHash,
    architecture: FROZEN_CLIENT_TOOLCHAIN.manifest.architecture,
    catalogGeneration: 'selected-agent-test',
  });
  activeTestArtifact = {
    logicalName,
    buildHash,
    architecture: selected.architecture,
    appleImageId: `sha256:${'b'.repeat(64)}`,
    dockerImageId: selected.configDigest,
    manifestDigest: selected.manifestDigest,
    archivePath: join(hostArtifactDirectory, selected.archive.fileName),
    archiveSha256: selected.archive.sha256,
    archiveSizeBytes: selected.archive.sizeBytes,
  };
  return {
    hostArtifactDirectory,
    guestArtifactDirectory: APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR,
    artifact: activeTestArtifact,
    clientToolchainManifestPath: FROZEN_CLIENT_TOOLCHAIN.path,
  };
}

export const ADMISSION_BINDINGS = {
  catalogSha256: '2'.repeat(64),
  innerDockerCatalogSha256: '7'.repeat(64),
  profileSha256: '3'.repeat(64),
  toolchainDigest: '6'.repeat(64),
} as const;

/** The resolved capability config hash admission records in its audit event. */
export const ADMISSION_CONFIG_HASH = '7'.repeat(64);

/** Registers before/after hooks that point `IRONCURTAIN_HOME` at a fresh owner-only temp dir. */
export function useDockerWorkloadHome(): () => string {
  let home = '';
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'docker-workload-home-'));
    chmodSync(home, 0o700);
    process.env.IRONCURTAIN_HOME = home;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return () => home;
}

export interface FakeClock {
  clock(): Date;
  sleep(milliseconds: number): Promise<void>;
  advance(milliseconds: number): void;
}

/**
 * A mutable clock whose `sleep` advances time (mirrors the supervisor tests).
 * `jumpPerSleepMs`, when set, advances by a fixed amount regardless of the
 * requested duration — used to cross the frozen recovery bound deterministically.
 */
export function createFakeClock(baseIso = '2026-07-20T12:00:00.000Z', jumpPerSleepMs?: number): FakeClock {
  let currentMs = Date.parse(baseIso);
  return {
    clock: () => new Date(currentMs),
    sleep: async (milliseconds: number) => {
      currentMs += jumpPerSleepMs ?? milliseconds;
    },
    advance: (milliseconds: number) => {
      currentMs += milliseconds;
    },
  };
}

/** `docker info` of a daemon in the required configuration (rootless + vfs). */
export const QUALIFIED_DOCKER_INFO = {
  Driver: 'vfs',
  SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'],
  ServerVersion: '29.2.1',
} as const;

export const MANAGED_INNER_NETWORK_ID = '8'.repeat(64);

/**
 * Default in-container exec responder: every bootstrap command succeeds and the
 * readiness probe reports the required daemon configuration. Recognises each command by its
 * verb rather than its full argv, so it stays correct if a frozen argv gains
 * flags. The stat reply is the module's own expected string, so a change to the
 * API-directory contract cannot leave this harness silently asserting the old one.
 */
export function respondHealthyAppleVmDaemon(argv: readonly string[]): DockerExecResult {
  if (argv.includes('network') && argv.includes('create')) {
    return { exitCode: 0, stdout: `${MANAGED_INNER_NETWORK_ID}\n`, stderr: '' };
  }
  if (argv.includes('network') && argv.includes('inspect')) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        Id: MANAGED_INNER_NETWORK_ID,
        Name: APPLE_VM_DOCKER_WORKLOAD_NETWORK,
        Driver: 'bridge',
        Scope: 'local',
        Internal: true,
        Labels: { 'com.ironcurtain.managed-workload': 'true' },
        Containers: {},
      }),
      stderr: '',
    };
  }
  if (argv.includes('info')) return { exitCode: 0, stdout: JSON.stringify(QUALIFIED_DOCKER_INFO), stderr: '' };
  if (argv.includes('version') && argv.includes('{{json .}}')) {
    const manifest = FROZEN_CLIENT_TOOLCHAIN.manifest;
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        Client: {
          Version: manifest.docker.cliVersion,
          ApiVersion: manifest.docker.clientApiVersion,
          Os: 'linux',
          Arch: manifest.architecture,
        },
        Server: {
          Version: manifest.docker.daemonVersion,
          ApiVersion: manifest.docker.daemonApiVersion,
          MinAPIVersion: manifest.docker.minimumDaemonApiVersion,
          Os: 'linux',
          Arch: manifest.architecture,
        },
      }),
      stderr: '',
    };
  }
  if (argv.includes('buildx')) {
    return {
      exitCode: 0,
      stdout: `github.com/docker/buildx v${FROZEN_CLIENT_TOOLCHAIN.manifest.buildxVersion}\n`,
      stderr: '',
    };
  }
  if (argv.includes('compose')) {
    return { exitCode: 0, stdout: `${FROZEN_CLIENT_TOOLCHAIN.manifest.composeVersion}\n`, stderr: '' };
  }
  if (argv.includes('image') && argv.includes('inspect')) {
    const logicalName = argv.at(-1);
    const artifact = activeTestArtifact;
    if (artifact === undefined || artifact.logicalName !== logicalName) {
      return { exitCode: 1, stdout: '', stderr: `No such image: ${logicalName}` };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify([
        {
          Id: artifact.dockerImageId,
          RepoTags: [artifact.logicalName],
          Config: { Labels: { 'ironcurtain.build-hash': artifact.buildHash } },
          Created: '2026-07-20T12:00:00.000Z',
        },
      ]),
      stderr: '',
    };
  }
  if (argv[0] === APPLE_VM_DAEMON_API_DIR_STAT_ARGV[0]) {
    return { exitCode: 0, stdout: `${APPLE_VM_DAEMON_API_DIR_EXPECTED_STAT}\n`, stderr: '' };
  }
  return { exitCode: 0, stdout: '', stderr: '' };
}

export interface EventRuntime {
  readonly runtime: ContainerRuntime;
  readonly events: string[];
  /** Every exec argv in order, kept out of `events` so lifecycle assertions stay stable. */
  readonly execs: (readonly string[])[];
  readonly containers: DockerContainerInfo[];
  readonly networks: DockerNetworkInfo[];
  setLeasePath(path: string): void;
}

export interface CreateEventRuntimeOptions {
  readonly containers?: readonly DockerContainerInfo[];
  readonly networks?: readonly DockerNetworkInfo[];
  /** Override the in-container exec responder to script a daemon failure. */
  readonly exec?: (argv: readonly string[]) => DockerExecResult | Promise<DockerExecResult>;
}

/**
 * Fake ContainerRuntime that records lifecycle calls and, when given the lease
 * path, proves that every `create()` was preceded by its ledger append.
 */
export function createEventRuntime(initial?: CreateEventRuntimeOptions): EventRuntime {
  const containers: DockerContainerInfo[] = structuredClone((initial?.containers ?? []) as DockerContainerInfo[]);
  const networks: DockerNetworkInfo[] = structuredClone((initial?.networks ?? []) as DockerNetworkInfo[]);
  const events: string[] = [];
  const execs: (readonly string[])[] = [];
  const respond = initial?.exec ?? respondHealthyAppleVmDaemon;
  let leasePath: string | undefined;
  let sequence = 0;

  const runtime: ContainerRuntime = {
    ...createMockDocker(),
    async exec(_container: string, argv: readonly string[]) {
      execs.push([...argv]);
      return respond(argv);
    },
    async create(config: DockerContainerConfig) {
      events.push(`create:${config.name}`);
      if (leasePath !== undefined) {
        const lease = loadDockerWorkloadLease(leasePath);
        const ledgered = lease.resources.some(
          (resource) => resource.requestedName === config.name && resource.observedId === null,
        );
        if (!ledgered) throw new Error(`create(${config.name}) ran before its ledger append`);
      }
      sequence += 1;
      const id = `container-id-${sequence}`;
      containers.push({
        id,
        name: config.name,
        created: '2026-07-20T12:00:00Z',
        running: true,
        labels: { ...(config.labels ?? {}) },
      });
      return id;
    },
    async start(id: string) {
      events.push(`start:${id}`);
    },
    async stop(id: string) {
      events.push(`stop:${id}`);
    },
    async remove(id: string) {
      events.push(`remove:${id}`);
      const index = containers.findIndex((container) => container.id === id);
      if (index !== -1) containers.splice(index, 1);
    },
    async containerExists(id: string) {
      return containers.some((container) => container.id === id);
    },
    async listContainers() {
      return structuredClone(containers);
    },
    async listNetworks() {
      return structuredClone(networks);
    },
    async createNetwork(name: string, options?: { labels?: Readonly<Record<string, string>> }) {
      events.push(`create-network:${name}`);
      sequence += 1;
      networks.push({
        id: `network-id-${sequence}`,
        name,
        created: '2026-07-20T12:00:00Z',
        labels: { ...(options?.labels ?? {}) },
        subnets: [],
        containerIds: [],
      });
    },
    async removeNetwork(id: string) {
      events.push(`remove-network:${id}`);
      const index = networks.findIndex((network) => network.id === id);
      if (index !== -1) networks.splice(index, 1);
    },
  };
  return { runtime, events, execs, containers, networks, setLeasePath: (path) => (leasePath = path) };
}

export interface FakeSupervisorOptions {
  readonly clock: () => Date;
  readonly launch?: 'ready' | 'throw';
  readonly statusMode?: 'ready' | 'absent';
  readonly alive?: boolean;
  readonly closeLeaseOnStop?: boolean;
  readonly pid?: number;
}

export interface FakeSupervisor extends WatchdogSupervisorController {
  readonly calls: { launched: number; stopRequested: number };
}

export function createFakeSupervisor(options: FakeSupervisorOptions): FakeSupervisor {
  const pid = options.pid ?? 424242;
  const calls = { launched: 0, stopRequested: 0 };
  let stopped = false;
  return {
    calls,
    async launch(launchOptions) {
      calls.launched += 1;
      if (options.launch === 'throw') {
        throw new Error('watchdog supervisor startup incident: injected attestation failure');
      }
      return { pid, status: buildReadyStatus(dirname(launchOptions.statusPath), options.clock(), pid, false) };
    },
    readStatus(statusPath) {
      if (options.statusMode === 'absent') return undefined;
      try {
        return buildReadyStatus(dirname(statusPath), options.clock(), pid, stopped);
      } catch {
        return undefined;
      }
    },
    requestStop(stopRequestPath, lease, cleanup, now) {
      calls.stopRequested += 1;
      if (options.closeLeaseOnStop) {
        // Simulate the detached supervisor synchronously accepting the coordinator's proof.
        const leasePath = join(dirname(stopRequestPath), 'lease.json');
        if (loadDockerWorkloadLease(leasePath).status === 'revoking') {
          closeDockerWorkloadLease(leasePath, lease.generation, cleanup, now);
        }
        stopped = true;
      }
    },
    isAlive() {
      return options.alive ?? true;
    },
  };
}

function buildReadyStatus(leaseDir: string, now: Date, pid: number, closed: boolean): ResourceWatchdogSupervisorStatus {
  const lease = loadDockerWorkloadLease(join(leaseDir, 'lease.json'));
  const policy = loadResourceWatchdogPolicy(join(leaseDir, 'policy.json'));
  return {
    schemaVersion: 1,
    leaseId: lease.leaseId,
    generation: lease.generation,
    supervisorPid: pid,
    state: closed ? 'closed' : 'ready',
    policySha256: policy.sha256,
    policyId: policy.policy.policyId,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastSample: { sampledAtMs: now.getTime(), availableBytes: 100_000_000_000, allocatedBytes: 4096 },
    trip: null,
    detail: closed ? 'durable lease cleanup observed' : 'watchdog ready',
  };
}

/**
 * Take the real `${leasePath}.lock` as the live current process so the next
 * lease mutation reports busy. Uses the production lock so contention is
 * adjudicated by live ownership, never by the malformed-record grace window.
 * Release the returned handle to let the contending mutation through.
 */
export function holdLeaseLock(leasePath: string): ProcessLockHandle {
  return acquireProcessLock(`${leasePath}.lock`);
}
