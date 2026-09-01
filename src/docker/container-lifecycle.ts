/**
 * Shared container lifecycle helpers used by both DockerAgentSession and
 * runPtySession to avoid duplicating stop/remove/network-cleanup logic.
 */

import type { ContainerRuntime } from './types.js';
import type { DockerWorkloadBundleHandle } from '../docker-workload/infrastructure.js';
import { releaseManagedResourceLease } from './docker-resource-lifecycle.js';
import { errorMessage } from '../utils/error-message.js';
import * as logger from '../logger.js';

/**
 * Stop and remove Docker containers and their per-session network in parallel.
 * Best-effort: individual failures are swallowed so one broken container
 * doesn't prevent cleanup of the others.
 */
export async function cleanupContainers(
  docker: ContainerRuntime,
  opts: {
    containerId: string | null;
    sidecarContainerId: string | null;
    networkName: string | null;
  },
): Promise<void> {
  const cleanups: Promise<void>[] = [];

  if (opts.containerId) {
    const cid = opts.containerId;
    cleanups.push(
      docker
        .stop(cid)
        .then(() => docker.remove(cid))
        .catch(() => {}),
    );
  }

  if (opts.sidecarContainerId) {
    const sid = opts.sidecarContainerId;
    cleanups.push(
      docker
        .stop(sid)
        .then(() => docker.remove(sid))
        .catch(() => {}),
    );
  }

  await Promise.all(cleanups);

  for (const id of [opts.containerId, opts.sidecarContainerId]) {
    if (id && (await docker.containerExists(id))) {
      logger.warn(`cleanupContainers: container ${id} still exists after removal`);
    }
  }

  // Remove per-session internal network after both containers are gone
  if (opts.networkName !== null) {
    await docker.removeNetwork(opts.networkName).catch(() => {});
    if (docker.networkExists && (await docker.networkExists(opts.networkName))) {
      logger.warn(`cleanupContainers: network ${opts.networkName} still exists after removal`);
    }
  }
}

export interface DestroyBundleOuterResourcesOptions {
  readonly docker: ContainerRuntime;
  /** Present only for an admitted secure nested Docker-workload bundle. */
  readonly dockerWorkload: DockerWorkloadBundleHandle | undefined;
  readonly containerId: string | null;
  readonly sidecarContainerId: string | null;
  readonly networkName: string | null;
  /** The bundle id whose managed-resource owner lease should be released. */
  readonly bundleId: string;
  /** Call-site name, used to prefix a teardown-failure warning. */
  readonly context: string;
}

/**
 * Single teardown path for a bundle's outer resources, shared by
 * `destroyDockerInfrastructure`, the `assembleDockerInfrastructure` failure
 * path, and the PTY session `finally`.
 *
 * §8.3 ordering: an admitted Docker-workload bundle tears its LEDGERED outer
 * resources (including the multi-homed agent and its egress network) down
 * through the lease first, by exact identity with absence proofs.
 *
 * `cleanupContainers` then performs the ordinary sweep for the MCP/MITM(/PTY)
 * transport and its per-session network. The transport never joins the
 * ledgered egress network, so detached watchdog cleanup cannot be blocked by an
 * unledgered endpoint. Re-removing the agent is a harmless no-op.
 *
 * Finally the managed-resource owner lease is released unconditionally — a
 * genuine no-op for non-docker runtimes, which never acquire one.
 */
export async function destroyBundleOuterResources(options: DestroyBundleOuterResourcesOptions): Promise<void> {
  if (options.dockerWorkload) {
    await options.dockerWorkload
      .teardown()
      .catch((err: unknown) =>
        logger.warn(`${options.context}: dockerWorkload.teardown() failed: ${errorMessage(err)}`),
      );
  }
  await cleanupContainers(options.docker, {
    containerId: options.containerId,
    sidecarContainerId: options.sidecarContainerId,
    networkName: options.networkName,
  });
  releaseManagedResourceLease(options.bundleId);
}
