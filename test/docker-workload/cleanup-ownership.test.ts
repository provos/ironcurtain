import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDockerWorkloadLease,
  heartbeatDockerWorkloadLease,
  loadDockerWorkloadLease,
} from '../../src/docker-workload/bundle-lease.js';
import {
  performSerializedDockerWorkloadCleanup,
  tryHeartbeatDockerWorkloadLease,
} from '../../src/docker-workload/cleanup-ownership.js';
import { captureCleanupProof } from '../../src/docker-workload/bundle-cleanup.js';
import { createMockDocker } from '../helpers/docker-mocks.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Docker-workload lifecycle ownership', () => {
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
