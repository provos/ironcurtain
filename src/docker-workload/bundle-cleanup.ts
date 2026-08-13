/**
 * Frozen host-authoritative cleanup order for one secure nested Docker bundle.
 *
 * The detached watchdog supervisor (on a resource trip), the coordinator
 * teardown path, and crash reconciliation must all execute the identical
 * frozen sequence — assert exact target identity, remove exact bundle state,
 * then capture two empty owned inventories. Keeping the helpers in one module
 * guarantees the three call sites cannot drift.
 */

import { existsSync, lstatSync, rmSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ContainerRuntime } from '../docker/types.js';
import type { ResourceWatchdogCleanupProof } from '../docker/resource-watchdog.js';
import { inventoryOwnedResourceIds } from './bundle-revocation.js';
import type { DockerWorkloadCleanupProof, DockerWorkloadLease } from './bundle-lease.js';

/** Refuse cleanup unless the state root is still the exact real directory rendered into the policy. */
export function assertExactTargetIdentity(lease: DockerWorkloadLease, device: number, inode: number): void {
  const stats = lstatSync(lease.paths.stateRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev !== device || stats.ino !== inode) {
    throw new Error('watchdog supervisor refuses cleanup after state-root identity change');
  }
}

/** Remove exactly the bundle-owned host-only paths, longest-first, never touching the workspace or the lease. */
export function removeExactBundleState(lease: DockerWorkloadLease, leasePath: string): void {
  const paths = [
    lease.paths.apiRoot,
    lease.paths.exchangeRoot,
    lease.paths.runtimeRoot,
    lease.paths.stagingRoot,
    lease.paths.stateRoot,
  ];
  const unique = [...new Set(paths)].sort((left, right) => right.length - left.length);
  for (const path of unique) {
    assertSafeCleanupPath(path, lease.paths.workspaceRoot, leasePath);
    rmSync(path, { recursive: true, force: true });
  }
}

export function assertSafeCleanupPath(path: string, workspaceRoot: string, leasePath: string): void {
  const parts = path.split('/').filter(Boolean);
  if (!isAbsolute(path) || resolve(path) !== path || parts.length < 2) {
    throw new Error(`watchdog supervisor refuses unsafe cleanup path: ${path}`);
  }
  if (path === workspaceRoot || workspaceRoot.startsWith(`${path}/`) || path.startsWith(`${workspaceRoot}/`)) {
    throw new Error(`watchdog supervisor refuses workspace cleanup path: ${path}`);
  }
  if (path === leasePath || leasePath.startsWith(`${path}/`)) {
    throw new Error(`watchdog supervisor refuses cleanup path containing its lease: ${path}`);
  }
}

/** Take two host-authoritative owned inventories separated by the frozen grace interval and prove both are empty. */
export async function captureCleanupProof(
  runtime: ContainerRuntime,
  lease: DockerWorkloadLease,
  gapMs: number,
  now: () => Date,
  sleep: (milliseconds: number) => Promise<void>,
  assertBudget: (minimumRemainingMs?: number) => void = () => {},
): Promise<DockerWorkloadCleanupProof> {
  const firstOwnedResourceIds = [...(await inventoryOwnedResourceIds(runtime, lease, assertBudget))];
  const first = {
    capturedAt: now().toISOString(),
    ownedResourceIds: firstOwnedResourceIds,
  };
  assertBudget(gapMs);
  await sleep(gapMs);
  assertBudget();
  const secondOwnedResourceIds = [...(await inventoryOwnedResourceIds(runtime, lease, assertBudget))];
  const second = {
    capturedAt: now().toISOString(),
    ownedResourceIds: secondOwnedResourceIds,
  };
  if (first.ownedResourceIds.length !== 0 || second.ownedResourceIds.length !== 0) {
    throw new Error('watchdog supervisor cleanup inventories are not empty');
  }
  if (existsSync(lease.paths.stateRoot)) throw new Error('watchdog supervisor state root still exists after cleanup');
  return { exactOuterResourcesAbsent: true, stateRootAbsent: true, inventories: [first, second] };
}

/** Translate a lease cleanup proof into the watchdog state machine's proof shape. */
export function toWatchdogCleanupProof(cleanup: DockerWorkloadCleanupProof): ResourceWatchdogCleanupProof {
  const [first, second] = cleanup.inventories;
  return {
    exactOuterResourceAbsent: cleanup.exactOuterResourcesAbsent,
    stateRootAbsent: cleanup.stateRootAbsent,
    inventories: [
      { capturedAtMs: Date.parse(first.capturedAt), ownedResourceIds: first.ownedResourceIds },
      { capturedAtMs: Date.parse(second.capturedAt), ownedResourceIds: second.ownedResourceIds },
    ],
  };
}
