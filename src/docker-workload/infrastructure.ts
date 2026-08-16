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
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getDockerWorkloadLeaseDir,
  getDockerWorkloadLeasesRoot,
  getDockerWorkloadRoot,
  getDockerWorkloadStateRoot,
} from '../config/paths.js';
import type { ContainerRuntime } from '../docker/types.js';
import type { ContainerRuntimeKind } from '../docker/container-runtime.js';
import { loadResourceWatchdogPolicy, type LoadedResourceWatchdogPolicy } from '../docker/resource-watchdog.js';
// Type-only: the readiness record is deliberately field-compatible with the
// `daemon-ready` evidence payload, and a type import adds no runtime edge.
import type { AppleVmDaemonReadiness } from './apple-vm-daemon.js';
import type { AppleVmDockerWorkloadNetwork, AppleVmDockerWorkloadProvisioning } from './apple-private-docker.js';
import {
  activateDockerWorkloadLease,
  createDockerWorkloadLease,
  heartbeatDockerWorkloadLease,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  recordDockerWorkloadLeaseIncident,
  returnDockerWorkloadLeaseRecoveryToIncident,
  requestDockerWorkloadOuterResource,
  type DockerWorkloadCleanupProof,
} from './bundle-lease.js';
import type { DockerWorkloadRevocationResult } from './bundle-revocation.js';
import {
  DockerWorkloadCleanupPreconditionError,
  isDockerWorkloadLifecycleClaimBusy,
  performSerializedDockerWorkloadCleanup,
  tryHeartbeatDockerWorkloadLease,
  withDockerWorkloadLifecycleClaim,
} from './cleanup-ownership.js';
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
import {
  DAEMON_READY_ATTESTATION,
  type DockerWorkloadAuditEventPayload,
  type DockerWorkloadAuditSink,
  type ExpandedOuterCreate,
} from './lifecycle-evidence.js';
import { acquireProcessLock, ProcessLockBusyError, type ProcessIdentityResolver } from './process-lock.js';

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
const HEARTBEAT_CLAIM_RETRY_MS = 50;
const POST_CREATE_SAMPLE_POLL_MS = 50;
const ADMISSION_LOCK_ACQUIRE_ATTEMPTS = 16;

export type DockerWorkloadRuntimeKind = ContainerRuntimeKind;
export type OuterResourceKind = 'container' | 'network';
export type OuterResourceRole = 'agent' | 'nested-daemon' | 'fixed-relay' | 'proxy' | 'network';

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
  /** The resolved capability config hash recorded in the admission audit event. */
  readonly configHash: string;
  readonly watchdogPolicyTemplatePath: string;
  readonly watchdogSupervisorEntrypointPath: string;
  readonly leaseId?: string;
  readonly generation?: string;
  readonly ownershipLabelKey?: string;
  readonly auditSink?: DockerWorkloadAuditSink;
  readonly clock?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pidAlive?: (pid: number) => boolean;
  /** Test seam for cross-process lock identity; production reads the host process table. */
  readonly processIdentityForPid?: ProcessIdentityResolver;
  /** Resolve the runtime recorded by an older lease when backend selection changed. */
  readonly runtimeForKind?: (kind: DockerWorkloadRuntimeKind) => ContainerRuntime;
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
  /** Test seam for cross-process lock identity; production reads the host process table. */
  readonly processIdentityForPid?: ProcessIdentityResolver;
  /** Resolve the runtime recorded by an older lease when backend selection changed. */
  readonly runtimeForKind?: (kind: DockerWorkloadRuntimeKind) => ContainerRuntime;
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

interface ReconcileDockerWorkloadHeldResult extends ReconcileDockerWorkloadResult {
  /** Current-pass reasons, used only to make admission failures actionable. */
  readonly fenceDetails: readonly string[];
}

/** Cleanup is proven, but mandatory post-close audit publication failed. */
class DockerWorkloadPostCloseAuditError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'DockerWorkloadPostCloseAuditError';
  }
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

  return withDockerWorkloadAdmissionLock(root, options.processIdentityForPid, async () => {
    const reconciliation = await reconcileHeld({ ...options, clock, sleep, pidAlive, supervisor });
    if (reconciliation.fenced.length > 0) {
      throw new Error(
        `refusing Docker-workload admission while unresolved leases block it: ${reconciliation.fenceDetails.join(
          ', ',
        )}`,
      );
    }

    // Validate the packaged policy before creating lease-specific state. A
    // broken or incomplete install must fail without accumulating empty
    // lease/state directories on every retry.
    const template = loadFrozenWatchdogPolicyTemplate(options.watchdogPolicyTemplatePath);
    const leaseDir = getDockerWorkloadLeaseDir(leaseId);
    const stateRoot = getDockerWorkloadStateRoot(leaseId);
    createStateRootSubtree(stateRoot);
    mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    const evidenceDir = join(leaseDir, EVIDENCE_DIR);
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });

    const policyPath = join(leaseDir, POLICY_FILE);
    const loadedPolicy = renderWatchdogPolicy(template.template, stateRoot, policyPath);

    const leasePath = join(leaseDir, LEASE_FILE);
    createDockerWorkloadLease(leasePath, {
      leaseId,
      bundleId: options.bundleId,
      generation,
      runtimeKind: options.runtimeKind,
      paths: leasePathsFor(options.workspaceRoot, stateRoot),
      bindings: { watchdogPolicySha256: loadedPolicy.sha256 },
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
      leasePath,
      policyPath,
      statusPath: join(leaseDir, STATUS_FILE),
      stopRequestPath: join(leaseDir, STOP_REQUEST_FILE),
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
      processIdentityForPid: options.processIdentityForPid,
    });
  });
}

/** Reconcile every nonclosed lease under the cross-process admission lock. */
export async function reconcileDockerWorkloadLeases(
  options: ReconcileDockerWorkloadOptions,
): Promise<ReconcileDockerWorkloadResult> {
  const { reconciled, preserved, fenced } = await withDockerWorkloadAdmissionLock(
    getDockerWorkloadRoot(),
    options.processIdentityForPid,
    () => reconcileHeld(options),
  );
  return { reconciled, preserved, fenced };
}

interface DockerWorkloadBundleHandleContext {
  readonly runtime: ContainerRuntime;
  readonly runtimeKind: DockerWorkloadRuntimeKind;
  readonly bundleId: string;
  readonly leaseId: string;
  readonly generation: string;
  readonly leasePath: string;
  readonly policyPath: string;
  readonly statusPath: string;
  readonly stopRequestPath: string;
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
  readonly processIdentityForPid: ProcessIdentityResolver | undefined;
}

/** Live handle over one admitted bundle lease. Methods are the narrow calls the product wiring makes. */
export class DockerWorkloadBundleHandle {
  private readonly context: DockerWorkloadBundleHandleContext;
  private rejecting = false;
  private supervisorPid: number | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatRefreshPromise: Promise<boolean> | undefined;
  private supervisorMonitorTimer: NodeJS.Timeout | undefined;
  private teardownPromise: Promise<DockerWorkloadTeardownResult> | undefined;
  private readonly localCreateOperations = new Set<symbol>();

  constructor(context: DockerWorkloadBundleHandleContext) {
    this.context = context;
    // Admission can spend minutes hashing/loading a multi-gigabyte archive.
    // Start ownership heartbeats as soon as the handle exists, not only after
    // activation, so the detached supervisor never mistakes valid bootstrap
    // work for a dead coordinator.
    this.startHeartbeatTimer();
  }

  // The lease identity fields live once on `this.context`; these getters expose
  // them read-only without a second copy that could drift.
  get leaseId(): string {
    return this.context.leaseId;
  }
  get generation(): string {
    return this.context.generation;
  }
  get leasePath(): string {
    return this.context.leasePath;
  }
  get loadedPolicy(): LoadedResourceWatchdogPolicy {
    return this.context.loadedPolicy;
  }
  get stagingRoot(): string {
    return loadDockerWorkloadLease(this.leasePath).paths.stagingRoot;
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

  /**
   * Exclude cleanup while freshness, ledger precommit, runtime create, and
   * immutable-ID observation execute as one lifecycle operation.
   */
  async withOuterCreateClaim<T>(operation: () => Promise<T>): Promise<T> {
    if (this.rejecting) throw new Error('Docker-workload bundle is tearing down; outer create is rejected');
    const baselineSampleAt = this.context.supervisor.readStatus(this.context.statusPath)?.lastSample?.sampledAtMs;
    const token = Symbol('outer-create');
    let result: T;
    try {
      result = await withDockerWorkloadLifecycleClaim(
        {
          leasePath: this.leasePath,
          clock: this.context.clock,
          sleep: this.context.sleep,
          wait: true,
          processIdentityForPid: this.context.processIdentityForPid,
        },
        async () => {
          const status = loadDockerWorkloadLease(this.leasePath).status;
          if (this.rejecting || (status !== 'admitting' && status !== 'active')) {
            throw new Error(`Docker-workload bundle is ${status}; outer create is rejected`);
          }
          this.localCreateOperations.add(token);
          heartbeatDockerWorkloadLease(this.leasePath, this.generation, this.context.clock());
          const heartbeat = setInterval(() => {
            try {
              heartbeatDockerWorkloadLease(this.leasePath, this.generation, this.context.clock());
            } catch {
              // The held lifecycle claim prevents cleanup; a lease-lock collision retries next interval.
            }
          }, DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS);
          heartbeat.unref();
          try {
            return await operation();
          } finally {
            clearInterval(heartbeat);
          }
        },
      );
      await this.reconfirmSupervisorAfterCreate(baselineSampleAt);
      return result;
    } finally {
      this.localCreateOperations.delete(token);
    }
  }

  /** Launch and attest the detached watchdog supervisor; fail admission on anything but 'ready'. */
  async attestWatchdog(): Promise<ResourceWatchdogSupervisorStatus> {
    const launched = await this.context.supervisor.launch({
      leasePath: this.leasePath,
      policyPath: this.context.policyPath,
      statusPath: this.context.statusPath,
      stopRequestPath: this.context.stopRequestPath,
      entrypointPath: this.context.supervisorEntrypointPath,
      startupTimeoutMs: DOCKER_WORKLOAD_WATCHDOG_STARTUP_TIMEOUT_MS,
    });
    this.supervisorPid = launched.pid;
    this.assertSupervisorStatus(launched.status);
    const firstSample = launched.status.lastSample;
    if (firstSample === null) throw new Error('watchdog attestation returned no first sample');
    this.emit({
      kind: 'watchdog-attested',
      supervisorPid: launched.pid,
      policySha256: this.loadedPolicy.sha256,
      templateSha256: this.context.templateSha256,
      firstSample,
    });
    this.startSupervisorMonitor();
    return launched.status;
  }

  /**
   * Record the adjudicated nested-daemon configuration (§8.2 step 4/5 evidence).
   *
   * Called only after readiness ACCEPTED the daemon, so the event states which
   * configuration was admitted rather than merely that something answered. The
   * attestation marker is stamped here, not carried by the readiness record:
   * these values reach the host through a bundle-local socket, so the evidence
   * must say so beside the host-observed events it sits next to.
   */
  recordDaemonReady(readiness: AppleVmDaemonReadiness): void {
    this.emit({
      kind: 'daemon-ready',
      attestation: DAEMON_READY_ATTESTATION,
      driver: readiness.driver,
      securityOptions: [...readiness.securityOptions],
      serverVersion: readiness.serverVersion,
      readinessMs: readiness.readinessMs,
    });
  }

  /** Record the exact private-Docker inputs and advisory bundle-local observations before activation. */
  recordPrivateDockerBootstrap(
    provisioning: AppleVmDockerWorkloadProvisioning,
    network: AppleVmDockerWorkloadNetwork,
  ): void {
    this.emit({
      kind: 'private-docker-bootstrap',
      attestation: DAEMON_READY_ATTESTATION,
      toolchainDigest: provisioning.preflight.toolchainDigest,
      toolchain: provisioning.preflight.toolchain,
      artifact: {
        logicalName: provisioning.image.logicalName,
        buildHash: provisioning.image.buildHash,
        archiveSha256: provisioning.image.archiveSha256,
        outerAppleImageId: provisioning.image.outerAppleImageId,
        innerDockerImageId: provisioning.image.immutableImageId,
      },
      network: {
        name: network.name,
        runtimeId: network.id,
      },
    });
  }

  /** Prove the watchdog supervisor is still fresh immediately before daemon/VM create. */
  assertWatchdogFresh(): void {
    const status = this.context.supervisor.readStatus(this.context.statusPath);
    if (status === undefined) throw new Error('watchdog supervisor status is missing');
    this.assertSupervisorStatus(status);
  }

  /** One deterministic health-monitor iteration; the interval uses the same path. */
  async pollSupervisorHealth(): Promise<void> {
    if (this.rejecting || this.supervisorPid === undefined || this.localCreateOperations.size !== 0) return;
    try {
      this.assertWatchdogFresh();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.emit({ kind: 'incident', code: 'watchdog-supervisor-unhealthy', detail });
      await this.teardown();
    }
  }

  private async reconfirmSupervisorAfterCreate(baselineSampleAt: number | undefined): Promise<void> {
    // Preserve the established non-daemon seam: callers that never had a
    // watchdog attestation are not retroactively gated by this handoff.
    if (baselineSampleAt === undefined) return;
    try {
      this.assertWatchdogFresh();
      return;
    } catch {
      // A long valid create intentionally excludes sampling. Demand a newer
      // real sample before returning authority to the caller.
    }
    const deadline = this.context.clock().getTime() + this.loadedPolicy.policy.staleAfterMs;
    for (;;) {
      const status = this.context.supervisor.readStatus(this.context.statusPath);
      if (status !== undefined && status.lastSample !== null && status.lastSample.sampledAtMs > baselineSampleAt) {
        this.assertSupervisorStatus(status);
        return;
      }
      if (this.context.clock().getTime() >= deadline) {
        throw new Error('watchdog supervisor did not publish a fresh sample after outer create');
      }
      await this.context.sleep(POST_CREATE_SAMPLE_POLL_MS);
    }
  }

  /** One single-flight heartbeat iteration; claim collisions retry briefly instead of phase-locking with samples. */
  refreshCoordinatorHeartbeat(): Promise<boolean> {
    if (this.heartbeatRefreshPromise !== undefined) return this.heartbeatRefreshPromise;
    const refresh = this.retryCoordinatorHeartbeat();
    this.heartbeatRefreshPromise = refresh;
    void refresh.then(
      () => {
        if (this.heartbeatRefreshPromise === refresh) this.heartbeatRefreshPromise = undefined;
      },
      () => {
        if (this.heartbeatRefreshPromise === refresh) this.heartbeatRefreshPromise = undefined;
      },
    );
    return refresh;
  }

  /** Activate atomically against cleanup immediately before releasing the agent. */
  async activate(): Promise<void> {
    if (this.rejecting) throw new Error('Docker-workload bundle is tearing down; activation is rejected');
    await withDockerWorkloadLifecycleClaim(
      {
        leasePath: this.leasePath,
        clock: this.context.clock,
        sleep: this.context.sleep,
        wait: true,
        processIdentityForPid: this.context.processIdentityForPid,
      },
      () => {
        const lease = loadDockerWorkloadLease(this.leasePath);
        if (this.rejecting || lease.status !== 'admitting') {
          throw new Error(`Docker-workload bundle is ${lease.status}; activation is rejected`);
        }
        // Image verification/loading can outlast the pre-create check. Bind
        // freshness, coordinator ownership, and the authority transition to
        // one lifecycle owner before the caller attaches and releases the agent.
        this.assertWatchdogFresh();
        heartbeatDockerWorkloadLease(this.leasePath, this.generation, this.context.clock());
        activateDockerWorkloadLease(this.leasePath, this.generation, this.context.clock());
        this.emit({ kind: 'lease-transition', from: 'admitting', to: 'active' });
        return Promise.resolve();
      },
    );
  }

  /** §8.3 teardown in the frozen order; idempotent and tolerant of transient lock contention. */
  teardown(): Promise<DockerWorkloadTeardownResult> {
    this.rejecting = true;
    this.clearSupervisorMonitor();
    return (this.teardownPromise ??= this.runTeardown());
  }

  private async runTeardown(): Promise<DockerWorkloadTeardownResult> {
    try {
      const startLease = loadDockerWorkloadLease(this.leasePath);
      if (startLease.status === 'closed') return { alreadyClosed: true, supervisorLost: false };
      const result = await performSerializedDockerWorkloadCleanup({
        runtime: this.context.runtime,
        leasePath: this.leasePath,
        generation: this.generation,
        targetDevice: this.loadedPolicy.policy.targetDevice,
        targetInode: this.loadedPolicy.policy.targetInode,
        gapMs: this.loadedPolicy.policy.cleanupInventoryGapMs,
        clock: this.context.clock,
        sleep: this.context.sleep,
        waitForOwner: true,
        processIdentityForPid: this.context.processIdentityForPid,
        onRevoking: (from) => this.emit({ kind: 'lease-transition', from, to: 'revoking' }),
      });
      if (result.revocation !== undefined) {
        this.emit({
          kind: 'revocation-result',
          removedResourceIds: [...result.revocation.removedResourceIds],
          finalOwnedResourceIds: [...result.revocation.finalOwnedResourceIds],
        });
        this.emit({ kind: 'cleanup-proof', inventories: result.cleanup.inventories });
      }
      const supervisorLost = await this.stopWatchdogAfterCleanup(result.cleanup);
      return {
        alreadyClosed: result.alreadyClosed,
        supervisorLost,
        revocation: result.revocation,
        cleanup: result.cleanup,
      };
    } finally {
      // Preserve ownership throughout cleanup, but never leave an errored
      // coordinator heartbeating forever; the supervisor/reconciler must then
      // be able to take over after the stale bound.
      this.clearHeartbeatTimer();
      this.teardownPromise = undefined;
    }
  }

  private async stopWatchdogAfterCleanup(cleanup: DockerWorkloadCleanupProof): Promise<boolean> {
    const lease = loadDockerWorkloadLease(this.leasePath);
    this.context.supervisor.requestStop(
      this.context.stopRequestPath,
      { leaseId: lease.leaseId, generation: lease.generation },
      cleanup,
      this.context.clock(),
    );
    const deadline = this.context.clock().getTime() + SUPERVISOR_STOP_TIMEOUT_MS;
    for (;;) {
      const status = this.context.supervisor.readStatus(this.context.statusPath);
      if (status?.state === 'closed') return false;
      const supervisorGone = this.supervisorPid === undefined || !this.context.supervisor.isAlive(this.supervisorPid);
      if (supervisorGone || this.context.clock().getTime() >= deadline) {
        this.emit({
          kind: 'incident',
          code: 'watchdog-supervisor-lost',
          detail: 'cleanup completed but the watchdog supervisor was unreachable for terminal acknowledgement',
        });
        return true;
      }
      await this.context.sleep(SUPERVISOR_STOP_POLL_MS);
    }
  }

  private startHeartbeatTimer(): void {
    if (!this.context.startHeartbeat) return;
    this.heartbeatTimer = setInterval(() => {
      void this.refreshCoordinatorHeartbeat().catch(() => {
        // Transient lease-lock contention or a terminal lease; the next interval retries.
      });
    }, DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private async retryCoordinatorHeartbeat(): Promise<boolean> {
    const deadline = this.context.clock().getTime() + DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS;
    for (;;) {
      if (this.rejecting) return false;
      try {
        const status = loadDockerWorkloadLease(this.leasePath).status;
        if (status !== 'admitting' && status !== 'active') return false;
        if (
          tryHeartbeatDockerWorkloadLease({
            leasePath: this.leasePath,
            generation: this.generation,
            clock: this.context.clock,
            processIdentityForPid: this.context.processIdentityForPid,
          })
        ) {
          return true;
        }
      } catch {
        // A concurrent short lease mutation gets the same bounded retry.
      }
      if (this.context.clock().getTime() >= deadline) return false;
      await this.context.sleep(HEARTBEAT_CLAIM_RETRY_MS);
    }
  }

  private startSupervisorMonitor(): void {
    if (!this.context.startHeartbeat || this.supervisorMonitorTimer !== undefined) return;
    this.supervisorMonitorTimer = setInterval(() => {
      void this.pollSupervisorHealth().catch((error: unknown) => {
        this.emit({
          kind: 'incident',
          code: 'watchdog-monitor-teardown-failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.loadedPolicy.policy.sampleIntervalMs);
    this.supervisorMonitorTimer.unref();
  }

  private assertSupervisorStatus(status: ResourceWatchdogSupervisorStatus): void {
    assertResourceWatchdogSupervisorFresh(
      status,
      { leaseId: this.leaseId, generation: this.generation, policySha256: this.loadedPolicy.sha256 },
      this.loadedPolicy.policy.staleAfterMs,
      this.context.clock(),
    );
    if (this.supervisorPid === undefined || status.supervisorPid !== this.supervisorPid) {
      throw new Error('watchdog supervisor process ID binding mismatch');
    }
    if (!this.context.supervisor.isAlive(this.supervisorPid)) {
      throw new Error('watchdog supervisor process is not alive');
    }
  }

  private clearSupervisorMonitor(): void {
    if (this.supervisorMonitorTimer !== undefined) {
      clearInterval(this.supervisorMonitorTimer);
      this.supervisorMonitorTimer = undefined;
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private emit(payload: DockerWorkloadAuditEventPayload): void {
    emitAudit(this.context.auditSink, this.leaseId, this.generation, this.context.clock().toISOString(), payload);
  }
}

async function reconcileHeld(options: ReconcileDockerWorkloadOptions): Promise<ReconcileDockerWorkloadHeldResult> {
  const clock = options.clock ?? defaultClock;
  const sleep = options.sleep ?? defaultSleep;
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  const supervisor = options.supervisor ?? defaultSupervisorController;
  const recoveryBoundMs = options.recoveryBoundMs ?? DOCKER_WORKLOAD_RECOVERY_BOUND_MS;
  const staleHeartbeatMs = options.staleHeartbeatMs ?? DOCKER_WORKLOAD_STALE_HEARTBEAT_MS;
  const leasesRoot = getDockerWorkloadLeasesRoot();

  const reconciled: string[] = [];
  const preserved: string[] = [];
  const fences: Array<{ readonly leaseId: string; readonly detail: string }> = [];
  const postCloseAuditFailures: DockerWorkloadPostCloseAuditError[] = [];
  const recordFence = (leaseId: string, detail: string): void => {
    fences.push({ leaseId, detail });
  };
  for (const leaseId of listLeaseIds(leasesRoot)) {
    const leaseDir = join(leasesRoot, leaseId);
    const leasePath = join(leaseDir, LEASE_FILE);
    let lease;
    try {
      lease = loadDockerWorkloadLease(leasePath);
    } catch {
      // Unrelated directories are ignored, but once a lease marker exists its
      // contents are authoritative lifecycle state. Corruption, permissions,
      // symlinks, or an older unsupported schema must fence admission rather
      // than making possibly-running outer resources disappear from recovery.
      if (pathEntryExistsWithoutFollowing(leasePath)) {
        recordFence(leaseId, `${leaseId} (lease record is unreadable; exact recovery cannot be proven)`);
      }
      continue;
    }
    if (lease.status === 'closed') continue;
    const recoveringIncident = lease.incident !== null;
    const now = clock();
    const heartbeatFresh = now.getTime() - Date.parse(lease.coordinator.heartbeatAt) < staleHeartbeatMs;
    const coordinatorLive = heartbeatFresh && pidAlive(lease.coordinator.pid);
    if (!recoveringIncident && isLeaseLive(lease, leaseDir, supervisor, coordinatorLive, now)) {
      preserved.push(leaseId);
      continue;
    }
    // A recent heartbeat fences long enough for a just-launched supervisor to
    // publish status. After the stale bound, cleanup-claim serialization makes
    // it safe for reconciliation to compete with an in-flight supervisor trip.
    if (!recoveringIncident && heartbeatFresh) {
      recordFence(leaseId, `${leaseId} (lifecycle is still owned or recently active)`);
      continue;
    }
    try {
      await recoverStaleLease({
        leaseDir,
        leasePath,
        lease,
        options,
        clock,
        sleep,
        supervisor,
        recoveryBoundMs,
        staleHeartbeatMs,
      });
      reconciled.push(leaseId);
    } catch (error) {
      if (error instanceof DockerWorkloadPostCloseAuditError) {
        // Cleanup is already proven. Preserve mandatory audit failure as the
        // pass result, but continue exact recovery so an earlier lease cannot
        // starve later incident cleanup.
        postCloseAuditFailures.push(error);
        continue;
      }
      if (isDockerWorkloadLifecycleClaimBusy(error) || error instanceof DockerWorkloadCleanupPreconditionError) {
        recordFence(leaseId, `${leaseId} (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      fenceLease(leasePath, lease.leaseId, lease.generation, error, clock, options.auditSink);
      recordFence(leaseId, describeFencedLease(leasePath, leaseId, error));
    }
  }
  if (postCloseAuditFailures.length === 1) throw postCloseAuditFailures[0];
  if (postCloseAuditFailures.length > 1) {
    throw new DockerWorkloadPostCloseAuditError(
      `${postCloseAuditFailures.length} Docker-workload leases were durably closed, but mandatory audit publication failed`,
      new AggregateError(postCloseAuditFailures),
    );
  }
  return {
    reconciled,
    preserved,
    fenced: fences.map((fence) => fence.leaseId),
    fenceDetails: fences.map((fence) => fence.detail),
  };
}

function isLeaseLive(
  lease: ReturnType<typeof loadDockerWorkloadLease>,
  leaseDir: string,
  supervisor: WatchdogSupervisorController,
  coordinatorFresh: boolean,
  now: Date,
): boolean {
  // A detached supervisor protects cleanup; it never inherits ownership of a
  // bundle. A dead or stale coordinator therefore always makes the lease
  // recoverable even when the supervisor continues sampling successfully.
  if (!coordinatorFresh) return false;
  // Admission before watchdog attestation and coordinator-driven revocation
  // are live while their coordinator is fresh. Once active, both independent
  // owners must be fresh and bound to this exact lease/policy.
  if (lease.status !== 'active') return true;
  try {
    const status = supervisor.readStatus(join(leaseDir, STATUS_FILE));
    if (status === undefined) return false;
    const supervisorStaleAfterMs = loadResourceWatchdogPolicy(join(leaseDir, POLICY_FILE)).policy.staleAfterMs;
    assertResourceWatchdogSupervisorFresh(
      status,
      { leaseId: lease.leaseId, generation: lease.generation, policySha256: lease.bindings.watchdogPolicySha256 },
      supervisorStaleAfterMs,
      now,
    );
    return true;
  } catch {
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
  readonly staleHeartbeatMs: number;
}): Promise<void> {
  const { leaseDir, leasePath, lease, options, clock, sleep, supervisor, recoveryBoundMs } = context;
  const runtime =
    lease.runtimeKind === options.runtimeKind ? options.runtime : options.runtimeForKind?.(lease.runtimeKind);
  if (runtime === undefined) {
    throw new Error(
      `cannot reconcile ${lease.runtimeKind} lease through selected ${options.runtimeKind} runtime; recorded runtime is unavailable`,
    );
  }
  const loadedPolicy = loadResourceWatchdogPolicy(join(leaseDir, POLICY_FILE));
  if (loadedPolicy.sha256 !== lease.bindings.watchdogPolicySha256) {
    throw new Error('reconciliation policy hash does not match the lease binding');
  }
  const result = await performSerializedDockerWorkloadCleanup({
    runtime,
    leasePath,
    generation: lease.generation,
    targetDevice: loadedPolicy.policy.targetDevice,
    targetInode: loadedPolicy.policy.targetInode,
    gapMs: loadedPolicy.policy.cleanupInventoryGapMs,
    clock,
    sleep,
    waitForOwner: false,
    timeoutMs: recoveryBoundMs,
    processIdentityForPid: options.processIdentityForPid,
    revalidate: (claimedLease) => {
      if (claimedLease.status === 'incident') return;
      if (claimedLease.status === 'revoking') return;
      if (claimedLease.status !== 'admitting' && claimedLease.status !== 'active') {
        throw new DockerWorkloadCleanupPreconditionError(
          `lease state ${claimedLease.status} no longer permits reconciliation cleanup`,
        );
      }
      if (clock().getTime() - Date.parse(claimedLease.coordinator.heartbeatAt) < context.staleHeartbeatMs) {
        throw new DockerWorkloadCleanupPreconditionError('coordinator heartbeat refreshed before cleanup ownership');
      }
    },
    onRevoking: (from) => {
      emitAudit(options.auditSink, lease.leaseId, lease.generation, clock().toISOString(), {
        kind: 'lease-transition',
        from,
        to: 'revoking',
      });
    },
  });
  if (result.revocation !== undefined) {
    try {
      emitAudit(options.auditSink, lease.leaseId, lease.generation, clock().toISOString(), {
        kind: 'revocation-result',
        removedResourceIds: [...result.revocation.removedResourceIds],
        finalOwnedResourceIds: [...result.revocation.finalOwnedResourceIds],
      });
      emitAudit(options.auditSink, lease.leaseId, lease.generation, clock().toISOString(), {
        kind: 'cleanup-proof',
        inventories: result.cleanup.inventories,
      });
      emitAudit(options.auditSink, lease.leaseId, lease.generation, clock().toISOString(), {
        kind: 'lease-transition',
        from: 'revoking',
        to: 'closed',
      });
    } catch (error) {
      throw new DockerWorkloadPostCloseAuditError(
        `Docker-workload lease ${lease.leaseId} is durably closed, but mandatory cleanup audit publication failed`,
        error,
      );
    }
  }

  try {
    supervisor.requestStop(
      join(leaseDir, STOP_REQUEST_FILE),
      { leaseId: lease.leaseId, generation: lease.generation },
      result.cleanup,
      clock(),
    );
  } catch (error) {
    // Exact cleanup is already durably closed. A detached supervisor also
    // observes that proof directly, so a failed stop notification is an
    // operational incident, not unresolved workload authority.
    try {
      emitAudit(options.auditSink, lease.leaseId, lease.generation, clock().toISOString(), {
        kind: 'incident',
        code: 'watchdog-supervisor-stop-notification-failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    } catch (auditError) {
      throw new DockerWorkloadPostCloseAuditError(
        `Docker-workload lease ${lease.leaseId} is durably closed, but mandatory supervisor-loss audit publication failed`,
        auditError,
      );
    }
  }
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
    if (current.incident !== null && current.status === 'revoking') {
      returnDockerWorkloadLeaseRecoveryToIncident(leasePath, generation, clock());
    } else if (current.status !== 'incident' && current.status !== 'closed') {
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

function describeFencedLease(leasePath: string, leaseId: string, error: unknown): string {
  const latest = error instanceof Error ? error.message : String(error);
  try {
    const lease = loadDockerWorkloadLease(leasePath);
    if (lease.incident === null) return `${leaseId} (latest recovery failure: ${latest})`;
    return `${leaseId} (original incident ${lease.incident.code} at ${lease.incident.recordedAt}: ${lease.incident.detail}; latest recovery failure: ${latest})`;
  } catch {
    return `${leaseId} (lease record is unreadable; latest recovery failure: ${latest})`;
  }
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
  processIdentityForPid: ProcessIdentityResolver | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, ADMISSION_LOCK_FILE);
  let lock;
  try {
    lock = acquireProcessLock(lockPath, {
      attempts: ADMISSION_LOCK_ACQUIRE_ATTEMPTS,
      processIdentityForPid,
    });
  } catch (error) {
    if (error instanceof ProcessLockBusyError) {
      const owner = error.ownerPid === undefined ? '' : ` (owner pid ${error.ownerPid})`;
      throw new Error(`Docker-workload admission is busy${owner}`, { cause: error });
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    lock.release();
  }
}

function pathEntryExistsWithoutFollowing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
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
