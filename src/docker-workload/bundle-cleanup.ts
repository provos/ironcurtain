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
import { dirname, isAbsolute, resolve } from 'node:path';
import { getBundleRuntimeRootForHome } from '../config/paths.js';
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
  const bundleRuntimeRoot = resolveLeaseBundleRuntimeRoot(lease);
  const paths = [
    bundleRuntimeRoot,
    lease.paths.apiRoot,
    lease.paths.exchangeRoot,
    lease.paths.runtimeRoot,
    lease.paths.stagingRoot,
    lease.paths.stateRoot,
  ];
  const unique = [...new Set(paths.filter((path): path is string => path !== undefined))].sort(
    (left, right) => right.length - left.length,
  );
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
  const bundleRuntimeRoot = resolveLeaseBundleRuntimeRoot(lease);
  if (bundleRuntimeRoot !== undefined && existsSync(bundleRuntimeRoot)) {
    throw new Error('watchdog supervisor bundle runtime root still exists after cleanup');
  }
  return { exactOuterResourcesAbsent: true, stateRootAbsent: true, inventories: [first, second] };
}

/** Bind runtime cleanup to the lease's selected home, never the current process environment. */
function resolveLeaseBundleRuntimeRoot(lease: DockerWorkloadLease): string | undefined {
  const stateDirectory = dirname(lease.paths.stateRoot);
  const workloadRoot = dirname(stateDirectory);
  const ironCurtainHome = dirname(workloadRoot);
  const canonicalStateRoot = resolve(ironCurtainHome, 'docker-workload', 'state', lease.leaseId);
  if (lease.paths.stateRoot !== canonicalStateRoot) {
    if (lease.paths.bundleRuntimeRoot !== undefined) {
      throw new Error('watchdog supervisor bundle runtime root is not bound to its state root');
    }
    // Version-1 unit fixtures and historical standalone leases predate this
    // path. Their nested-Docker state remains recoverable without inventing an
    // ambient-home deletion target.
    return undefined;
  }
  const expected = getBundleRuntimeRootForHome(ironCurtainHome, lease.bundleId);
  if (lease.paths.bundleRuntimeRoot !== undefined && lease.paths.bundleRuntimeRoot !== expected) {
    throw new Error('watchdog supervisor bundle runtime root binding mismatch');
  }
  // Canonical historical leases implicitly owned this exact deterministic
  // path before the field was persisted. Re-derive it only from the home and
  // bundle identity already bound into the lease; never consult ambient state.
  return lease.paths.bundleRuntimeRoot ?? expected;
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
