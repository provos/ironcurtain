import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  admitDockerWorkloadBundle,
  reconcileDockerWorkloadLeases,
  type DockerWorkloadAdmissionOptions,
} from '../../src/docker-workload/infrastructure.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import { createRecordingDockerWorkloadAuditSink } from '../../src/docker-workload/lifecycle-evidence.js';
import {
  ADMISSION_BINDINGS,
  WATCHDOG_ENTRYPOINT_PATH,
  WATCHDOG_TEMPLATE_PATH,
  createEventRuntime,
  createFakeClock,
  createFakeSupervisor,
  useDockerWorkloadHome,
  type EventRuntime,
  type FakeClock,
  type FakeSupervisor,
} from './helpers/infrastructure-harness.js';

const getHome = useDockerWorkloadHome();

function baseOptions(
  clock: FakeClock,
  runtime: EventRuntime,
  supervisor: FakeSupervisor,
  auditSink?: DockerWorkloadAdmissionOptions['auditSink'],
): DockerWorkloadAdmissionOptions {
  return {
    runtime: runtime.runtime,
    runtimeKind: 'docker',
    bundleId: 'bundle-admission-001',
    workspaceRoot: join(getHome(), 'workspace'),
    bindings: ADMISSION_BINDINGS,
    watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
    watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
    auditSink,
    clock: clock.clock,
    sleep: clock.sleep,
    pidAlive: () => true,
    supervisor,
    startHeartbeat: false,
  };
}

describe('Docker-workload admission (§8.2 order)', () => {
  it('ledgers before create, attests the watchdog before the nested-daemon create, and observes before use', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    const sink = createRecordingDockerWorkloadAuditSink();
    const handle = await admitDockerWorkloadBundle(baseOptions(clock, runtime, supervisor, sink));
    runtime.setLeasePath(handle.leasePath);

    const status = await handle.attestWatchdog();
    expect(status.state).toBe('ready');
    handle.assertWatchdogFresh();
    expect(runtime.events).toEqual([]);

    const grant = handle.requestOuterResource('container', 'nested-daemon');
    const ledgered = loadDockerWorkloadLease(handle.leasePath).resources;
    expect(ledgered).toHaveLength(1);
    expect(ledgered[0]).toMatchObject({ requestedName: grant.requestedName, observedId: null });
    expect(runtime.events).toEqual([]);

    const containerId = await runtime.runtime.create({
      name: grant.requestedName,
      image: 'ironcurtain-nested-daemon',
      mounts: [],
      network: 'none',
      env: {},
      command: [],
      labels: grant.labels,
    });
    grant.observed(containerId, { args: ['create', grant.requestedName] });
    expect(loadDockerWorkloadLease(handle.leasePath).resources[0].observedId).toBe(containerId);

    await runtime.runtime.start(containerId);
    handle.activate();
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('active');

    expect(sink.events.map((event) => event.kind)).toEqual([
      'admission-decision',
      'watchdog-attested',
      'outer-create',
      'lease-transition',
    ]);
  });

  it('aborts admission on watchdog attestation failure, leaving a reconcilable lease and no created resources', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, launch: 'throw' });
    const handle = await admitDockerWorkloadBundle(baseOptions(clock, runtime, supervisor));
    runtime.setLeasePath(handle.leasePath);

    await expect(handle.attestWatchdog()).rejects.toThrow(/incident|attestation/u);
    expect(runtime.events).toEqual([]);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');

    const reconcileClock = createFakeClock('2026-07-20T13:00:00.000Z');
    const reconciliation = await reconcileDockerWorkloadLeases({
      runtime: runtime.runtime,
      runtimeKind: 'docker',
      clock: reconcileClock.clock,
      sleep: reconcileClock.sleep,
      pidAlive: () => true,
      supervisor: createFakeSupervisor({ clock: reconcileClock.clock, statusMode: 'absent' }),
    });
    expect(reconciliation.reconciled).toEqual([handle.leaseId]);
    expect(reconciliation.fenced).toEqual([]);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
  });

  it('rejects activation while any requested outer resource is unobserved', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    const handle = await admitDockerWorkloadBundle(baseOptions(clock, runtime, supervisor));
    handle.requestOuterResource('container', 'nested-daemon');
    expect(() => handle.activate()).toThrow(/before every requested outer resource is observed/u);
  });
});
