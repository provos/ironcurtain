import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  admitDockerWorkloadBundle,
  reconcileDockerWorkloadLeases,
  DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY,
  type DockerWorkloadAdmissionOptions,
  type ReconcileDockerWorkloadOptions,
  type WatchdogSupervisorController,
} from '../../src/docker-workload/infrastructure.js';
import type { ResourceWatchdogSupervisorStatus } from '../../src/docker-workload/resource-watchdog-supervisor.js';
import {
  activateDockerWorkloadLease,
  createDockerWorkloadLease,
  heartbeatDockerWorkloadLease,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  recoverDockerWorkloadLeaseIncident,
  recordDockerWorkloadLeaseIncident,
  requestDockerWorkloadOuterResource,
} from '../../src/docker-workload/bundle-lease.js';
import { getDockerWorkloadLeaseDir, getDockerWorkloadStateRoot } from '../../src/config/paths.js';
import { loadFrozenWatchdogPolicyTemplate, renderWatchdogPolicy } from '../../src/docker-workload/watchdog-policy.js';
import { createRecordingDockerWorkloadAuditSink } from '../../src/docker-workload/lifecycle-evidence.js';
import { tryAcquireDockerWorkloadLifecycleClaim } from '../../src/docker-workload/cleanup-ownership.js';
import type { DockerContainerInfo } from '../../src/docker/types.js';
import {
  ADMISSION_BINDINGS,
  ADMISSION_CONFIG_HASH,
  WATCHDOG_ENTRYPOINT_PATH,
  WATCHDOG_TEMPLATE_PATH,
  createEventRuntime,
  createFakeClock,
  createFakeSupervisor,
  useDockerWorkloadHome,
  type EventRuntime,
  type FakeClock,
} from './helpers/infrastructure-harness.js';

const KEY = DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY;
const getHome = useDockerWorkloadHome();

interface SeedResource {
  readonly requestId: string;
  readonly kind: 'container' | 'network';
  readonly role: 'agent' | 'nested-daemon' | 'fixed-relay' | 'proxy' | 'network';
  readonly name: string;
  readonly observedId?: string;
}

function seedLease(options: {
  readonly leaseId: string;
  readonly heartbeatIso: string;
  readonly runtimeKind?: 'docker' | 'apple-container';
  readonly resources?: readonly SeedResource[];
  readonly activate?: boolean;
}): { readonly leaseId: string; readonly leasePath: string; readonly generation: string } {
  const { leaseId } = options;
  const stateRoot = getDockerWorkloadStateRoot(leaseId);
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  for (const subdir of ['daemon', 'api', 'exchange', 'staging']) {
    mkdirSync(join(stateRoot, subdir), { recursive: true, mode: 0o700 });
  }
  const leaseDir = getDockerWorkloadLeaseDir(leaseId);
  mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
  const template = loadFrozenWatchdogPolicyTemplate(WATCHDOG_TEMPLATE_PATH);
  const loadedPolicy = renderWatchdogPolicy(template.template, stateRoot, join(leaseDir, 'policy.json'));
  const generation = `gen-${leaseId}`;
  const now = new Date(options.heartbeatIso);
  const leasePath = join(leaseDir, 'lease.json');
  createDockerWorkloadLease(leasePath, {
    leaseId,
    bundleId: `bundle-${leaseId}`,
    generation,
    runtimeKind: options.runtimeKind ?? 'docker',
    paths: {
      workspaceRoot: join(getHome(), 'workspace'),
      stateRoot,
      runtimeRoot: join(stateRoot, 'daemon'),
      apiRoot: join(stateRoot, 'api'),
      exchangeRoot: join(stateRoot, 'exchange'),
      stagingRoot: join(stateRoot, 'staging'),
    },
    bindings: { ...ADMISSION_BINDINGS, watchdogPolicySha256: loadedPolicy.sha256 },
    cleanupInventoryGapMs: loadedPolicy.policy.cleanupInventoryGapMs,
    coordinatorPid: process.pid,
    now,
  });
  for (const resource of options.resources ?? []) {
    requestDockerWorkloadOuterResource(
      leasePath,
      generation,
      {
        requestId: resource.requestId,
        kind: resource.kind,
        role: resource.role,
        requestedName: resource.name,
        ownershipLabelKey: KEY,
      },
      now,
    );
    if (resource.observedId !== undefined) {
      observeDockerWorkloadOuterResource(leasePath, generation, resource.requestId, resource.observedId, now);
    }
  }
  if (options.activate) activateDockerWorkloadLease(leasePath, generation, now);
  return { leaseId, leasePath, generation };
}

function reconcileOptions(runtime: EventRuntime, clock: FakeClock): ReconcileDockerWorkloadOptions {
  return {
    runtime: runtime.runtime,
    runtimeKind: 'docker',
    clock: clock.clock,
    sleep: clock.sleep,
    pidAlive: () => true,
    supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
  };
}

function admissionOptions(runtime: EventRuntime, clock: FakeClock): DockerWorkloadAdmissionOptions {
  return {
    runtime: runtime.runtime,
    runtimeKind: 'docker',
    bundleId: 'bundle-fresh-001',
    workspaceRoot: join(getHome(), 'workspace'),
    bindings: ADMISSION_BINDINGS,
    configHash: ADMISSION_CONFIG_HASH,
    watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
    watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
    clock: clock.clock,
    sleep: clock.sleep,
    pidAlive: () => true,
    supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
    startHeartbeat: false,
  };
}

function container(id: string, name: string, generation: string): DockerContainerInfo {
  return { id, name, created: '2026-07-20T12:00:00Z', running: true, labels: { [KEY]: generation } };
}

function markIncident(
  seeded: ReturnType<typeof seedLease>,
  code = 'docker-workload-cleanup-failed',
  detail = 'authoritative Apple inventory timed out twice',
): void {
  recordDockerWorkloadLeaseIncident(
    seeded.leasePath,
    seeded.generation,
    { code, detail },
    new Date('2026-07-20T12:00:01.000Z'),
  );
}

describe('Docker-workload crash reconciliation (§8.3 recovery)', () => {
  it('automatically recovers an incident with an already-absent resource and leftover state before admission', async () => {
    const runtime = createEventRuntime();
    const incident = seedLease({
      leaseId: 'dw-incident-absent',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      resources: [
        {
          requestId: 'res-absent',
          kind: 'container',
          role: 'nested-daemon',
          name: 'ic-already-absent',
          observedId: 'already-absent-id',
        },
      ],
      activate: true,
    });
    markIncident(incident);
    const original = loadDockerWorkloadLease(incident.leasePath).incident;
    expect(existsSync(getDockerWorkloadStateRoot(incident.leaseId))).toBe(true);

    const handle = await admitDockerWorkloadBundle(
      admissionOptions(runtime, createFakeClock('2026-07-20T12:00:02.000Z')),
    );

    const recovered = loadDockerWorkloadLease(incident.leasePath);
    expect(recovered).toMatchObject({ status: 'closed', incident: original, cleanup: { stateRootAbsent: true } });
    expect(existsSync(getDockerWorkloadStateRoot(incident.leaseId))).toBe(false);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');

    const again = await reconcileDockerWorkloadLeases(
      reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:02.000Z')),
    );
    expect(again.reconciled).toEqual([]);
    expect(again.preserved).toEqual([handle.leaseId]);
    expect(loadDockerWorkloadLease(incident.leasePath)).toEqual(recovered);
  });

  it('does not re-fence a recovered lease when the old supervisor stop notification fails', async () => {
    const runtime = createEventRuntime();
    const incident = seedLease({
      leaseId: 'dw-incident-stop-notification',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
    });
    markIncident(incident);
    const original = loadDockerWorkloadLease(incident.leasePath).incident;
    const clock = createFakeClock('2026-07-20T12:00:02.000Z');
    const sink = createRecordingDockerWorkloadAuditSink();
    const supervisor: WatchdogSupervisorController = {
      ...createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
      requestStop() {
        throw new Error('old supervisor stop socket is unavailable');
      },
    };

    const handle = await admitDockerWorkloadBundle({
      ...admissionOptions(runtime, clock),
      supervisor,
      auditSink: sink,
    });

    expect(loadDockerWorkloadLease(incident.leasePath)).toMatchObject({
      status: 'closed',
      incident: original,
      cleanup: { exactOuterResourcesAbsent: true, stateRootAbsent: true },
    });
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        kind: 'incident',
        code: 'watchdog-supervisor-stop-notification-failed',
        detail: 'old supervisor stop socket is unavailable',
      }),
    );
  });

  it('recovers only the exact owned resource, preserves foreign resources, and preserves a healthy active lease', async () => {
    const runtime = createEventRuntime({
      containers: [
        container('owned-incident-id', 'ic-owned-incident', 'gen-dw-a-incident'),
        container('healthy-id', 'ic-healthy', 'gen-dw-b-healthy'),
        { ...container('foreign-id', 'ic-foreign', 'foreign-generation'), labels: {} },
      ],
    });
    const incident = seedLease({
      leaseId: 'dw-a-incident',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      resources: [
        {
          requestId: 'res-owned',
          kind: 'container',
          role: 'nested-daemon',
          name: 'ic-owned-incident',
          observedId: 'owned-incident-id',
        },
      ],
      activate: true,
    });
    const healthy = seedLease({
      leaseId: 'dw-b-healthy',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      resources: [
        {
          requestId: 'res-healthy',
          kind: 'container',
          role: 'nested-daemon',
          name: 'ic-healthy',
          observedId: 'healthy-id',
        },
      ],
      activate: true,
    });
    markIncident(incident);
    const clock = createFakeClock('2026-07-20T12:00:02.000Z');

    const result = await reconcileDockerWorkloadLeases({
      ...reconcileOptions(runtime, clock),
      supervisor: createFakeSupervisor({ clock: clock.clock }),
    });

    expect(result).toEqual({ reconciled: [incident.leaseId], preserved: [healthy.leaseId], fenced: [] });
    expect(runtime.containers.map((entry) => entry.id).sort()).toEqual(['foreign-id', 'healthy-id']);
    expect(loadDockerWorkloadLease(incident.leasePath).status).toBe('closed');
    expect(loadDockerWorkloadLease(healthy.leasePath).status).toBe('active');
  });

  it('keeps the original incident and fences when exact ownership validation still fails', async () => {
    const runtime = createEventRuntime({
      containers: [{ ...container('wrong-label-id', 'ic-wrong-label', 'not-the-generation'), labels: {} }],
    });
    const incident = seedLease({
      leaseId: 'dw-incident-wrong-label',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      resources: [
        {
          requestId: 'res-wrong-label',
          kind: 'container',
          role: 'nested-daemon',
          name: 'ic-wrong-label',
          observedId: 'wrong-label-id',
        },
      ],
      activate: true,
    });
    markIncident(incident, 'original-inventory-loss', 'the first inventory could not be completed');
    const original = loadDockerWorkloadLease(incident.leasePath).incident;
    const clock = createFakeClock('2026-07-20T12:00:02.000Z');

    const result = await reconcileDockerWorkloadLeases(reconcileOptions(runtime, clock));

    expect(result.fenced).toEqual([incident.leaseId]);
    expect(runtime.containers.map((entry) => entry.id)).toEqual(['wrong-label-id']);
    expect(loadDockerWorkloadLease(incident.leasePath)).toMatchObject({ status: 'incident', incident: original });
    await expect(admitDockerWorkloadBundle(admissionOptions(runtime, clock))).rejects.toThrow(
      /dw-incident-wrong-label.*original-inventory-loss.*latest recovery failure.*wrong generation label/u,
    );
  });

  it('fences an incident create-before-observe collision with a foreign same-name resource', async () => {
    const runtime = createEventRuntime({
      containers: [container('foreign-same-name-id', 'ic-unobserved-collision', 'foreign-generation')],
    });
    const incident = seedLease({
      leaseId: 'dw-incident-unobserved-collision',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      resources: [
        {
          requestId: 'res-unobserved-collision',
          kind: 'container',
          role: 'nested-daemon',
          name: 'ic-unobserved-collision',
        },
      ],
    });
    markIncident(incident, 'original-create-loss', 'create result was not observed');
    const original = loadDockerWorkloadLease(incident.leasePath).incident;

    const result = await reconcileDockerWorkloadLeases(
      reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:02.000Z')),
    );

    expect(result.fenced).toEqual([incident.leaseId]);
    expect(runtime.containers.map((entry) => entry.id)).toEqual(['foreign-same-name-id']);
    expect(loadDockerWorkloadLease(incident.leasePath)).toMatchObject({ status: 'incident', incident: original });
  });

  it('audits the complete successful incident recovery sequence', async () => {
    const runtime = createEventRuntime({
      containers: [container('audit-owned-id', 'ic-audit-owned', 'gen-dw-incident-audit')],
    });
    const incident = seedLease({
      leaseId: 'dw-incident-audit',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      resources: [
        {
          requestId: 'res-audit-owned',
          kind: 'container',
          role: 'nested-daemon',
          name: 'ic-audit-owned',
          observedId: 'audit-owned-id',
        },
      ],
      activate: true,
    });
    markIncident(incident);
    const sink = createRecordingDockerWorkloadAuditSink();

    const result = await reconcileDockerWorkloadLeases({
      ...reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:02.000Z')),
      auditSink: sink,
    });

    expect(result.reconciled).toEqual([incident.leaseId]);
    expect(sink.events.map((event) => event.kind)).toEqual([
      'lease-transition',
      'revocation-result',
      'cleanup-proof',
      'lease-transition',
    ]);
    expect(sink.events[0]).toMatchObject({ kind: 'lease-transition', from: 'incident', to: 'revoking' });
    expect(sink.events[1]).toMatchObject({ kind: 'revocation-result', removedResourceIds: ['audit-owned-id'] });
    expect(sink.events[3]).toMatchObject({ kind: 'lease-transition', from: 'revoking', to: 'closed' });
  });

  it('resumes a crash after incident-to-revoking transition', async () => {
    const runtime = createEventRuntime();
    const incident = seedLease({ leaseId: 'dw-incident-revoking', heartbeatIso: '2026-07-20T12:00:00.000Z' });
    markIncident(incident);
    const original = loadDockerWorkloadLease(incident.leasePath).incident;
    recoverDockerWorkloadLeaseIncident(incident.leasePath, incident.generation, new Date('2026-07-20T12:00:02.000Z'));

    const result = await reconcileDockerWorkloadLeases(
      reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:03.000Z')),
    );

    expect(result.reconciled).toEqual([incident.leaseId]);
    expect(loadDockerWorkloadLease(incident.leasePath)).toMatchObject({ status: 'closed', incident: original });
  });

  it('continues reconciling later incidents when an earlier incident remains unresolved', async () => {
    const failing = createEventRuntime();
    const failingRuntime = {
      ...failing.runtime,
      async listContainers(): Promise<never> {
        throw new Error('recorded Docker runtime inventory is unavailable');
      },
    };
    const succeeding = createEventRuntime();
    const first = seedLease({
      leaseId: 'dw-a-unresolved',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      runtimeKind: 'docker',
    });
    const second = seedLease({
      leaseId: 'dw-b-recoverable',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      runtimeKind: 'apple-container',
    });
    markIncident(first, 'first-failure', 'first runtime was unavailable');
    markIncident(second, 'second-failure', 'second runtime transiently failed');
    const clock = createFakeClock('2026-07-20T12:00:02.000Z');

    const result = await reconcileDockerWorkloadLeases({
      runtime: failingRuntime,
      runtimeKind: 'docker',
      runtimeForKind: (kind) => (kind === 'apple-container' ? succeeding.runtime : failingRuntime),
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => true,
      supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
    });

    expect(result).toEqual({ reconciled: [second.leaseId], preserved: [], fenced: [first.leaseId] });
    expect(loadDockerWorkloadLease(first.leasePath)).toMatchObject({
      status: 'incident',
      incident: { code: 'first-failure', detail: 'first runtime was unavailable' },
    });
    expect(loadDockerWorkloadLease(second.leasePath)).toMatchObject({
      status: 'closed',
      incident: { code: 'second-failure', detail: 'second runtime transiently failed' },
    });
  });

  it('reconciles a stale lease before admitting a new bundle', async () => {
    const runtime = createEventRuntime();
    const stale = seedLease({ leaseId: 'dw-stale', heartbeatIso: '2026-07-20T10:00:00.000Z' });
    const handle = await admitDockerWorkloadBundle(
      admissionOptions(runtime, createFakeClock('2026-07-20T12:00:00.000Z')),
    );
    expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('closed');
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
  });

  it('reconciles a stale lease through its recorded runtime after backend selection changes', async () => {
    const recordedRuntime = createEventRuntime({
      containers: [container('recorded-id', 'ic-recorded', 'gen-dw-recorded-runtime')],
    });
    const selectedRuntime = createEventRuntime({
      containers: [{ ...container('foreign-apple-id', 'foreign-apple', 'foreign-generation'), labels: {} }],
    });
    const stale = seedLease({
      leaseId: 'dw-recorded-runtime',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [
        {
          requestId: 'res-recorded',
          kind: 'container',
          role: 'agent',
          name: 'ic-recorded',
          observedId: 'recorded-id',
        },
      ],
      activate: true,
    });
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');

    const result = await reconcileDockerWorkloadLeases({
      runtime: selectedRuntime.runtime,
      runtimeKind: 'apple-container',
      runtimeForKind: (kind) => (kind === 'docker' ? recordedRuntime.runtime : selectedRuntime.runtime),
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => false,
      supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
    });

    expect(result).toEqual({ reconciled: ['dw-recorded-runtime'], preserved: [], fenced: [] });
    expect(recordedRuntime.containers).toHaveLength(0);
    expect(selectedRuntime.containers.map((item) => item.id)).toEqual(['foreign-apple-id']);
    expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('closed');
  });

  it('fences rather than inventorying the wrong runtime when the recorded backend is unavailable', async () => {
    const recordedRuntime = createEventRuntime({
      containers: [container('still-running-id', 'ic-still-running', 'gen-dw-runtime-mismatch')],
    });
    const selectedRuntime = createEventRuntime();
    const stale = seedLease({
      leaseId: 'dw-runtime-mismatch',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [
        {
          requestId: 'res-mismatch',
          kind: 'container',
          role: 'agent',
          name: 'ic-still-running',
          observedId: 'still-running-id',
        },
      ],
      activate: true,
    });
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');

    const result = await reconcileDockerWorkloadLeases({
      runtime: selectedRuntime.runtime,
      runtimeKind: 'apple-container',
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => false,
      supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
    });

    expect(result.fenced).toEqual(['dw-runtime-mismatch']);
    expect(recordedRuntime.containers.map((item) => item.id)).toEqual(['still-running-id']);
    expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('incident');
  });

  it.each(['corrupt', 'symlink'] as const)('fences a %s lease marker and blocks new admission', async (kind) => {
    const leaseId = `dw-unreadable-${kind}`;
    const leaseDir = getDockerWorkloadLeaseDir(leaseId);
    mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    const leasePath = join(leaseDir, 'lease.json');
    if (kind === 'corrupt') {
      writeFileSync(leasePath, '{not-json}\n', { mode: 0o600 });
    } else {
      const target = join(leaseDir, 'foreign.json');
      writeFileSync(target, '{}\n', { mode: 0o600 });
      symlinkSync(target, leasePath);
    }
    const runtime = createEventRuntime();
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');

    const result = await reconcileDockerWorkloadLeases(reconcileOptions(runtime, clock));
    expect(result.fenced).toEqual([leaseId]);
    await expect(admitDockerWorkloadBundle(admissionOptions(runtime, clock))).rejects.toThrow(
      /unresolved leases block/u,
    );
  });

  it('preserves a live lease whose coordinator heartbeat is fresh', async () => {
    const runtime = createEventRuntime({ containers: [container('live-id', 'ic-live', 'gen-dw-live')] });
    const live = seedLease({
      leaseId: 'dw-live',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-live', observedId: 'live-id' },
      ],
      activate: true,
    });
    const clock = createFakeClock('2026-07-20T12:00:05.000Z');
    const result = await reconcileDockerWorkloadLeases({
      ...reconcileOptions(runtime, clock),
      supervisor: createFakeSupervisor({ clock: clock.clock }),
    });
    expect(result).toMatchObject({ preserved: ['dw-live'], reconciled: [], fenced: [] });
    expect(loadDockerWorkloadLease(live.leasePath).status).toBe('active');
    expect(runtime.containers.map((value) => value.id)).toEqual(['live-id']);
  });

  it('deletes only exact generation-owned resources and preserves foreign objects (observed-but-unremoved)', async () => {
    const runtime = createEventRuntime({
      containers: [
        container('owned-id', 'ic-owned', 'gen-dw-observed'),
        container('foreign-id', 'ic-foreign', 'other-generation'),
      ],
    });
    const stale = seedLease({
      leaseId: 'dw-observed',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-owned', observedId: 'owned-id' },
      ],
      activate: true,
    });
    const result = await reconcileDockerWorkloadLeases(
      reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:00.000Z')),
    );
    expect(result.reconciled).toEqual(['dw-observed']);
    expect(runtime.containers.map((value) => value.id)).toEqual(['foreign-id']);
    expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('closed');
  });

  it('recovers the create-before-observe crash window by requested name plus generation label', async () => {
    const runtime = createEventRuntime({ containers: [container('crashed-id', 'ic-crashed', 'gen-dw-unobserved')] });
    const stale = seedLease({
      leaseId: 'dw-unobserved',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [{ requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-crashed' }],
    });
    const result = await reconcileDockerWorkloadLeases(
      reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:00.000Z')),
    );
    expect(result.reconciled).toEqual(['dw-unobserved']);
    expect(runtime.containers).toHaveLength(0);
    const closed = loadDockerWorkloadLease(stale.leasePath);
    expect(closed.status).toBe('closed');
    expect(closed.resources[0]).toMatchObject({ observedId: 'crashed-id' });
  });

  it('fences an ownerless lease while its detached supervisor owns cleanup', async () => {
    const runtime = createEventRuntime({ containers: [container('sup-id', 'ic-sup', 'gen-dw-sup')] });
    const stale = seedLease({
      leaseId: 'dw-sup',
      heartbeatIso: '2026-07-20T09:00:00.000Z', // coordinator heartbeat 3h stale
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-sup', observedId: 'sup-id' },
      ],
      activate: true,
    });
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');
    const claim = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: stale.leasePath });
    try {
      const result = await reconcileDockerWorkloadLeases({
        runtime: runtime.runtime,
        runtimeKind: 'docker',
        clock: clock.clock,
        sleep: clock.sleep,
        pidAlive: () => false,
        supervisor: createFakeSupervisor({ clock: clock.clock }),
      });
      expect(result).toMatchObject({ preserved: [], reconciled: [], fenced: ['dw-sup'] });
      expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('active');
      expect(runtime.containers.map((container) => container.id)).toEqual(['sup-id']);
    } finally {
      claim.release();
    }
  });

  it('fences recent coordinator death long enough for a starting supervisor to publish ownership', async () => {
    const runtime = createEventRuntime();
    const recent = seedLease({
      leaseId: 'dw-starting',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      activate: false,
    });
    const clock = createFakeClock('2026-07-20T12:00:05.000Z');
    const result = await reconcileDockerWorkloadLeases({
      ...reconcileOptions(runtime, clock),
      pidAlive: () => false,
    });
    expect(result).toMatchObject({ preserved: [], reconciled: [], fenced: ['dw-starting'] });
    expect(loadDockerWorkloadLease(recent.leasePath).status).toBe('admitting');
  });

  it('recovers an ownerless lease after its detached supervisor is gone', async () => {
    const runtime = createEventRuntime({ containers: [container('gone-id', 'ic-gone', 'gen-dw-gone')] });
    const stale = seedLease({
      leaseId: 'dw-gone',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-gone', observedId: 'gone-id' },
      ],
      activate: true,
    });
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');
    const result = await reconcileDockerWorkloadLeases({
      runtime: runtime.runtime,
      runtimeKind: 'docker',
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => false,
      supervisor: createFakeSupervisor({ clock: clock.clock, alive: false }),
    });
    expect(result).toMatchObject({ preserved: [], reconciled: ['dw-gone'], fenced: [] });
    expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('closed');
    expect(runtime.containers).toHaveLength(0);
  });

  it('abandons stale recovery when the heartbeat refreshes before cleanup ownership', async () => {
    const runtime = createEventRuntime({ containers: [container('fresh-id', 'ic-fresh', 'gen-dw-refreshed')] });
    const seeded = seedLease({
      leaseId: 'dw-refreshed',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-fresh', observedId: 'fresh-id' },
      ],
      activate: true,
    });
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');
    const result = await reconcileDockerWorkloadLeases({
      ...reconcileOptions(runtime, clock),
      runtimeKind: 'apple-container',
      runtimeForKind: () => {
        heartbeatDockerWorkloadLease(seeded.leasePath, seeded.generation, clock.clock());
        return runtime.runtime;
      },
    });

    expect(result).toEqual({ reconciled: [], preserved: [], fenced: ['dw-refreshed'] });
    expect(loadDockerWorkloadLease(seeded.leasePath).status).toBe('active');
    expect(runtime.containers.map((entry) => entry.id)).toEqual(['fresh-id']);
  });

  it('fails closed (fences) when a supervisor status exists but the rendered policy is unreadable', async () => {
    const runtime = createEventRuntime();
    const seeded = seedLease({ leaseId: 'dw-nopolicy', heartbeatIso: '2026-07-20T09:00:00.000Z' });
    // Delete the rendered policy: recovery must fence rather than reclaiming
    // resources without the exact cleanup target and policy binding.
    rmSync(join(getDockerWorkloadLeaseDir('dw-nopolicy'), 'policy.json'), { force: true });
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');
    const status: ResourceWatchdogSupervisorStatus = {
      schemaVersion: 1,
      leaseId: seeded.leaseId,
      generation: seeded.generation,
      supervisorPid: 555_555,
      state: 'ready',
      policySha256: 'a'.repeat(64),
      policyId: 'docker-workload-observed-state-v1',
      startedAt: clock.clock().toISOString(),
      updatedAt: clock.clock().toISOString(),
      lastSample: { sampledAtMs: clock.clock().getTime(), availableBytes: 1, allocatedBytes: 1 },
      trip: null,
      detail: 'ready',
    };
    // A fresh supervisor cannot turn an ownerless bundle into a live lease.
    const supervisor: WatchdogSupervisorController = {
      ...createFakeSupervisor({ clock: clock.clock }),
      readStatus: () => status,
    };
    const result = await reconcileDockerWorkloadLeases({
      runtime: runtime.runtime,
      runtimeKind: 'docker',
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => false,
      supervisor,
    });
    expect(result.fenced).toEqual(['dw-nopolicy']);
    expect(loadDockerWorkloadLease(seeded.leasePath).status).toBe('incident');
  });

  it('fences a lease whose recovery exceeds the bound, then retries it on the next admission', async () => {
    const runtime = createEventRuntime();
    const stale = seedLease({ leaseId: 'dw-slow', heartbeatIso: '2026-07-20T09:00:00.000Z' });
    const sink = createRecordingDockerWorkloadAuditSink();
    const jumpClock = createFakeClock('2026-07-20T12:00:00.000Z', 130_000);
    const result = await reconcileDockerWorkloadLeases({ ...reconcileOptions(runtime, jumpClock), auditSink: sink });
    expect(result.fenced).toEqual(['dw-slow']);
    expect(result.reconciled).toEqual([]);
    expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('incident');
    expect(
      sink.events.some((event) => event.kind === 'incident' && event.code === 'docker-workload-recovery-fenced'),
    ).toBe(true);
    const original = loadDockerWorkloadLease(stale.leasePath).incident;

    const handle = await admitDockerWorkloadBundle(
      admissionOptions(runtime, createFakeClock('2026-07-20T12:10:00.000Z')),
    );
    expect(loadDockerWorkloadLease(stale.leasePath)).toMatchObject({ status: 'closed', incident: original });
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
  });
});
