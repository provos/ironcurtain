/** Persist the previous release's format to exercise recovery across upgrades. */
import { writeStableJsonAtomic } from '../../src/hardened-fs.js';
import {
  loadDockerWorkloadLease,
  type CreateDockerWorkloadLeaseOptions,
  type DockerWorkloadLease,
} from '../../src/docker-workload/bundle-lease.js';

export type CreateLegacyDockerWorkloadLeaseOptions = Omit<CreateDockerWorkloadLeaseOptions, 'bindings'> & {
  readonly bindings: Extract<DockerWorkloadLease, { schemaVersion: 1 }>['bindings'];
};

export function createLegacyDockerWorkloadLease(
  path: string,
  options: CreateLegacyDockerWorkloadLeaseOptions,
): DockerWorkloadLease {
  const now = (options.now ?? new Date()).toISOString();
  writeStableJsonAtomic(
    path,
    {
      schemaVersion: 1,
      leaseId: options.leaseId,
      bundleId: options.bundleId,
      generation: options.generation,
      sequence: 0,
      status: 'admitting',
      runtimeKind: options.runtimeKind,
      paths: options.paths,
      bindings: options.bindings,
      coordinator: { pid: options.coordinatorPid ?? process.pid, startedAt: now, heartbeatAt: now },
      cleanupInventoryGapMs: options.cleanupInventoryGapMs,
      resources: [],
      cleanup: null,
      incident: null,
      createdAt: now,
      updatedAt: now,
    },
    { mode: 0o600 },
  );
  return loadDockerWorkloadLease(path);
}
