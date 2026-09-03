import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateDockerWorkloadLease,
  closeDockerWorkloadLease,
  createDockerWorkloadLease,
  heartbeatDockerWorkloadLease,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  requestDockerWorkloadOuterResource,
  revokeDockerWorkloadLease,
} from '../../src/docker-workload/bundle-lease.js';
import {
  performSerializedDockerWorkloadCleanup,
  tryHeartbeatDockerWorkloadLease,
} from '../../src/docker-workload/cleanup-ownership.js';
import { captureCleanupProof, removeExactBundleState } from '../../src/docker-workload/bundle-cleanup.js';
import { getBundleRuntimeRootForHome } from '../../src/config/paths.js';
import { createMockDocker } from '../helpers/docker-mocks.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Docker-workload lifecycle ownership', () => {
  it('cleans the deterministic runtime root for a canonical historical lease without a recorded binding', () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-historical-root-'));
    temporaryDirectories.push(directory);
    const ironCurtainHome = join(directory, 'home');
    const leaseId = 'lease-cleanup-historical-root-001';
    const bundleId = 'bundle-cleanup-historical-root-001';
    const leaseDirectory = join(ironCurtainHome, 'docker-workload', 'leases', leaseId);
    const leasePath = join(leaseDirectory, 'lease.json');
    const stateRoot = join(ironCurtainHome, 'docker-workload', 'state', leaseId);
    const workspaceRoot = join(directory, 'workspace');
    const bundleRuntimeRoot = getBundleRuntimeRootForHome(ironCurtainHome, bundleId);
    const neighborRuntimeRoot = getBundleRuntimeRootForHome(ironCurtainHome, 'neighbor-cleanup-historical-root-001');
    mkdirSync(leaseDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    mkdirSync(bundleRuntimeRoot, { recursive: true, mode: 0o700 });
    mkdirSync(neighborRuntimeRoot, { recursive: true, mode: 0o700 });
    createDockerWorkloadLease(leasePath, {
      leaseId,
      bundleId,
      generation: 'generation-cleanup-historical-root-001',
      runtimeKind: 'docker',
      paths: {
        workspaceRoot,
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
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
    });

    removeExactBundleState(loadDockerWorkloadLease(leasePath), leasePath);

    expect(existsSync(stateRoot)).toBe(false);
    expect(existsSync(bundleRuntimeRoot)).toBe(false);
    expect(existsSync(workspaceRoot)).toBe(true);
    expect(existsSync(neighborRuntimeRoot)).toBe(true);
    expect(existsSync(leasePath)).toBe(true);
  });

  it('returns an already-closed proof even when no cleanup budget remains', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-closed-budget-'));
    temporaryDirectories.push(directory);
    const controlDir = join(directory, 'control');
    const leasePath = join(controlDir, 'lease.json');
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(controlDir, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const generation = 'generation-cleanup-closed-budget-001';
    const initial = new Date('2026-07-20T12:00:00.000Z');
    createDockerWorkloadLease(leasePath, {
      leaseId: 'lease-cleanup-closed-budget-001',
      bundleId: 'bundle-cleanup-closed-budget-001',
      generation,
      runtimeKind: 'apple-container',
      paths: {
        workspaceRoot,
        stateRoot: join(directory, 'absent-state'),
        runtimeRoot: join(directory, 'absent-state', 'runtime'),
        apiRoot: join(directory, 'absent-state', 'api'),
        exchangeRoot: join(directory, 'absent-state', 'exchange'),
        stagingRoot: join(directory, 'absent-state', 'staging'),
      },
      bindings: {
        catalogSha256: '2'.repeat(64),
        innerDockerCatalogSha256: '7'.repeat(64),
        profileSha256: '3'.repeat(64),
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
      now: initial,
    });
    revokeDockerWorkloadLease(leasePath, generation, initial);
    const cleanup = {
      exactOuterResourcesAbsent: true as const,
      stateRootAbsent: true as const,
      inventories: [
        { capturedAt: '2026-07-20T12:00:00.000Z', ownedResourceIds: [] },
        { capturedAt: '2026-07-20T12:00:00.100Z', ownedResourceIds: [] },
      ] as const,
    };
    closeDockerWorkloadLease(leasePath, generation, cleanup, new Date('2026-07-20T12:00:00.100Z'));
    const listContainers = vi.fn(async () => []);

    await expect(
      performSerializedDockerWorkloadCleanup({
        runtime: { ...createMockDocker(), listContainers },
        leasePath,
        generation,
        targetDevice: 0,
        targetInode: 0,
        gapMs: 100,
        clock: () => new Date('2026-07-20T12:00:10.000Z'),
        sleep: async () => {},
        waitForOwner: true,
        timeoutMs: 0,
      }),
    ).resolves.toEqual({ alreadyClosed: true, cleanup });
    expect(listContainers).not.toHaveBeenCalled();
  });

  it('does not start another destructive phase after the cooperative cleanup budget expires', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-budget-'));
    temporaryDirectories.push(directory);
    const controlDir = join(directory, 'control');
    const leasePath = join(controlDir, 'lease.json');
    const stateRoot = join(directory, 'state');
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(controlDir, { mode: 0o700 });
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const target = lstatSync(stateRoot);
    const generation = 'generation-cleanup-budget-001';
    const initialMs = Date.parse('2026-07-20T12:00:00.000Z');
    createDockerWorkloadLease(leasePath, {
      leaseId: 'lease-cleanup-budget-001',
      bundleId: 'bundle-cleanup-budget-001',
      generation,
      runtimeKind: 'apple-container',
      paths: {
        workspaceRoot,
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
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
      now: new Date(initialMs),
    });
    requestDockerWorkloadOuterResource(leasePath, generation, {
      requestId: 'resource-cleanup-budget-001',
      kind: 'container',
      role: 'agent',
      requestedName: 'ic-cleanup-budget',
      ownershipLabelKey: 'com.ironcurtain.docker-workload.generation',
    });
    observeDockerWorkloadOuterResource(
      leasePath,
      generation,
      'resource-cleanup-budget-001',
      'container-cleanup-budget-001',
    );
    activateDockerWorkloadLease(leasePath, generation);

    let currentMs = initialMs;
    const stop = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const listContainers = vi.fn(async () => {
      currentMs += 101;
      return [
        {
          id: 'container-cleanup-budget-001',
          name: 'ic-cleanup-budget',
          created: new Date(initialMs).toISOString(),
          running: true,
          labels: { 'com.ironcurtain.docker-workload.generation': generation },
        },
      ];
    });
    const runtime = { ...createMockDocker(), stop, remove, listContainers };

    await expect(
      performSerializedDockerWorkloadCleanup({
        runtime,
        leasePath,
        generation,
        targetDevice: target.dev,
        targetInode: target.ino,
        gapMs: 100,
        clock: () => new Date(currentMs),
        sleep: async (milliseconds) => {
          currentMs += milliseconds;
        },
        waitForOwner: true,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/cooperative bound/u);

    expect(listContainers).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(loadDockerWorkloadLease(leasePath).status).toBe('incident');
  });

  it('timestamps cleanup inventories only after each authoritative inventory completes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-timestamp-'));
    temporaryDirectories.push(directory);
    const controlDir = join(directory, 'control');
    const leasePath = join(controlDir, 'lease.json');
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(controlDir, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const generation = 'generation-cleanup-timestamp-001';
    const initialMs = Date.parse('2026-07-20T12:00:00.000Z');
    createDockerWorkloadLease(leasePath, {
      leaseId: 'lease-cleanup-timestamp-001',
      bundleId: 'bundle-cleanup-timestamp-001',
      generation,
      runtimeKind: 'apple-container',
      paths: {
        workspaceRoot,
        stateRoot: join(directory, 'absent-state'),
        runtimeRoot: join(directory, 'absent-state', 'runtime'),
        apiRoot: join(directory, 'absent-state', 'api'),
        exchangeRoot: join(directory, 'absent-state', 'exchange'),
        stagingRoot: join(directory, 'absent-state', 'staging'),
      },
      bindings: {
        catalogSha256: '2'.repeat(64),
        innerDockerCatalogSha256: '7'.repeat(64),
        profileSha256: '3'.repeat(64),
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
      now: new Date(initialMs),
    });

    let currentMs = initialMs;
    let inventoryCalls = 0;
    const runtime = {
      ...createMockDocker(),
      async listContainers() {
        inventoryCalls += 1;
        currentMs += inventoryCalls === 1 ? 30_000 : 5_000;
        return [];
      },
    };
    const proof = await captureCleanupProof(
      runtime,
      loadDockerWorkloadLease(leasePath),
      100,
      () => new Date(currentMs),
      async (milliseconds) => {
        currentMs += milliseconds;
      },
    );

    expect(inventoryCalls).toBe(2);
    expect(proof.inventories).toEqual([
      { capturedAt: '2026-07-20T12:00:30.000Z', ownedResourceIds: [] },
      { capturedAt: '2026-07-20T12:00:35.100Z', ownedResourceIds: [] },
    ]);
  });

  it('records an incident when authoritative inventory remains unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-inventory-failure-'));
    temporaryDirectories.push(directory);
    const controlDir = join(directory, 'control');
    const leasePath = join(controlDir, 'lease.json');
    const stateRoot = join(directory, 'state');
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(controlDir, { mode: 0o700 });
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const target = lstatSync(stateRoot);
    const generation = 'generation-cleanup-inventory-failure-001';
    const initialMs = Date.parse('2026-07-20T12:00:00.000Z');
    createDockerWorkloadLease(leasePath, {
      leaseId: 'lease-cleanup-inventory-failure-001',
      bundleId: 'bundle-cleanup-inventory-failure-001',
      generation,
      runtimeKind: 'apple-container',
      paths: {
        workspaceRoot,
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
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
      now: new Date(initialMs),
    });
    let currentMs = initialMs;
    const runtime = {
      ...createMockDocker(),
      async listContainers(): Promise<never> {
        throw new Error('authoritative Apple inventory timed out twice');
      },
    };

    await expect(
      performSerializedDockerWorkloadCleanup({
        runtime,
        leasePath,
        generation,
        targetDevice: target.dev,
        targetInode: target.ino,
        gapMs: 100,
        clock: () => new Date(currentMs),
        sleep: async (milliseconds) => {
          currentMs += milliseconds;
        },
        waitForOwner: true,
      }),
    ).rejects.toThrow(/timed out twice/u);
    expect(loadDockerWorkloadLease(leasePath)).toMatchObject({
      status: 'incident',
      incident: {
        code: 'docker-workload-cleanup-failed',
        detail: 'authoritative Apple inventory timed out twice',
      },
      cleanup: null,
    });
  });

  it('blocks a heartbeat after stale revalidation until cleanup has durably closed the lease', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-owner-'));
    temporaryDirectories.push(directory);
    const leasePath = join(directory, 'control', 'lease.json');
    const stateRoot = join(directory, 'state');
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(join(directory, 'control'), { mode: 0o700 });
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const target = lstatSync(stateRoot);
    const generation = 'generation-cleanup-owner-001';
    const initialHeartbeat = '2026-07-20T12:00:00.000Z';
    createDockerWorkloadLease(leasePath, {
      leaseId: 'lease-cleanup-owner-001',
      bundleId: 'bundle-cleanup-owner-001',
      generation,
      runtimeKind: 'docker',
      paths: {
        workspaceRoot,
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
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
      now: new Date(initialHeartbeat),
    });
    let currentMs = Date.parse(initialHeartbeat);
    let heartbeatAttempted = false;
    let heartbeatAccepted = true;
    let revokingHeartbeatError: unknown;
    const runtime = {
      ...createMockDocker(),
      async listContainers() {
        return [];
      },
      async listNetworks() {
        return [];
      },
    };

    await performSerializedDockerWorkloadCleanup({
      runtime,
      leasePath,
      generation,
      targetDevice: target.dev,
      targetInode: target.ino,
      gapMs: 100,
      clock: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        currentMs += milliseconds;
      },
      waitForOwner: true,
      revalidate: (lease) => expect(lease.coordinator.heartbeatAt).toBe(initialHeartbeat),
      afterRevalidate: () => {
        currentMs += 1_000;
        heartbeatAttempted = true;
        heartbeatAccepted = tryHeartbeatDockerWorkloadLease({
          leasePath,
          generation,
          clock: () => new Date(currentMs),
        });
        expect(loadDockerWorkloadLease(leasePath).coordinator.heartbeatAt).toBe(initialHeartbeat);
      },
      onRevoking: () => {
        try {
          heartbeatDockerWorkloadLease(leasePath, generation, new Date(currentMs));
        } catch (error) {
          revokingHeartbeatError = error;
        }
      },
    });

    expect(heartbeatAttempted).toBe(true);
    expect(heartbeatAccepted).toBe(false);
    expect(revokingHeartbeatError).toEqual(expect.objectContaining({ message: expect.stringMatching(/revoking/u) }));
    expect(loadDockerWorkloadLease(leasePath)).toMatchObject({
      status: 'closed',
      coordinator: { heartbeatAt: initialHeartbeat },
    });
  });
});
