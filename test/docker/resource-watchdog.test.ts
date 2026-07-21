import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResourceWatchdog,
  sampleResourceState,
  type ResourceWatchdogPolicy,
  type ResourceWatchdogSample,
} from '../../src/docker/resource-watchdog.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('resource watchdog', () => {
  it('measures exact non-overlapping state classes without following symlinks', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'bundle'));
    writeFileSync(join(root, 'bundle', 'state.bin'), Buffer.alloc(4096, 1));
    symlinkSync('/private/tmp', join(root, 'bundle', 'outside-link'));
    const policy = makePolicy(root);
    const sample = sampleResourceState(policy, () => 1234);
    expect(sample.sampledAtMs).toBe(1234);
    expect(sample.classes).toHaveLength(2);
    expect(sample.classes.find((value) => value.id === 'bundle-state')?.allocatedBytes).toBeGreaterThan(0);
    expect(sample.classes.find((value) => value.id === 'optional-cache')).toMatchObject({
      exists: false,
      allocatedBytes: 0,
    });
  });

  it('attests a healthy first sample and records soft evidence without revocation', async () => {
    let now = 1000;
    const policy = syntheticPolicy();
    const sample = syntheticSample(policy, { allocatedBytes: 150 });
    const onTrip = vi.fn(async () => {});
    const onSoftEvidence = vi.fn();
    const watchdog = new ResourceWatchdog(policy, {
      sample: async () => sample,
      onTrip,
      onSoftEvidence,
      now: () => now,
      schedule: false,
    });
    const attestation = await watchdog.start();
    expect(attestation.policyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(onSoftEvidence).toHaveBeenCalledWith(sample);
    expect(onTrip).not.toHaveBeenCalled();
    now += 200;
    watchdog.assertFresh();
  });

  it.each([
    ['hard-state-threshold', { allocatedBytes: 201, availableBytes: 1000 }],
    ['host-reserve', { allocatedBytes: 10, availableBytes: 49 }],
  ] as const)('trips once on %s and invokes exact revocation', async (expectedCode, changes) => {
    const policy = syntheticPolicy();
    const onTrip = vi.fn(async () => {});
    const watchdog = new ResourceWatchdog(policy, {
      sample: async () => syntheticSample(policy, changes),
      onTrip,
      schedule: false,
    });
    await expect(watchdog.start()).rejects.toThrow(/failed startup attestation/u);
    expect(watchdog.trip?.code).toBe(expectedCode);
    expect(onTrip).toHaveBeenCalledTimes(1);
    await watchdog.tick();
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it('trips on target identity change and internally inconsistent class totals', async () => {
    const policy = syntheticPolicy();
    const onTrip = vi.fn(async () => {});
    const wrongIdentity = new ResourceWatchdog(policy, {
      sample: async () => syntheticSample(policy, { targetInode: 999 }),
      onTrip,
      schedule: false,
    });
    await expect(wrongIdentity.start()).rejects.toThrow();
    expect(wrongIdentity.trip?.code).toBe('target-identity');

    const inconsistent = syntheticSample(policy);
    const wrongTotal = new ResourceWatchdog(policy, {
      sample: async () => ({ ...inconsistent, allocatedBytes: 1 }),
      onTrip,
      schedule: false,
    });
    await expect(wrongTotal.start()).rejects.toThrow();
    expect(wrongTotal.trip?.code).toBe('sample-error');
  });

  it('trips on a sampling error', async () => {
    const policy = syntheticPolicy();
    const onTrip = vi.fn(async () => {});
    const watchdog = new ResourceWatchdog(policy, {
      sample: async () => {
        throw new Error('measurement failed');
      },
      onTrip,
      schedule: false,
    });
    await expect(watchdog.start()).rejects.toThrow(/measurement failed/u);
    expect(watchdog.trip?.code).toBe('sample-error');
  });

  it('trips when an in-flight sample becomes stale', async () => {
    const policy = syntheticPolicy();
    let now = 1000;
    let resolveSample: ((sample: ResourceWatchdogSample) => void) | undefined;
    const pendingSample = new Promise<ResourceWatchdogSample>((resolvePromise) => {
      resolveSample = resolvePromise;
    });
    const onTrip = vi.fn(async () => {});
    const watchdog = new ResourceWatchdog(policy, {
      sample: () => pendingSample,
      onTrip,
      now: () => now,
      schedule: false,
    });
    const startup = watchdog.start();
    await Promise.resolve();
    now += policy.staleAfterMs;
    await watchdog.tick();
    expect(watchdog.trip?.code).toBe('sample-stale');
    resolveSample?.(syntheticSample(policy));
    await expect(startup).rejects.toThrow(/failed startup attestation/u);
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed revocation instead of treating a trip as handled', async () => {
    const policy = syntheticPolicy();
    const watchdog = new ResourceWatchdog(policy, {
      sample: async () => syntheticSample(policy, { allocatedBytes: 250 }),
      onTrip: () => Promise.reject(new Error('outer runtime unavailable')),
      schedule: false,
    });
    await expect(watchdog.start()).rejects.toThrow(/revocation failed.*outer runtime unavailable/u);
    expect(watchdog.trip?.code).toBe('hard-state-threshold');
    expect(watchdog.revocationError).toBe('outer runtime unavailable');
  });

  it('refuses shutdown until exact deletion and two separated empty inventories', async () => {
    const policy = syntheticPolicy();
    const watchdog = new ResourceWatchdog(policy, {
      sample: async () => syntheticSample(policy),
      onTrip: async () => {},
      schedule: false,
    });
    await watchdog.start();
    expect(() =>
      watchdog.stopAfterCleanup({
        exactOuterResourceAbsent: true,
        stateRootAbsent: true,
        inventories: [
          { capturedAtMs: 1000, ownedResourceIds: [] },
          { capturedAtMs: 1099, ownedResourceIds: [] },
        ],
      }),
    ).toThrow(/not sufficiently separated/u);
    expect(() =>
      watchdog.stopAfterCleanup({
        exactOuterResourceAbsent: true,
        stateRootAbsent: true,
        inventories: [
          { capturedAtMs: 1000, ownedResourceIds: ['still-live'] },
          { capturedAtMs: 1200, ownedResourceIds: [] },
        ],
      }),
    ).toThrow(/two empty/u);
    watchdog.stopAfterCleanup({
      exactOuterResourceAbsent: true,
      stateRootAbsent: true,
      inventories: [
        { capturedAtMs: 1000, ownedResourceIds: [] },
        { capturedAtMs: 1200, ownedResourceIds: [] },
      ],
    });
    expect(() => watchdog.assertFresh()).toThrow(/stopped/u);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'resource-watchdog-'));
  temporaryDirectories.push(root);
  return root;
}

function makePolicy(root: string): ResourceWatchdogPolicy {
  const stats = lstatSync(root);
  return {
    ...syntheticPolicy(),
    targetRoot: root,
    targetDevice: stats.dev,
    targetInode: stats.ino,
    stateClasses: [
      { id: 'bundle-state', relativePath: 'bundle', kind: 'directory', required: true },
      { id: 'optional-cache', relativePath: 'cache', kind: 'directory', required: false },
    ],
  };
}

function syntheticPolicy(): ResourceWatchdogPolicy {
  return {
    schemaVersion: 1,
    policyId: 'apple-observed-disk-v1',
    targetRoot: '/private/tmp/watchdog-target',
    targetDevice: 10,
    targetInode: 20,
    stateClasses: [
      { id: 'bundle-state', relativePath: 'bundle', kind: 'directory', required: false },
      { id: 'optional-cache', relativePath: 'cache', kind: 'directory', required: false },
    ],
    sampleIntervalMs: 100,
    sampleTimeoutMs: 100,
    staleAfterMs: 300,
    softEvidenceBytes: 100,
    hardSafetyBytes: 200,
    hostReserveBytes: 50,
    maximumOvershootBytes: 25,
    cleanupInventoryGapMs: 100,
  };
}

function syntheticSample(
  policy: ResourceWatchdogPolicy,
  changes: Partial<ResourceWatchdogSample> = {},
): ResourceWatchdogSample {
  const allocatedBytes = changes.allocatedBytes ?? 150;
  const classes = policy.stateClasses.map((stateClass) => ({
    id: stateClass.id,
    path: join(policy.targetRoot, stateClass.relativePath),
    exists: false,
    allocatedBytes: stateClass.id === 'bundle-state' ? allocatedBytes : 0,
  }));
  return {
    sampledAtMs: 1000,
    targetDevice: policy.targetDevice,
    targetInode: policy.targetInode,
    availableBytes: 1000,
    allocatedBytes,
    classes,
    ...changes,
  };
}
