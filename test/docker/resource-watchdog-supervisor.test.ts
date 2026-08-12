import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertResourceWatchdogSupervisorFresh,
  loadResourceWatchdogSupervisorStatus,
  requestResourceWatchdogSupervisorStop,
  runResourceWatchdogSupervisor,
} from '../../src/docker-workload/resource-watchdog-supervisor.js';
import {
  createDockerWorkloadLease,
  loadDockerWorkloadLease,
  revokeDockerWorkloadLease,
  type CreateDockerWorkloadLeaseOptions,
} from '../../src/docker-workload/bundle-lease.js';
import type { ResourceWatchdogPolicy } from '../../src/docker/resource-watchdog.js';
import { createMockDocker } from '../helpers/docker-mocks.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('detached resource-watchdog supervisor core', () => {
  it('revokes and closes independently when the initial sample crosses the hard threshold', async () => {
    const fixture = supervisorFixture('trip');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    writeFileSync(join(fixture.stateRoot, 'daemon', 'state.bin'), Buffer.alloc(8192, 1));
    const policy = writePolicy(fixture, { softEvidenceBytes: 512, hardSafetyBytes: 1024 });
    createLease(fixture, policy.sha256);
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        currentMs += milliseconds;
      },
    });

    expect(loadDockerWorkloadLease(fixture.paths.leasePath)).toMatchObject({ status: 'closed', cleanup: {} });
    expect(() => lstatSync(fixture.stateRoot)).toThrow();
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      trip: { code: 'hard-state-threshold' },
    });
  });

  it('accepts normal shutdown only after revocation, exact state absence, and two empty inventories', async () => {
    const fixture = supervisorFixture('normal');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
    });
    createLease(fixture, policy.sha256);
    const running = runResourceWatchdogSupervisor({ ...fixture.paths, runtime: emptyRuntime() });
    const ready = await waitForReady(fixture.paths.statusPath);
    assertResourceWatchdogSupervisorFresh(
      ready,
      {
        leaseId: fixture.leaseOptions.leaseId,
        generation: fixture.leaseOptions.generation,
        policySha256: policy.sha256,
      },
      1000,
      new Date(ready.updatedAt),
    );

    const revoking = revokeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    rmSync(fixture.stateRoot, { recursive: true, force: true });
    requestResourceWatchdogSupervisorStop(fixture.paths.stopRequestPath, revoking, {
      exactOuterResourcesAbsent: true,
      stateRootAbsent: true,
      inventories: [
        { capturedAt: '2026-07-20T12:00:00.000Z', ownedResourceIds: [] },
        { capturedAt: '2026-07-20T12:00:00.200Z', ownedResourceIds: [] },
      ],
    });
    await running;
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      detail: 'coordinator cleanup proof accepted',
    });
  });

  it('rejects a stale heartbeat or a status bound to another policy', () => {
    const fixture = supervisorFixture('freshness');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
    });
    createLease(fixture, policy.sha256);
    const status = {
      schemaVersion: 1 as const,
      leaseId: fixture.leaseOptions.leaseId,
      generation: fixture.leaseOptions.generation,
      supervisorPid: process.pid,
      state: 'ready' as const,
      policySha256: policy.sha256,
      policyId: 'apple-observed-disk-v1',
      startedAt: '2026-07-20T12:00:00.000Z',
      updatedAt: '2026-07-20T12:00:00.000Z',
      lastSample: null,
      trip: null,
      detail: null,
    };
    expect(() =>
      assertResourceWatchdogSupervisorFresh(
        status,
        {
          leaseId: status.leaseId,
          generation: status.generation,
          policySha256: '9'.repeat(64),
        },
        1000,
        new Date(status.updatedAt),
      ),
    ).toThrow(/binding mismatch/u);
    expect(() =>
      assertResourceWatchdogSupervisorFresh(
        status,
        { leaseId: status.leaseId, generation: status.generation, policySha256: status.policySha256 },
        100,
        new Date('2026-07-20T12:00:00.100Z'),
      ),
    ).toThrow(/stale/u);
  });

  it('keeps its control plane outside the state tree it may delete', async () => {
    const fixture = supervisorFixture('control-path');
    chmodSync(fixture.stateRoot, 0o700);
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
    });
    createLease(fixture, policy.sha256);
    await expect(
      runResourceWatchdogSupervisor({
        ...fixture.paths,
        statusPath: join(fixture.stateRoot, 'status.json'),
        runtime: emptyRuntime(),
      }),
    ).rejects.toThrow(/control files.*outside/u);
  });

  it('remeasures normal-stop state instead of trusting coordinator cleanup booleans', async () => {
    const fixture = supervisorFixture('forged-stop');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
    });
    createLease(fixture, policy.sha256);
    const running = runResourceWatchdogSupervisor({ ...fixture.paths, runtime: emptyRuntime() });
    await waitForReady(fixture.paths.statusPath);
    const revoking = revokeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    requestResourceWatchdogSupervisorStop(fixture.paths.stopRequestPath, revoking, {
      exactOuterResourcesAbsent: true,
      stateRootAbsent: true,
      inventories: [
        { capturedAt: '2026-07-20T12:00:00.000Z', ownedResourceIds: [] },
        { capturedAt: '2026-07-20T12:00:00.200Z', ownedResourceIds: [] },
      ],
    });
    await expect(running).rejects.toThrow(/state root still exists/u);
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('revoking');
  });
});

function supervisorFixture(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `watchdog-supervisor-${label}-`));
  temporaryDirectories.push(directory);
  const stateRoot = join(directory, 'state');
  mkdirSync(stateRoot);
  const leaseOptions: CreateDockerWorkloadLeaseOptions = {
    leaseId: `lease-${label}-001`,
    bundleId: `bundle-${label}-001`,
    generation: `generation-${label}-001`,
    runtimeKind: 'docker',
    paths: {
      workspaceRoot: join(directory, 'workspace'),
      stateRoot,
      runtimeRoot: join(stateRoot, 'runtime'),
      apiRoot: join(stateRoot, 'api'),
      exchangeRoot: join(stateRoot, 'exchange'),
      stagingRoot: join(stateRoot, 'staging'),
    },
    bindings: {
      catalogSha256: '2'.repeat(64),
      innerDockerCatalogSha256: '7'.repeat(64),
      profileSha256: '3'.repeat(64),
      watchdogPolicySha256: '0'.repeat(64),
      toolchainDigest: '6'.repeat(64),
    },
    cleanupInventoryGapMs: 100,
    now: new Date('2026-07-20T12:00:00.000Z'),
  };
  return {
    directory,
    stateRoot,
    leaseOptions,
    paths: {
      leasePath: join(directory, 'lease.json'),
      policyPath: join(directory, 'policy.json'),
      statusPath: join(directory, 'status.json'),
      stopRequestPath: join(directory, 'stop.json'),
    },
  };
}

function writePolicy(
  fixture: ReturnType<typeof supervisorFixture>,
  thresholds: Pick<ResourceWatchdogPolicy, 'softEvidenceBytes' | 'hardSafetyBytes'>,
): { readonly policy: ResourceWatchdogPolicy; readonly sha256: string } {
  const stats = lstatSync(fixture.stateRoot);
  const policy: ResourceWatchdogPolicy = {
    schemaVersion: 1,
    policyId: 'apple-observed-disk-v1',
    targetRoot: fixture.stateRoot,
    targetDevice: stats.dev,
    targetInode: stats.ino,
    stateClasses: [{ id: 'daemon-state', relativePath: 'daemon', kind: 'directory', required: true }],
    sampleIntervalMs: 100,
    sampleTimeoutMs: 100,
    staleAfterMs: 300,
    ...thresholds,
    hostReserveBytes: 1,
    maximumOvershootBytes: 1024 * 1024,
    cleanupInventoryGapMs: 100,
  };
  const bytes = Buffer.from(`${JSON.stringify(policy)}\n`);
  writeFileSync(fixture.paths.policyPath, bytes, { mode: 0o400 });
  chmodSync(fixture.paths.policyPath, 0o400);
  return { policy, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function createLease(fixture: ReturnType<typeof supervisorFixture>, watchdogPolicySha256: string): void {
  createDockerWorkloadLease(fixture.paths.leasePath, {
    ...fixture.leaseOptions,
    bindings: { ...fixture.leaseOptions.bindings, watchdogPolicySha256 },
  });
}

function emptyRuntime() {
  return {
    ...createMockDocker(),
    async listContainers() {
      return [];
    },
    async listNetworks() {
      return [];
    },
  };
}

async function waitForReady(path: string) {
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      const status = loadResourceWatchdogSupervisorStatus(path);
      if (status.state === 'ready') return status;
    } catch {
      // Atomic status file may not exist yet.
    }
    if (Date.now() >= deadline) throw new Error('watchdog supervisor did not become ready');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}
