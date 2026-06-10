/**
 * Apple `container` CLI wrapper implementing the ContainerRuntime interface.
 *
 * Peer implementation to docker-manager.ts for macOS 26+ on Apple silicon
 * (see docs/designs/apple-container-runtime.md). Each container runs in its
 * own lightweight VM; networking uses host-only vmnet networks instead of
 * Docker's bridge + sidecar arrangement.
 *
 * This module is the only place allowed to spawn the `container` binary,
 * always via execFile with argument arrays (no shell strings).
 *
 * CLI semantics verified against `container` 1.0.0:
 *   - `create`/`start`/`exec`/`stop`/`delete` mirror the Docker verbs;
 *     `--init`, `--cap-drop ALL`, `--label`, `--cpus`/`--memory`, `--user`,
 *     `--entrypoint`, `-t` all exist with Docker-compatible meanings.
 *   - `inspect` family returns JSON only (no Go templates); shapes are
 *     parsed below (`AppleContainerInspect` / `AppleImageInspect`).
 *   - `network create --internal` creates a host-only vmnet network and
 *     duplicate creation fails with "already exists" on stderr.
 *   - Inspecting a missing container/image exits non-zero.
 *   - No `--add-host`, no `--restart`, no restartable `network connect`:
 *     those configs throw instead of being silently dropped.
 */

import { arch, platform, release } from 'node:os';
import type { ContainerRuntime, DockerContainerConfig, DockerExecResult } from './types.js';
import * as logger from '../logger.js';
import type { DockerAvailability } from '../session/preflight.js';
import { isExecError, isExecTimeout } from '../utils/exec-error.js';
import { spawnWithIdleTimeout } from './spawn-with-idle-timeout.js';
import {
  defaultExecFile,
  type ExecFileFn,
  DEFAULT_EXEC_TIMEOUT_MS,
  PULL_IDLE_TIMEOUT_MS,
  BUILD_IDLE_TIMEOUT_MS,
  IRONCURTAIN_LABEL_BUNDLE,
  IRONCURTAIN_LABEL_WORKFLOW,
  IRONCURTAIN_LABEL_SCOPE,
  type CreateDockerManagerOptions,
} from './docker-manager.js';
import { createDockerProgressSink, type DockerProgressSink } from './docker-progress-sink.js';

/** Grace period for `container stop` before the runtime kills the VM. */
const STOP_TIMEOUT_SECONDS = 10;

/** Minimum supported `container` CLI major version (1.0.0 stability line). */
const MIN_MAJOR_VERSION = 1;

/**
 * Minimum Darwin kernel major for macOS 26. The `container network`
 * commands this backend depends on do not function on macOS 15 (Darwin 24).
 */
const MIN_DARWIN_MAJOR = 25;

/** Shape of one element of `container inspect` JSON output (1.0.0). */
interface AppleContainerInspect {
  readonly configuration?: {
    readonly labels?: Readonly<Record<string, string>>;
    readonly image?: { readonly descriptor?: { readonly digest?: string } };
  };
  readonly status?: {
    readonly state?: string;
    readonly networks?: ReadonlyArray<{ readonly network?: string; readonly ipv4Address?: string }>;
  };
}

/** Shape of one element of `container image inspect` JSON output (1.0.0). */
interface AppleImageInspect {
  readonly id?: string;
  readonly variants?: ReadonlyArray<{
    readonly config?: { readonly config?: { readonly Labels?: Readonly<Record<string, string>> } };
  }>;
}

function firstInspectEntry(stdout: string): unknown {
  const parsed = JSON.parse(stdout) as unknown[];
  return parsed[0];
}

/** Digests appear both bare and `sha256:`-prefixed; compare normalized. */
function normalizeDigest(digest: string): string {
  return digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
}

/** Host facts consulted by the availability probe; injectable for tests. */
export interface AppleContainerHostInfo {
  readonly platform: string;
  readonly arch: string;
  /** Darwin kernel release, e.g. "25.5.0" (macOS 26.5). */
  readonly release: string;
}

function currentHostInfo(): AppleContainerHostInfo {
  return { platform: platform(), arch: arch(), release: release() };
}

/**
 * Availability probe for the Apple container runtime. Mirrors the shape of
 * `checkDockerAvailable` so mode selection can treat backends uniformly.
 */
export async function checkAppleContainerAvailable(
  execFileFn: ExecFileFn = defaultExecFile,
  host: AppleContainerHostInfo = currentHostInfo(),
): Promise<DockerAvailability> {
  if (host.platform !== 'darwin' || host.arch !== 'arm64') {
    return {
      available: false,
      reason: 'apple-container requires macOS on Apple silicon',
      detailedMessage: 'The Apple container runtime only runs on Apple silicon Macs.',
    };
  }

  const darwinMajor = Number.parseInt(host.release.split('.')[0] ?? '0', 10);
  if (darwinMajor < MIN_DARWIN_MAJOR) {
    return {
      available: false,
      reason: 'apple-container requires macOS 26 or later',
      detailedMessage:
        'The `container network` commands this backend depends on do not function before macOS 26. ' +
        'Upgrade macOS or use the Docker backend.',
    };
  }

  let versionLine: string;
  try {
    const { stdout } = await execFileFn('container', ['--version'], { timeout: 10_000 });
    versionLine = stdout.trim();
  } catch {
    return {
      available: false,
      reason: 'container CLI not installed',
      detailedMessage:
        'The `container` binary was not found. Install it from https://github.com/apple/container/releases ' +
        'and start its services with `container system start`.',
    };
  }

  const match = /version\s+(\d+)\.(\d+)\.(\d+)/.exec(versionLine);
  const major = match ? Number.parseInt(match[1], 10) : 0;
  if (!match || major < MIN_MAJOR_VERSION) {
    return {
      available: false,
      reason: `container CLI too old (need >= ${MIN_MAJOR_VERSION}.0.0)`,
      detailedMessage:
        `Found "${versionLine}" but IronCurtain requires the ${MIN_MAJOR_VERSION}.0.0 stability line. ` +
        'Upgrade from https://github.com/apple/container/releases.',
    };
  }

  try {
    await execFileFn('container', ['system', 'status'], { timeout: 10_000 });
  } catch {
    return {
      available: false,
      reason: 'container services not running',
      detailedMessage: 'The container apiserver is not running. Start it with `container system start`.',
    };
  }

  return { available: true };
}

/**
 * Builds the `container create` argument list from a container config.
 * Exported for testing.
 *
 * Configs that encode Docker-only mechanisms (`extraHosts`, `restartPolicy`,
 * `network: 'none'`) throw rather than being silently dropped: they only
 * occur on the Docker-specific topologies, and reaching here with one set
 * means a wiring bug, not a portable request.
 */
export function buildAppleCreateArgs(config: DockerContainerConfig): string[] {
  if (config.extraHosts && config.extraHosts.length > 0) {
    throw new Error('apple-container does not support extra host mappings (--add-host); use a host-only network');
  }
  if (config.restartPolicy) {
    throw new Error('apple-container does not support restart policies');
  }
  if (config.network === 'none') {
    throw new Error("apple-container has no '--network=none'; use an --internal (host-only) network");
  }

  const args = ['create'];

  args.push('--name', config.name);
  args.push('--network', config.network);

  // Reap-and-forward init for the workload, same rationale as Docker's
  // --init (zombie children under `sleep infinity`; see docker-manager.ts).
  // vminitd is the VM's PID 1 regardless; this adds the in-container init.
  args.push('--init');

  // Security: drop all capabilities, then selectively re-add. Inside the
  // per-container VM this guards the workload, not the host boundary.
  args.push('--cap-drop', 'ALL');
  for (const cap of config.capAdd ?? []) {
    args.push('--cap-add', cap);
  }

  for (const port of config.ports ?? []) {
    args.push('--publish', port);
  }

  // Same present-or-absent label contract as buildCreateArgs (docker).
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
    args.push('--memory', `${config.resources.memoryMb}M`);
  }
  if (config.resources?.cpus) {
    args.push('--cpus', String(config.resources.cpus));
  }

  for (const mount of config.mounts) {
    // `--mount` is the only syntax with an explicit readonly option. Its
    // comma/equals-separated format has no escaping, so reject paths that
    // would corrupt it rather than emit a wrong mount.
    if (/[,=]/.test(mount.source) || /[,=]/.test(mount.target)) {
      throw new Error(`mount path contains ',' or '=' which the --mount format cannot escape: ${mount.source}`);
    }
    const readonlySuffix = mount.readonly ? ',readonly' : '';
    args.push('--mount', `source=${mount.source},target=${mount.target}${readonlySuffix}`);
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

  if (config.user !== undefined) {
    args.push('--user', config.user);
  }

  args.push(config.image);
  args.push(...config.command);

  return args;
}

export function createAppleContainerManager(
  execFileFn?: ExecFileFn,
  availabilityProbe: (execFileFn?: ExecFileFn) => Promise<DockerAvailability> = checkAppleContainerAvailable,
  spawnOpts?: CreateDockerManagerOptions,
): ContainerRuntime {
  const exec = execFileFn ?? defaultExecFile;
  const streamOpts = {
    spawn: spawnOpts?.spawn,
    stdoutSink: spawnOpts?.stdoutSink,
    stderrSink: spawnOpts?.stderrSink,
  };
  const progressSinkFactory = spawnOpts?.progressSinkFactory ?? createDockerProgressSink;

  // Mirrors runStreamed in docker-manager.ts: idle-timeout watchdog plus a
  // progress sink collapsing pull/build chatter to a single status line.
  const runStreamed = async (params: {
    operation: 'container pull' | 'container build';
    args: readonly string[];
    idleTimeoutMs: number;
  }): Promise<void> => {
    const hasInjectedSinks = streamOpts.stdoutSink !== undefined && streamOpts.stderrSink !== undefined;
    const progress: DockerProgressSink | undefined = hasInjectedSinks
      ? undefined
      : progressSinkFactory({ operation: params.operation });
    try {
      await spawnWithIdleTimeout('container', params.args, {
        idleTimeoutMs: params.idleTimeoutMs,
        operation: params.operation,
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

  const inspectContainer = async (nameOrId: string, timeout: number): Promise<AppleContainerInspect | undefined> => {
    const { stdout } = await exec('container', ['inspect', nameOrId], { timeout });
    return firstInspectEntry(stdout) as AppleContainerInspect | undefined;
  };

  return {
    async preflight(image: string): Promise<void> {
      const status = await availabilityProbe(execFileFn);
      if (!status.available) {
        throw new Error(`Apple container runtime is not available. ${status.detailedMessage}`);
      }

      try {
        await exec('container', ['image', 'inspect', image], { timeout: 10_000 });
      } catch {
        throw new Error(`Container image not found: ${image}. Build it first.`);
      }
    },

    async create(config: DockerContainerConfig): Promise<string> {
      const args = buildAppleCreateArgs(config);
      const { stdout } = await exec('container', args, { timeout: 60_000 });
      return stdout.trim();
    },

    async start(nameOrId: string): Promise<void> {
      await exec('container', ['start', nameOrId], { timeout: 60_000 });
    },

    async exec(
      nameOrId: string,
      command: readonly string[],
      timeoutMs?: number,
      execUser?: string | null,
    ): Promise<DockerExecResult> {
      const timeout = timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
      // Same --user resolution contract as the Docker implementation (see
      // ContainerRuntime.exec JSDoc): undefined → 'codespace', null → omit.
      const resolvedUser = execUser === undefined ? 'codespace' : execUser;
      const userArgs = resolvedUser === null ? [] : (['--user', resolvedUser] as const);
      try {
        const { stdout, stderr } = await exec('container', ['exec', ...userArgs, nameOrId, ...command], {
          timeout,
          maxBuffer: 50 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (err: unknown) {
        if (isExecError(err)) {
          if (isExecTimeout(err)) {
            logger.warn(
              `[apple-container-manager] exec timed out after ${timeout}ms (killed=${String(err.killed)}, ` +
                `signal=${err.signal ?? 'none'}): container exec ${nameOrId} ${command[0] ?? ''}`,
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
        await exec('container', ['stop', '--time', String(STOP_TIMEOUT_SECONDS), nameOrId], {
          timeout: (STOP_TIMEOUT_SECONDS + 5) * 1000,
        });
      } catch {
        // Container may already be stopped
      }
    },

    async remove(nameOrId: string): Promise<void> {
      try {
        await exec('container', ['delete', '--force', nameOrId], { timeout: 30_000 });
      } catch {
        // Container may already be removed
      }
    },

    async isRunning(nameOrId: string): Promise<boolean> {
      try {
        const entry = await inspectContainer(nameOrId, 5_000);
        return entry?.status?.state === 'running';
      } catch {
        return false;
      }
    },

    async imageExists(image: string): Promise<boolean> {
      try {
        await exec('container', ['image', 'inspect', image], { timeout: 10_000 });
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
      const args = ['build', '--progress', 'plain', '-t', tag, '-f', dockerfilePath];
      if (labels) {
        for (const [key, value] of Object.entries(labels)) {
          args.push('--label', `${key}=${value}`);
        }
      }
      args.push(contextDir);
      try {
        await runStreamed({
          operation: 'container build',
          args,
          idleTimeoutMs: BUILD_IDLE_TIMEOUT_MS,
        });
      } catch (err: unknown) {
        // The BuildKit builder VM currently requires Rosetta; surface the
        // one-command fix instead of the raw virtualization error.
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('Rosetta is not installed')) {
          throw new Error(
            `container build failed: the BuildKit builder VM requires Rosetta. ` +
              `Install it with \`softwareupdate --install-rosetta --agree-to-license\` and retry.\n${message}`,
            { cause: err },
          );
        }
        throw err;
      }
    },

    async getImageLabel(image: string, label: string): Promise<string | undefined> {
      try {
        const { stdout } = await exec('container', ['image', 'inspect', image], { timeout: 10_000 });
        const entry = firstInspectEntry(stdout) as AppleImageInspect | undefined;
        for (const variant of entry?.variants ?? []) {
          const value = variant.config?.config?.Labels?.[label];
          if (value !== undefined) return value;
        }
        return undefined;
      } catch {
        return undefined;
      }
    },

    async getContainerLabel(container: string, label: string): Promise<string | undefined> {
      try {
        const entry = await inspectContainer(container, 5_000);
        return entry?.configuration?.labels?.[label];
      } catch {
        return undefined;
      }
    },

    async createNetwork(
      name: string,
      options?: { internal?: boolean; subnet?: string; gateway?: string },
    ): Promise<void> {
      if (options?.gateway) {
        throw new Error('apple-container networks do not support an explicit gateway; the runtime assigns it');
      }
      try {
        const args = ['network', 'create'];
        if (options?.internal) args.push('--internal');
        if (options?.subnet) args.push('--subnet', options.subnet);
        args.push(name);
        await exec('container', args, { timeout: 30_000 });
      } catch (err: unknown) {
        if (isExecError(err) && err.stderr.includes('already exists')) return;
        throw err;
      }
    },

    async removeNetwork(name: string): Promise<void> {
      try {
        await exec('container', ['network', 'delete', name], { timeout: 30_000 });
      } catch {
        // Ignore errors -- network may already be removed
      }
    },

    async pullImage(image: string): Promise<void> {
      await runStreamed({
        operation: 'container pull',
        args: ['image', 'pull', '--progress', 'plain', image],
        idleTimeoutMs: PULL_IDLE_TIMEOUT_MS,
      });
    },

    async getImageId(nameOrId: string): Promise<string | undefined> {
      // Try as image first (returns the image's own digest)
      try {
        const { stdout } = await exec('container', ['image', 'inspect', nameOrId], { timeout: 5_000 });
        const id = (firstInspectEntry(stdout) as AppleImageInspect | undefined)?.id;
        if (id) return normalizeDigest(id);
      } catch {
        // Not an image - fall through to container inspection
      }

      // Try as container (returns the digest of the image it was created from)
      try {
        const entry = await inspectContainer(nameOrId, 5_000);
        const digest = entry?.configuration?.image?.descriptor?.digest;
        return digest ? normalizeDigest(digest) : undefined;
      } catch {
        return undefined;
      }
    },

    connectNetwork(): Promise<void> {
      // Only the Docker tcp-sidecar topology attaches a running container
      // to a second network; the host-only topology never needs it.
      return Promise.reject(
        new Error('apple-container does not support connecting a container to additional networks'),
      );
    },

    async getContainerIp(containerId: string, network: string): Promise<string> {
      // The address may not be assigned immediately after start; retry
      // briefly, mirroring the Docker implementation.
      const maxAttempts = 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const entry = await inspectContainer(containerId, 10_000);
        const attachment = entry?.status?.networks?.find((n) => n.network === network);
        const cidr = attachment?.ipv4Address;
        if (cidr) {
          const ip = cidr.split('/')[0];
          if (ip) return ip;
        }

        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      throw new Error(`No IP address found for container ${containerId} on network ${network}`);
    },

    async containerExists(nameOrId: string): Promise<boolean> {
      try {
        // `container inspect` exits non-zero when the container does not
        // exist, for both running and stopped containers otherwise.
        await exec('container', ['inspect', nameOrId], { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    },

    async removeStaleContainer(name: string): Promise<boolean> {
      const exists = await this.containerExists(name);
      if (!exists) return false;

      // Verify the container belongs to IronCurtain before removing it,
      // same `ironcurtain.bundle` ownership check as the Docker backend.
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
