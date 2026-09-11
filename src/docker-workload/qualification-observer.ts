/** Durable ownership for host-only qualification containers added to an active bundle. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ContainerRuntime, DockerContainerConfig } from '../docker/types.js';
import {
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  requestDockerWorkloadOuterResource,
} from './bundle-lease.js';
import { withDockerWorkloadLifecycleClaim } from './cleanup-ownership.js';
import { DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY } from './infrastructure.js';

/**
 * Hold the same crash-recoverable claim as watchdog cleanup across precommit,
 * runtime create and immutable-ID observation. A lost create response or killed
 * observer leaves the exact name and generation in the lease for revocation.
 * Local early removal needs no ledger mutation: revocation records its absence.
 */
export async function createQualificationObserverContainer(options: {
  readonly runtime: ContainerRuntime;
  readonly leasePath: string;
  readonly generation: string;
  readonly config: DockerContainerConfig;
}): Promise<string> {
  return withDockerWorkloadLifecycleClaim(
    { leasePath: options.leasePath, clock: () => new Date(), sleep: delay, wait: true },
    async () => {
      const lease = loadDockerWorkloadLease(options.leasePath);
      if (lease.runtimeKind !== 'docker' || lease.status !== 'active' || lease.generation !== options.generation) {
        throw new Error('qualification observer requires the same active Docker lease generation');
      }
      const requestId = `res-${randomUUID()}`;
      requestDockerWorkloadOuterResource(options.leasePath, lease.generation, {
        requestId,
        kind: 'container',
        role: 'qualification-observer',
        requestedName: options.config.name,
        ownershipLabelKey: DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY,
      });
      const id = await options.runtime.create({
        ...options.config,
        bundleLabel: lease.bundleId,
        labels: { ...options.config.labels, [DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY]: lease.generation },
      });
      observeDockerWorkloadOuterResource(options.leasePath, lease.generation, requestId, id);
      return id;
    },
  );
}
