/** Exact host-authoritative outer-resource revocation for a bundle lease. */

import type { ContainerRuntime, DockerContainerInfo } from '../docker/types.js';
import {
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  recordDockerWorkloadOuterResourceRemoval,
  revokeDockerWorkloadLease,
  type DockerWorkloadLease,
  type DockerWorkloadOuterResource,
} from './bundle-lease.js';

export interface DockerWorkloadRevocationResult {
  readonly removedResourceIds: readonly string[];
  readonly finalOwnedResourceIds: readonly string[];
}

/**
 * Revoke only resources whose immutable ID/name and generation label match the
 * host-only lease. The create-before-observation crash window is resolved by
 * the precommitted random name plus the exact generation label, then promoted
 * to an immutable-ID record before deletion.
 */
export async function revokeDockerWorkloadOuterResources(
  runtime: ContainerRuntime,
  leasePath: string,
  generation: string,
  now: () => Date = () => new Date(),
): Promise<DockerWorkloadRevocationResult> {
  let lease = loadDockerWorkloadLease(leasePath);
  if (lease.generation !== generation) throw new Error('Docker-workload revocation generation mismatch');
  if (lease.status === 'admitting' || lease.status === 'active') {
    lease = revokeDockerWorkloadLease(leasePath, generation, now());
  } else if (lease.status !== 'revoking') {
    throw new Error(`Docker-workload revocation cannot run for terminal lease: ${lease.status}`);
  }
  if (runtime.listContainers === undefined) {
    throw new Error('selected outer runtime cannot inventory containers for exact revocation');
  }

  const removedResourceIds: string[] = [];
  const ordered = [...lease.resources].sort(compareRevocationOrder);
  for (const snapshot of ordered) {
    const current = requiredResource(loadDockerWorkloadLease(leasePath), snapshot.requestId);
    if (current.removal !== null) continue;
    if (current.kind === 'container') {
      const removed = await revokeContainer(runtime, leasePath, generation, current, now);
      removedResourceIds.push(removed);
    } else {
      const removed = await revokeNetwork(runtime, leasePath, generation, current, now);
      removedResourceIds.push(removed);
    }
  }

  const finalLease = loadDockerWorkloadLease(leasePath);
  const finalOwnedResourceIds = await inventoryOwnedResourceIds(runtime, finalLease);
  if (finalOwnedResourceIds.length !== 0) {
    throw new Error(`Docker-workload revocation left owned outer resources: ${finalOwnedResourceIds.join(',')}`);
  }
  return { removedResourceIds, finalOwnedResourceIds };
}

export async function inventoryOwnedResourceIds(
  runtime: ContainerRuntime,
  lease: DockerWorkloadLease,
): Promise<readonly string[]> {
  if (runtime.listContainers === undefined) {
    throw new Error('selected outer runtime cannot inventory containers for cleanup proof');
  }
  const containers = await runtime.listContainers();
  assertUniqueInventory(containers, 'container');
  const ownershipTuples = new Set(
    lease.resources.map((resource) => `${resource.ownershipLabelKey}\0${resource.ownershipLabelValue}`),
  );
  const ids = containers
    .filter((container) =>
      [...ownershipTuples].some((tuple) => {
        const [key, value] = tuple.split('\0');
        return container.labels[key] === value;
      }),
    )
    .map((container) => container.id);
  if (lease.resources.some((resource) => resource.kind === 'network')) {
    if (runtime.listNetworks === undefined) {
      throw new Error('selected outer runtime cannot inventory networks for cleanup proof');
    }
    const networks = await runtime.listNetworks();
    assertUniqueInventory(networks, 'network');
    ids.push(
      ...networks
        .filter((network) =>
          [...ownershipTuples].some((tuple) => {
            const [key, value] = tuple.split('\0');
            return network.labels[key] === value;
          }),
        )
        .map((network) => network.id),
    );
  }
  return [...ids].sort();
}

async function revokeContainer(
  runtime: ContainerRuntime,
  leasePath: string,
  generation: string,
  resource: DockerWorkloadOuterResource,
  now: () => Date,
): Promise<string> {
  const inventory = await requiredContainerInventory(runtime);
  let observedId = resource.observedId;
  if (observedId === null) {
    const matching = inventory.filter((container) => container.name === resource.requestedName);
    if (matching.length > 1)
      throw new Error(`outer runtime returned duplicate container name: ${resource.requestedName}`);
    const discovered = matching.at(0);
    if (discovered === undefined) {
      recordDockerWorkloadOuterResourceRemoval(
        leasePath,
        generation,
        resource.requestId,
        { kind: 'requested-name-absent', identity: resource.requestedName },
        now(),
      );
      return resource.requestedName;
    }
    assertOwnership(discovered, resource);
    observedId = discovered.id;
    observeDockerWorkloadOuterResource(leasePath, generation, resource.requestId, observedId, now());
  } else {
    const observed = inventory.find((container) => container.id === observedId);
    if (observed === undefined) {
      recordDockerWorkloadOuterResourceRemoval(
        leasePath,
        generation,
        resource.requestId,
        { kind: 'immutable-id-absent', identity: observedId },
        now(),
      );
      return observedId;
    }
    if (observed.name !== resource.requestedName) {
      throw new Error(`observed container name changed for immutable ID ${observedId}`);
    }
    assertOwnership(observed, resource);
  }

  await runtime.stop(observedId);
  await runtime.remove(observedId);
  if (await runtime.containerExists(observedId)) {
    throw new Error(`exact outer container still exists after revocation: ${observedId}`);
  }
  recordDockerWorkloadOuterResourceRemoval(
    leasePath,
    generation,
    resource.requestId,
    { kind: 'immutable-id-absent', identity: observedId },
    now(),
  );
  return observedId;
}

async function revokeNetwork(
  runtime: ContainerRuntime,
  leasePath: string,
  generation: string,
  resource: DockerWorkloadOuterResource,
  now: () => Date,
): Promise<string> {
  if (runtime.listNetworks === undefined) {
    throw new Error('selected outer runtime cannot inventory networks for exact revocation');
  }
  const inventory = await runtime.listNetworks();
  assertUniqueInventory(inventory, 'network');
  let observedId = resource.observedId;
  if (observedId === null) {
    const matching = inventory.filter((network) => network.name === resource.requestedName);
    if (matching.length > 1)
      throw new Error(`outer runtime returned duplicate network name: ${resource.requestedName}`);
    const discovered = matching.at(0);
    if (discovered === undefined) {
      recordDockerWorkloadOuterResourceRemoval(
        leasePath,
        generation,
        resource.requestId,
        { kind: 'requested-name-absent', identity: resource.requestedName },
        now(),
      );
      return resource.requestedName;
    }
    assertOwnership(discovered, resource);
    observedId = discovered.id;
    observeDockerWorkloadOuterResource(leasePath, generation, resource.requestId, observedId, now());
  } else {
    const observed = inventory.find((network) => network.id === observedId);
    if (observed === undefined) {
      recordDockerWorkloadOuterResourceRemoval(
        leasePath,
        generation,
        resource.requestId,
        { kind: 'immutable-id-absent', identity: observedId },
        now(),
      );
      return observedId;
    }
    if (observed.name !== resource.requestedName) {
      throw new Error(`observed network name changed for immutable ID ${observedId}`);
    }
    assertOwnership(observed, resource);
  }

  await runtime.removeNetwork(observedId);
  const after = await runtime.listNetworks();
  assertUniqueInventory(after, 'network');
  if (after.some((network) => network.id === observedId)) {
    throw new Error(`exact outer network still exists after revocation: ${observedId}`);
  }
  recordDockerWorkloadOuterResourceRemoval(
    leasePath,
    generation,
    resource.requestId,
    { kind: 'immutable-id-absent', identity: observedId },
    now(),
  );
  return observedId;
}

async function requiredContainerInventory(runtime: ContainerRuntime): Promise<readonly DockerContainerInfo[]> {
  if (runtime.listContainers === undefined) throw new Error('selected outer runtime cannot inventory containers');
  const inventory = await runtime.listContainers();
  assertUniqueInventory(inventory, 'container');
  return inventory;
}

function assertOwnership(
  resource: { readonly id: string; readonly labels: Readonly<Record<string, string>> },
  request: DockerWorkloadOuterResource,
): void {
  if (resource.labels[request.ownershipLabelKey] !== request.ownershipLabelValue) {
    throw new Error(`refusing to revoke outer resource with wrong generation label: ${resource.id}`);
  }
}

function assertUniqueInventory(
  resources: readonly { readonly id: string; readonly name: string }[],
  kind: string,
): void {
  if (resources.some((resource) => resource.id === '' || resource.name === '')) {
    throw new Error(`outer runtime returned incomplete ${kind} inventory`);
  }
  if (new Set(resources.map((resource) => resource.id)).size !== resources.length) {
    throw new Error(`outer runtime returned duplicate ${kind} immutable ID`);
  }
}

function requiredResource(lease: DockerWorkloadLease, requestId: string): DockerWorkloadOuterResource {
  const resource = lease.resources.find((candidate) => candidate.requestId === requestId);
  if (resource === undefined) throw new Error(`Docker-workload lease lost outer-resource request: ${requestId}`);
  return resource;
}

function compareRevocationOrder(left: DockerWorkloadOuterResource, right: DockerWorkloadOuterResource): number {
  if (left.kind !== right.kind) return left.kind === 'container' ? -1 : 1;
  const priorities = new Map([
    ['agent', 0],
    ['nested-daemon', 1],
    ['fixed-relay', 2],
    ['proxy', 3],
  ]);
  return (priorities.get(left.role) ?? 100) - (priorities.get(right.role) ?? 100);
}
