import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { admitDockerWorkloadBundle } from '../../src/docker-workload/infrastructure.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import {
  createRecordingDockerWorkloadAuditSink,
  type DockerWorkloadAuditSink,
} from '../../src/docker-workload/lifecycle-evidence.js';
import {
  ADMISSION_BINDINGS,
  ADMISSION_CONFIG_HASH,
  WATCHDOG_ENTRYPOINT_PATH,
  WATCHDOG_TEMPLATE_PATH,
  createEventRuntime,
  createFakeClock,
  createFakeSupervisor,
  holdLeaseLock,
  useDockerWorkloadHome,
  type EventRuntime,
  type FakeSupervisor,
} from './helpers/infrastructure-harness.js';

const getHome = useDockerWorkloadHome();

interface Timing {
  clock(): Date;
  sleep(milliseconds: number): Promise<void>;
}

async function bringUp(
  timing: Timing,
  runtime: EventRuntime,
  supervisor: FakeSupervisor,
  sink?: DockerWorkloadAuditSink,
) {
  const handle = await admitDockerWorkloadBundle({
    runtime: runtime.runtime,
    runtimeKind: 'docker',
    bundleId: 'bundle-teardown-001',
    workspaceRoot: join(getHome(), 'workspace'),
    bindings: ADMISSION_BINDINGS,
    configHash: ADMISSION_CONFIG_HASH,
    watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
    watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
    auditSink: sink,
    clock: timing.clock,
    sleep: timing.sleep,
    pidAlive: () => true,
    supervisor,
    startHeartbeat: false,
  });
  runtime.setLeasePath(handle.leasePath);
  await handle.attestWatchdog();
  const grant = handle.requestOuterResource('container', 'nested-daemon');
  const containerId = await runtime.runtime.create({
    name: grant.requestedName,
    image: 'ironcurtain-nested-daemon',
    mounts: [],
    network: 'none',
    env: {},
    command: [],
    labels: grant.labels,
  });
  grant.observed(containerId);
  handle.activate();
  return { handle, containerId, requestedName: grant.requestedName };
}

describe('Docker-workload teardown (§8.3 order)', () => {
  it('runs the frozen order, closes via the supervisor handshake, and is idempotent', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true, alive: true });
    const sink = createRecordingDockerWorkloadAuditSink();
    const { handle, containerId, requestedName } = await bringUp(clock, runtime, supervisor, sink);
    const stateRoot = loadDockerWorkloadLease(handle.leasePath).paths.stateRoot;

    const result = await handle.teardown();
    expect(result.alreadyClosed).toBe(false);
    expect(result.supervisorLost).toBe(false);
    expect(result.revocation?.removedResourceIds).toEqual([containerId]);
    expect(supervisor.calls.stopRequested).toBe(1);
    expect(runtime.events).toEqual([`create:${requestedName}`, `stop:${containerId}`, `remove:${containerId}`]);

    const lease = loadDockerWorkloadLease(handle.leasePath);
    expect(lease.status).toBe('closed');
    expect(lease.cleanup).toMatchObject({ exactOuterResourcesAbsent: true, stateRootAbsent: true });
    expect(existsSync(stateRoot)).toBe(false);

    expect(sink.events.slice(4).map((event) => event.kind)).toEqual([
      'lease-transition',
      'revocation-result',
      'cleanup-proof',
    ]);
    expect(sink.events.some((event) => event.kind === 'incident')).toBe(false);

    const second = await handle.teardown();
    expect(second.alreadyClosed).toBe(true);
  });

  it('falls back to a coordinator close with a watchdog-supervisor-lost incident when the supervisor is gone', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: false, alive: false });
    const sink = createRecordingDockerWorkloadAuditSink();
    const { handle } = await bringUp(clock, runtime, supervisor, sink);

    const result = await handle.teardown();
    expect(result.supervisorLost).toBe(true);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    const incident = sink.events.find((event) => event.kind === 'incident');
    expect(incident).toMatchObject({ kind: 'incident', code: 'watchdog-supervisor-lost' });
  });

  it('retries teardown through transient lease-lock contention', async () => {
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');
    const lock = { path: undefined as string | undefined, released: false };
    const timing: Timing = {
      clock: () => new Date(currentMs),
      sleep: async (milliseconds: number) => {
        if (!lock.released && lock.path !== undefined) {
          rmSync(lock.path, { force: true });
          lock.released = true;
        }
        currentMs += milliseconds;
      },
    };
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: timing.clock, closeLeaseOnStop: true });
    const { handle } = await bringUp(timing, runtime, supervisor);

    lock.path = holdLeaseLock(handle.leasePath);
    const result = await handle.teardown();
    expect(lock.released).toBe(true);
    expect(result.alreadyClosed).toBe(false);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
  });
});
