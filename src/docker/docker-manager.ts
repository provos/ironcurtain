/**
 * Docker CLI wrapper implementing the ContainerRuntime interface.
 *
 * Uses child_process.execFile for all Docker CLI commands.
 * This keeps the implementation simple and avoids a dependency
 * on the Docker Engine API or dockerode.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContainerRuntime, DockerContainerConfig, DockerExecResult } from './types.js';
import * as logger from '../logger.js';
import { checkDockerAvailable, type DockerAvailability } from '../session/preflight.js';
import { isExecError, isExecTimeout } from '../utils/exec-error.js';
import { spawnWithIdleTimeout, type SpawnFn } from './spawn-with-idle-timeout.js';
import {
  createDockerProgressSink,
  type CreateDockerProgressSinkOptions,
  type DockerProgressSink,
} from './docker-progress-sink.js';

/** Async exec function signature matching promisified execFile. */
export type ExecFileFn = (
  cmd: string,
  args: readonly string[],
  opts: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export const defaultExecFile: ExecFileFn = async (cmd, args, opts) => {
  const execFileAsync = promisify(execFileCb);
  return execFileAsync(cmd, [...args], opts);
};

/** Default timeout for docker exec commands (10 minutes). */
export const DEFAULT_EXEC_TIMEOUT_MS = 600_000;

/**
 * Idle (no-stdout/stderr) timeout for `docker pull`. The Docker daemon
 * heartbeats layer progress every few hundred ms during a healthy pull, so
 * 2 minutes of silence reliably indicates a hung daemon or dead registry
 * connection. The total wall-clock can still legitimately be hours for a
 * slow connection on a large base image like `devcontainers/universal`.
 */
export const PULL_IDLE_TIMEOUT_MS = 120_000;

/**
 * Idle timeout for `docker build`. Builds can have legitimately quiet RUN
 * steps (e.g. compilers running without output), so we allow longer silence
 * than for pulls before declaring the build hung. Combined with
 * `--progress=plain`, BuildKit will still emit per-step progress.
 */
export const BUILD_IDLE_TIMEOUT_MS = 300_000;

/** Grace period for docker stop before SIGKILL. */
const STOP_TIMEOUT_SECONDS = 10;

/** Docker label keys emitted on every IronCurtain-owned container. */
export const IRONCURTAIN_LABEL_BUNDLE = 'ironcurtain.bundle';
export const IRONCURTAIN_LABEL_WORKFLOW = 'ironcurtain.workflow';
export const IRONCURTAIN_LABEL_SCOPE = 'ironcurtain.scope';

/**
 * Builds the `docker create` argument list from a container config.
 * Exported for testing.
 */
export function buildCreateArgs(config: DockerContainerConfig): string[] {
  const args = ['create'];

  args.push('--name', config.name);
  args.push('--network', config.network);

  // Run an init process (docker-init / tini) as PID 1 so zombie children are
  // reaped. Without this, processes orphaned inside the container linger as
  // zombies under `sleep infinity`, and `kill -0 <pid>` returns success for
  // them — which silently breaks watcher loops in agent-generated scripts
  // (see workflow-scratch.md entry #22). The flag is harmless for short-
  // lived sidecar/service containers.
  args.push('--init');

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

  // Emit IronCurtain label scheme. See docs/designs/workflow-session-identity.md §7:
  //   - `ironcurtain.bundle` is always present on IronCurtain-owned containers.
  //   - `ironcurtain.workflow` + `ironcurtain.scope` are only set in workflow mode.
  // Each label is emitted only when its value is defined (present-or-absent contract)
  // so we never produce `--label ironcurtain.workflow=undefined` for standalone
  // sessions. An explicitly set empty string still emits, matching the type contract.
  if (config.bundleLabel !== undefined) {
    args.push('--label', `${IRONCURTAIN_LABEL_BUNDLE}=${config.bundleLabel}`);
  }
  if (config.workflowLabel !== undefined) {
    args.push('--label', `${IRONCURTAIN_LABEL_WORKFLOW}=${config.workflowLabel}`);
  }
  if (config.scopeLabel !== undefined) {
    args.push('--label', `${IRONCURTAIN_LABEL_SCOPE}=${config.scopeLabel}`);
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

  // Linux-only: when set (typically to '0:0'), runs the entrypoint as
  // root so it can renumber the codespace user before dropping
  // privileges. macOS skips this (VirtioFS handles UID translation).
  // See `DockerContainerConfig.user` JSDoc.
  if (config.user !== undefined) {
    args.push('--user', config.user);
  }

  args.push(config.image);
  args.push(...config.command);

  return args;
}

/** Test seams for the streaming spawn path used by pull/build. */
export interface CreateDockerManagerOptions {
  spawn?: SpawnFn;
  stdoutSink?: NodeJS.WritableStream;
  stderrSink?: NodeJS.WritableStream;
  /**
   * Override the progress-sink factory (tests). When `stdoutSink` /
   * `stderrSink` are provided explicitly the progress sink is bypassed
   * regardless of this option.
   */
  progressSinkFactory?: (opts: CreateDockerProgressSinkOptions) => DockerProgressSink;
}

export function createDockerManager(
  execFileFn?: ExecFileFn,
  dockerAvailabilityProbe: () => Promise<DockerAvailability> = checkDockerAvailable,
  spawnOpts?: CreateDockerManagerOptions,
): ContainerRuntime {
  const exec = execFileFn ?? defaultExecFile;
  const streamOpts = {
    spawn: spawnOpts?.spawn,
    stdoutSink: spawnOpts?.stdoutSink,
    stderrSink: spawnOpts?.stderrSink,
  };
  const progressSinkFactory = spawnOpts?.progressSinkFactory ?? createDockerProgressSink;

  // Runs a `docker pull` / `docker build` invocation with the streaming
  // idle-timeout primitive, wrapped in a progress sink that collapses the
  // raw output flood into a single updating status line (TTY) or
  // verbatim pass-through (non-TTY). When the test seam provides explicit
  // sinks we honor them and skip the wrapper.
  const runStreamed = async (params: {
    operation: 'docker pull' | 'docker build';
    args: readonly string[];
    idleTimeoutMs: number;
    env?: NodeJS.ProcessEnv;
  }): Promise<void> => {
    const hasInjectedSinks = streamOpts.stdoutSink !== undefined && streamOpts.stderrSink !== undefined;
    const progress: DockerProgressSink | undefined = hasInjectedSinks
      ? undefined
      : progressSinkFactory({ operation: params.operation });
    try {
      await spawnWithIdleTimeout('docker', params.args, {
        idleTimeoutMs: params.idleTimeoutMs,
        operation: params.operation,
        env: params.env,
        spawn: streamOpts.spawn,
        stdoutSink: streamOpts.stdoutSink ?? progress?.stdout,
        stderrSink: streamOpts.stderrSink ?? progress?.stderr,
      });
      progress?.finish(true);
    } catch (err) {
      progress?.finish(false);
      progress?.dumpRecent();
      throw err;
    }
  };

  return {
    async preflight(image: string): Promise<void> {
      const status = await dockerAvailabilityProbe();
      if (!status.available) {
        throw new Error(`Docker is not available. ${status.detailedMessage}`);
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

    async exec(
      nameOrId: string,
      command: readonly string[],
      timeoutMs?: number,
      execUser?: string | null,
    ): Promise<DockerExecResult> {
      const timeout = timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
      // Resolve the `--user` flag (see ContainerRuntime.exec JSDoc):
      //   undefined → 'codespace' (default for agent containers)
      //   string    → override
      //   null      → skip the flag entirely (non-agent containers
      //               without a codespace account, e.g. signal-cli)
      // On Linux, agent containers are created with `--user 0:0` (see
      // issue #232) so the entrypoint can renumber the codespace user;
      // without an explicit `--user codespace` here, every exec would
      // land as root and bypass the sudoers / $HOME setup the agent
      // expects. On macOS, `--user 0:0` is not passed and the
      // Dockerfile `USER codespace` directive already takes effect,
      // but re-asserting `codespace` is a harmless no-op.
      const resolvedUser = execUser === undefined ? 'codespace' : execUser;
      const userArgs = resolvedUser === null ? [] : (['--user', resolvedUser] as const);
      try {
        const { stdout, stderr } = await exec('docker', ['exec', ...userArgs, nameOrId, ...command], {
          timeout,
          maxBuffer: 50 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (err: unknown) {
        if (isExecError(err)) {
          if (isExecTimeout(err)) {
            logger.warn(
              `[docker-manager] exec timed out after ${timeout}ms (killed=${String(err.killed)}, ` +
                `signal=${err.signal ?? 'none'}): docker exec ${nameOrId} ${command[0] ?? ''}`,
            );
          }
          return {
            exitCode: typeof err.code === 'number' ? err.code : 1,
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
      // `--progress=plain` plus BuildKit gives line-oriented streamed output,
      // which (a) makes the user-visible "what's happening" question
      // answerable and (b) provides the per-step heartbeat the idle-timeout
      // watchdog needs to distinguish a quiet RUN from a hung builder.
      const args = ['build', '--progress=plain', '-t', tag, '-f', dockerfilePath];
      if (labels) {
        for (const [key, value] of Object.entries(labels)) {
          args.push('--label', `${key}=${value}`);
        }
      }
      args.push(contextDir);
      await runStreamed({
        operation: 'docker build',
        args,
        idleTimeoutMs: BUILD_IDLE_TIMEOUT_MS,
        env: { DOCKER_BUILDKIT: '1' },
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

    async getContainerLabel(container: string, label: string): Promise<string | undefined> {
      try {
        const { stdout } = await exec('docker', ['inspect', '-f', `{{index .Config.Labels "${label}"}}`, container], {
          timeout: 5_000,
        });
        const value = stdout.trim();
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
      // Streamed via spawn (not execFile) so the watchdog can reset on
      // every heartbeat. Large images like devcontainers/universal
      // (~5 GB) on slow links legitimately take an hour or more; only
      // true silence kills. The progress sink collapses the per-layer
      // chatter into a single updating status line.
      await runStreamed({
        operation: 'docker pull',
        args: ['pull', image],
        idleTimeoutMs: PULL_IDLE_TIMEOUT_MS,
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

    async getNetworkGateway(name: string): Promise<string | undefined> {
      try {
        const { stdout } = await exec(
          'docker',
          ['network', 'inspect', '-f', '{{(index .IPAM.Config 0).Gateway}}', name],
          {
            timeout: 10_000,
          },
        );
        const value = stdout.trim();
        return value && value !== '<no value>' ? value : undefined;
      } catch {
        return undefined;
      }
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

    /**
     * Remove a stale container left behind by a crashed session.
     * Only removes containers labeled with `ironcurtain.bundle` to avoid
     * accidentally removing unrelated containers that share the name.
     * Returns true if a stale container was found and removed.
     */
    async removeStaleContainer(name: string): Promise<boolean> {
      const exists = await this.containerExists(name);
      if (!exists) return false;

      // Verify the container belongs to IronCurtain before removing it.
      // We query by `ironcurtain.bundle`. Containers from before this refactor
      // carry `ironcurtain.session` and will NOT be matched -- upgrade-in-place
      // is not supported; operators wipe `~/.ironcurtain/workflow-runs/` per the
      // migration notes in docs/designs/workflow-container-lifecycle.md §10 and
      // docs/designs/workflow-session-identity.md.
      const label = await this.getContainerLabel(name, IRONCURTAIN_LABEL_BUNDLE);
      if (!label) {
        logger.warn(`Container "${name}" exists but lacks ${IRONCURTAIN_LABEL_BUNDLE} label; skipping removal`);
        return false;
      }

      logger.warn(`Removing stale container "${name}" from a previous session`);
      await this.stop(name);
      await this.remove(name);

      // Verify removal succeeded (remove() swallows errors)
      if (await this.containerExists(name)) {
        throw new Error(`Failed to remove stale container "${name}"`);
      }
      return true;
    },
  };
}
