/**
 * Docker CLI wrapper implementing the ContainerRuntime interface.
 *
 * Uses child_process.execFile for all Docker CLI commands.
 * This keeps the implementation simple and avoids a dependency
 * on the Docker Engine API or dockerode.
 */

import { execFile as execFileCb } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ContainerRuntime, DockerContainerConfig, DockerExecResult, DockerImageInfo } from './types.js';
import * as logger from '../logger.js';
import { checkDockerAvailable, type DockerAvailability } from './docker-probe.js';
import { isExecError, isExecTimeout } from '../utils/exec-error.js';
import { spawnWithIdleTimeout, type SpawnFn } from './spawn-with-idle-timeout.js';
import {
  createDockerProgressSink,
  type CreateDockerProgressSinkOptions,
  type DockerProgressSink,
  type DockerProgressOperation,
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

/** Default timeout for docker commit. Large writable layers can legitimately take minutes. */
export const DEFAULT_COMMIT_TIMEOUT_MS = 600_000;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseDockerImageInfo(raw: unknown): DockerImageInfo {
  if (!isRecord(raw)) {
    throw new Error('Unexpected docker image inspect result: expected object');
  }
  const config = isRecord(raw.Config) ? raw.Config : {};
  const labelsRaw = isRecord(config.Labels) ? config.Labels : {};
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(labelsRaw)) {
    if (typeof value === 'string') labels[key] = value;
  }
  const repoTagsRaw = Array.isArray(raw.RepoTags) ? raw.RepoTags : [];
  const repoTags = repoTagsRaw.filter((tag): tag is string => typeof tag === 'string');
  return {
    id: typeof raw.Id === 'string' ? raw.Id : '',
    repoTags,
    labels,
    created: typeof raw.Created === 'string' ? raw.Created : '',
  };
}

function parseDockerImageId(stdout: string): string {
  const matches = stdout.match(/sha256:[a-f0-9]{64}/gi);
  const imageId = matches?.at(-1);
  if (!imageId) {
    throw new Error(`docker image creation returned unexpected image id: ${stdout.trim() || '(empty)'}`);
  }
  return imageId;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Renders a value for a Dockerfile `ENV key=value` directive. Values made of
 * safe characters pass through bare; anything else is double-quoted with `\`
 * and `"` escaped so `docker import --change` parses it intact.
 */
function quoteDockerfileValue(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Reads a container's effective Config (ENTRYPOINT/CMD/WORKDIR/USER/ENV) and
 * renders it as Dockerfile `--change` directives. `docker export | docker
 * import` flattens a container to a single-layer image but DROPS the image
 * Config; re-baking it keeps a flattened snapshot behaving like its source on
 * resume (the baked ENTRYPOINT runs the UID-remap + proxy bridge, and ENV
 * carries the base-image PATH that container creation intentionally never
 * re-supplies). **Throws** when the config cannot be read or parsed, so the
 * flattened commit fails rather than shipping a config-less image that would
 * resume broken; callers treat a snapshot failure as fall-back-to-fresh. (A
 * successful read that genuinely yields no directives is fine and proceeds.)
 */
async function readContainerConfigChanges(exec: ExecFileFn, containerId: string): Promise<string[]> {
  // Let an inspect failure propagate (do NOT swallow): a flattened snapshot with
  // no re-baked ENTRYPOINT/PATH resumes broken, so failing the snapshot is safer
  // than producing a config-less image.
  const { stdout } = await exec('docker', ['container', 'inspect', '--format', '{{json .Config}}', containerId], {
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`docker container inspect returned unparseable Config for ${containerId}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`docker container inspect returned a non-object Config for ${containerId}`);
  }

  const changes: string[] = [];
  const entrypoint = asStringArray(parsed.Entrypoint);
  if (entrypoint.length > 0) changes.push(`ENTRYPOINT ${JSON.stringify(entrypoint)}`);
  const cmd = asStringArray(parsed.Cmd);
  if (cmd.length > 0) changes.push(`CMD ${JSON.stringify(cmd)}`);
  if (typeof parsed.WorkingDir === 'string' && parsed.WorkingDir.length > 0) {
    changes.push(`WORKDIR ${parsed.WorkingDir}`);
  }
  if (typeof parsed.User === 'string' && parsed.User.length > 0) {
    changes.push(`USER ${parsed.User}`);
  }
  for (const entry of asStringArray(parsed.Env)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    // A single ENV directive can't carry a newline; such values are dynamic
    // (re-supplied at create) so dropping them from the snapshot is safe.
    if (/[\r\n]/.test(value)) continue;
    changes.push(`ENV ${key}=${quoteDockerfileValue(value)}`);
  }
  return changes;
}

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

/** Streaming-sink options shared by the runtime managers' build/pull runner. */
export interface StreamOpts {
  spawn?: SpawnFn;
  stdoutSink?: NodeJS.WritableStream;
  stderrSink?: NodeJS.WritableStream;
}

/**
 * Builds the streaming `pull`/`build` runner shared by the Docker and Apple
 * `container` managers: it drives `spawnWithIdleTimeout` for `bin` and wraps the
 * raw output flood in a progress sink (collapsed status line on a TTY, verbatim
 * otherwise), bypassing the sink when the caller injected explicit sinks (tests).
 */
export function makeRunStreamed(
  bin: string,
  streamOpts: StreamOpts,
  progressSinkFactory: (opts: CreateDockerProgressSinkOptions) => DockerProgressSink,
): (params: {
  operation: DockerProgressOperation;
  args: readonly string[];
  idleTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
}) => Promise<void> {
  return async (params) => {
    const hasInjectedSinks = streamOpts.stdoutSink !== undefined && streamOpts.stderrSink !== undefined;
    const progress: DockerProgressSink | undefined = hasInjectedSinks
      ? undefined
      : progressSinkFactory({ operation: params.operation });
    try {
      await spawnWithIdleTimeout(bin, params.args, {
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
  const runStreamed = makeRunStreamed('docker', streamOpts, progressSinkFactory);

  return {
    supportsImageSnapshots: true,

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
      workdir?: string,
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
      const workdirArgs = workdir === undefined ? [] : (['--workdir', workdir] as const);
      try {
        const { stdout, stderr } = await exec('docker', ['exec', ...userArgs, ...workdirArgs, nameOrId, ...command], {
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

    async commit(containerId: string, options = {}): Promise<string> {
      if (options.flatten === true) {
        // Re-bake the image Config that export/import drops. Read it BEFORE
        // export so a still-running container reports its live ENTRYPOINT/ENV.
        const configChanges = await readContainerConfigChanges(exec, containerId);
        const dir = mkdtempSync(join(tmpdir(), 'ironcurtain-snapshot-'));
        const tarPath = join(dir, 'container.tar');
        try {
          await exec('docker', ['export', '--output', tarPath, containerId], {
            timeout: options.timeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
          });
          const args = ['import'];
          // Config first, then caller changes (labels) so a caller can override.
          for (const change of [...configChanges, ...(options.changes ?? [])]) {
            args.push('--change', change);
          }
          args.push(tarPath);
          if (options.tag !== undefined) {
            args.push(options.tag);
          }
          const { stdout } = await exec('docker', args, {
            timeout: options.timeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
          });
          return parseDockerImageId(stdout);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }

      const args = ['commit'];
      if (options.pause === false) {
        args.push('--no-pause');
      }
      for (const change of options.changes ?? []) {
        args.push('--change', change);
      }
      args.push(containerId);
      if (options.tag !== undefined) {
        args.push(options.tag);
      }
      const { stdout } = await exec('docker', args, {
        timeout: options.timeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      return parseDockerImageId(stdout);
    },

    async removeImage(ref: string): Promise<boolean> {
      try {
        await exec('docker', ['image', 'rm', '--force', ref], { timeout: 60_000, maxBuffer: 1024 * 1024 });
        return true;
      } catch (err: unknown) {
        if (isExecError(err) && /no such image|not found|does not exist/i.test(err.stderr)) {
          // Already gone -- nothing to reclaim.
          return false;
        }
        if (isExecError(err) && /image is being used|in use by|dependent child|conflict/i.test(err.stderr)) {
          // Still pinned by a running container or a derived image. Not a hard
          // failure: a later GC sweep reclaims it once the holder is gone.
          // Logged distinctly so it isn't conflated with an unexpected error.
          logger.warn(`[docker-manager] image ${ref} still in use; deferring removal to a later sweep`);
          return false;
        }
        const detail = isExecError(err) ? err.stderr.trim() || err.message : String(err);
        logger.warn(`[docker-manager] failed to remove image ${ref}: ${detail}`);
        return false;
      }
    },

    async listImages(options?: { readonly labelFilter?: string }): Promise<readonly DockerImageInfo[]> {
      const args = ['image', 'ls', '--no-trunc', '--quiet'];
      if (options?.labelFilter !== undefined) {
        args.push('--filter', `label=${options.labelFilter}`);
      }
      const { stdout } = await exec('docker', args, { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
      const ids = [
        ...new Set(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ];
      if (ids.length === 0) return [];
      const { stdout: inspectStdout } = await exec('docker', ['image', 'inspect', ...ids], {
        timeout: 30_000,
        maxBuffer: 50 * 1024 * 1024,
      });
      const parsed = JSON.parse(inspectStdout) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Unexpected docker image inspect result: expected array');
      }
      return parsed.map(parseDockerImageInfo);
    },

    async inspectImage(ref: string): Promise<DockerImageInfo | undefined> {
      try {
        const { stdout } = await exec('docker', ['image', 'inspect', ref], {
          timeout: 10_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const parsed = JSON.parse(stdout) as unknown;
        if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
        return parseDockerImageInfo(parsed[0]);
      } catch {
        return undefined;
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
      } catch (err: unknown) {
        // Non-fatal: callers invoke this in best-effort teardown paths and
        // depend on it never throwing. But a genuine failure here orphans the
        // network (there is no stale-network reaper, unlike removeStaleContainer),
        // so surface it rather than swallowing silently. "not found" is benign
        // (already removed) and stays quiet.
        if (isExecError(err) && /not found|no such network/i.test(err.stderr)) return;
        const detail = isExecError(err) ? err.stderr.trim() || err.message : String(err);
        logger.warn(`removeNetwork: failed to remove "${name}": ${detail}`);
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
