import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  activateDockerWorkloadLease,
  createDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  requestDockerWorkloadOuterResource,
} from '../../src/docker-workload/bundle-lease.js';
import { resourceWatchdogPolicySchema } from '../../src/docker/resource-watchdog.js';
import { DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY } from '../../src/docker-workload/infrastructure.js';

/** Real current-format lease for observer lifecycle and workflow tests. */
export function createQualificationObserverLease(root: string, runtimeKind: 'docker' | 'apple-container' = 'docker') {
  const leasePath = join(root, 'lease.json');
  const stateRoot = join(root, 'state');
  mkdirSync(stateRoot, { mode: 0o700 });
  const identity = statSync(stateRoot);
  const watchdogPolicy = resourceWatchdogPolicySchema.parse({
    ...JSON.parse(readFileSync(resolve('config/docker-workload/resource-watchdog-policy.json'), 'utf8')),
    targetRoot: stateRoot,
    targetDevice: identity.dev,
    targetInode: identity.ino,
  });
  const generation = 'generation-one';
  createDockerWorkloadLease(leasePath, {
    leaseId: 'observer-lease',
    bundleId: 'observer-bundle',
    generation,
    runtimeKind,
    ...(runtimeKind === 'docker' ? { dockerEndpoint: { host: 'unix:///selected.sock' } } : {}),
    paths: {
      workspaceRoot: join(root, 'workspace'),
      stateRoot,
      runtimeRoot: join(root, 'runtime'),
      apiRoot: join(stateRoot, 'api'),
      exchangeRoot: join(stateRoot, 'exchange'),
      stagingRoot: join(root, 'stage'),
    },
    bindings: { watchdogPolicy },
    cleanupInventoryGapMs: watchdogPolicy.cleanupInventoryGapMs,
  });
  for (const role of ['nested-daemon', 'agent', 'daemon-api']) {
    requestDockerWorkloadOuterResource(leasePath, generation, {
      requestId: role,
      kind: role === 'daemon-api' ? 'volume' : 'container',
      role,
      requestedName: role,
      ownershipLabelKey: DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY,
    });
    observeDockerWorkloadOuterResource(leasePath, generation, role, role);
  }
  activateDockerWorkloadLease(leasePath, generation);
  return { leasePath, generation };
}
