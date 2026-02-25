/**
 * Manages the signal-cli-rest-api Docker container.
 *
 * Unlike agent containers (per-session, ephemeral, --network=none),
 * the signal-cli container is a long-lived background service that
 * needs network access to communicate with Signal servers.
 *
 * Delegates to DockerManager for all Docker CLI operations.
 */

import { mkdirSync } from 'node:fs';
import type { DockerManager } from '../docker/types.js';
import { getSignalDataDir } from './signal-config.js';

/** Configuration for the signal-cli Docker container. */
export interface SignalContainerConfig {
  /** Docker image name with tag. */
  readonly image: string;
  /** Host port to bind the REST API to. */
  readonly port: number;
  /** Host directory for signal-cli persistent data. */
  readonly dataDir: string;
  /** Container name for identification. */
  readonly containerName: string;
}

/** Manages the signal-cli-rest-api Docker container. */
export interface SignalContainerManager {
  /** Ensures the container is running. Returns the REST API base URL. Idempotent. */
  ensureRunning(): Promise<string>;

  /** Polls GET /v1/health until the REST API responds. */
  waitForHealthy(baseUrl: string, timeoutMs?: number): Promise<void>;

  /** Stops and removes the container. */
  teardown(): Promise<void>;

  /** Pulls the latest version of the configured Docker image. */
  pullImage(): Promise<void>;

  /** Returns true if the container exists (running or stopped). */
  exists(): Promise<boolean>;

  /** Returns true if the container is currently running. */
  isRunning(): Promise<boolean>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSignalContainerManager(
  docker: DockerManager,
  config: SignalContainerConfig,
): SignalContainerManager {
  const resolvedDataDir = config.dataDir || getSignalDataDir();

  return {
    async ensureRunning(): Promise<string> {
      const baseUrl = `http://127.0.0.1:${config.port}`;

      // Pull latest image (fast no-op when already up to date)
      try {
        await docker.pullImage(config.image);
      } catch {
        // Offline or registry unavailable - continue with cached image
      }

      // If container exists, check whether its image is current.
      // If outdated, remove it so we recreate with the new image.
      if (await docker.containerExists(config.containerName)) {
        const containerId = await docker.getImageId(config.containerName);
        const imageId = await docker.getImageId(config.image);
        const outdated = containerId && imageId && containerId !== imageId;

        if (outdated) {
          if (await docker.isRunning(config.containerName)) {
            await docker.stop(config.containerName);
          }
          await docker.remove(config.containerName);
          // Fall through to create below
        } else if (await docker.isRunning(config.containerName)) {
          return baseUrl;
        } else {
          await docker.start(config.containerName);
          return baseUrl;
        }
      }

      // Create new container via DockerManager.create()
      mkdirSync(resolvedDataDir, { recursive: true });
      await docker.create({
        image: config.image,
        name: config.containerName,
        network: 'bridge',
        ports: [`127.0.0.1:${config.port}:8080`],
        restartPolicy: 'unless-stopped',
        // The signal-cli-rest-api entrypoint needs capabilities for:
        //   CHOWN, FOWNER - jsonrpc2-helper creates FIFOs and sets permissions
        //   DAC_OVERRIDE  - root writes config to UID-1000-owned volume
        //   SETUID/SETGID - usermod/groupmod + setpriv to drop privileges
        //   KILL          - supervisor manages signal-cli child process
        capAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'KILL'],
        mounts: [
          {
            source: resolvedDataDir,
            target: '/home/.local/share/signal-cli',
            readonly: false,
          },
        ],
        env: {
          MODE: 'json-rpc',
          // Skip recursive chown on data dir - it's already owned by
          // UID 1000 (matching the container's signal-api user).
          SIGNAL_CLI_CHOWN_ON_STARTUP: 'false',
        },
        command: [],
      });
      await docker.start(config.containerName);
      return baseUrl;
    },

    async waitForHealthy(baseUrl: string, timeoutMs = 30_000): Promise<void> {
      const start = Date.now();
      let delay = 500;
      while (Date.now() - start < timeoutMs) {
        try {
          const resp = await fetch(`${baseUrl}/v1/health`);
          if (resp.status === 204) return;
        } catch {
          // Container starting up
        }
        await sleep(delay);
        delay = Math.min(delay * 1.5, 3000);
      }
      throw new Error(`signal-cli container did not become healthy within ${timeoutMs}ms`);
    },

    async teardown(): Promise<void> {
      await docker.stop(config.containerName);
      await docker.remove(config.containerName);
    },

    async pullImage(): Promise<void> {
      await docker.pullImage(config.image);
    },

    async exists(): Promise<boolean> {
      return docker.containerExists(config.containerName);
    },

    async isRunning(): Promise<boolean> {
      return docker.isRunning(config.containerName);
    },
  };
}
