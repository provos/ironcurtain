/**
 * Shared container lifecycle helpers used by both DockerAgentSession and
 * runPtySession to avoid duplicating stop/remove/network-cleanup logic.
 */

import type { ContainerRuntime } from './types.js';
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
