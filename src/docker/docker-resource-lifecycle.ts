/**
 * Crash-safe ownership, reconciliation, and IPv4 allocation for Docker
 * resources created by IronCurtain.
 *
 * Docker intentionally outlives its CLI clients. A killed IronCurtain process
 * therefore leaves containers and networks behind unless a later process can
 * prove ownership and reclaim them. Labels plus a host-side owner lease provide
 * that proof without confusing a concurrently-starting empty network for an
 * orphan.
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces, platform } from 'node:os';
import { resolve } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';
import * as logger from '../logger.js';
import { isExecError } from '../utils/exec-error.js';
import type { BundleId } from '../session/types.js';
import type { ContainerRuntime, DockerNetworkInfo } from './types.js';

export const IRONCURTAIN_MANAGED_LABEL = 'ironcurtain.managed';
export const IRONCURTAIN_OWNER_PID_LABEL = 'ironcurtain.owner-pid';
export const IRONCURTAIN_OWNER_TOKEN_LABEL = 'ironcurtain.owner-token';
export const IRONCURTAIN_CREATED_AT_LABEL = 'ironcurtain.created-at';
export const IRONCURTAIN_RESOURCE_SCHEMA_LABEL = 'ironcurtain.resource-schema';
const IRONCURTAIN_BUNDLE_LABEL = 'ironcurtain.bundle';
const RESOURCE_SCHEMA = '2';
// Current bundle slugs are 12 hex digits; pre-identity-refactor names used a
// raw UUID substring and therefore contain a hyphen after eight digits.
const LEGACY_NETWORK_RE = /^ironcurtain-(?:[a-f0-9]{12}|[a-f0-9]{8}-[a-f0-9]{3})$/;
const LEGACY_EMPTY_NETWORK_GRACE_MS = 2 * 60_000;

interface OwnerLease {
  readonly token: string;
  readonly pid: number;
  readonly identity: ProcessIdentity;
  readonly path: string;
}

export interface ProcessIdentity {
  /** Stable for a single host boot, preventing a pre-reboot lease from matching. */
  readonly bootId: string;
  /** OS-reported process start time, preventing a recycled PID from matching. */
  readonly startedAt: string;
}

const ownerLeases = new Map<string, OwnerLease>();
let exitHookInstalled = false;
let cachedBootId: string | undefined;

function currentBootId(): string {
  if (cachedBootId) return cachedBootId;
  try {
    if (platform() === 'linux') {
      cachedBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } else if (platform() === 'darwin') {
      const bootTime = execFileSync('sysctl', ['-n', 'kern.boottime'], {
        encoding: 'utf8',
        timeout: 1_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = bootTime.match(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/);
      if (match) cachedBootId = `darwin:${match[1]}.${match[2]}`;
    }
  } catch {
    // Process start time remains sufficient to distinguish recycled PIDs.
  }
  cachedBootId ||= `${platform()}:unknown-boot`;
  return cachedBootId;
}

function defaultProcessIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim();
    if (!startedAt) return undefined;
    return { bootId: currentBootId(), startedAt };
  } catch {
    return undefined;
  }
}

function leaseRoot(): string {
  return resolve(getIronCurtainHome(), 'run', 'docker-owners');
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const lease of ownerLeases.values()) {
      try {
        unlinkSync(lease.path);
      } catch {
        // A crash reconciler may already have removed it.
      }
    }
  });
}

function ownerLeaseKey(root: string, bundleId: string): string {
  return `${root}\0${bundleId}`;
}

function getOwnerLease(bundleId: string): OwnerLease {
  const root = leaseRoot();
  const key = ownerLeaseKey(root, bundleId);
  const existing = ownerLeases.get(key);
  if (existing) return existing;

  mkdirSync(root, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const path = resolve(root, `${token}.json`);
  const identity = defaultProcessIdentity(process.pid);
  if (!identity) throw new Error(`Unable to determine the identity of owner process ${process.pid}`);
  const lease = { token, pid: process.pid, identity, path };
  writeFileSync(
    path,
    JSON.stringify({ token, pid: process.pid, identity, bundleId, createdAt: new Date().toISOString() }),
    { mode: 0o600, flag: 'wx' },
  );
  ownerLeases.set(key, lease);
  installExitHook();
  return lease;
}

/** Labels stamped on every managed container and network. */
export function managedResourceLabels(bundleId: BundleId | string): Record<string, string> {
  const lease = getOwnerLease(bundleId);
  return {
    [IRONCURTAIN_MANAGED_LABEL]: 'true',
    [IRONCURTAIN_BUNDLE_LABEL]: bundleId,
    [IRONCURTAIN_OWNER_PID_LABEL]: String(lease.pid),
    [IRONCURTAIN_OWNER_TOKEN_LABEL]: lease.token,
    [IRONCURTAIN_CREATED_AT_LABEL]: new Date().toISOString(),
    [IRONCURTAIN_RESOURCE_SCHEMA_LABEL]: RESOURCE_SCHEMA,
  };
}

/** Marks a completed/failed bundle as no longer live so same-process GC can reclaim a failed teardown. */
export function releaseManagedResourceLease(bundleId: BundleId | string): void {
  const root = leaseRoot();
  const key = ownerLeaseKey(root, bundleId);
  const lease = ownerLeases.get(key);
  if (!lease) return;
  ownerLeases.delete(key);
  try {
    unlinkSync(lease.path);
  } catch {
    // Already reclaimed or removed during shutdown.
  }
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ownerIsAlive(
  labels: Readonly<Record<string, string>>,
  pidAlive: (pid: number) => boolean,
  processIdentity: (pid: number) => ProcessIdentity | undefined,
  root = leaseRoot(),
): boolean {
  const pid = Number(labels[IRONCURTAIN_OWNER_PID_LABEL]);
  const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
  if (!Number.isSafeInteger(pid) || pid <= 0 || !token || !pidAlive(pid)) return false;
  try {
    const lease = JSON.parse(readFileSync(resolve(root, `${token}.json`), 'utf8')) as {
      token?: unknown;
      pid?: unknown;
      identity?: Partial<ProcessIdentity>;
    };
    if (
      lease.token !== token ||
      lease.pid !== pid ||
      typeof lease.identity?.bootId !== 'string' ||
      typeof lease.identity.startedAt !== 'string'
    ) {
      return false;
    }
    const currentIdentity = processIdentity(pid);
    return (
      currentIdentity !== undefined &&
      currentIdentity.bootId === lease.identity.bootId &&
      currentIdentity.startedAt === lease.identity.startedAt
    );
  } catch {
    return false;
  }
}

interface ReconcileOptions {
  readonly dryRun?: boolean;
  readonly now?: Date;
  readonly pidAlive?: (pid: number) => boolean;
  readonly processIdentity?: (pid: number) => ProcessIdentity | undefined;
  readonly legacyGraceMs?: number;
}

export interface ReconcileResult {
  readonly removedContainers: readonly string[];
  readonly removedNetworks: readonly string[];
  readonly retainedActiveResources: number;
  readonly skippedUnsafeNetworks: readonly string[];
}

function resourceAgeMs(created: string, now: Date): number {
  const timestamp = Date.parse(created);
  return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) : Number.POSITIVE_INFINITY;
}

async function withReconcileLock<T>(
  fn: () => Promise<T>,
  processIdentity: (pid: number) => ProcessIdentity | undefined,
): Promise<T | undefined> {
  const root = leaseRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = resolve(root, 'reconcile.lock');
  let fd: number | undefined;
  try {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as {
          pid?: unknown;
          identity?: Partial<ProcessIdentity>;
        };
        const currentIdentity = typeof owner.pid === 'number' ? processIdentity(owner.pid) : undefined;
        if (
          typeof owner.pid === 'number' &&
          defaultPidAlive(owner.pid) &&
          currentIdentity !== undefined &&
          owner.identity !== undefined &&
          currentIdentity.bootId === owner.identity.bootId &&
          currentIdentity.startedAt === owner.identity.startedAt
        ) {
          return undefined;
        }
      } catch {
        // Invalid/stale lock: replace it below.
      }
      rmSync(lockPath, { force: true });
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) }));
    }
    return await fn();
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (fd !== undefined) rmSync(lockPath, { force: true });
  }
}

/**
 * Reclaims resources whose owner process is gone. Unlabeled legacy networks
 * are reclaimed only when empty and old enough; attached legacy resources are
 * deliberately left for an explicit operator action because ownership cannot
 * be proven safely.
 */
export async function reconcileIronCurtainDockerResources(
  docker: ContainerRuntime,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const empty: ReconcileResult = {
    removedContainers: [],
    removedNetworks: [],
    retainedActiveResources: 0,
    skippedUnsafeNetworks: [],
  };
  if (!docker.listNetworks || !docker.listContainers) return empty;

  const identityProbe = options.processIdentity ?? defaultProcessIdentity;
  const identityCache = new Map<number, ProcessIdentity | undefined>();
  const processIdentity = (pid: number): ProcessIdentity | undefined => {
    if (!identityCache.has(pid)) identityCache.set(pid, identityProbe(pid));
    return identityCache.get(pid);
  };
  const result = await withReconcileLock(async (): Promise<ReconcileResult> => {
    const pidAlive = options.pidAlive ?? defaultPidAlive;
    const now = options.now ?? new Date();
    const removedContainers: string[] = [];
    const removedNetworks: string[] = [];
    const skippedUnsafeNetworks: string[] = [];
    const deadOwnerTokens = new Set<string>();
    let retainedActiveResources = 0;

    const managedContainers = await docker.listContainers?.({ labelFilter: `${IRONCURTAIN_MANAGED_LABEL}=true` });
    for (const container of managedContainers ?? []) {
      if (ownerIsAlive(container.labels, pidAlive, processIdentity)) {
        retainedActiveResources++;
        continue;
      }
      const ownerToken = container.labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
      if (ownerToken) deadOwnerTokens.add(ownerToken);
      logger.warn(`[docker-gc] reclaiming orphaned container ${container.name}`);
      if (!options.dryRun) {
        await docker.remove(container.id);
        if (await docker.containerExists(container.id)) {
          logger.warn(`[docker-gc] container ${container.name} still exists after forced removal`);
          continue;
        }
      }
      removedContainers.push(container.name);
    }

    const removedContainerIds = new Set(
      (managedContainers ?? [])
        .filter((container) => removedContainers.includes(container.name))
        .map((container) => container.id),
    );
    const networks = await docker.listNetworks?.();
    for (const network of networks ?? []) {
      const managed = network.labels[IRONCURTAIN_MANAGED_LABEL] === 'true';
      const legacy = !managed && LEGACY_NETWORK_RE.test(network.name);
      if (!managed && !legacy) continue;

      if (managed && ownerIsAlive(network.labels, pidAlive, processIdentity)) {
        retainedActiveResources++;
        continue;
      }
      const ownerToken = network.labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
      if (managed && ownerToken) deadOwnerTokens.add(ownerToken);
      if (legacy) {
        const graceMs = options.legacyGraceMs ?? LEGACY_EMPTY_NETWORK_GRACE_MS;
        if (network.containerIds.length > 0 || resourceAgeMs(network.created, now) < graceMs) {
          skippedUnsafeNetworks.push(network.name);
          continue;
        }
      }

      const survivingAttachments = network.containerIds.filter((id) => !removedContainerIds.has(id));
      if (survivingAttachments.length > 0) {
        logger.warn(`[docker-gc] refusing to remove ${network.name}: it has non-orphan attachments`);
        skippedUnsafeNetworks.push(network.name);
        continue;
      }
      logger.warn(`[docker-gc] reclaiming orphaned network ${network.name}`);
      if (!options.dryRun) {
        await docker.removeNetwork(network.name);
        if (docker.networkExists && (await docker.networkExists(network.name))) {
          logger.warn(`[docker-gc] network ${network.name} still exists after removal`);
          continue;
        }
      }
      removedNetworks.push(network.name);
    }

    if (!options.dryRun) {
      for (const token of deadOwnerTokens) rmSync(resolve(leaseRoot(), `${token}.json`), { force: true });
    }

    return { removedContainers, removedNetworks, retainedActiveResources, skippedUnsafeNetworks };
  }, processIdentity);
  return result ?? empty;
}

/** Startup/retry reconciliation must never become a Docker session prerequisite. */
export async function reconcileIronCurtainDockerResourcesBestEffort(
  docker: ContainerRuntime,
  context: string,
): Promise<void> {
  try {
    await reconcileIronCurtainDockerResources(docker);
  } catch (error) {
    logger.warn(
      `[docker-gc] ${context} reconciliation skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface Ipv4Cidr {
  readonly network: number;
  readonly prefix: number;
}

function ipv4ToNumber(address: string): number | undefined {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function numberToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function parseIpv4Cidr(value: string): Ipv4Cidr | undefined {
  const [address, rawPrefix] = value.split('/');
  const prefix = Number(rawPrefix);
  const ip = ipv4ToNumber(address);
  if (ip === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (ip & mask) >>> 0, prefix };
}

function cidrsOverlap(left: Ipv4Cidr, right: Ipv4Cidr): boolean {
  const prefix = Math.min(left.prefix, right.prefix);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (left.network & mask) === (right.network & mask);
}

export function hostInterfaceIpv4Cidrs(): readonly string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && entry.cidr)
    .map((entry) => entry.cidr as string);
}

const DOCKER_SUBNET_PREFIX = 29;
const ADDRESS_POOLS = ['172.20.0.0/14', '172.24.0.0/14', '172.28.0.0/14', '10.240.0.0/12'] as const;

/** Returns the allocator pool containing a selected /29. */
export function dockerAllocationPoolForSubnet(subnet: string): string {
  const candidate = parseIpv4Cidr(subnet);
  if (!candidate) return subnet;
  return (
    ADDRESS_POOLS.find((pool) => {
      const parsed = parseIpv4Cidr(pool);
      return parsed !== undefined && cidrsOverlap(candidate, parsed);
    }) ?? subnet
  );
}

export class InternalNetworkConnectivityError extends Error {
  constructor(
    message: string,
    readonly subnet?: string,
  ) {
    super(message);
    this.name = 'InternalNetworkConnectivityError';
  }
}

export async function withInternalNetworkAllocationRetry<T>(
  options: {
    readonly maxAttempts: number;
    readonly description: string;
    readonly reconcile?: () => Promise<void>;
  },
  runAttempt: (excludedSubnets: ReadonlySet<string>, attempt: number) => Promise<T>,
): Promise<T> {
  const excludedSubnets = new Set<string>();
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await runAttempt(excludedSubnets, attempt);
    } catch (error) {
      lastError = error;
      if (!(error instanceof InternalNetworkConnectivityError) || !error.subnet || attempt === options.maxAttempts) {
        throw error;
      }
      const rejectedPool = dockerAllocationPoolForSubnet(error.subnet);
      excludedSubnets.add(rejectedPool);
      logger.warn(
        `${options.description} ${error.subnet} failed its end-to-end checks; rejecting ${rejectedPool} and ` +
          `retrying with another allocation (${attempt}/${options.maxAttempts})`,
      );
      await options.reconcile?.();
    }
  }
  throw lastError;
}

function* candidateSubnets(name: string): Generator<string> {
  const seed = createHash('sha256').update(name).digest().readUInt32BE(0);
  for (const poolValue of ADDRESS_POOLS) {
    const pool = parseIpv4Cidr(poolValue);
    if (!pool) continue;
    const count = 2 ** (DOCKER_SUBNET_PREFIX - pool.prefix);
    const offset = seed % count;
    const blockSize = 2 ** (32 - DOCKER_SUBNET_PREFIX);
    for (let index = 0; index < count; index++) {
      const block = (pool.network + ((offset + index) % count) * blockSize) >>> 0;
      yield `${numberToIpv4(block)}/${DOCKER_SUBNET_PREFIX}`;
    }
  }
}

function allocationConflict(error: unknown): boolean {
  if (!isExecError(error)) return false;
  return /overlap|address pool|fully subnetted|pool.*exhaust|no available network/i.test(error.stderr);
}

export interface AllocatedInternalNetwork {
  readonly name: string;
  readonly subnet: string;
}

/** Allocates a small internal subnet while never falling back into 192.168/16. */
export async function createIronCurtainInternalNetwork(
  docker: ContainerRuntime,
  name: string,
  bundleId: BundleId | string,
  options: {
    readonly excludedSubnets?: ReadonlySet<string>;
    readonly hostCidrs?: readonly string[];
  } = {},
): Promise<AllocatedInternalNetwork> {
  const networks = (await docker.listNetworks?.()) ?? [];
  const sameNamedNetwork = networks.find((network) => network.name === name);
  if (sameNamedNetwork) {
    throw new Error(
      `Docker network ${name} already exists (${sameNamedNetwork.subnets.join(', ') || 'unknown subnet'}). ` +
        `Refusing to reuse it because its requested ownership/subnet cannot be verified.`,
    );
  }
  const occupied = [
    ...networks.flatMap((network: DockerNetworkInfo) => network.subnets),
    ...(options.hostCidrs ?? hostInterfaceIpv4Cidrs()),
  ]
    .map(parseIpv4Cidr)
    .filter((cidr): cidr is Ipv4Cidr => cidr !== undefined);
  const excluded = [...(options.excludedSubnets ?? [])]
    .map(parseIpv4Cidr)
    .filter((cidr): cidr is Ipv4Cidr => cidr !== undefined);

  let lastConflict: unknown;
  for (const subnet of candidateSubnets(name)) {
    const candidate = parseIpv4Cidr(subnet);
    if (
      !candidate ||
      excluded.some((cidr) => cidrsOverlap(candidate, cidr)) ||
      occupied.some((cidr) => cidrsOverlap(candidate, cidr))
    ) {
      continue;
    }
    try {
      await docker.createNetwork(name, {
        internal: true,
        subnet,
        labels: managedResourceLabels(bundleId),
      });
      return { name, subnet };
    } catch (error) {
      if (!allocationConflict(error)) throw error;
      lastConflict = error;
      occupied.push(candidate);
    }
  }

  throw new Error(
    `No collision-free IronCurtain Docker subnet is available for ${name}. ` +
      `Reconciled the managed resources and searched /29 networks outside 192.168.0.0/16.`,
    { cause: lastConflict },
  );
}
