import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inventoryOwnedResourceIds,
  revokeDockerWorkloadOuterResources,
} from '../../src/docker-workload/bundle-revocation.js';
import {
  activateDockerWorkloadLease,
  createDockerWorkloadLease,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  requestDockerWorkloadOuterResource,
  type CreateDockerWorkloadLeaseOptions,
} from '../../src/docker-workload/bundle-lease.js';
import type { DockerContainerInfo, DockerNetworkInfo } from '../../src/docker/types.js';
import { createMockDocker } from '../helpers/docker-mocks.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Docker-workload exact outer-resource revocation', () => {
  it('deletes observed immutable IDs in container-before-network order and preserves foreign resources', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    request(fixture, 'isolated-network', 'network', 'daemon-isolation', 'ic-network');
    observeDockerWorkloadOuterResource(fixture.path, fixture.options.generation, 'daemon-sidecar', 'container-owned');
    observeDockerWorkloadOuterResource(fixture.path, fixture.options.generation, 'isolated-network', 'network-owned');
    activateDockerWorkloadLease(fixture.path, fixture.options.generation);

    const state = runtimeState(
      fixture.options.generation,
      [
        container('container-owned', 'ic-daemon', fixture.options.generation),
        container('container-foreign', 'unrelated', 'foreign-generation'),
      ],
      [
        network('network-owned', 'ic-network', fixture.options.generation),
        network('network-foreign', 'unrelated-network', 'foreign-generation'),
      ],
    );
    const result = await revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation);
    expect(result).toEqual({
      removedResourceIds: ['container-owned', 'network-owned'],
      finalOwnedResourceIds: [],
    });
    expect(state.calls).toEqual(['stop:container-owned', 'remove:container-owned', 'remove-network:network-owned']);
    expect(state.containers.map((value) => value.id)).toEqual(['container-foreign']);
    expect(state.networks.map((value) => value.id)).toEqual(['network-foreign']);
    expect(loadDockerWorkloadLease(fixture.path).resources.every((resource) => resource.removal !== null)).toBe(true);
  });

  it('recovers the create-before-observation window by exact name plus generation, then records the ID', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    const state = runtimeState(fixture.options.generation, [
      container('recovered-container-id', 'ic-daemon', fixture.options.generation),
    ]);

    await revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation);
    expect(loadDockerWorkloadLease(fixture.path).resources[0]).toMatchObject({
      observedId: 'recovered-container-id',
      removal: { proof: 'immutable-id-absent', identity: 'recovered-container-id' },
    });
  });

  it('records requested-name absence when a crash happened before runtime creation', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    const state = runtimeState(fixture.options.generation, []);
    await revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation);
    expect(loadDockerWorkloadLease(fixture.path).resources[0].removal).toMatchObject({
      proof: 'requested-name-absent',
      identity: 'ic-daemon',
    });
  });

  it('refuses a colliding foreign name and never calls remove', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    const state = runtimeState(fixture.options.generation, [container('foreign-id', 'ic-daemon', 'wrong-generation')]);
    await expect(
      revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation),
    ).rejects.toThrow(/wrong generation label/u);
    expect(state.calls).toEqual([]);
    expect(state.containers).toHaveLength(1);
    expect(loadDockerWorkloadLease(fixture.path).resources[0].removal).toBeNull();
  });

  it('does not claim cleanup when the runtime silently fails to remove an exact ID', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    observeDockerWorkloadOuterResource(fixture.path, fixture.options.generation, 'daemon-sidecar', 'container-owned');
    activateDockerWorkloadLease(fixture.path, fixture.options.generation);
    const state = runtimeState(fixture.options.generation, [
      container('container-owned', 'ic-daemon', fixture.options.generation),
    ]);
    state.removeFails = true;
    let failOpenExistsCalls = 0;
    state.runtime.containerExists = async () => {
      failOpenExistsCalls += 1;
      return false;
    };
    await expect(
      revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation),
    ).rejects.toThrow(/still exists/u);
    expect(failOpenExistsCalls).toBe(0);
    expect(loadDockerWorkloadLease(fixture.path).resources[0].removal).toBeNull();
    await expect(inventoryOwnedResourceIds(state.runtime, loadDockerWorkloadLease(fixture.path))).resolves.toEqual([
      'container-owned',
    ]);
  });

  it('does not record immutable-ID absence when the authoritative post-remove inventory fails', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    observeDockerWorkloadOuterResource(fixture.path, fixture.options.generation, 'daemon-sidecar', 'container-owned');
    activateDockerWorkloadLease(fixture.path, fixture.options.generation);
    const state = runtimeState(fixture.options.generation, [
      container('container-owned', 'ic-daemon', fixture.options.generation),
    ]);
    const listContainers = state.runtime.listContainers.bind(state.runtime);
    let inventoryCalls = 0;
    state.runtime.listContainers = async () => {
      inventoryCalls += 1;
      if (inventoryCalls === 2) throw new Error('scripted post-remove inventory timeout');
      return listContainers();
    };

    await expect(
      revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation),
    ).rejects.toThrow(/post-remove inventory timeout/u);
    expect(state.containers).toEqual([]);
    expect(loadDockerWorkloadLease(fixture.path).resources[0].removal).toBeNull();
  });
});

function leaseFixture(): {
  readonly path: string;
  readonly options: CreateDockerWorkloadLeaseOptions;
} {
  const directory = mkdtempSync(join(tmpdir(), 'docker-workload-revocation-'));
  temporaryDirectories.push(directory);
  return {
    path: join(directory, 'lease.json'),
    options: {
      leaseId: 'lease-revocation-001',
      bundleId: 'bundle-revocation-001',
      generation: 'generation-revocation-001',
      runtimeKind: 'docker',
      paths: {
        workspaceRoot: '/workspace/repository',
        stateRoot: '/private/tmp/ic-state',
        runtimeRoot: '/private/tmp/ic-runtime',
        apiRoot: '/private/tmp/ic-api',
        exchangeRoot: '/private/tmp/ic-exchange',
        stagingRoot: '/private/tmp/ic-staging',
      },
      bindings: {
        catalogSha256: '2'.repeat(64),
        innerDockerCatalogSha256: '7'.repeat(64),
        profileSha256: '3'.repeat(64),
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
      now: new Date('2026-07-20T12:00:00.000Z'),
    },
  };
}

function request(
  fixture: ReturnType<typeof leaseFixture>,
  requestId: string,
  kind: 'container' | 'network',
  role: string,
  requestedName: string,
): void {
  requestDockerWorkloadOuterResource(fixture.path, fixture.options.generation, {
    requestId,
    kind,
    role,
    requestedName,
    ownershipLabelKey: 'com.ironcurtain.docker-workload.generation',
  });
}

function container(id: string, name: string, generation: string): DockerContainerInfo {
  return {
    id,
    name,
    created: '2026-07-20T12:00:00Z',
    running: true,
    labels: { 'com.ironcurtain.docker-workload.generation': generation },
  };
}

function network(id: string, name: string, generation: string): DockerNetworkInfo {
  return {
    id,
    name,
    created: '2026-07-20T12:00:00Z',
    labels: { 'com.ironcurtain.docker-workload.generation': generation },
    subnets: [],
    containerIds: [],
  };
}

function runtimeState(
  _generation: string,
  initialContainers: readonly DockerContainerInfo[],
  initialNetworks: readonly DockerNetworkInfo[] = [],
) {
  const containers = structuredClone(initialContainers) as DockerContainerInfo[];
  const networks = structuredClone(initialNetworks) as DockerNetworkInfo[];
  const calls: string[] = [];
  const state = {
    containers,
    networks,
    calls,
    removeFails: false,
    runtime: {
      ...createMockDocker(),
      async listContainers() {
        return structuredClone(containers);
      },
      async listNetworks() {
        return structuredClone(networks);
      },
      async stop(id: string) {
        calls.push(`stop:${id}`);
      },
      async remove(id: string) {
        calls.push(`remove:${id}`);
        if (!state.removeFails) {
          const index = containers.findIndex((containerValue) => containerValue.id === id);
          if (index !== -1) containers.splice(index, 1);
        }
      },
      async containerExists(id: string) {
        return containers.some((containerValue) => containerValue.id === id);
      },
      async removeNetwork(id: string) {
        calls.push(`remove-network:${id}`);
        const index = networks.findIndex((networkValue) => networkValue.id === id);
        if (index !== -1) networks.splice(index, 1);
      },
    },
  };
  return state;
}
