/** Backend-neutral access to one bundle-private Docker Engine. */

import { z } from 'zod';
import type { ContainerRuntime, DockerExecResult } from '../docker/types.js';
import {
  preflightClientToolchain,
  type ClientToolchainPreflight,
  type LoadedClientToolchainManifest,
} from './client-toolchain.js';

export const PRIVATE_DOCKER_API_DIR = '/run/ironcurtain-docker';
export const PRIVATE_DOCKER_SOCKET = `${PRIVATE_DOCKER_API_DIR}/docker.sock`;
export const PRIVATE_DOCKER_HOST = `unix://${PRIVATE_DOCKER_SOCKET}`;
/** Pinned Docker CLI/toolchain location shared by supported private-daemon backends. */
export const PRIVATE_DOCKER_TOOLCHAIN_DIR = '/usr/local/lib/ironcurtain-docker/bin';
export const PRIVATE_DOCKER_CLIENT = `${PRIVATE_DOCKER_TOOLCHAIN_DIR}/docker`;
export const PRIVATE_DOCKER_WORKLOAD_NETWORK = 'ironcurtain';
export const PRIVATE_DOCKER_WORKLOAD_NETWORK_ENV = 'IRONCURTAIN_DOCKER_NETWORK';

export const PRIVATE_DOCKER_READINESS_TEXT_BOUNDS = Object.freeze({
  driverLength: 128,
  serverVersionLength: 128,
  securityOptionLength: 256,
  securityOptionCount: 64,
});

const REQUIRED_STORAGE_DRIVER = 'vfs';
const ROOTLESS_SECURITY_OPTION = 'name=rootless';
const INFO_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const LOG_TAIL_MAX_BYTES = 4096;
const MAX_NETWORK_INSPECT_BYTES = 16 * 1024;
const MANAGED_NETWORK_LABEL_KEY = 'com.ironcurtain.managed-workload';
const MANAGED_NETWORK_LABEL_VALUE = 'true';
const CONTROL_CHARACTERS = /[^\P{Cc}\n\t]/gu;

const dockerInfoSchema = z.object({
  Driver: z.string().min(1),
  SecurityOptions: z.array(z.string().min(1)).nullish(),
  ServerVersion: z.string().min(1),
});

export interface PrivateDockerClient {
  readonly containerId: string;
  /** Execute Docker CLI arguments after the fixed `docker --host ...` prefix. */
  execute(args: readonly string[], timeoutMs?: number): Promise<DockerExecResult>;
}

/** Bind all private-Docker commands to one outer container, client, socket, and user. */
export function createPrivateDockerClient(options: {
  readonly runtime: Pick<ContainerRuntime, 'exec'>;
  readonly containerId: string;
  readonly dockerCommand: string;
  readonly dockerHost: string;
  readonly execUser: string | null;
  readonly defaultTimeoutMs: number;
}): PrivateDockerClient {
  return {
    containerId: options.containerId,
    execute: (args, timeoutMs) =>
      options.runtime.exec(
        options.containerId,
        [options.dockerCommand, '--host', options.dockerHost, ...args],
        timeoutMs ?? options.defaultTimeoutMs,
        options.execUser,
      ),
  };
}

export interface PrivateDockerDaemonReadiness {
  readonly driver: string;
  readonly securityOptions: readonly string[];
  readonly serverVersion: string;
  readonly readinessMs: number;
}

export interface WaitForPrivateDockerDaemonReadyOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly readLogTail?: () => Promise<Pick<DockerExecResult, 'stdout' | 'exitCode'>>;
  readonly label?: string;
}

/** Poll and adjudicate one rootless/vfs daemon through a backend-provided client. */
export async function waitForPrivateDockerDaemonReady(
  client: PrivateDockerClient,
  options: WaitForPrivateDockerDaemonReadyOptions,
): Promise<PrivateDockerDaemonReadiness> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const label = options.label ?? 'private Docker daemon';
  const startedAtMs = now();
  const deadlineMs = startedAtMs + options.timeoutMs;

  for (;;) {
    const probe = await client.execute(['info', '--format', '{{json .}}'], INFO_PROBE_TIMEOUT_MS);
    if (probe.exitCode === 0) {
      const answer = readDockerInfoAnswer(probe.stdout, label);
      if (answer.kind === 'daemon-answered') {
        return { ...answer.readiness, readinessMs: now() - startedAtMs };
      }
    }
    if (now() >= deadlineMs) {
      throw new Error(
        `${label} did not become ready within ${options.timeoutMs}ms; dockerd log tail:\n${await readLogTail(options.readLogTail)}`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

/** Preflight the common Docker CLI/daemon/plugin tuple through one private client. */
export function preflightPrivateDockerClient(options: {
  readonly client: PrivateDockerClient;
  readonly manifest: LoadedClientToolchainManifest;
}): Promise<ClientToolchainPreflight> {
  return preflightClientToolchain({
    containerId: options.client.containerId,
    manifest: options.manifest,
    runtime: {
      exec: async (containerId, command, timeoutMs) => {
        if (containerId !== options.client.containerId) {
          throw new Error('private Docker preflight container ID mismatch');
        }
        if (command[0] !== 'docker') throw new Error('private Docker preflight requires the Docker client');
        return options.client.execute(command.slice(1), timeoutMs);
      },
    },
  });
}

export interface PrivateDockerWorkloadNetwork {
  readonly name: typeof PRIVATE_DOCKER_WORKLOAD_NETWORK;
  readonly id: string;
}

/** Create and adjudicate the bundle-local internal bridge shared by both backends. */
export async function createPrivateDockerWorkloadNetwork(
  client: PrivateDockerClient,
): Promise<PrivateDockerWorkloadNetwork> {
  const created = await client.execute([
    'network',
    'create',
    '--driver',
    'bridge',
    '--internal',
    '--label',
    `${MANAGED_NETWORK_LABEL_KEY}=${MANAGED_NETWORK_LABEL_VALUE}`,
    PRIVATE_DOCKER_WORKLOAD_NETWORK,
  ]);
  if (created.exitCode !== 0) throw privateDockerCommandError('managed network create', created);
  const createdId = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(createdId)) {
    throw new Error('private Docker managed network create returned an invalid network ID');
  }

  const inspected = await client.execute([
    'network',
    'inspect',
    '--format',
    '{{json .}}',
    PRIVATE_DOCKER_WORKLOAD_NETWORK,
  ]);
  if (inspected.exitCode !== 0) throw privateDockerCommandError('managed network inspect', inspected);
  if (Buffer.byteLength(inspected.stdout, 'utf8') > MAX_NETWORK_INSPECT_BYTES) {
    throw new Error('private Docker managed network inspection exceeded the response limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspected.stdout) as unknown;
  } catch (error) {
    throw new Error('private Docker managed network inspect returned invalid JSON', { cause: error });
  }
  const labels = (parsed as { Labels?: unknown } | null)?.Labels;
  const containers = (parsed as { Containers?: unknown } | null)?.Containers;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { Id?: unknown }).Id !== createdId ||
    (parsed as { Name?: unknown }).Name !== PRIVATE_DOCKER_WORKLOAD_NETWORK ||
    (parsed as { Driver?: unknown }).Driver !== 'bridge' ||
    (parsed as { Scope?: unknown }).Scope !== 'local' ||
    (parsed as { Internal?: unknown }).Internal !== true ||
    typeof labels !== 'object' ||
    labels === null ||
    Array.isArray(labels) ||
    Object.keys(labels).length !== 1 ||
    (labels as Record<string, unknown>)[MANAGED_NETWORK_LABEL_KEY] !== MANAGED_NETWORK_LABEL_VALUE ||
    typeof containers !== 'object' ||
    containers === null ||
    Array.isArray(containers) ||
    Object.keys(containers).length !== 0
  ) {
    throw new Error('private Docker managed network did not resolve to the required empty labeled internal bridge');
  }
  return { name: PRIVATE_DOCKER_WORKLOAD_NETWORK, id: createdId };
}

export interface ApplePrivateDockerImageObservation {
  readonly transport: 'apple-archive';
  readonly logicalName: string;
  readonly buildHash: string;
  readonly archiveSha256: string;
  readonly outerImageId: string;
  readonly innerImageId: string;
}

export interface DockerDesktopPrivateDockerImageObservation {
  readonly transport: 'docker-desktop-direct';
  readonly outerImageId: string;
}

/** Backend-discriminated selected-image evidence for one private daemon. */
export type PrivateDockerImageObservation =
  | ApplePrivateDockerImageObservation
  | DockerDesktopPrivateDockerImageObservation;

export interface PrivateDockerBootstrapObservation {
  readonly preflight: ClientToolchainPreflight;
  readonly network: PrivateDockerWorkloadNetwork;
  readonly image: PrivateDockerImageObservation;
}

function readDockerInfoAnswer(
  stdout: string,
  label: string,
):
  | { readonly kind: 'daemon-silent' }
  | { readonly kind: 'daemon-answered'; readonly readiness: Omit<PrivateDockerDaemonReadiness, 'readinessMs'> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`${label} readiness could not parse the docker info JSON`);
  }
  if (!daemonAnswered(parsed)) return { kind: 'daemon-silent' };

  const result = dockerInfoSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${label} readiness received docker info JSON without Driver/SecurityOptions/ServerVersion`);
  }
  const info = result.data;
  assertBoundedDockerInfoText(info, label);
  const securityOptions = info.SecurityOptions ?? [];
  if (info.Driver !== REQUIRED_STORAGE_DRIVER) {
    throw new Error(
      `${label} readiness rejected an unsupported storage driver: expected ${REQUIRED_STORAGE_DRIVER}, received ${info.Driver}`,
    );
  }
  if (!securityOptions.includes(ROOTLESS_SECURITY_OPTION)) {
    throw new Error(
      `${label} readiness rejected a non-rootless daemon: ${ROOTLESS_SECURITY_OPTION} missing from [${securityOptions.join(', ')}]`,
    );
  }
  return {
    kind: 'daemon-answered',
    readiness: { driver: info.Driver, securityOptions, serverVersion: info.ServerVersion },
  };
}

function daemonAnswered(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const info = parsed as Record<string, unknown>;
  if (Array.isArray(info.ServerErrors) && info.ServerErrors.length > 0) return false;
  return nonEmptyString(info.Driver) && nonEmptyString(info.ServerVersion);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertBoundedDockerInfoText(info: z.infer<typeof dockerInfoSchema>, label: string): void {
  const bounds = PRIVATE_DOCKER_READINESS_TEXT_BOUNDS;
  assertBoundedField('Driver', info.Driver, bounds.driverLength, label);
  assertBoundedField('ServerVersion', info.ServerVersion, bounds.serverVersionLength, label);
  const securityOptions = info.SecurityOptions ?? [];
  if (securityOptions.length > bounds.securityOptionCount) {
    throw new Error(
      `${label} readiness rejected oversized docker info text: SecurityOptions has ${securityOptions.length} entries, bound is ${bounds.securityOptionCount}`,
    );
  }
  securityOptions.forEach((option, index) =>
    assertBoundedField(`SecurityOptions[${index}]`, option, bounds.securityOptionLength, label),
  );
}

function assertBoundedField(field: string, value: string, maxLength: number, label: string): void {
  if (value.length > maxLength) {
    throw new Error(
      `${label} readiness rejected oversized docker info text: ${field} is ${value.length} characters, bound is ${maxLength}`,
    );
  }
}

async function readLogTail(read: WaitForPrivateDockerDaemonReadyOptions['readLogTail']): Promise<string> {
  if (read === undefined) return '(dockerd log unavailable)';
  try {
    const tail = await read();
    if (tail.exitCode !== 0) return '(dockerd log unavailable)';
    const text = boundedDiagnostic(tail.stdout, LOG_TAIL_MAX_BYTES);
    return text.length > 0 ? text : '(dockerd log is empty)';
  } catch {
    return '(dockerd log unavailable)';
  }
}

function boundedDiagnostic(text: string, maxBytes: number): string {
  const sanitized = text.replace(CONTROL_CHARACTERS, '').trim();
  const bytes = Buffer.from(sanitized, 'utf8');
  if (bytes.byteLength <= maxBytes) return sanitized;
  return `${bytes.subarray(0, maxBytes).toString('utf8')}… (truncated)`;
}

function privateDockerCommandError(operation: string, result: DockerExecResult): Error {
  const detail = (result.stderr.trim() || result.stdout.trim() || 'no diagnostic output').slice(-2048);
  return new Error(`private Docker ${operation} failed with exit code ${result.exitCode}: ${detail}`);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
