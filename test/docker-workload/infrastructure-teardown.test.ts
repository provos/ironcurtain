import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { admitDockerWorkloadBundle } from '../../src/docker-workload/infrastructure.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import type { ProcessLockHandle } from '../../src/docker-workload/process-lock.js';
import { tryAcquireDockerWorkloadLifecycleClaim } from '../../src/docker-workload/cleanup-ownership.js';
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
  await handle.activate();
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
    let alive = true;
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: false });
    supervisor.isAlive = () => alive;
    const sink = createRecordingDockerWorkloadAuditSink();
    const { handle } = await bringUp(clock, runtime, supervisor, sink);
    alive = false;

    const result = await handle.teardown();
    expect(result.supervisorLost).toBe(true);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    const incident = sink.events.find((event) => event.kind === 'incident');
    expect(incident).toMatchObject({ kind: 'incident', code: 'watchdog-supervisor-lost' });
  });

  it('retries teardown through transient lease-lock contention', async () => {
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');
    const contention = {
      lock: undefined as ProcessLockHandle | undefined,
      leasePath: undefined as string | undefined,
      leaseStatusAtRelease: undefined as string | undefined,
    };
    const timing: Timing = {
      clock: () => new Date(currentMs),
      sleep: async (milliseconds: number) => {
        if (contention.lock !== undefined && contention.leasePath !== undefined) {
          contention.leaseStatusAtRelease = loadDockerWorkloadLease(contention.leasePath).status;
          contention.lock.release();
          contention.lock = undefined;
        }
        currentMs += milliseconds;
      },
    };
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: timing.clock, closeLeaseOnStop: true });
    const { handle } = await bringUp(timing, runtime, supervisor);

    contention.leasePath = handle.leasePath;
    contention.lock = holdLeaseLock(handle.leasePath);
    const result = await handle.teardown();
    expect(contention.lock).toBeUndefined();
    // Teardown's first act is a lease mutation, so a lease still `active` at the
    // first sleep proves this sleep is the busy backoff — the live lock really
    // blocked the mutation rather than being reclaimed as a stale record.
    expect(contention.leaseStatusAtRelease).toBe('active');
    expect(result.alreadyClosed).toBe(false);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
  });

  it('uses the serialized teardown when the exact bound supervisor disappears', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const { handle, containerId } = await bringUp(clock, runtime, supervisor);
    supervisor.readStatus = () => undefined;

    await handle.pollSupervisorHealth();

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    expect(runtime.containers.some((container) => container.id === containerId)).toBe(false);
    expect(runtime.events.filter((event) => event === `remove:${containerId}`)).toHaveLength(1);
  });

  it('defers teardown while a watchdog sample owns the lifecycle claim', async () => {
    const baseClock = createFakeClock();
    const timing: Timing = {
      clock: baseClock.clock,
      sleep: async (milliseconds) => {
        baseClock.advance(milliseconds);
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      },
    };
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: timing.clock, closeLeaseOnStop: true });
    const { handle, containerId, requestedName } = await bringUp(timing, runtime, supervisor);
    const sampleClaim = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: handle.leasePath });

    const teardown = handle.teardown();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(runtime.events).toEqual([`create:${requestedName}`]);

    sampleClaim.release();
    await teardown;
    expect(runtime.events.filter((event) => event === `remove:${containerId}`)).toHaveLength(1);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
  });

  it('retries one single-flight heartbeat after a sampling-claim collision', async () => {
    const clock = createFakeClock();
    let sampleClaim: ReturnType<typeof tryAcquireDockerWorkloadLifecycleClaim> | undefined;
    let retrySleeps = 0;
    const timing: Timing = {
      clock: clock.clock,
      sleep: async (milliseconds) => {
        retrySleeps += 1;
        clock.advance(milliseconds);
        sampleClaim?.release();
        sampleClaim = undefined;
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      },
    };
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: timing.clock, closeLeaseOnStop: true });
    const { handle } = await bringUp(timing, runtime, supervisor);
    const before = loadDockerWorkloadLease(handle.leasePath).coordinator.heartbeatAt;
    clock.advance(1_000);
    sampleClaim = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: handle.leasePath });

    const first = handle.refreshCoordinatorHeartbeat();
    const overlapping = handle.refreshCoordinatorHeartbeat();
    expect(overlapping).toBe(first);
    await expect(first).resolves.toBe(true);

    expect(retrySleeps).toBe(1);
    const after = loadDockerWorkloadLease(handle.leasePath).coordinator.heartbeatAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    expect(Date.parse(after) - Date.parse(before)).toBeLessThan(30_000);
  });

  it('fences the lease as incident when exact runtime cleanup fails', async () => {
    const clock = createFakeClock();
    const baseRuntime = createEventRuntime();
    const runtime: EventRuntime = {
      ...baseRuntime,
      runtime: {
        ...baseRuntime.runtime,
        remove: async () => {
          throw new Error('injected exact removal failure');
        },
      },
    };
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const { handle } = await bringUp(clock, runtime, supervisor);

    await expect(handle.teardown()).rejects.toThrow(/injected exact removal failure/u);
    expect(loadDockerWorkloadLease(handle.leasePath)).toMatchObject({
      status: 'incident',
      incident: { code: 'docker-workload-cleanup-failed' },
    });
  });
});
