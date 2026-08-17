/** Cross-process ownership for the exact Docker-workload cleanup sequence. */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContainerRuntime } from '../docker/types.js';
import { assertExactTargetIdentity, captureCleanupProof, removeExactBundleState } from './bundle-cleanup.js';
import {
  closeDockerWorkloadLease,
  heartbeatDockerWorkloadLease,
  loadDockerWorkloadLease,
  recoverDockerWorkloadLeaseIncident,
  recordDockerWorkloadLeaseIncident,
  returnDockerWorkloadLeaseRecoveryToIncident,
  revokeDockerWorkloadLease,
  type DockerWorkloadCleanupProof,
  type DockerWorkloadLease,
} from './bundle-lease.js';
import { revokeDockerWorkloadOuterResources, type DockerWorkloadRevocationResult } from './bundle-revocation.js';
import {
  acquireProcessLock,
  ProcessLockBusyError,
  type ProcessIdentityResolver,
  type ProcessLockHandle,
} from './process-lock.js';
import { DOCKER_WORKLOAD_RECOVERY_BOUND_MS } from './watchdog-policy.js';

export const DOCKER_WORKLOAD_CLEANUP_LOCK_FILE = 'cleanup.lock';
const CLEANUP_LOCK_POLL_MS = 50;

export interface DockerWorkloadLifecycleClaimOptions {
  readonly leasePath: string;
  readonly clock: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly wait: boolean;
  readonly timeoutMs?: number;
  readonly processIdentityForPid?: ProcessIdentityResolver;
}

export interface DockerWorkloadLifecycleClaimHandle {
  release(): void;
}

/** Refresh coordinator ownership only when no sample, create, or cleanup operation owns the lifecycle. */
export function tryHeartbeatDockerWorkloadLease(options: {
  readonly leasePath: string;
  readonly generation: string;
  readonly clock: () => Date;
  readonly processIdentityForPid?: ProcessIdentityResolver;
}): boolean {
  let claim: DockerWorkloadLifecycleClaimHandle;
  try {
    claim = tryAcquireDockerWorkloadLifecycleClaim(options);
  } catch (error) {
    if (isDockerWorkloadLifecycleClaimBusy(error)) return false;
    throw error;
  }
  try {
    heartbeatDockerWorkloadLease(options.leasePath, options.generation, options.clock());
    return true;
  } finally {
    claim.release();
  }
}

/** Acquire the claim when a caller must retain ownership across a callback-driven state machine. */
export function tryAcquireDockerWorkloadLifecycleClaim(options: {
  readonly leasePath: string;
  readonly processIdentityForPid?: ProcessIdentityResolver;
}): DockerWorkloadLifecycleClaimHandle {
  return acquireProcessLock(join(dirname(options.leasePath), DOCKER_WORKLOAD_CLEANUP_LOCK_FILE), {
    attempts: 2,
    processIdentityForPid: options.processIdentityForPid,
  });
}

export async function withDockerWorkloadLifecycleClaim<T>(
  options: DockerWorkloadLifecycleClaimOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const claim = await acquireLifecycleClaim(options);
  try {
    return await operation();
  } finally {
    claim.release();
  }
}

export interface SerializedDockerWorkloadCleanupOptions {
  readonly runtime: ContainerRuntime;
  readonly leasePath: string;
  readonly generation: string;
  readonly targetDevice: number;
  readonly targetInode: number;
  readonly gapMs: number;
  readonly clock: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Supervisor/coordinator wait; reconciliation instead fences a live claimant. */
  readonly waitForOwner: boolean;
  readonly timeoutMs?: number;
  readonly processIdentityForPid?: ProcessIdentityResolver;
  /** Recheck a stale observation after ownership is acquired, before mutation or runtime I/O. */
  readonly revalidate?: (lease: DockerWorkloadLease) => void;
  /** Synchronous audit hook after the durable transition and before runtime I/O. */
  readonly onRevoking?: (from: 'admitting' | 'active' | 'incident') => void;
  /** Deterministic concurrency seam after stale revalidation and before revocation. */
  readonly afterRevalidate?: () => void;
}

export interface SerializedDockerWorkloadCleanupResult {
  readonly alreadyClosed: boolean;
  readonly cleanup: DockerWorkloadCleanupProof;
  readonly revocation?: DockerWorkloadRevocationResult;
}

/** A stale cleanup observation became false after the lifecycle claim was acquired. */
export class DockerWorkloadCleanupPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerWorkloadCleanupPreconditionError';
  }
}

/**
 * Execute the full destructive sequence under one crash-recoverable claim.
 *
 * The lease closes before the claim is released. A contender that was blocked
 * by runtime I/O therefore observes the durable cleanup proof and returns it
 * without repeating an inspect, stop, remove, state deletion, or inventory.
 */
export async function performSerializedDockerWorkloadCleanup(
  options: SerializedDockerWorkloadCleanupOptions,
): Promise<SerializedDockerWorkloadCleanupResult> {
  const timeoutMs = options.timeoutMs ?? DOCKER_WORKLOAD_RECOVERY_BOUND_MS;
  const deadline = options.clock().getTime() + timeoutMs;
  const assertBudget = (minimumRemainingMs = 0): void => {
    const remainingMs = deadline - options.clock().getTime();
    if (remainingMs <= minimumRemainingMs) {
      throw new Error(`Docker-workload cleanup exceeded the ${timeoutMs}ms cooperative bound`);
    }
  };
  const claim = await acquireLifecycleClaim({
    leasePath: options.leasePath,
    clock: options.clock,
    sleep: options.sleep,
    wait: options.waitForOwner,
    timeoutMs: options.timeoutMs,
    processIdentityForPid: options.processIdentityForPid,
  });

  try {
    const current = loadDockerWorkloadLease(options.leasePath);
    if (current.generation !== options.generation) throw new Error('Docker-workload cleanup generation mismatch');
    if (current.status === 'closed') {
      if (current.cleanup === null) throw new Error('closed Docker-workload lease has no cleanup proof');
      return { alreadyClosed: true, cleanup: current.cleanup };
    }
    assertBudget();
    options.revalidate?.(current);
    options.afterRevalidate?.();

    try {
      for (;;) {
        try {
          const beforeRevocation = loadDockerWorkloadLease(options.leasePath);
          if (beforeRevocation.status === 'incident') {
            recoverDockerWorkloadLeaseIncident(options.leasePath, options.generation, options.clock());
            options.onRevoking?.('incident');
          } else if (beforeRevocation.status === 'admitting' || beforeRevocation.status === 'active') {
            revokeDockerWorkloadLease(options.leasePath, options.generation, options.clock());
            options.onRevoking?.(beforeRevocation.status);
          }
          const revocation = await revokeDockerWorkloadOuterResources(
            options.runtime,
            options.leasePath,
            options.generation,
            options.clock,
            assertBudget,
          );
          assertBudget();
          const lease = loadDockerWorkloadLease(options.leasePath);
          if (existsSync(lease.paths.stateRoot)) {
            assertExactTargetIdentity(lease, options.targetDevice, options.targetInode);
          }
          assertBudget();
          removeExactBundleState(lease, options.leasePath);
          assertBudget();
          const cleanup = await captureCleanupProof(
            options.runtime,
            lease,
            options.gapMs,
            options.clock,
            options.sleep,
            assertBudget,
          );
          assertBudget();
          closeDockerWorkloadLease(options.leasePath, options.generation, cleanup, options.clock());
          return { alreadyClosed: false, revocation, cleanup };
        } catch (error) {
          if (!isLeaseMutationBusy(error) || options.clock().getTime() >= deadline) throw error;
          assertBudget(CLEANUP_LOCK_POLL_MS);
          await options.sleep(CLEANUP_LOCK_POLL_MS);
        }
      }
    } catch (error) {
      const failed = loadDockerWorkloadLease(options.leasePath);
      const detail = error instanceof Error ? error.message : String(error);
      if (failed.incident !== null && failed.status === 'revoking') {
        returnDockerWorkloadLeaseRecoveryToIncident(options.leasePath, options.generation, options.clock());
      } else if (failed.status !== 'closed' && failed.status !== 'incident') {
        recordDockerWorkloadLeaseIncident(
          options.leasePath,
          options.generation,
          {
            code: 'docker-workload-cleanup-failed',
            detail,
          },
          options.clock(),
        );
      }
      throw error;
    }
  } finally {
    claim.release();
  }
}

/** Supervisor/reconciler use this to defer rather than report a lifecycle-claim collision as a sample/cleanup error. */
export function isDockerWorkloadLifecycleClaimBusy(error: unknown): boolean {
  return error instanceof ProcessLockBusyError;
}

function isLeaseMutationBusy(error: unknown): boolean {
  return error instanceof Error && error.cause instanceof ProcessLockBusyError;
}

async function acquireLifecycleClaim(options: DockerWorkloadLifecycleClaimOptions): Promise<ProcessLockHandle> {
  const deadline = options.clock().getTime() + (options.timeoutMs ?? DOCKER_WORKLOAD_RECOVERY_BOUND_MS);
  for (;;) {
    try {
      return acquireProcessLock(join(dirname(options.leasePath), DOCKER_WORKLOAD_CLEANUP_LOCK_FILE), {
        attempts: 2,
        processIdentityForPid: options.processIdentityForPid,
      });
    } catch (error) {
      if (!(error instanceof ProcessLockBusyError) || !options.wait) throw error;
      if (options.clock().getTime() >= deadline) {
        throw new Error('timed out waiting for Docker-workload lifecycle owner', { cause: error });
      }
      await options.sleep(CLEANUP_LOCK_POLL_MS);
    }
  }
}
