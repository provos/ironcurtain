import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { createLegacyDockerWorkloadLease } from '../helpers/legacy-docker-workload-lease.js';

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
    createLease(fixture, policy.policy);
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

  it.each([1, 2] as const)('accepts normal shutdown with a running generation-v%i supervisor', async (version) => {
    const fixture = supervisorFixture('normal');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
    });
    if (version === 1) {
      createLegacyDockerWorkloadLease(fixture.paths.leasePath, {
        ...fixture.leaseOptions,
        bindings: { watchdogPolicySha256: policy.sha256 },
      });
    } else createLease(fixture, policy.policy);
    const running = runResourceWatchdogSupervisor({ ...fixture.paths, runtime: emptyRuntime() });
    const ready = await waitForReady(fixture.paths.statusPath);
    assertResourceWatchdogSupervisorFresh(
      ready,
      {
        leaseId: fixture.leaseOptions.leaseId,
        generation: fixture.leaseOptions.generation,
        ...(version === 1 ? { policySha256: policy.sha256 } : { policy: policy.policy }),
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
    expect(JSON.parse(readFileSync(fixture.paths.stopRequestPath, 'utf8'))).toMatchObject({ schemaVersion: version });
    await running;
    expect(loadDockerWorkloadLease(fixture.paths.leasePath)).toMatchObject({
      status: 'closed',
      schemaVersion: version,
    });
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      schemaVersion: version,
      state: 'closed',
      detail: 'durable lease cleanup observed',
    });
  });

  it('compares policy values without binding JSON formatting and rejects threshold substitution', async () => {
    const fixture = supervisorFixture('policy-values');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const { policy } = writePolicy(fixture, { softEvidenceBytes: 512, hardSafetyBytes: 1024 });
    createLease(fixture, policy);
    chmodSync(fixture.paths.policyPath, 0o600);
    writeFileSync(
      fixture.paths.policyPath,
      JSON.stringify(Object.fromEntries(Object.entries(policy).reverse()), null, 2),
    );
    chmodSync(fixture.paths.policyPath, 0o400);
    let now = Date.parse('2026-07-20T12:00:00.000Z');
    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(now),
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');

    const changed = supervisorFixture('policy-substitution');
    mkdirSync(join(changed.stateRoot, 'daemon'));
    const original = writePolicy(changed, { softEvidenceBytes: 512, hardSafetyBytes: 1024 });
    createLease(changed, original.policy);
    chmodSync(changed.paths.policyPath, 0o600);
    writeFileSync(changed.paths.policyPath, JSON.stringify({ ...original.policy, hardSafetyBytes: 2048 }));
    chmodSync(changed.paths.policyPath, 0o400);
    await expect(runResourceWatchdogSupervisor({ ...changed.paths, runtime: emptyRuntime() })).rejects.toThrow(
      /does not match/,
    );
    expect(loadDockerWorkloadLease(changed.paths.leasePath).status).toBe('admitting');
  });

  it('keeps the original byte comparison for a legacy generation', async () => {
    const fixture = supervisorFixture('legacy-policy');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, { softEvidenceBytes: 512, hardSafetyBytes: 1024 });
    createLegacyDockerWorkloadLease(fixture.paths.leasePath, {
      ...fixture.leaseOptions,
      bindings: { watchdogPolicySha256: policy.sha256 },
    });
    chmodSync(fixture.paths.policyPath, 0o600);
    writeFileSync(fixture.paths.policyPath, JSON.stringify(policy.policy, null, 2));
    chmodSync(fixture.paths.policyPath, 0o400);
    await expect(runResourceWatchdogSupervisor({ ...fixture.paths, runtime: emptyRuntime() })).rejects.toThrow(
      /does not match/,
    );
  });

  it('resumes a revoking lease after a prior cleanup owner disappears', async () => {
    const fixture = supervisorFixture('stale-coordinator');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
    });
    createLease(fixture, policy.policy);
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
    createLease(fixture, policy.policy);
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
    createLease(fixture, policy.policy);
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
    createLease(fixture, policy.policy);
    const status = {
      schemaVersion: 2 as const,
      leaseId: fixture.leaseOptions.leaseId,
      generation: fixture.leaseOptions.generation,
      supervisorPid: process.pid,
      state: 'ready' as const,
      policy: policy.policy,
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
          policy: { ...policy.policy, hardSafetyBytes: policy.policy.hardSafetyBytes + 1 },
        },
        1000,
        new Date(status.updatedAt),
      ),
    ).toThrow(/binding mismatch/u);
    expect(() =>
      assertResourceWatchdogSupervisorFresh(
        status,
        { leaseId: status.leaseId, generation: status.generation, policy: status.policy },
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
    createLease(fixture, policy.policy);
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
    createLease(fixture, policy.policy);
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
  const leaseOptions: Omit<CreateDockerWorkloadLeaseOptions, 'bindings'> = {
    leaseId: `lease-${label}-001`,
    bundleId: `bundle-${label}-001`,
    generation: `generation-${label}-001`,
    runtimeKind: 'docker',
    dockerEndpoint: { host: 'unix:///var/run/docker.sock' },
    paths: {
      workspaceRoot: join(directory, 'workspace'),
      stateRoot,
      runtimeRoot: join(stateRoot, 'runtime'),
      apiRoot: join(stateRoot, 'api'),
      exchangeRoot: join(stateRoot, 'exchange'),
      stagingRoot: join(stateRoot, 'staging'),
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

function createLease(fixture: ReturnType<typeof supervisorFixture>, watchdogPolicy: ResourceWatchdogPolicy): void {
  createDockerWorkloadLease(fixture.paths.leasePath, {
    ...fixture.leaseOptions,
    bindings: { watchdogPolicy },
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
