import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stableStringify } from '../../src/hash.js';
import {
  activateDockerWorkloadLease,
  closeDockerWorkloadLease,
  createDockerWorkloadLease,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  recoverDockerWorkloadLeaseIncident,
  recordDockerWorkloadLeaseIncident,
  recordDockerWorkloadOuterResourceRemoval,
  requestDockerWorkloadOuterResource,
  revokeDockerWorkloadLease,
  type CreateDockerWorkloadLeaseOptions,
} from '../../src/docker-workload/bundle-lease.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Docker-workload bundle lease', () => {
  it('requires a captured endpoint for new Docker leases and persists its exact value', () => {
    const { path, options } = fixture();
    expect(() => createDockerWorkloadLease(path, { ...options, runtimeKind: 'docker' })).toThrow(
      /captured Docker endpoint/u,
    );
    const dockerEndpoint = { host: 'unix:///selected.sock' };
    createDockerWorkloadLease(path, { ...options, runtimeKind: 'docker', dockerEndpoint });
    expect(loadDockerWorkloadLease(path)).toMatchObject({ runtimeKind: 'docker', dockerEndpoint });
  });

  it('keeps legacy catalog-bearing v1 leases readable and cleanable without writing those fields to new leases', () => {
    const { path, options } = fixture();
    const created = createDockerWorkloadLease(path, options);
    expect(created).toMatchObject({ schemaVersion: 2, bindings: options.bindings });

    const legacy = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion: number;
      bindings: Record<string, unknown>;
    };
    legacy.schemaVersion = 1;
    legacy.bindings = { watchdogPolicySha256: '5'.repeat(64), catalogSha256: '2'.repeat(64) };
    writeFileSync(path, `${stableStringify(legacy)}\n`, { mode: 0o600 });
    expect(loadDockerWorkloadLease(path)).toMatchObject({ schemaVersion: 1, bindings: legacy.bindings });

    revokeDockerWorkloadLease(path, options.generation);
    const closed = closeDockerWorkloadLease(path, options.generation, {
      exactOuterResourcesAbsent: true,
      stateRootAbsent: true,
      inventories: [
        { capturedAt: '2026-07-20T12:00:00.000Z', ownedResourceIds: [] },
        { capturedAt: '2026-07-20T12:00:00.200Z', ownedResourceIds: [] },
      ],
    });
    expect(closed).toMatchObject({ schemaVersion: 1, status: 'closed', bindings: legacy.bindings });
  });

  it('durably records request before immutable observation and closes only after exact cleanup proof', () => {
    const { path, options } = fixture();
    expect(createDockerWorkloadLease(path, options)).toMatchObject({ status: 'admitting', sequence: 0 });
    const requested = requestDockerWorkloadOuterResource(path, options.generation, {
      requestId: 'daemon-sidecar',
      kind: 'container',
      role: 'nested-daemon',
      requestedName: 'ic-daemon-fixture',
      ownershipLabelKey: 'com.ironcurtain.docker-workload.generation',
    });
    expect(requested.resources[0]).toMatchObject({
      requestedName: 'ic-daemon-fixture',
      ownershipLabelValue: options.generation,
      observedId: null,
    });
    expect(() => activateDockerWorkloadLease(path, options.generation)).toThrow(/every requested.*observed/u);

    const immutableId = 'a'.repeat(64);
    observeDockerWorkloadOuterResource(path, options.generation, 'daemon-sidecar', immutableId);
    expect(activateDockerWorkloadLease(path, options.generation).status).toBe('active');
    revokeDockerWorkloadLease(path, options.generation);
    expect(() =>
      recordDockerWorkloadOuterResourceRemoval(path, options.generation, 'daemon-sidecar', {
        kind: 'requested-name-absent',
        identity: 'ic-daemon-fixture',
      }),
    ).toThrow(/immutable-ID/u);
    recordDockerWorkloadOuterResourceRemoval(path, options.generation, 'daemon-sidecar', {
      kind: 'immutable-id-absent',
      identity: immutableId,
    });
    const first = '2026-07-20T12:00:00.000Z';
    const second = '2026-07-20T12:00:00.200Z';
    expect(
      closeDockerWorkloadLease(path, options.generation, {
        exactOuterResourcesAbsent: true,
        stateRootAbsent: true,
        inventories: [
          { capturedAt: first, ownedResourceIds: [] },
          { capturedAt: second, ownedResourceIds: [] },
        ],
      }),
    ).toMatchObject({ status: 'closed', sequence: 6 });
    expect(loadDockerWorkloadLease(path).cleanup?.inventories[1].capturedAt).toBe(second);
  });

  it('recovers the create-before-observation window only through requested-name absence', () => {
    const { path, options } = fixture();
    createDockerWorkloadLease(path, options);
    requestDockerWorkloadOuterResource(path, options.generation, {
      requestId: 'isolated-network',
      kind: 'network',
      role: 'daemon-isolation',
      requestedName: 'ic-net-fixture',
      ownershipLabelKey: 'com.ironcurtain.docker-workload.generation',
    });
    revokeDockerWorkloadLease(path, options.generation);
    expect(() =>
      recordDockerWorkloadOuterResourceRemoval(path, options.generation, 'isolated-network', {
        kind: 'immutable-id-absent',
        identity: 'b'.repeat(64),
      }),
    ).toThrow(/requested-name/u);
    expect(
      recordDockerWorkloadOuterResourceRemoval(path, options.generation, 'isolated-network', {
        kind: 'requested-name-absent',
        identity: 'ic-net-fixture',
      }).resources[0].removal?.proof,
    ).toBe('requested-name-absent');
  });

  it('fails closed on generation mismatch, invalid transitions, or insufficient inventories', () => {
    const { path, options } = fixture();
    createDockerWorkloadLease(path, options);
    expect(() =>
      requestDockerWorkloadOuterResource(path, 'wrong-generation', {
        requestId: 'daemon-sidecar',
        kind: 'container',
        role: 'nested-daemon',
        requestedName: 'ic-daemon-fixture',
        ownershipLabelKey: 'com.ironcurtain.docker-workload.generation',
      }),
    ).toThrow(/generation mismatch/u);
    expect(() => revokeDockerWorkloadLease(path, options.generation)).not.toThrow();
    expect(() => activateDockerWorkloadLease(path, options.generation)).toThrow(/only an admitting/u);
    expect(() =>
      closeDockerWorkloadLease(path, options.generation, {
        exactOuterResourcesAbsent: true,
        stateRootAbsent: true,
        inventories: [
          { capturedAt: '2026-07-20T12:00:00.000Z', ownedResourceIds: [] },
          { capturedAt: '2026-07-20T12:00:00.050Z', ownedResourceIds: [] },
        ],
      }),
    ).toThrow(/not sufficiently separated/u);
  });

  it('preserves an incident through recovery and successful close', () => {
    const { path, options } = fixture();
    createDockerWorkloadLease(path, options);
    requestDockerWorkloadOuterResource(path, options.generation, {
      requestId: 'daemon-sidecar',
      kind: 'container',
      role: 'nested-daemon',
      requestedName: 'ic-daemon-fixture',
      ownershipLabelKey: 'com.ironcurtain.docker-workload.generation',
    });
    const incident = recordDockerWorkloadLeaseIncident(path, options.generation, {
      code: 'watchdog-loss',
      detail: 'detached watchdog heartbeat became stale',
    });
    const canonicalV1Bytes = readFileSync(path, 'utf8');
    expect(incident).toMatchObject({ status: 'incident', resources: [{ requestId: 'daemon-sidecar' }] });
    expect(() => revokeDockerWorkloadLease(path, options.generation)).toThrow(/incident/u);
    expect(loadDockerWorkloadLease(path).incident).toEqual(incident.incident);
    expect(readFileSync(path, 'utf8')).toBe(canonicalV1Bytes);

    const recovering = recoverDockerWorkloadLeaseIncident(path, options.generation);
    expect(recovering).toMatchObject({ status: 'revoking', incident: incident.incident });
    recordDockerWorkloadOuterResourceRemoval(path, options.generation, 'daemon-sidecar', {
      kind: 'requested-name-absent',
      identity: 'ic-daemon-fixture',
    });
    const closed = closeDockerWorkloadLease(path, options.generation, {
      exactOuterResourcesAbsent: true,
      stateRootAbsent: true,
      inventories: [
        { capturedAt: '2026-07-20T12:00:00.000Z', ownedResourceIds: [] },
        { capturedAt: '2026-07-20T12:00:00.200Z', ownedResourceIds: [] },
      ],
    });
    expect(closed).toMatchObject({ status: 'closed', incident: incident.incident, cleanup: { stateRootAbsent: true } });
  });

  it('never overwrites the original incident evidence', () => {
    const { path, options } = fixture();
    createDockerWorkloadLease(path, options);
    const original = recordDockerWorkloadLeaseIncident(path, options.generation, {
      code: 'original-loss',
      detail: 'first cleanup failure',
    }).incident;
    recoverDockerWorkloadLeaseIncident(path, options.generation);
    expect(() =>
      recordDockerWorkloadLeaseIncident(path, options.generation, {
        code: 'later-loss',
        detail: 'later cleanup failure',
      }),
    ).toThrow(/already has incident history/u);
    expect(loadDockerWorkloadLease(path).incident).toEqual(original);
  });

  it('requires canonical owner-only files and rejects symlink or non-canonical JSON substitution', () => {
    const { directory, path, options } = fixture();
    createDockerWorkloadLease(path, options);
    chmodSync(path, 0o644);
    expect(() => loadDockerWorkloadLease(path)).toThrow(/owner-only/u);
    chmodSync(path, 0o600);
    const link = join(directory, 'lease-link.json');
    symlinkSync(path, link);
    expect(() => loadDockerWorkloadLease(link)).toThrow(/non-symlink/u);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    expect(() => loadDockerWorkloadLease(path)).toThrow(/canonical JSON/u);
  });
});

function fixture(): {
  readonly directory: string;
  readonly path: string;
  readonly options: CreateDockerWorkloadLeaseOptions;
} {
  const directory = mkdtempSync(join(tmpdir(), 'docker-workload-lease-'));
  temporaryDirectories.push(directory);
  const options: CreateDockerWorkloadLeaseOptions = {
    leaseId: 'lease-fixture-001',
    bundleId: 'bundle-fixture-001',
    generation: 'generation-fixture-001',
    runtimeKind: 'apple-container',
    paths: {
      workspaceRoot: '/workspace/ironcurtain',
      stateRoot: '/private/tmp/ironcurtain-state',
      runtimeRoot: '/private/tmp/ironcurtain-runtime',
      apiRoot: '/private/tmp/ironcurtain-api',
      exchangeRoot: '/private/tmp/ironcurtain-exchange',
      stagingRoot: '/private/tmp/ironcurtain-staging',
    },
    bindings: {
      watchdogPolicy: {
        schemaVersion: 1,
        policyId: 'lease-policy-fixture',
        targetRoot: '/private/tmp/ironcurtain-state',
        targetDevice: 1,
        targetInode: 1,
        stateClasses: [{ id: 'daemon', relativePath: 'daemon', kind: 'directory', required: true }],
        sampleIntervalMs: 100,
        sampleTimeoutMs: 100,
        staleAfterMs: 300,
        softEvidenceBytes: 1024,
        hardSafetyBytes: 2048,
        hostReserveBytes: 1,
        maximumOvershootBytes: 1024,
        cleanupInventoryGapMs: 100,
      },
    },
    cleanupInventoryGapMs: 100,
    coordinatorPid: process.pid,
    now: new Date('2026-07-20T12:00:00.000Z'),
  };
  return { directory, path: join(directory, 'lease.json'), options };
}
