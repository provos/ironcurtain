/** Coordinator-independent process wrapper for the host resource watchdog. */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { sha256HexSchema as sha256Schema, stableStringify } from '../hash.js';
import { assertCanonicalHostPath, writeStableJsonAtomic } from '../hardened-fs.js';
import {
  dockerWorkloadCleanupProofSchema,
  lifecycleIdentifierSchema as identifierSchema,
  timestampSchema,
  watchdogSampleSummarySchema as sampleSchema,
} from '../zod-helpers.js';
import { createContainerRuntime } from '../docker/container-runtime.js';
import type { ContainerRuntime } from '../docker/types.js';
import { inventoryOwnedResourceIds, revokeDockerWorkloadOuterResources } from './bundle-revocation.js';
import {
  assertExactTargetIdentity,
  captureCleanupProof,
  removeExactBundleState,
  toWatchdogCleanupProof,
} from './bundle-cleanup.js';
import {
  closeDockerWorkloadLease,
  loadDockerWorkloadLease,
  recordDockerWorkloadLeaseIncident,
  type DockerWorkloadCleanupProof,
  type DockerWorkloadLease,
} from './bundle-lease.js';
import {
  loadResourceWatchdogPolicy,
  ResourceWatchdog,
  type ResourceWatchdogAttestation,
  type ResourceWatchdogSample,
  type ResourceWatchdogTrip,
} from '../docker/resource-watchdog.js';

export const RESOURCE_WATCHDOG_SUPERVISOR_SCHEMA_VERSION = 1;
export const MAX_RESOURCE_WATCHDOG_SUPERVISOR_JSON_BYTES = 1024 * 1024;

const stopRequestSchema = z
  .object({
    schemaVersion: z.literal(RESOURCE_WATCHDOG_SUPERVISOR_SCHEMA_VERSION),
    leaseId: identifierSchema,
    generation: identifierSchema,
    requestedAt: timestampSchema,
    cleanup: dockerWorkloadCleanupProofSchema,
  })
  .strict();
const tripSchema = z
  .object({
    code: z.enum(['hard-state-threshold', 'host-reserve', 'sample-error', 'sample-stale', 'target-identity']),
    atMs: z.number().int().nonnegative(),
    detail: z.string().min(1).max(8192),
    overshootBytes: z.number().int().nonnegative(),
    overshootWithinFrozenMaximum: z.boolean(),
  })
  .strict();
const supervisorStatusSchema = z
  .object({
    schemaVersion: z.literal(RESOURCE_WATCHDOG_SUPERVISOR_SCHEMA_VERSION),
    leaseId: identifierSchema,
    generation: identifierSchema,
    supervisorPid: z.number().int().positive(),
    state: z.enum(['starting', 'ready', 'revoking', 'closed', 'incident']),
    policySha256: sha256Schema,
    policyId: identifierSchema,
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    lastSample: sampleSchema.nullable(),
    trip: tripSchema.nullable(),
    detail: z.string().min(1).max(8192).nullable(),
  })
  .strict();

export type ResourceWatchdogSupervisorStatus = z.infer<typeof supervisorStatusSchema>;
export type ResourceWatchdogSupervisorStopRequest = z.infer<typeof stopRequestSchema>;

export interface RunResourceWatchdogSupervisorOptions {
  readonly leasePath: string;
  readonly policyPath: string;
  readonly statusPath: string;
  readonly stopRequestPath: string;
  readonly runtime?: ContainerRuntime;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface LaunchDetachedResourceWatchdogSupervisorOptions extends Omit<
  RunResourceWatchdogSupervisorOptions,
  'runtime' | 'now' | 'sleep'
> {
  readonly entrypointPath: string;
  readonly startupTimeoutMs: number;
}

/** Run inside the detached child process until normal cleanup or a trip closes the lease. */
export async function runResourceWatchdogSupervisor(options: RunResourceWatchdogSupervisorOptions): Promise<void> {
  assertCanonicalPrivatePath(options.statusPath, 'watchdog supervisor status');
  assertCanonicalPrivatePath(options.stopRequestPath, 'watchdog supervisor stop request');
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const loadedPolicy = loadResourceWatchdogPolicy(options.policyPath);
  let lease = loadDockerWorkloadLease(options.leasePath);
  if (lease.bindings.watchdogPolicySha256 !== loadedPolicy.sha256) {
    throw new Error('watchdog supervisor policy hash does not match the bundle lease');
  }
  if (lease.paths.stateRoot !== loadedPolicy.policy.targetRoot) {
    throw new Error('watchdog supervisor target root does not match the bundle lease');
  }
  for (const controlPath of [options.leasePath, options.policyPath, options.statusPath, options.stopRequestPath]) {
    if (controlPath === lease.paths.stateRoot || controlPath.startsWith(`${lease.paths.stateRoot}/`)) {
      throw new Error('watchdog supervisor control files must be outside the revocable state root');
    }
  }
  const runtime = options.runtime ?? createContainerRuntime(lease.runtimeKind);
  const startedAt = now().toISOString();
  const baseStatus = {
    schemaVersion: RESOURCE_WATCHDOG_SUPERVISOR_SCHEMA_VERSION,
    leaseId: lease.leaseId,
    generation: lease.generation,
    supervisorPid: process.pid,
    policySha256: loadedPolicy.sha256,
    policyId: loadedPolicy.policy.policyId,
    startedAt,
  } as const;
  let lastStatus = supervisorStatusSchema.parse({
    ...baseStatus,
    state: 'starting',
    updatedAt: startedAt,
    lastSample: null,
    trip: null,
    detail: null,
  });
  writeStrictJsonAtomic(options.statusPath, lastStatus);

  let attestation: ResourceWatchdogAttestation | undefined;
  let tripped: ResourceWatchdogTrip | undefined;
  const watchdog = new ResourceWatchdog(loadedPolicy.policy, {
    schedule: false,
    now: () => now().getTime(),
    onTrip: async (trip) => {
      tripped = trip;
      lastStatus = statusUpdate(lastStatus, now(), {
        state: 'revoking',
        trip: compactTrip(trip),
        detail: trip.detail,
      });
      writeStrictJsonAtomic(options.statusPath, lastStatus);
      try {
        await revokeDockerWorkloadOuterResources(runtime, options.leasePath, lease.generation, now);
        lease = loadDockerWorkloadLease(options.leasePath);
        assertExactTargetIdentity(lease, loadedPolicy.policy.targetDevice, loadedPolicy.policy.targetInode);
        removeExactBundleState(lease, options.leasePath);
        const cleanup = await captureCleanupProof(
          runtime,
          lease,
          loadedPolicy.policy.cleanupInventoryGapMs,
          now,
          sleep,
        );
        closeDockerWorkloadLease(options.leasePath, lease.generation, cleanup, now());
        watchdog.stopAfterCleanup(toWatchdogCleanupProof(cleanup));
        lastStatus = statusUpdate(lastStatus, now(), {
          state: 'closed',
          trip: compactTrip(trip),
          detail: 'resource trip revoked exact outer resources and completed cleanup',
        });
        writeStrictJsonAtomic(options.statusPath, lastStatus);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        try {
          const current = loadDockerWorkloadLease(options.leasePath);
          if (current.status !== 'incident' && current.status !== 'closed') {
            recordDockerWorkloadLeaseIncident(
              options.leasePath,
              current.generation,
              { code: 'watchdog-revocation-failed', detail },
              now(),
            );
          }
        } catch {
          // Status remains authoritative evidence that revocation was not completed.
        }
        lastStatus = statusUpdate(lastStatus, now(), {
          state: 'incident',
          trip: compactTrip(trip),
          detail,
        });
        writeStrictJsonAtomic(options.statusPath, lastStatus);
        throw error;
      }
    },
    onSoftEvidence: (sample) => {
      lastStatus = statusUpdate(lastStatus, now(), { lastSample: compactSample(sample) });
      writeStrictJsonAtomic(options.statusPath, lastStatus);
    },
  });

  try {
    attestation = await watchdog.start();
  } catch (error) {
    if (loadDockerWorkloadLease(options.leasePath).status === 'closed') return;
    throw error;
  }
  lastStatus = statusUpdate(lastStatus, now(), {
    state: 'ready',
    lastSample: compactSample(attestation.firstSample),
    detail: 'watchdog startup attestation passed',
  });
  writeStrictJsonAtomic(options.statusPath, lastStatus);

  for (;;) {
    await sleep(loadedPolicy.policy.sampleIntervalMs);
    const stopRequest = tryLoadStopRequest(options.stopRequestPath);
    if (stopRequest !== undefined) {
      lease = loadDockerWorkloadLease(options.leasePath);
      if (stopRequest.leaseId !== lease.leaseId || stopRequest.generation !== lease.generation) {
        throw new Error('watchdog supervisor stop request lease identity mismatch');
      }
      if (lease.status === 'admitting' || lease.status === 'active') {
        throw new Error('watchdog supervisor refuses to stop before lease revocation');
      }
      if (lease.resources.some((resource) => resource.removal === null)) {
        throw new Error('watchdog supervisor refuses to stop before every outer-resource absence proof');
      }
      if (existsSync(lease.paths.stateRoot)) {
        throw new Error('watchdog supervisor refuses to stop while the exact state root still exists');
      }
      const actuallyOwned = await inventoryOwnedResourceIds(runtime, lease);
      if (actuallyOwned.length !== 0) {
        throw new Error(`watchdog supervisor refuses to stop while owned resources remain: ${actuallyOwned.join(',')}`);
      }
      watchdog.stopAfterCleanup(toWatchdogCleanupProof(stopRequest.cleanup));
      if (lease.status === 'revoking') {
        closeDockerWorkloadLease(options.leasePath, lease.generation, stopRequest.cleanup, now());
      } else if (lease.status !== 'closed') {
        throw new Error(`watchdog supervisor refuses terminal stop from lease state ${lease.status}`);
      }
      lastStatus = statusUpdate(lastStatus, now(), {
        state: 'closed',
        detail: 'coordinator cleanup proof accepted',
      });
      writeStrictJsonAtomic(options.statusPath, lastStatus);
      return;
    }
    const sample = await watchdog.tick();
    if (sample !== undefined) {
      lastStatus = statusUpdate(lastStatus, now(), { lastSample: compactSample(sample) });
      writeStrictJsonAtomic(options.statusPath, lastStatus);
    }
    if (tripped !== undefined) return;
  }
}

/** Spawn a process-group-independent child and wait for its hash-bound attestation. */
export async function launchDetachedResourceWatchdogSupervisor(
  options: LaunchDetachedResourceWatchdogSupervisorOptions,
): Promise<{ readonly pid: number; readonly status: ResourceWatchdogSupervisorStatus }> {
  assertCanonicalHostPath(options.entrypointPath, 'watchdog supervisor entrypoint');
  if (
    !Number.isSafeInteger(options.startupTimeoutMs) ||
    options.startupTimeoutMs < 100 ||
    options.startupTimeoutMs > 60_000
  ) {
    throw new Error('watchdog supervisor startup timeout is invalid');
  }
  const child = spawn(
    process.execPath,
    [
      options.entrypointPath,
      '--lease',
      options.leasePath,
      '--policy',
      options.policyPath,
      '--status',
      options.statusPath,
      '--stop-request',
      options.stopRequestPath,
    ],
    { detached: true, stdio: 'ignore', env: process.env },
  );
  let startupError: Error | undefined;
  child.once('error', (error) => {
    startupError = error;
  });
  const pid = child.pid;
  try {
    if (pid === undefined) throw new Error('watchdog supervisor child has no process ID');
    const deadline = Date.now() + options.startupTimeoutMs;
    for (;;) {
      if (startupError !== undefined) throw new Error('watchdog supervisor failed to start', { cause: startupError });
      let status: ResourceWatchdogSupervisorStatus | undefined;
      try {
        status = loadResourceWatchdogSupervisorStatus(options.statusPath);
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new Error('watchdog supervisor did not attest before the startup deadline', { cause: error });
        }
      }
      if (status !== undefined) {
        if (status.supervisorPid !== pid) throw new Error('watchdog supervisor status process ID mismatch');
        if (status.state === 'ready' || status.state === 'closed') {
          child.unref();
          return { pid, status };
        }
        if (status.state === 'incident') {
          throw new Error(`watchdog supervisor startup incident: ${status.detail ?? 'unknown'}`);
        }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
}

/** Do not orphan a detached supervisor whose startup attestation was rejected. */
async function terminateChild(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  await waitForChildExit(child, 500);
  if (childHasExited(child)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    return;
  }
  await waitForChildExit(child, 500);
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const done = (): void => {
      clearTimeout(timer);
      child.off('exit', done);
      child.off('error', done);
      resolvePromise();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once('exit', done);
    child.once('error', done);
  });
}

export function requestResourceWatchdogSupervisorStop(
  path: string,
  lease: Pick<DockerWorkloadLease, 'leaseId' | 'generation'>,
  cleanup: DockerWorkloadCleanupProof,
  now = new Date(),
): void {
  writeStrictJsonAtomic(
    path,
    stopRequestSchema.parse({
      schemaVersion: RESOURCE_WATCHDOG_SUPERVISOR_SCHEMA_VERSION,
      leaseId: lease.leaseId,
      generation: lease.generation,
      requestedAt: now.toISOString(),
      cleanup,
    }),
  );
}

export function loadResourceWatchdogSupervisorStatus(path: string): ResourceWatchdogSupervisorStatus {
  return loadStrictJson(path, 'watchdog supervisor status', supervisorStatusSchema);
}

export function assertResourceWatchdogSupervisorFresh(
  status: ResourceWatchdogSupervisorStatus,
  expected: { readonly leaseId: string; readonly generation: string; readonly policySha256: string },
  staleAfterMs: number,
  now = new Date(),
): void {
  const validated = supervisorStatusSchema.parse(status);
  if (
    validated.leaseId !== expected.leaseId ||
    validated.generation !== expected.generation ||
    validated.policySha256 !== expected.policySha256
  ) {
    throw new Error('watchdog supervisor status binding mismatch');
  }
  if (validated.state !== 'ready') throw new Error(`watchdog supervisor is not ready: ${validated.state}`);
  if (now.getTime() - Date.parse(validated.updatedAt) >= staleAfterMs) {
    throw new Error('watchdog supervisor heartbeat is stale');
  }
}

function tryLoadStopRequest(path: string): ResourceWatchdogSupervisorStopRequest | undefined {
  if (!existsSync(path)) return undefined;
  return loadStrictJson(path, 'watchdog supervisor stop request', stopRequestSchema);
}

function compactSample(sample: ResourceWatchdogSample) {
  return {
    sampledAtMs: sample.sampledAtMs,
    availableBytes: sample.availableBytes,
    allocatedBytes: sample.allocatedBytes,
  };
}

function compactTrip(trip: ResourceWatchdogTrip) {
  return {
    code: trip.code,
    atMs: trip.atMs,
    detail: trip.detail,
    overshootBytes: trip.overshootBytes,
    overshootWithinFrozenMaximum: trip.overshootWithinFrozenMaximum,
  };
}

function statusUpdate(
  current: ResourceWatchdogSupervisorStatus,
  now: Date,
  update: Partial<Pick<ResourceWatchdogSupervisorStatus, 'state' | 'lastSample' | 'trip' | 'detail'>>,
): ResourceWatchdogSupervisorStatus {
  return supervisorStatusSchema.parse({ ...current, ...update, updatedAt: now.toISOString() });
}

function loadStrictJson<T>(path: string, label: string, schema: z.ZodType<T>): T {
  assertCanonicalPrivatePath(path, label);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be a readable regular non-symlink file: ${path}`, { cause: error });
  }
  let bytes: Buffer;
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || (stats.mode & 0o077) !== 0) throw new Error(`${label} must be an owner-only regular file`);
    if (stats.size < 2 || stats.size > MAX_RESOURCE_WATCHDOG_SUPERVISOR_JSON_BYTES) {
      throw new Error(`${label} size is outside the allowed range`);
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  const value = schema.parse(parsed);
  if (!bytes.equals(Buffer.from(`${stableStringify(value)}\n`))) throw new Error(`${label} is not canonical JSON`);
  return value;
}

function writeStrictJsonAtomic(path: string, value: unknown): void {
  assertCanonicalPrivatePath(path, 'watchdog supervisor output');
  writeStableJsonAtomic(path, value, { mode: 0o600 });
}

function assertCanonicalPrivatePath(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} path must be canonical and absolute`);
  const parent = statSync(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) {
    throw new Error(`${label} parent must be an owner-only directory`);
  }
  const relativePath = relative(dirname(path), path);
  if (relativePath === '' || relativePath.startsWith('..')) throw new Error(`${label} path is invalid`);
}
