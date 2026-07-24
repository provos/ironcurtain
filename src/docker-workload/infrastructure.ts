/**
 * Common secure nested Docker-workload lifecycle orchestration.
 *
 * Admission, per-outer-resource ledgering, watchdog attestation, activation,
 * teardown, and crash reconciliation for one Docker-capable bundle. This module
 * owns the §8.2 startup and §8.3 teardown ordering and shares the frozen
 * cleanup helpers with the detached watchdog supervisor so the three cleanup
 * call sites (supervisor trip, coordinator teardown, crash reconciliation)
 * cannot drift.
 *
 * It deliberately does NOT consult the temporary implementation fuse in
 * `config.ts`: this is the mechanism the product wiring calls only after that
 * fuse has already admitted the session. A guard test enforces the non-import.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  getDockerWorkloadLeaseDir,
  getDockerWorkloadLeasesRoot,
  getDockerWorkloadRoot,
  getDockerWorkloadStateRoot,
} from '../config/paths.js';
import type { ContainerRuntime } from '../docker/types.js';
import { loadResourceWatchdogPolicy, type LoadedResourceWatchdogPolicy } from '../docker/resource-watchdog.js';
import {
  activateDockerWorkloadLease,
  closeDockerWorkloadLease,
  createDockerWorkloadLease,
  heartbeatDockerWorkloadLease,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  recordDockerWorkloadLeaseIncident,
  requestDockerWorkloadOuterResource,
  revokeDockerWorkloadLease,
  type DockerWorkloadCleanupProof,
} from './bundle-lease.js';
import { revokeDockerWorkloadOuterResources, type DockerWorkloadRevocationResult } from './bundle-revocation.js';
import { assertExactTargetIdentity, captureCleanupProof, removeExactBundleState } from './bundle-cleanup.js';
import {
  DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS,
  DOCKER_WORKLOAD_RECOVERY_BOUND_MS,
  DOCKER_WORKLOAD_STALE_HEARTBEAT_MS,
  DOCKER_WORKLOAD_WATCHDOG_STARTUP_TIMEOUT_MS,
  loadFrozenWatchdogPolicyTemplate,
  renderWatchdogPolicy,
} from './watchdog-policy.js';
import {
  assertResourceWatchdogSupervisorFresh,
  launchDetachedResourceWatchdogSupervisor,
  loadResourceWatchdogSupervisorStatus,
  requestResourceWatchdogSupervisorStop,
  type LaunchDetachedResourceWatchdogSupervisorOptions,
  type ResourceWatchdogSupervisorStatus,
} from './resource-watchdog-supervisor.js';
import type {
  DockerWorkloadAuditEventPayload,
  DockerWorkloadAuditSink,
  ExpandedOuterCreate,
} from './lifecycle-evidence.js';

export const DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY = 'com.ironcurtain.docker-workload.generation';

const LEASE_FILE = 'lease.json';
const POLICY_FILE = 'policy.json';
const STATUS_FILE = 'status.json';
const STOP_REQUEST_FILE = 'stop.json';
const EVIDENCE_DIR = 'evidence';
const ADMISSION_LOCK_FILE = 'admission.lock';
const STATE_SUBDIRS = ['daemon', 'api', 'exchange', 'staging'] as const;
const SUPERVISOR_STOP_TIMEOUT_MS = 10_000;
const SUPERVISOR_STOP_POLL_MS = 50;
const BUSY_RETRY_ATTEMPTS = 4;
const BUSY_RETRY_BACKOFF_MS = 50;
const ADMISSION_LOCK_ACQUIRE_ATTEMPTS = 16;

export type DockerWorkloadRuntimeKind = 'docker' | 'apple-container';
export type OuterResourceKind = 'container' | 'network';
export type OuterResourceRole = 'agent' | 'nested-daemon' | 'fixed-relay' | 'proxy' | 'network';

/** The sha256 attestation bindings the caller supplies; the watchdog policy hash is computed at render time. */
export interface DockerWorkloadAdmissionBindings {
  readonly catalogSha256: string;
  readonly profileSha256: string;
  readonly performanceBudgetSha256: string;
  readonly toolchainDigest: string;
}

/**
 * A precommitted outer-resource ledger entry. The caller creates the runtime
 * object with the returned name and ownership labels, then calls `observed()`
 * with the runtime's immutable ID (for networks the caller reads the ID back
 * via `listNetworks` — `createNetwork` returns void).
 */
export interface OuterResourceGrant {
  readonly requestId: string;
  readonly requestedName: string;
  readonly labels: Readonly<Record<string, string>>;
  observed(immutableId: string, expanded?: ExpandedOuterCreate): void;
}

/** Injectable seam over the detached watchdog supervisor process for tests. */
export interface WatchdogSupervisorController {
  launch(
    options: LaunchDetachedResourceWatchdogSupervisorOptions,
  ): Promise<{ readonly pid: number; readonly status: ResourceWatchdogSupervisorStatus }>;
  readStatus(statusPath: string): ResourceWatchdogSupervisorStatus | undefined;
  requestStop(
    stopRequestPath: string,
    lease: { readonly leaseId: string; readonly generation: string },
    cleanup: DockerWorkloadCleanupProof,
    now: Date,
  ): void;
  isAlive(pid: number): boolean;
}

export interface DockerWorkloadAdmissionOptions {
  readonly runtime: ContainerRuntime;
  readonly runtimeKind: DockerWorkloadRuntimeKind;
  readonly bundleId: string;
  readonly workspaceRoot: string;
  readonly bindings: DockerWorkloadAdmissionBindings;
  /** The resolved capability config hash recorded in the admission audit event. */
  readonly configHash: string;
  /** Provenance of `bindings` for the audit trail (default: 'placeholder'). */
  readonly bindingsProvenance?: 'placeholder' | 'qualified';
  readonly watchdogPolicyTemplatePath: string;
  readonly watchdogSupervisorEntrypointPath: string;
  readonly leaseId?: string;
  readonly generation?: string;
  readonly ownershipLabelKey?: string;
  readonly auditSink?: DockerWorkloadAuditSink;
  readonly clock?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pidAlive?: (pid: number) => boolean;
  readonly randomName?: (role: OuterResourceRole, kind: OuterResourceKind) => string;
  readonly supervisor?: WatchdogSupervisorController;
  /** Off for tests that must not leave a real host heartbeat interval running. */
  readonly startHeartbeat?: boolean;
}

export interface ReconcileDockerWorkloadOptions {
  readonly runtime: ContainerRuntime;
  readonly runtimeKind: DockerWorkloadRuntimeKind;
  readonly auditSink?: DockerWorkloadAuditSink;
  readonly clock?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pidAlive?: (pid: number) => boolean;
  readonly supervisor?: WatchdogSupervisorController;
  readonly recoveryBoundMs?: number;
  readonly staleHeartbeatMs?: number;
}

export interface ReconcileDockerWorkloadResult {
  /** Lease IDs the frozen order deleted and closed. */
  readonly reconciled: readonly string[];
  /** Lease IDs left untouched because they are live. */
  readonly preserved: readonly string[];
  /** Lease IDs left fenced (incident); these block new admission. */
  readonly fenced: readonly string[];
}

export interface DockerWorkloadTeardownResult {
  readonly alreadyClosed: boolean;
  readonly supervisorLost: boolean;
  readonly revocation?: DockerWorkloadRevocationResult;
  readonly cleanup?: DockerWorkloadCleanupProof;
}

/**
 * Reconcile every nonclosed lease under a cross-process lock, then admit one new
 * bundle: create its state-root subtree, render the frozen watchdog policy, and
 * durably create the host-only lease. No outer resource is created and the
 * watchdog is not yet attested — those are handle methods driven by the caller
 * in §8.2 order.
 */
export async function admitDockerWorkloadBundle(
  options: DockerWorkloadAdmissionOptions,
): Promise<DockerWorkloadBundleHandle> {
  const clock = options.clock ?? defaultClock;
  const sleep = options.sleep ?? defaultSleep;
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  const supervisor = options.supervisor ?? defaultSupervisorController;
  const leaseId = options.leaseId ?? `dw-${randomUUID()}`;
  const generation = options.generation ?? `gen-${randomUUID()}`;
  const ownershipLabelKey = options.ownershipLabelKey ?? DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY;
  const root = getDockerWorkloadRoot();

  return withDockerWorkloadAdmissionLock(root, pidAlive, async () => {
    const reconciliation = await reconcileHeld({ ...options, clock, sleep, pidAlive, supervisor });
    if (reconciliation.fenced.length > 0) {
      throw new Error(
        `refusing Docker-workload admission while fenced leases block it: ${reconciliation.fenced.join(', ')}`,
      );
    }

    const leaseDir = getDockerWorkloadLeaseDir(leaseId);
    const stateRoot = getDockerWorkloadStateRoot(leaseId);
    createStateRootSubtree(stateRoot);
    mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    const evidenceDir = join(leaseDir, EVIDENCE_DIR);
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });

    const template = loadFrozenWatchdogPolicyTemplate(options.watchdogPolicyTemplatePath);
    const policyPath = join(leaseDir, POLICY_FILE);
    const loadedPolicy = renderWatchdogPolicy(template.template, stateRoot, policyPath);

    const leasePath = join(leaseDir, LEASE_FILE);
    createDockerWorkloadLease(leasePath, {
      leaseId,
      bundleId: options.bundleId,
      generation,
      runtimeKind: options.runtimeKind,
      paths: leasePathsFor(options.workspaceRoot, stateRoot),
      bindings: { ...options.bindings, watchdogPolicySha256: loadedPolicy.sha256 },
      cleanupInventoryGapMs: loadedPolicy.policy.cleanupInventoryGapMs,
      coordinatorPid: process.pid,
      now: clock(),
    });

    emitAudit(options.auditSink, leaseId, generation, clock().toISOString(), {
      kind: 'admission-decision',
      decision: 'admitting',
      bundleId: options.bundleId,
      runtimeKind: options.runtimeKind,
      configHash: options.configHash,
      bindingsProvenance: options.bindingsProvenance ?? 'placeholder',
      watchdogPolicySha256: loadedPolicy.sha256,
      watchdogTemplateSha256: template.sha256,
      detail: 'reconciled outstanding leases and created a fresh admitting lease',
    });

    return new DockerWorkloadBundleHandle({
      runtime: options.runtime,
      runtimeKind: options.runtimeKind,
      bundleId: options.bundleId,
      leaseId,
      generation,
      leaseDir,
      leasePath,
      policyPath,
      statusPath: join(leaseDir, STATUS_FILE),
      stopRequestPath: join(leaseDir, STOP_REQUEST_FILE),
      evidenceDir,
      loadedPolicy,
      templateSha256: template.sha256,
      ownershipLabelKey,
      supervisorEntrypointPath: options.watchdogSupervisorEntrypointPath,
      auditSink: options.auditSink,
      clock,
      sleep,
      randomName: options.randomName ?? defaultRandomName,
      supervisor,
      startHeartbeat: options.startHeartbeat ?? true,
    });
  });
}

/** Reconcile every nonclosed lease under the cross-process admission lock. */
export async function reconcileDockerWorkloadLeases(
  options: ReconcileDockerWorkloadOptions,
): Promise<ReconcileDockerWorkloadResult> {
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  return withDockerWorkloadAdmissionLock(getDockerWorkloadRoot(), pidAlive, () => reconcileHeld(options));
}

interface DockerWorkloadBundleHandleContext {
  readonly runtime: ContainerRuntime;
  readonly runtimeKind: DockerWorkloadRuntimeKind;
  readonly bundleId: string;
  readonly leaseId: string;
  readonly generation: string;
  readonly leaseDir: string;
  readonly leasePath: string;
  readonly policyPath: string;
  readonly statusPath: string;
  readonly stopRequestPath: string;
  readonly evidenceDir: string;
  readonly loadedPolicy: LoadedResourceWatchdogPolicy;
  readonly templateSha256: string;
  readonly ownershipLabelKey: string;
  readonly supervisorEntrypointPath: string;
  readonly auditSink: DockerWorkloadAuditSink | undefined;
  readonly clock: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly randomName: (role: OuterResourceRole, kind: OuterResourceKind) => string;
  readonly supervisor: WatchdogSupervisorController;
  readonly startHeartbeat: boolean;
}

/** Live handle over one admitted bundle lease. Methods are the narrow calls the product wiring makes. */
export class DockerWorkloadBundleHandle {
  private readonly context: DockerWorkloadBundleHandleContext;
  private rejecting = false;
  private supervisorPid: number | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(context: DockerWorkloadBundleHandleContext) {
    this.context = context;
  }

  // The lease identity fields live once on `this.context`; these getters expose
  // them read-only without a second copy that could drift.
  get leaseId(): string {
    return this.context.leaseId;
  }
  get generation(): string {
    return this.context.generation;
  }
  get leaseDir(): string {
    return this.context.leaseDir;
  }
  get leasePath(): string {
    return this.context.leasePath;
  }
  get policyPath(): string {
    return this.context.policyPath;
  }
  get statusPath(): string {
    return this.context.statusPath;
  }
  get stopRequestPath(): string {
    return this.context.stopRequestPath;
  }
  get evidenceDir(): string {
    return this.context.evidenceDir;
  }
  get loadedPolicy(): LoadedResourceWatchdogPolicy {
    return this.context.loadedPolicy;
  }
  get templateSha256(): string {
    return this.context.templateSha256;
  }

  /** Precommit one outer resource to the ledger BEFORE the caller creates it. */
  requestOuterResource(kind: OuterResourceKind, role: OuterResourceRole): OuterResourceGrant {
    if (this.rejecting) throw new Error('Docker-workload bundle is tearing down; new outer resources are rejected');
    if (kind === 'network' && this.context.runtimeKind === 'apple-container') {
      throw new Error('apple-container has no outer network objects to ledger');
    }
    const requestId = `res-${randomUUID()}`;
    const requestedName = this.context.randomName(role, kind);
    requestDockerWorkloadOuterResource(
      this.leasePath,
      this.generation,
      { requestId, kind, role, requestedName, ownershipLabelKey: this.context.ownershipLabelKey },
      this.context.clock(),
    );
    const labels = { [this.context.ownershipLabelKey]: this.generation };
    return {
      requestId,
      requestedName,
      labels,
      observed: (immutableId: string, expanded?: ExpandedOuterCreate): void => {
        observeDockerWorkloadOuterResource(
          this.leasePath,
          this.generation,
          requestId,
          immutableId,
          this.context.clock(),
        );
        this.emit({
          kind: 'outer-create',
          requestId,
          resourceKind: kind,
          role,
          requestedName,
          immutableId,
          expanded: expanded ?? {},
        });
      },
    };
  }

  /** Launch and attest the detached watchdog supervisor; fail admission on anything but 'ready'. */
  async attestWatchdog(): Promise<ResourceWatchdogSupervisorStatus> {
    const launched = await this.context.supervisor.launch({
      leasePath: this.leasePath,
      policyPath: this.policyPath,
      statusPath: this.statusPath,
      stopRequestPath: this.stopRequestPath,
      entrypointPath: this.context.supervisorEntrypointPath,
      startupTimeoutMs: DOCKER_WORKLOAD_WATCHDOG_STARTUP_TIMEOUT_MS,
    });
    if (launched.status.state !== 'ready') {
      throw new Error(`watchdog attestation failed: supervisor reported state ${launched.status.state}`);
    }
    const firstSample = launched.status.lastSample;
    if (firstSample === null) throw new Error('watchdog attestation returned no first sample');
    this.supervisorPid = launched.pid;
    this.emit({
      kind: 'watchdog-attested',
      supervisorPid: launched.pid,
      policySha256: this.loadedPolicy.sha256,
      templateSha256: this.templateSha256,
      firstSample,
    });
    return launched.status;
  }

  /** Prove the watchdog supervisor is still fresh immediately before daemon/VM create. */
  assertWatchdogFresh(): void {
    const status = this.context.supervisor.readStatus(this.statusPath);
    if (status === undefined) throw new Error('watchdog supervisor status is missing');
    assertResourceWatchdogSupervisorFresh(
      status,
      { leaseId: this.leaseId, generation: this.generation, policySha256: this.loadedPolicy.sha256 },
      this.loadedPolicy.policy.staleAfterMs,
      this.context.clock(),
    );
  }

  /** Activate the lease (every requested resource must be observed) and start the host-owned heartbeat. */
  activate(): void {
    activateDockerWorkloadLease(this.leasePath, this.generation, this.context.clock());
    this.emit({ kind: 'lease-transition', from: 'admitting', to: 'active' });
    this.startHeartbeatTimer();
  }

  /** §8.3 teardown in the frozen order; idempotent and tolerant of transient lock contention. */
  async teardown(): Promise<DockerWorkloadTeardownResult> {
    return this.withBusyRetry(async () => {
      this.rejecting = true;
      this.clearHeartbeatTimer();
      const startLease = loadDockerWorkloadLease(this.leasePath);
      if (startLease.status === 'closed') return { alreadyClosed: true, supervisorLost: false };
      if (startLease.status === 'admitting' || startLease.status === 'active') {
        revokeDockerWorkloadLease(this.leasePath, this.generation, this.context.clock());
        this.emit({ kind: 'lease-transition', from: startLease.status, to: 'revoking' });
      }
      const { revocation, cleanup } = await performExactRevocationAndCleanup({
        runtime: this.context.runtime,
        leasePath: this.leasePath,
        generation: this.generation,
        targetDevice: this.loadedPolicy.policy.targetDevice,
        targetInode: this.loadedPolicy.policy.targetInode,
        gapMs: this.loadedPolicy.policy.cleanupInventoryGapMs,
        clock: this.context.clock,
        sleep: this.context.sleep,
      });
      this.emit({
        kind: 'revocation-result',
        removedResourceIds: [...revocation.removedResourceIds],
        finalOwnedResourceIds: [...revocation.finalOwnedResourceIds],
      });
      this.emit({ kind: 'cleanup-proof', inventories: cleanup.inventories });
      const supervisorLost = await this.stopWatchdogAndClose(cleanup);
      return { alreadyClosed: false, supervisorLost, revocation, cleanup };
    });
  }

  private async stopWatchdogAndClose(cleanup: DockerWorkloadCleanupProof): Promise<boolean> {
    const lease = loadDockerWorkloadLease(this.leasePath);
    this.context.supervisor.requestStop(
      this.stopRequestPath,
      { leaseId: lease.leaseId, generation: lease.generation },
      cleanup,
      this.context.clock(),
    );
    const deadline = this.context.clock().getTime() + SUPERVISOR_STOP_TIMEOUT_MS;
    for (;;) {
      if (loadDockerWorkloadLease(this.leasePath).status === 'closed') return false;
      const supervisorGone = this.supervisorPid === undefined || !this.context.supervisor.isAlive(this.supervisorPid);
      if (supervisorGone || this.context.clock().getTime() >= deadline) {
        this.closeLeaseAsCoordinator(cleanup);
        return true;
      }
      await this.context.sleep(SUPERVISOR_STOP_POLL_MS);
    }
  }

  private closeLeaseAsCoordinator(cleanup: DockerWorkloadCleanupProof): void {
    let closedByCoordinator = false;
    try {
      closeDockerWorkloadLease(this.leasePath, this.generation, cleanup, this.context.clock());
      closedByCoordinator = true;
    } catch (error) {
      if (loadDockerWorkloadLease(this.leasePath).status !== 'closed') throw error;
    }
    this.emit({
      kind: 'incident',
      code: 'watchdog-supervisor-lost',
      detail: closedByCoordinator
        ? 'coordinator closed the lease after the watchdog supervisor was unreachable'
        : 'watchdog supervisor closed the lease before exiting; coordinator confirmed closure',
    });
  }

  private startHeartbeatTimer(): void {
    if (!this.context.startHeartbeat) return;
    this.heartbeatTimer = setInterval(() => {
      try {
        heartbeatDockerWorkloadLease(this.leasePath, this.generation, this.context.clock());
      } catch {
        // Transient lock contention or a terminal lease; teardown clears the timer.
      }
    }, DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async withBusyRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isLeaseBusyError(error) || attempt === BUSY_RETRY_ATTEMPTS - 1) throw error;
        await this.context.sleep(BUSY_RETRY_BACKOFF_MS);
      }
    }
  }

  private emit(payload: DockerWorkloadAuditEventPayload): void {
    emitAudit(this.context.auditSink, this.leaseId, this.generation, this.context.clock().toISOString(), payload);
  }
}

async function reconcileHeld(options: ReconcileDockerWorkloadOptions): Promise<ReconcileDockerWorkloadResult> {
  const clock = options.clock ?? defaultClock;
  const sleep = options.sleep ?? defaultSleep;
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  const supervisor = options.supervisor ?? defaultSupervisorController;
  const recoveryBoundMs = options.recoveryBoundMs ?? DOCKER_WORKLOAD_RECOVERY_BOUND_MS;
  const staleHeartbeatMs = options.staleHeartbeatMs ?? DOCKER_WORKLOAD_STALE_HEARTBEAT_MS;
  const leasesRoot = getDockerWorkloadLeasesRoot();

  const reconciled: string[] = [];
  const preserved: string[] = [];
  const fenced: string[] = [];
  for (const leaseId of listLeaseIds(leasesRoot)) {
    const leaseDir = join(leasesRoot, leaseId);
    const leasePath = join(leaseDir, LEASE_FILE);
    let lease;
    try {
      lease = loadDockerWorkloadLease(leasePath);
    } catch {
      continue; // Not a valid lease directory.
    }
    if (lease.status === 'closed') continue;
    if (lease.status === 'incident') {
      fenced.push(leaseId);
      continue;
    }
    if (isLeaseLive(lease, leaseDir, supervisor, pidAlive, clock(), staleHeartbeatMs)) {
      preserved.push(leaseId);
      continue;
    }
    try {
      await recoverStaleLease({ leaseDir, leasePath, lease, options, clock, sleep, supervisor, recoveryBoundMs });
      reconciled.push(leaseId);
    } catch (error) {
      fenceLease(leasePath, lease.leaseId, lease.generation, error, clock, options.auditSink);
      fenced.push(leaseId);
    }
  }
  return { reconciled, preserved, fenced };
}

function isLeaseLive(
  lease: ReturnType<typeof loadDockerWorkloadLease>,
  leaseDir: string,
  supervisor: WatchdogSupervisorController,
  pidAlive: (pid: number) => boolean,
  now: Date,
  staleHeartbeatMs: number,
): boolean {
  // Coordinator-heartbeat freshness: the coordinator writes a heartbeat every
  // DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS, so staleHeartbeatMs is the right bound
  // here — that is this constant's actual purpose.
  if (pidAlive(lease.coordinator.pid) && now.getTime() - Date.parse(lease.coordinator.heartbeatAt) < staleHeartbeatMs) {
    return true;
  }
  // Supervisor freshness: the detached supervisor survives coordinator exit and
  // samples on its own rendered-policy cadence, so its staleness bound is the
  // lease's rendered policy `staleAfterMs`, NOT the coordinator-heartbeat
  // constant. Fail closed (treat as stale) when a supervisor status exists but
  // the rendered policy is missing/unreadable: recoverStaleLease then fences on
  // the same unreadable policy rather than the reconciler blindly reclaiming.
  const status = supervisor.readStatus(join(leaseDir, STATUS_FILE));
  if (status === undefined) return false;
  let supervisorStaleAfterMs: number;
  try {
    supervisorStaleAfterMs = loadResourceWatchdogPolicy(join(leaseDir, POLICY_FILE)).policy.staleAfterMs;
  } catch {
    return false;
  }
  try {
    assertResourceWatchdogSupervisorFresh(
      status,
      { leaseId: lease.leaseId, generation: lease.generation, policySha256: lease.bindings.watchdogPolicySha256 },
      supervisorStaleAfterMs,
      now,
    );
    return true;
  } catch {
    // Supervisor status is not fresh; the lease is stale.
    return false;
  }
}

async function recoverStaleLease(context: {
  readonly leaseDir: string;
  readonly leasePath: string;
  readonly lease: ReturnType<typeof loadDockerWorkloadLease>;
  readonly options: ReconcileDockerWorkloadOptions;
  readonly clock: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly supervisor: WatchdogSupervisorController;
  readonly recoveryBoundMs: number;
}): Promise<void> {
  const { leaseDir, leasePath, lease, options, clock, sleep, supervisor, recoveryBoundMs } = context;
  if (options.runtime.listContainers === undefined) {
    throw new Error('selected outer runtime cannot inventory containers for reconciliation');
  }
  await options.runtime.listContainers();
  const recoveryStartMs = clock().getTime();

  const loadedPolicy = loadResourceWatchdogPolicy(join(leaseDir, POLICY_FILE));
  if (loadedPolicy.sha256 !== lease.bindings.watchdogPolicySha256) {
    throw new Error('reconciliation policy hash does not match the lease binding');
  }
  const { revocation, cleanup } = await performExactRevocationAndCleanup({
    runtime: options.runtime,
    leasePath,
    generation: lease.generation,
    targetDevice: loadedPolicy.policy.targetDevice,
    targetInode: loadedPolicy.policy.targetInode,
    gapMs: loadedPolicy.policy.cleanupInventoryGapMs,
    clock,
    sleep,
  });
  emitAudit(options.auditSink, lease.leaseId, lease.generation, clock().toISOString(), {
    kind: 'revocation-result',
    removedResourceIds: [...revocation.removedResourceIds],
    finalOwnedResourceIds: [...revocation.finalOwnedResourceIds],
  });
  emitAudit(options.auditSink, lease.leaseId, lease.generation, clock().toISOString(), {
    kind: 'cleanup-proof',
    inventories: cleanup.inventories,
  });

  if (clock().getTime() - recoveryStartMs >= recoveryBoundMs) {
    throw new Error(`Docker-workload recovery exceeded the frozen ${recoveryBoundMs}ms bound`);
  }

  supervisor.requestStop(
    join(leaseDir, STOP_REQUEST_FILE),
    { leaseId: lease.leaseId, generation: lease.generation },
    cleanup,
    clock(),
  );
  if (loadDockerWorkloadLease(leasePath).status === 'closed') return;
  closeDockerWorkloadLease(leasePath, lease.generation, cleanup, clock());
}

function fenceLease(
  leasePath: string,
  leaseId: string,
  generation: string,
  error: unknown,
  clock: () => Date,
  auditSink: DockerWorkloadAuditSink | undefined,
): void {
  const detail = error instanceof Error ? error.message : String(error);
  try {
    const current = loadDockerWorkloadLease(leasePath);
    if (current.status !== 'incident' && current.status !== 'closed') {
      recordDockerWorkloadLeaseIncident(
        leasePath,
        generation,
        { code: 'docker-workload-recovery-fenced', detail },
        clock(),
      );
    }
  } catch {
    // Best effort: the audit incident below is the durable record.
  }
  emitAudit(auditSink, leaseId, generation, clock().toISOString(), {
    kind: 'incident',
    code: 'docker-workload-recovery-fenced',
    detail,
  });
}

async function performExactRevocationAndCleanup(context: {
  readonly runtime: ContainerRuntime;
  readonly leasePath: string;
  readonly generation: string;
  readonly targetDevice: number;
  readonly targetInode: number;
  readonly gapMs: number;
  readonly clock: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
}): Promise<{ readonly revocation: DockerWorkloadRevocationResult; readonly cleanup: DockerWorkloadCleanupProof }> {
  const revocation = await revokeDockerWorkloadOuterResources(
    context.runtime,
    context.leasePath,
    context.generation,
    context.clock,
  );
  const lease = loadDockerWorkloadLease(context.leasePath);
  if (existsSync(lease.paths.stateRoot)) {
    assertExactTargetIdentity(lease, context.targetDevice, context.targetInode);
  }
  removeExactBundleState(lease, context.leasePath);
  const cleanup = await captureCleanupProof(context.runtime, lease, context.gapMs, context.clock, context.sleep);
  return { revocation, cleanup };
}

function leasePathsFor(workspaceRoot: string, stateRoot: string) {
  return {
    workspaceRoot,
    stateRoot,
    runtimeRoot: join(stateRoot, 'daemon'),
    apiRoot: join(stateRoot, 'api'),
    exchangeRoot: join(stateRoot, 'exchange'),
    stagingRoot: join(stateRoot, 'staging'),
  };
}

function createStateRootSubtree(stateRoot: string): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  for (const subdir of STATE_SUBDIRS) mkdirSync(join(stateRoot, subdir), { recursive: true, mode: 0o700 });
}

function listLeaseIds(leasesRoot: string): readonly string[] {
  if (!existsSync(leasesRoot)) return [];
  return readdirSync(leasesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function withDockerWorkloadAdmissionLock<T>(
  root: string,
  pidAlive: (pid: number) => boolean,
  operation: () => Promise<T>,
): Promise<T> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, ADMISSION_LOCK_FILE);
  const descriptor = acquireAdmissionLock(lockPath, pidAlive);
  try {
    return await operation();
  } finally {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  }
}

/**
 * Acquire the cross-process admission lock via an O_EXCL create, reclaiming a
 * stale lock left by a crashed coordinator.
 *
 * Bounded retry loop so a lost race re-checks ownership instead of throwing a raw
 * EEXIST, and so reclaiming and re-creating the lock is arbitrated by the atomic
 * O_EXCL create rather than an unconditional re-create. A live owner is reported
 * busy; a dead/unreadable owner's lock is reclaimed atomically
 * ({@link reclaimStaleAdmissionLock}) without ever deleting a racer's freshly
 * installed live lock. If the lock stays contended across every attempt the
 * caller sees the mapped "is busy" error, never a raw EEXIST.
 */
function acquireAdmissionLock(lockPath: string, pidAlive: (pid: number) => boolean): number {
  let lastError: unknown;
  for (let attempt = 0; attempt < ADMISSION_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      return writeLockFile(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      lastError = error;
      const owner = readAdmissionLockOwner(lockPath);
      if (owner !== undefined && pidAlive(owner.pid)) {
        throw new Error(`Docker-workload admission is busy (owner pid ${owner.pid})`, { cause: error });
      }
      reclaimStaleAdmissionLock(lockPath, pidAlive);
    }
  }
  throw new Error('Docker-workload admission is busy (lock remained contended after retries)', { cause: lastError });
}

/**
 * Atomically move a stale admission lock aside and discard it. `renameSync`
 * guarantees exactly one racer captures a given lock file; the loser sees ENOENT
 * and retries the O_EXCL create. A racer that installed a fresh LIVE lock between
 * our owner read and the rename is detected after capture and restored intact —
 * we never delete a live owner's lock.
 */
function reclaimStaleAdmissionLock(lockPath: string, pidAlive: (pid: number) => boolean): void {
  const captured = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, captured);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const owner = readAdmissionLockOwner(captured);
  if (owner !== undefined && pidAlive(owner.pid)) {
    // We captured a live lock a racer installed after our read — put it back.
    try {
      renameSync(captured, lockPath);
    } catch {
      rmSync(captured, { force: true });
    }
    return;
  }
  rmSync(captured, { force: true });
}

function writeLockFile(lockPath: string): number {
  const descriptor = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid })}\n`);
  return descriptor;
}

function readAdmissionLockOwner(lockPath: string): { readonly pid: number } | undefined {
  try {
    const value = JSON.parse(readFileSync(lockPath, 'utf8')) as { readonly pid?: unknown };
    return typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
      ? { pid: value.pid }
      : undefined;
  } catch {
    return undefined;
  }
}

function emitAudit(
  sink: DockerWorkloadAuditSink | undefined,
  leaseId: string,
  generation: string,
  at: string,
  payload: DockerWorkloadAuditEventPayload,
): void {
  if (sink === undefined) return;
  sink.emit({ at, leaseId, generation, ...payload });
}

function isLeaseBusyError(error: unknown): boolean {
  return error instanceof Error && /is busy/u.test(error.message);
}

function defaultClock(): Date {
  return new Date();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultRandomName(role: OuterResourceRole): string {
  return `ic-dw-${role}-${randomBytes(8).toString('hex')}`;
}

const defaultSupervisorController: WatchdogSupervisorController = {
  launch: (options) => launchDetachedResourceWatchdogSupervisor(options),
  readStatus: (statusPath) => {
    try {
      return loadResourceWatchdogSupervisorStatus(statusPath);
    } catch {
      return undefined;
    }
  },
  requestStop: (stopRequestPath, lease, cleanup, now) =>
    requestResourceWatchdogSupervisorStop(stopRequestPath, lease, cleanup, now),
  isAlive: (pid) => defaultPidAlive(pid),
};
