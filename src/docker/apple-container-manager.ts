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
import type {
  ContainerRuntime,
  DockerContainerConfig,
  DockerContainerInfo,
  DockerExecResult,
  DockerImageInfo,
  DockerNetworkCreateOptions,
} from './types.js';
import * as logger from '../logger.js';
import type { DockerAvailability } from './docker-probe.js';
import { isExecError, isExecTimeout } from '../utils/exec-error.js';
import {
  defaultExecFile,
  type ExecFileFn,
  DEFAULT_EXEC_TIMEOUT_MS,
  PULL_IDLE_TIMEOUT_MS,
  BUILD_IDLE_TIMEOUT_MS,
  IRONCURTAIN_LABEL_BUNDLE,
  IRONCURTAIN_LABEL_WORKFLOW,
  IRONCURTAIN_LABEL_SCOPE,
  makeRunStreamed,
  type CreateDockerManagerOptions,
} from './docker-manager.js';
import { buildContainerExecEnvironmentArgs } from './container-exec-environment.js';
import { createDockerProgressSink } from './docker-progress-sink.js';

/** Grace period for `container stop` before the runtime kills the VM. */
const STOP_TIMEOUT_SECONDS = 10;

/**
 * Apple Container's XPC-backed inventory can transiently hang after deleting
 * a VM. Retry one killed-by-timeout list process, but keep the total bounded:
 * an unsuccessful attempt is never treated as absence evidence.
 */
const CONTAINER_INVENTORY_TIMEOUT_MS = 30_000;
const CONTAINER_INVENTORY_RETRY_DELAY_MS = 250;

/**
 * Minimum supported `container` CLI version. 1.1.0 is the floor for the
 * `uds` topology this backend now uses: it adds working per-file UDS
 * relays via `-v <host.sock>:<guest.sock>` (host-listens / guest-connects
 * over vsock) and a functional `--network none`. 1.0.x lacks both and
 * would need the retired `tcp-hostonly` topology.
 */
const MIN_MAJOR_VERSION = 1;
const MIN_MINOR_VERSION = 1;

/**
 * Minimum Darwin kernel major for macOS 26. The `container network`
 * commands this backend depends on do not function on macOS 15 (Darwin 24).
 */
const MIN_DARWIN_MAJOR = 25;

/** Shape of one element of `container inspect` JSON output (1.0.0). */
interface AppleContainerInspect {
  readonly id?: string;
  readonly configuration?: {
    readonly id?: string;
    readonly creationDate?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly image?: { readonly descriptor?: { readonly digest?: string } };
  };
  readonly status?: {
    readonly state?: string;
    readonly networks?: ReadonlyArray<{ readonly network?: string; readonly ipv4Address?: string }>;
  };
}

/** Normalize one `container list --format json` entry for host reconciliation. */
export function parseAppleContainerInfo(raw: unknown): DockerContainerInfo {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Unexpected apple-container list result: expected object');
  }
  const entry = raw as AppleContainerInspect;
  const id = entry.id ?? entry.configuration?.id;
  if (typeof id !== 'string' || id === '') {
    throw new Error('Unexpected apple-container list result: missing container ID');
  }
  return {
    id,
    name: entry.configuration?.id ?? id,
    created: entry.configuration?.creationDate ?? '',
    running: entry.status?.state === 'running',
    labels: stringRecord(entry.configuration?.labels),
  };
}

/** Shape of one element of `container image inspect` JSON output (1.0.0). */
interface AppleImageInspect {
  readonly configuration?: {
    readonly creationDate?: string;
    readonly descriptor?: { readonly digest?: string };
    readonly name?: string;
  };
  readonly id?: string;
  readonly variants?: ReadonlyArray<{
    readonly platform?: { readonly architecture?: string; readonly os?: string };
    readonly config?: {
      readonly architecture?: string;
      readonly created?: string;
      readonly os?: string;
      readonly config?: { readonly Labels?: Readonly<Record<string, string>> };
    };
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

function canonicalSha256Digest(digest: string): string {
  const normalized = normalizeDigest(digest).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`Unexpected apple-container image digest: ${digest}`);
  }
  return `sha256:${normalized}`;
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** Normalize Apple Container's index-oriented image metadata for shared callers. */
export function parseAppleImageInfo(raw: unknown): DockerImageInfo {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Unexpected apple-container image inspect result: expected object');
  }
  const entry = raw as AppleImageInspect;
  const rawDigest = entry.configuration?.descriptor?.digest ?? entry.id;
  if (rawDigest === undefined) {
    throw new Error('Unexpected apple-container image inspect result: missing immutable image digest');
  }

  // Apple Container only runs on Apple silicon. Select the arm64 variant
  // explicitly so labels from another member of a multi-platform index can
  // never qualify the local image.
  const variant = entry.variants?.find(
    (candidate) =>
      (candidate.platform?.architecture ?? candidate.config?.architecture) === 'arm64' &&
      (candidate.platform?.os ?? candidate.config?.os) === 'linux',
  );
  if (variant === undefined) {
    throw new Error('Unexpected apple-container image inspect result: missing linux/arm64 variant');
  }

  return {
    // Unlike Docker, Apple Container identifies an image by the top-level OCI
    // index/manifest descriptor rather than the config digest.
    id: canonicalSha256Digest(rawDigest),
    repoTags: typeof entry.configuration?.name === 'string' ? [entry.configuration.name] : [],
    labels: stringRecord(variant.config?.config?.Labels),
    created: entry.configuration?.creationDate ?? variant.config?.created ?? '',
  };
}

function imageMatchesLabelFilter(
  image: { readonly labels: Readonly<Record<string, string>> },
  filter: string,
): boolean {
  const separator = filter.indexOf('=');
  if (separator === -1) return Object.hasOwn(image.labels, filter);
  return image.labels[filter.slice(0, separator)] === filter.slice(separator + 1);
}

/** Rejects with a consistent "feature is Docker-only" error for unsupported runtime ops. */
function unsupported(feature: string): Promise<never> {
  return Promise.reject(new Error(`apple-container does not support ${feature}; use the Docker backend`));
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
  const minor = match ? Number.parseInt(match[2], 10) : 0;
  if (!match || major < MIN_MAJOR_VERSION || (major === MIN_MAJOR_VERSION && minor < MIN_MINOR_VERSION)) {
    return {
      available: false,
      reason: `container CLI too old (need >= ${MIN_MAJOR_VERSION}.${MIN_MINOR_VERSION}.0)`,
      detailedMessage:
        `Found "${versionLine}" but IronCurtain requires >= ${MIN_MAJOR_VERSION}.${MIN_MINOR_VERSION}.0 ` +
        '(Unix-domain-socket relays and `--network none` for the UDS topology). ' +
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
 * Configs that encode Docker-only mechanisms (`extraHosts`, `restartPolicy`)
 * throw rather than being silently dropped: they only occur on the
 * Docker-specific topologies, and reaching here with one set means a
 * wiring bug, not a portable request.
 */
export function buildAppleCreateArgs(config: DockerContainerConfig): string[] {
  if (config.extraHosts && config.extraHosts.length > 0) {
    throw new Error('apple-container does not support extra host mappings (--add-host)');
  }
  if (config.restartPolicy) {
    throw new Error('apple-container does not support restart policies');
  }
  if (config.ipv4Address !== undefined) {
    throw new Error('apple-container does not support coordinator-selected static IPv4 addresses');
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
  for (const [key, value] of Object.entries(config.labels ?? {})) {
    args.push('--label', `${key}=${value}`);
  }

  if (config.resources?.memoryMb) {
    args.push('--memory', `${config.resources.memoryMb}M`);
  }
  if (config.resources?.cpus) {
    args.push('--cpus', String(config.resources.cpus));
  }

  for (const mount of config.mounts) {
    // `-v` is the only mount syntax that handles directories, single
    // files, AND Unix-domain sockets uniformly on 1.1.0+: a socket
    // source becomes a vsock relay (host-listens / guest-connects), a
    // file source is a virtiofs single-file share, a directory source
    // is a virtiofs share. `--mount` still rejects non-directory
    // sources, so we do not use it. The colon-separated format has no
    // escaping — reject paths that would corrupt it rather than emit a
    // wrong mount.
    if (mount.source.includes(':') || mount.target.includes(':')) {
      throw new Error(
        `mount path contains ':' which the -v format cannot escape (source=${mount.source}, target=${mount.target})`,
      );
    }
    const readonlySuffix = mount.readonly ? ':ro' : '';
    args.push('-v', `${mount.source}:${mount.target}${readonlySuffix}`);
  }

  for (const publish of config.publishSockets ?? []) {
    // Same colon-separated format as -v; same escaping rule.
    if (publish.hostPath.includes(':') || publish.containerPath.includes(':')) {
      throw new Error(
        `publish-socket path contains ':' which the format cannot escape ` +
          `(hostPath=${publish.hostPath}, containerPath=${publish.containerPath})`,
      );
    }
    args.push('--publish-socket', `${publish.hostPath}:${publish.containerPath}`);
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
  const runStreamed = makeRunStreamed('container', streamOpts, progressSinkFactory);

  const inspectContainer = async (nameOrId: string, timeout: number): Promise<AppleContainerInspect | undefined> => {
    const { stdout } = await exec('container', ['inspect', nameOrId], { timeout });
    return firstInspectEntry(stdout) as AppleContainerInspect | undefined;
  };

  const listContainersJsonOnce = async (): Promise<string> => {
    const { stdout } = await exec('container', ['list', '--all', '--format', 'json'], {
      timeout: CONTAINER_INVENTORY_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  };
  const listContainersJsonWithRetry = async (): Promise<string> => {
    try {
      return await listContainersJsonOnce();
    } catch (error) {
      if (!isExecError(error) || !isExecTimeout(error)) throw error;
      logger.warn(
        `[apple-container-manager] container inventory timed out after ${CONTAINER_INVENTORY_TIMEOUT_MS}ms; ` +
          `retrying once after ${CONTAINER_INVENTORY_RETRY_DELAY_MS}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, CONTAINER_INVENTORY_RETRY_DELAY_MS));
      return listContainersJsonOnce();
    }
  };

  return {
    supportsImageSnapshots: false,

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
      workdir?: string,
      environment?: Readonly<Record<string, string>>,
    ): Promise<DockerExecResult> {
      const timeout = timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
      // Same --user resolution contract as the Docker implementation (see
      // ContainerRuntime.exec JSDoc): undefined → 'codespace', null → omit.
      const resolvedUser = execUser === undefined ? 'codespace' : execUser;
      const userArgs = resolvedUser === null ? [] : (['--user', resolvedUser] as const);
      const workdirArgs = workdir === undefined ? [] : (['--workdir', workdir] as const);
      const environmentArgs = buildContainerExecEnvironmentArgs(environment);
      try {
        const { stdout, stderr } = await exec(
          'container',
          ['exec', ...userArgs, ...workdirArgs, ...environmentArgs, nameOrId, ...command],
          {
            timeout,
            maxBuffer: 50 * 1024 * 1024,
            ...(environment ? { env: { ...process.env, ...environment } } : {}),
          },
        );
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

    async loadImageArchive(archivePath: string): Promise<void> {
      await runStreamed({
        operation: 'container image load',
        args: ['image', 'load', '--input', archivePath],
        idleTimeoutMs: BUILD_IDLE_TIMEOUT_MS,
      });
    },

    async tagImage(sourceRef: string, targetRef: string): Promise<void> {
      await exec('container', ['image', 'tag', sourceRef, targetRef], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
    },

    async saveImageArchive(ref: string, archivePath: string, platform = 'linux/arm64'): Promise<void> {
      await runStreamed({
        operation: 'container image save',
        args: ['image', 'save', '--platform', platform, '--output', archivePath, ref],
        idleTimeoutMs: BUILD_IDLE_TIMEOUT_MS,
      });
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
        return parseAppleImageInfo(firstInspectEntry(stdout)).labels[label];
      } catch {
        return undefined;
      }
    },

    // Workflow snapshot creation remains Docker-only. Generic image inventory
    // operations support selected-image transport and cleanup on Apple
    // Container even though supportsImageSnapshots is false.
    commit: (): Promise<string> => unsupported('image commit (workflow snapshots)'),

    async removeImage(ref: string): Promise<boolean> {
      try {
        await exec('container', ['image', 'delete', '--force', ref], { timeout: 60_000, maxBuffer: 1024 * 1024 });
        return true;
      } catch (err: unknown) {
        if (isExecError(err) && /not found|does not exist|no such image/i.test(err.stderr)) return false;
        const detail = isExecError(err) ? err.stderr.trim() || err.message : String(err);
        logger.warn(`[apple-container-manager] failed to remove image ${ref}: ${detail}`);
        return false;
      }
    },

    async listImages(options?: { readonly labelFilter?: string }): Promise<readonly DockerImageInfo[]> {
      const { stdout } = await exec('container', ['image', 'list', '--format', 'json'], {
        timeout: 30_000,
        maxBuffer: 50 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Unexpected apple-container image list result: expected array');
      }
      const images = parsed.map(parseAppleImageInfo);
      const labelFilter = options?.labelFilter;
      return labelFilter === undefined ? images : images.filter((image) => imageMatchesLabelFilter(image, labelFilter));
    },

    async inspectImage(ref: string): Promise<DockerImageInfo | undefined> {
      try {
        const { stdout } = await exec('container', ['image', 'inspect', ref], {
          timeout: 10_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const parsed = JSON.parse(stdout) as unknown;
        if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
        return parseAppleImageInfo(parsed[0]);
      } catch (err: unknown) {
        if (isExecError(err) && /not found|does not exist|no such image/i.test(err.stderr)) return undefined;
        throw err;
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

    async listContainers(options?: { readonly labelFilter?: string }): Promise<readonly DockerContainerInfo[]> {
      const stdout = await listContainersJsonWithRetry();
      const parsed = JSON.parse(stdout) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Unexpected apple-container list result: expected array');
      }
      const containers = parsed.map(parseAppleContainerInfo);
      const labelFilter = options?.labelFilter;
      return labelFilter === undefined
        ? containers
        : containers.filter((container) => imageMatchesLabelFilter(container, labelFilter));
    },

    async createNetwork(name: string, options?: DockerNetworkCreateOptions): Promise<void> {
      if (options?.gateway) {
        throw new Error('apple-container networks do not support an explicit gateway; the runtime assigns it');
      }
      if (options?.labels && Object.keys(options.labels).length > 0) {
        throw new Error('apple-container networks do not support labels');
      }
      if (
        options?.ipv6Subnet ||
        options?.enableIPv6 ||
        (options?.driverOptions && Object.keys(options.driverOptions).length > 0)
      ) {
        throw new Error('apple-container networks do not support Docker bridge driver options');
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

    async getNetworkGateway(name: string): Promise<string | undefined> {
      try {
        const { stdout } = await exec('container', ['network', 'inspect', name], { timeout: 10_000 });
        const entry = firstInspectEntry(stdout) as { status?: { ipv4Gateway?: string } } | undefined;
        return entry?.status?.ipv4Gateway;
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
