/**
 * Docker CLI wrapper implementing the DockerManager interface.
 *
 * Uses child_process.execFile for all Docker CLI commands.
 * This keeps the implementation simple and avoids a dependency
 * on the Docker Engine API or dockerode.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { DockerContainerConfig, DockerExecResult, DockerManager } from './types.js';

/** Async exec function signature matching promisified execFile. */
export type ExecFileFn = (
  cmd: string,
  args: readonly string[],
  opts: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = async (cmd, args, opts) => {
  const execFileAsync = promisify(execFileCb);
  return execFileAsync(cmd, [...args], opts);
};

/** Default timeout for docker exec commands (10 minutes). */
const DEFAULT_EXEC_TIMEOUT_MS = 600_000;

/** Grace period for docker stop before SIGKILL. */
const STOP_TIMEOUT_SECONDS = 10;

/**
 * Builds the `docker create` argument list from a container config.
 * Exported for testing.
 */
export function buildCreateArgs(config: DockerContainerConfig): string[] {
  const args = ['create'];

  args.push('--name', config.name);
  args.push('--network', config.network);

  // Custom host mappings override the default host-gateway mapping
  if (config.extraHosts && config.extraHosts.length > 0) {
    for (const entry of config.extraHosts) {
      args.push(`--add-host=${entry}`);
    }
  } else if (config.network !== 'none') {
    // Linux needs explicit host.docker.internal mapping (useless with --network=none)
    args.push('--add-host=host.docker.internal:host-gateway');
  }

  // Security: drop all capabilities, then selectively re-add
  args.push('--cap-drop=ALL');
  for (const cap of config.capAdd ?? []) {
    args.push('--cap-add', cap);
  }

  // Port bindings (service containers only)
  for (const port of config.ports ?? []) {
    args.push('-p', port);
  }

  // Restart policy (service containers only)
  if (config.restartPolicy) {
    args.push('--restart', config.restartPolicy);
  }

  if (config.sessionLabel) {
    args.push('--label', `ironcurtain.session=${config.sessionLabel}`);
  }

  if (config.resources?.memoryMb) {
    args.push('--memory', `${config.resources.memoryMb}m`);
  }
  if (config.resources?.cpus) {
    args.push('--cpus', String(config.resources.cpus));
  }

  for (const mount of config.mounts) {
    const opts = mount.readonly ? ':ro' : '';
    args.push('-v', `${mount.source}:${mount.target}${opts}`);
  }

  for (const [key, value] of Object.entries(config.env)) {
    args.push('-e', `${key}=${value}`);
  }

  if (config.entrypoint !== undefined) {
    args.push('--entrypoint', config.entrypoint);
  }

  if (config.tty) {
    args.push('-t');
  }

  args.push(config.image);
  args.push(...config.command);

  return args;
}

export function createDockerManager(execFileFn?: ExecFileFn): DockerManager {
  const exec = execFileFn ?? defaultExecFile;

  return {
    async preflight(image: string): Promise<void> {
      try {
        await exec('docker', ['info'], { timeout: 10_000 });
      } catch {
        throw new Error('Docker is not available. Ensure Docker daemon is running.');
      }

      try {
        await exec('docker', ['image', 'inspect', image], { timeout: 10_000 });
      } catch {
        throw new Error(`Docker image not found: ${image}. Build it first.`);
      }
    },

    async create(config: DockerContainerConfig): Promise<string> {
      const args = buildCreateArgs(config);
      const { stdout } = await exec('docker', args, { timeout: 30_000 });
      return stdout.trim();
    },

    async start(nameOrId: string): Promise<void> {
      await exec('docker', ['start', nameOrId], { timeout: 30_000 });
    },

    async exec(nameOrId: string, command: readonly string[], timeoutMs?: number): Promise<DockerExecResult> {
      const timeout = timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
      try {
        const { stdout, stderr } = await exec('docker', ['exec', nameOrId, ...command], {
          timeout,
          maxBuffer: 50 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (err: unknown) {
        if (isExecError(err)) {
          return {
            exitCode: err.code ?? 1,
            stdout: err.stdout,
            stderr: err.stderr,
          };
        }
        throw err;
      }
    },

    async stop(nameOrId: string): Promise<void> {
      try {
        await exec('docker', ['stop', '-t', String(STOP_TIMEOUT_SECONDS), nameOrId], {
          timeout: (STOP_TIMEOUT_SECONDS + 5) * 1000,
        });
      } catch {
        // Container may already be stopped
      }
    },

    async remove(nameOrId: string): Promise<void> {
      try {
        await exec('docker', ['rm', '-f', nameOrId], { timeout: 10_000 });
      } catch {
        // Container may already be removed
      }
    },

    async isRunning(nameOrId: string): Promise<boolean> {
      try {
        const { stdout } = await exec('docker', ['inspect', '-f', '{{.State.Running}}', nameOrId], {
          timeout: 5_000,
        });
        return stdout.trim() === 'true';
      } catch {
        return false;
      }
    },

    async imageExists(image: string): Promise<boolean> {
      try {
        await exec('docker', ['image', 'inspect', image], { timeout: 10_000 });
        return true;
      } catch {
        return false;
      }
    },

    async buildImage(
      tag: string,
      dockerfilePath: string,
      contextDir: string,
      labels?: Record<string, string>,
    ): Promise<void> {
      const args = ['build', '-t', tag, '-f', dockerfilePath];
      if (labels) {
        for (const [key, value] of Object.entries(labels)) {
          args.push('--label', `${key}=${value}`);
        }
      }
      args.push(contextDir);
      await exec('docker', args, {
        timeout: 600_000,
        maxBuffer: 50 * 1024 * 1024,
      });
    },

    async getImageLabel(image: string, label: string): Promise<string | undefined> {
      try {
        const { stdout } = await exec('docker', ['inspect', '-f', `{{index .Config.Labels "${label}"}}`, image], {
          timeout: 10_000,
        });
        const value = stdout.trim();
        // docker inspect returns '<no value>' when the label doesn't exist
        return value && value !== '<no value>' ? value : undefined;
      } catch {
        return undefined;
      }
    },

    async createNetwork(
      name: string,
      options?: { internal?: boolean; subnet?: string; gateway?: string },
    ): Promise<void> {
      try {
        const args = ['network', 'create'];
        if (options?.internal) args.push('--internal');
        if (options?.subnet) args.push('--subnet', options.subnet);
        if (options?.gateway) args.push('--gateway', options.gateway);
        args.push(name);
        await exec('docker', args, { timeout: 10_000 });
      } catch (err: unknown) {
        if (isExecError(err) && err.stderr.includes('already exists')) return;
        throw err;
      }
    },

    async removeNetwork(name: string): Promise<void> {
      try {
        await exec('docker', ['network', 'rm', name], { timeout: 10_000 });
      } catch {
        // Ignore errors -- network may already be removed
      }
    },

    async pullImage(image: string): Promise<void> {
      await exec('docker', ['pull', image], {
        timeout: 300_000, // 5 minutes for large images
        maxBuffer: 50 * 1024 * 1024,
      });
    },

    async getImageId(nameOrId: string): Promise<string | undefined> {
      // Try as image first (returns the image's own ID)
      try {
        const { stdout } = await exec('docker', ['image', 'inspect', '-f', '{{.Id}}', nameOrId], {
          timeout: 5_000,
        });
        const id = stdout.trim();
        if (id) return id;
      } catch {
        // Not an image - fall through to container inspection
      }

      // Try as container (returns the image ID the container was created from)
      try {
        const { stdout } = await exec('docker', ['inspect', '-f', '{{.Image}}', nameOrId], {
          timeout: 5_000,
        });
        const id = stdout.trim();
        return id || undefined;
      } catch {
        return undefined;
      }
    },

    async connectNetwork(networkName: string, containerId: string): Promise<void> {
      await exec('docker', ['network', 'connect', networkName, containerId], { timeout: 10_000 });
    },

    async getContainerIp(containerId: string, network: string): Promise<string> {
      // Docker may not assign the IP immediately after `network connect`.
      // Retry a few times with a short delay.
      const maxAttempts = 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { stdout } = await exec('docker', ['inspect', '-f', '{{json .NetworkSettings.Networks}}', containerId], {
          timeout: 10_000,
        });
        const networks = JSON.parse(stdout.trim()) as Partial<Record<string, { IPAddress?: string }>>;
        const ip = networks[network]?.IPAddress;
        if (ip) return ip;

        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      throw new Error(`No IP address found for container ${containerId} on network ${network}`);
    },

    async containerExists(nameOrId: string): Promise<boolean> {
      try {
        // docker inspect succeeds for both running and stopped containers,
        // fails only when the container does not exist.
        await exec('docker', ['inspect', nameOrId], { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    },
  };
}

interface ExecError {
  code: number | null;
  stdout: string;
  stderr: string;
}

function isExecError(err: unknown): err is ExecError {
  return typeof err === 'object' && err !== null && 'stdout' in err;
}
