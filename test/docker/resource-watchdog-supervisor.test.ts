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
  closeDockerWorkloadLease,
  createDockerWorkloadLease,
  heartbeatDockerWorkloadLease,
  loadDockerWorkloadLease,
  revokeDockerWorkloadLease,
  type CreateDockerWorkloadLeaseOptions,
} from '../../src/docker-workload/bundle-lease.js';
import { tryAcquireDockerWorkloadLifecycleClaim } from '../../src/docker-workload/cleanup-ownership.js';
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

    revokeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    rmSync(fixture.stateRoot, { recursive: true, force: true });
    const cleanup = {
      exactOuterResourcesAbsent: true,
      stateRootAbsent: true,
      inventories: [
        { capturedAt: '2026-07-20T12:00:00.000Z', ownedResourceIds: [] },
        { capturedAt: '2026-07-20T12:00:00.200Z', ownedResourceIds: [] },
      ],
    } as const;
    const closed = closeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation, cleanup);
    requestResourceWatchdogSupervisorStop(fixture.paths.stopRequestPath, closed, cleanup);
    await running;
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      detail: 'durable lease cleanup observed',
    });
  });

  it('resumes a revoking lease after a prior cleanup owner disappears', async () => {
    const fixture = supervisorFixture('stale-coordinator');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
    });
    createLease(fixture, policy.sha256);
    revokeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    let currentMs = Date.parse('2026-07-20T12:01:00.000Z');

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        currentMs += milliseconds;
      },
    });

    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
    expect(() => lstatSync(fixture.stateRoot)).toThrow();
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      detail: 'stale coordinator triggered exact cleanup',
    });
  });

  it('cleans an active lease when its coordinator heartbeat crosses the stale bound', async () => {
    const fixture = supervisorFixture('stale-active');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
    });
    createLease(fixture, policy.sha256);
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        currentMs += Math.max(milliseconds, 31_000);
      },
    });

    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
    expect(() => lstatSync(fixture.stateRoot)).toThrow();
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      detail: 'stale coordinator triggered exact cleanup',
    });
  });

  it('defers samples during a 30s claimed create and publishes a real sample immediately after release', async () => {
    const fixture = supervisorFixture('long-create');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
      sampleIntervalMs: 5_000,
      sampleTimeoutMs: 5_000,
      staleAfterMs: 30_000,
    });
    createLease(fixture, policy.sha256);
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');
    let allowAdvance = false;
    let createClaim: ReturnType<typeof tryAcquireDockerWorkloadLifecycleClaim> | undefined;
    let nextHeartbeatMs = currentMs + 5_000;
    let releaseAtMs = Number.POSITIVE_INFINITY;
    const running = runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        while (!allowAdvance) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        currentMs += Math.max(milliseconds, 1_000);
        while (createClaim !== undefined && currentMs >= nextHeartbeatMs) {
          heartbeatDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation, new Date(currentMs));
          nextHeartbeatMs += 5_000;
        }
        if (createClaim !== undefined && currentMs >= releaseAtMs) {
          createClaim.release();
          createClaim = undefined;
        }
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      },
    });
    const ready = await waitForReady(fixture.paths.statusPath);
    const initialStatusAt = Date.parse(ready.updatedAt);
    createClaim = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: fixture.paths.leasePath });
    releaseAtMs = currentMs + 31_000;
    allowAdvance = true;

    let fresh: ReturnType<typeof loadResourceWatchdogSupervisorStatus>;
    try {
      fresh = await waitForStatus(
        fixture.paths.statusPath,
        (status) =>
          status.state === 'ready' && status.lastSample !== null && Date.parse(status.updatedAt) > initialStatusAt,
      );
    } catch (error) {
      releaseOptionalClaim(createClaim);
      createClaim = undefined;
      throw new Error(`long-create test stalled at ${currentMs} (release ${releaseAtMs})`, { cause: error });
    }
    expect(currentMs).toBeGreaterThanOrEqual(releaseAtMs);
    expect(fresh.trip).toBeNull();
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('admitting');

    revokeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    await running;
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
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
    revokeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    const forgedCleanup = {
      exactOuterResourcesAbsent: true,
      stateRootAbsent: true,
      inventories: [
        { capturedAt: '2026-07-20T12:00:00.000Z', ownedResourceIds: [] },
        { capturedAt: '2026-07-20T12:00:00.200Z', ownedResourceIds: [] },
      ],
    } as const;
    const closed = closeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation, forgedCleanup);
    requestResourceWatchdogSupervisorStop(fixture.paths.stopRequestPath, closed, forgedCleanup);
    await expect(running).rejects.toThrow(/state root still exists/u);
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'incident',
      detail: expect.stringMatching(/state root still exists/u),
    });
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
  thresholds: Pick<ResourceWatchdogPolicy, 'softEvidenceBytes' | 'hardSafetyBytes'> &
    Partial<Pick<ResourceWatchdogPolicy, 'sampleIntervalMs' | 'sampleTimeoutMs' | 'staleAfterMs'>>,
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

async function waitForStatus(
  path: string,
  predicate: (status: ReturnType<typeof loadResourceWatchdogSupervisorStatus>) => boolean,
) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const status = loadResourceWatchdogSupervisorStatus(path);
    if (predicate(status)) return status;
    if (Date.now() >= deadline) {
      throw new Error(`watchdog supervisor did not publish the expected status: ${JSON.stringify(status)}`);
    }
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
}

function releaseOptionalClaim(claim: { release(): void } | undefined): void {
  claim?.release();
}
