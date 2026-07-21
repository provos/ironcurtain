/**
 * Shared fixtures for the Docker-workload infrastructure tests: a per-file
 * host override, an advancing fake clock, an event-recording fake
 * ContainerRuntime, and an injectable fake watchdog supervisor. Everything runs
 * without a real container runtime, real daemon, or the implementation fuse.
 */

import { chmodSync, closeSync, constants, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach } from 'vitest';
import { loadResourceWatchdogPolicy } from '../../../src/docker/resource-watchdog.js';
import { closeDockerWorkloadLease, loadDockerWorkloadLease } from '../../../src/docker-workload/bundle-lease.js';
import type { WatchdogSupervisorController } from '../../../src/docker-workload/infrastructure.js';
import type { ResourceWatchdogSupervisorStatus } from '../../../src/docker-workload/resource-watchdog-supervisor.js';
import { createMockDocker } from '../../helpers/docker-mocks.js';
import type {
  ContainerRuntime,
  DockerContainerConfig,
  DockerContainerInfo,
  DockerNetworkInfo,
} from '../../../src/docker/types.js';

export const WATCHDOG_TEMPLATE_PATH = resolve('config/docker-workload/resource-watchdog-policy.json');
export const WATCHDOG_ENTRYPOINT_PATH = resolve('dist/docker-workload/resource-watchdog-supervisor-main.js');

export const ADMISSION_BINDINGS = {
  qualificationContractSha256: '1'.repeat(64),
  catalogSha256: '2'.repeat(64),
  profileSha256: '3'.repeat(64),
  performanceBudgetSha256: '4'.repeat(64),
  toolchainDigest: '6'.repeat(64),
} as const;

/** Full canonical qualification-evidence bindings (fixture hashes) for evidence-sealing tests. */
export const EVIDENCE_BINDINGS = {
  sourceCommit: '1'.repeat(40),
  dirtyPatchSha256: null,
  qualificationContractSha256: 'a'.repeat(64),
  profileCeilingSha256: 'a'.repeat(64),
  generatedProfileSha256: 'a'.repeat(64),
  preloadedCatalogSha256: 'a'.repeat(64),
  performanceBudgetSha256: 'a'.repeat(64),
  clientToolchainSha256: 'a'.repeat(64),
  relayBinarySha256: null,
  relayConfigSha256: null,
  relayEndpointSha256: null,
  watchdogPolicySha256: 'a'.repeat(64),
  buildEgressManifestSha256: 'a'.repeat(64),
} as const;

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

export interface EventRuntime {
  readonly runtime: ContainerRuntime;
  readonly events: string[];
  readonly containers: DockerContainerInfo[];
  readonly networks: DockerNetworkInfo[];
  setLeasePath(path: string): void;
}

/**
 * Fake ContainerRuntime that records lifecycle calls and, when given the lease
 * path, proves that every `create()` was preceded by its ledger append.
 */
export function createEventRuntime(initial?: {
  readonly containers?: readonly DockerContainerInfo[];
  readonly networks?: readonly DockerNetworkInfo[];
}): EventRuntime {
  const containers: DockerContainerInfo[] = structuredClone((initial?.containers ?? []) as DockerContainerInfo[]);
  const networks: DockerNetworkInfo[] = structuredClone((initial?.networks ?? []) as DockerNetworkInfo[]);
  const events: string[] = [];
  let leasePath: string | undefined;
  let sequence = 0;

  const runtime: ContainerRuntime = {
    ...createMockDocker(),
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
  return { runtime, events, containers, networks, setLeasePath: (path) => (leasePath = path) };
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
  return {
    calls,
    async launch(launchOptions) {
      calls.launched += 1;
      if (options.launch === 'throw') {
        throw new Error('watchdog supervisor startup incident: injected attestation failure');
      }
      return { pid, status: buildReadyStatus(dirname(launchOptions.statusPath), options.clock(), pid) };
    },
    readStatus(statusPath) {
      if (options.statusMode === 'absent') return undefined;
      try {
        return buildReadyStatus(dirname(statusPath), options.clock(), pid);
      } catch {
        return undefined;
      }
    },
    requestStop(stopRequestPath, lease, cleanup, now) {
      calls.stopRequested += 1;
      if (options.closeLeaseOnStop) {
        // Simulate the detached supervisor synchronously accepting the coordinator's proof.
        closeDockerWorkloadLease(join(dirname(stopRequestPath), 'lease.json'), lease.generation, cleanup, now);
      }
    },
    isAlive() {
      return options.alive ?? true;
    },
  };
}

function buildReadyStatus(leaseDir: string, now: Date, pid: number): ResourceWatchdogSupervisorStatus {
  const lease = loadDockerWorkloadLease(join(leaseDir, 'lease.json'));
  const policy = loadResourceWatchdogPolicy(join(leaseDir, 'policy.json'));
  return {
    schemaVersion: 1,
    leaseId: lease.leaseId,
    generation: lease.generation,
    supervisorPid: pid,
    state: 'ready',
    policySha256: policy.sha256,
    policyId: policy.policy.policyId,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastSample: { sampledAtMs: now.getTime(), availableBytes: 100_000_000_000, allocatedBytes: 4096 },
    trip: null,
    detail: 'watchdog ready',
  };
}

/** Create a `${leasePath}.lock` held by the live current process so the next lease mutation reports busy. */
export function holdLeaseLock(leasePath: string): string {
  const lockPath = `${leasePath}.lock`;
  const descriptor = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  closeSync(descriptor);
  return lockPath;
}
