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
 * the precommitted caller-selected name plus the exact generation label, then promoted
 * to an immutable-ID record before deletion.
 */
export async function revokeDockerWorkloadOuterResources(
  runtime: ContainerRuntime,
  leasePath: string,
  generation: string,
  now: () => Date = () => new Date(),
  assertBudget: () => void = () => {},
): Promise<DockerWorkloadRevocationResult> {
  assertBudget();
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
      const removed = await revokeContainer(runtime, leasePath, generation, current, now, assertBudget);
      removedResourceIds.push(removed);
    } else if (current.kind === 'network') {
      const removed = await revokeNetwork(runtime, leasePath, generation, current, now, assertBudget);
      removedResourceIds.push(removed);
    } else {
      const removed = await revokeVolume(runtime, leasePath, generation, current, now, assertBudget);
      removedResourceIds.push(removed);
    }
  }

  const finalLease = loadDockerWorkloadLease(leasePath);
  const finalOwnedResourceIds = await inventoryOwnedResourceIds(runtime, finalLease, assertBudget);
  if (finalOwnedResourceIds.length !== 0) {
    throw new Error(`Docker-workload revocation left owned outer resources: ${finalOwnedResourceIds.join(',')}`);
  }
  return { removedResourceIds, finalOwnedResourceIds };
}

export async function inventoryOwnedResourceIds(
  runtime: ContainerRuntime,
  lease: DockerWorkloadLease,
  assertBudget: () => void = () => {},
): Promise<readonly string[]> {
  if (runtime.listContainers === undefined) {
    throw new Error('selected outer runtime cannot inventory containers for cleanup proof');
  }
  assertBudget();
  const containers = await runtime.listContainers();
  assertBudget();
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
    assertBudget();
    const networks = await runtime.listNetworks();
    assertBudget();
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
  if (lease.resources.some((resource) => resource.kind === 'volume')) {
    if (runtime.listVolumes === undefined) {
      throw new Error('selected outer runtime cannot inventory volumes for cleanup proof');
    }
    assertBudget();
    const volumes = await runtime.listVolumes();
    assertBudget();
    assertUniqueInventory(volumes, 'volume');
    ids.push(
      ...volumes
        .filter((volume) =>
          [...ownershipTuples].some((tuple) => {
            const [key, value] = tuple.split('\0');
            return volume.labels[key] === value;
          }),
        )
        .map((volume) => volume.id),
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
  assertBudget: () => void,
): Promise<string> {
  const inventory = await requiredContainerInventory(runtime, assertBudget);
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

  assertBudget();
  await runtime.stop(observedId);
  assertBudget();
  await runtime.remove(observedId);
  assertBudget();
  const afterRemoval = await requiredContainerInventory(runtime, assertBudget);
  if (afterRemoval.some((container) => container.id === observedId)) {
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
  assertBudget: () => void,
): Promise<string> {
  if (runtime.listNetworks === undefined) {
    throw new Error('selected outer runtime cannot inventory networks for exact revocation');
  }
  const listNetworks = runtime.listNetworks.bind(runtime);
  return revokeNamedResource({
    kind: 'network',
    leasePath,
    generation,
    resource,
    now,
    assertBudget,
    list: listNetworks,
    remove: (id) => runtime.removeNetwork(id),
  });
}

async function revokeVolume(
  runtime: ContainerRuntime,
  leasePath: string,
  generation: string,
  resource: DockerWorkloadOuterResource,
  now: () => Date,
  assertBudget: () => void,
): Promise<string> {
  if (runtime.listVolumes === undefined || runtime.removeVolume === undefined) {
    throw new Error('selected outer runtime cannot inventory and remove volumes for exact revocation');
  }
  const listVolumes = runtime.listVolumes.bind(runtime);
  const removeVolume = runtime.removeVolume.bind(runtime);
  return revokeNamedResource({
    kind: 'volume',
    leasePath,
    generation,
    resource,
    now,
    assertBudget,
    list: listVolumes,
    remove: removeVolume,
  });
}

interface RevokeNamedResourceOptions {
  readonly kind: 'network' | 'volume';
  readonly leasePath: string;
  readonly generation: string;
  readonly resource: DockerWorkloadOuterResource;
  readonly now: () => Date;
  readonly assertBudget: () => void;
  readonly list: () => Promise<readonly NamedResourceInfo[]>;
  readonly remove: (id: string) => Promise<void>;
}

interface NamedResourceInfo {
  readonly id: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

async function revokeNamedResource(options: RevokeNamedResourceOptions): Promise<string> {
  const { kind, leasePath, generation, resource, now, assertBudget, list, remove } = options;
  const inventory = await requiredNamedResourceInventory(kind, list, assertBudget);
  let observedId = resource.observedId;
  if (observedId === null) {
    const matching = inventory.filter((candidate) => candidate.name === resource.requestedName);
    if (matching.length > 1)
      throw new Error(`outer runtime returned duplicate ${kind} name: ${resource.requestedName}`);
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
    const observed = inventory.find((candidate) => candidate.id === observedId);
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
      throw new Error(`observed ${kind} name changed for runtime identity ${observedId}`);
    }
    assertOwnership(observed, resource);
  }

  assertBudget();
  await remove(observedId);
  const after = await requiredNamedResourceInventory(kind, list, assertBudget);
  if (after.some((candidate) => candidate.id === observedId)) {
    throw new Error(`exact outer ${kind} still exists after revocation: ${observedId}`);
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

async function requiredContainerInventory(
  runtime: ContainerRuntime,
  assertBudget: () => void,
): Promise<readonly DockerContainerInfo[]> {
  if (runtime.listContainers === undefined) throw new Error('selected outer runtime cannot inventory containers');
  assertBudget();
  const inventory = await runtime.listContainers();
  assertBudget();
  assertUniqueInventory(inventory, 'container');
  return inventory;
}

async function requiredNamedResourceInventory(
  kind: 'network' | 'volume',
  list: () => Promise<readonly NamedResourceInfo[]>,
  assertBudget: () => void,
): Promise<readonly NamedResourceInfo[]> {
  assertBudget();
  const inventory = await list();
  assertBudget();
  assertUniqueInventory(inventory, kind);
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
  const kindPriority = { container: 0, volume: 1, network: 2 } as const;
  if (left.kind !== right.kind) return kindPriority[left.kind] - kindPriority[right.kind];
  const priorities = new Map([
    ['agent', 0],
    ['nested-daemon', 1],
    ['fixed-relay', 2],
    ['proxy', 3],
  ]);
  return (priorities.get(left.role) ?? 100) - (priorities.get(right.role) ?? 100);
}
