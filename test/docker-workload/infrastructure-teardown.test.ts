import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { admitDockerWorkloadBundle } from '../../src/docker-workload/infrastructure.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import type { ProcessLockHandle } from '../../src/docker-workload/process-lock.js';
import { tryAcquireDockerWorkloadLifecycleClaim } from '../../src/docker-workload/cleanup-ownership.js';
import type { ResourceWatchdogSupervisorStatus } from '../../src/docker-workload/resource-watchdog-supervisor.js';
import {
  createRecordingDockerWorkloadAuditSink,
  type DockerWorkloadAuditSink,
} from '../../src/docker-workload/lifecycle-evidence.js';
import {
  ADMISSION_CONFIGURATION,
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
  startHeartbeat = false,
) {
  const handle = await admitDockerWorkloadBundle({
    runtime: runtime.runtime,
    runtimeKind: 'docker',
    bundleId: 'bundle-teardown-001',
    workspaceRoot: join(getHome(), 'workspace'),
    configuration: ADMISSION_CONFIGURATION,
    watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
    watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
    auditSink: sink,
    clock: timing.clock,
    sleep: timing.sleep,
    pidAlive: () => true,
    supervisor,
    startHeartbeat,
  });
  runtime.setLeasePath(handle.leasePath);
  await handle.attestWatchdog();
  const requestedName = 'nested-daemon-test';
  const grant = handle.precommitOuterResource({ kind: 'container', role: 'nested-daemon', requestedName });
  const containerId = await runtime.runtime.create({
    name: requestedName,
    image: 'ironcurtain-nested-daemon',
    mounts: [],
    network: 'none',
    env: {},
    command: [],
    labels: grant.labels,
  });
  grant.observed(containerId);
  await handle.activate();
  return { handle, containerId, requestedName };
}

/** Hold publication steady until the simulated sampling owner publishes again. */
function controlPublication(supervisor: FakeSupervisor, leasePath: string, timing: Timing) {
  const readStatus = supervisor.readStatus.bind(supervisor);
  const initial = readStatus(join(dirname(leasePath), 'status.json'));
  if (initial === undefined || initial.lastSample === null) throw new Error('missing test attestation');
  const initialSample = initial.lastSample;
  let published = initial;
  supervisor.readStatus = (path) => {
    const current = readStatus(path);
    return current?.state === 'closed' ? current : published;
  };
  return {
    publish(
      update: (status: ResourceWatchdogSupervisorStatus) => ResourceWatchdogSupervisorStatus = (status) => status,
    ) {
      published = update({
        ...initial,
        updatedAt: timing.clock().toISOString(),
        lastSample: { ...initialSample, sampledAtMs: timing.clock().getTime() },
      });
    },
  };
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

  it('cancels stale cleanup after recovery and refreshes coordinator ownership under the claim', async () => {
    const clock = createFakeClock();
    let releaseSample = (): void => {};
    const timing: Timing = {
      clock: clock.clock,
      sleep: async (milliseconds) => {
        clock.advance(milliseconds);
        publication.publish();
        releaseSample();
      },
    };
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: timing.clock, closeLeaseOnStop: true });
    const sink = createRecordingDockerWorkloadAuditSink();
    const { handle, requestedName } = await bringUp(timing, runtime, supervisor, sink);
    const publication = controlPublication(supervisor, handle.leasePath, timing);
    clock.advance(31_000);
    const sample = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: handle.leasePath });
    releaseSample = () => sample.release();
    const emit = sink.emit.bind(sink);
    sink.emit = (event) => {
      if (event.kind === 'watchdog-health' && event.outcome === 'recovered') {
        expect(() => tryAcquireDockerWorkloadLifecycleClaim({ leasePath: handle.leasePath })).toThrow(/busy/u);
        expect(event.coordinatorHeartbeatAt).toBe(timing.clock().toISOString());
      }
      emit(event);
    };

    const health = handle.pollSupervisorHealth();
    expect(handle.pollSupervisorHealth()).toBe(health);
    await health;

    expect(loadDockerWorkloadLease(handle.leasePath)).toMatchObject({ status: 'active', incident: null });
    expect(sink.events.some((event) => event.kind === 'incident')).toBe(false);
    expect(runtime.events).toEqual([`create:${requestedName}`]);
    expect(sink.events.filter((event) => event.kind === 'watchdog-health').map((event) => event.outcome)).toEqual([
      'stale',
      'recovered',
    ]);
    clock.advance(1_000);
    await expect(handle.refreshCoordinatorHeartbeat()).resolves.toBe(true);
    await handle.pollSupervisorHealth();
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('active');
  });

  it('still revokes a persistently stale supervisor', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const { handle, containerId } = await bringUp(clock, runtime, supervisor);
    controlPublication(supervisor, handle.leasePath, clock);
    clock.advance(31_000);

    await handle.pollSupervisorHealth();

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    expect(runtime.events).toContain(`remove:${containerId}`);
  });

  const unsafeRecoveryCases = [
    {
      label: 'wrong PID',
      transform: (status) => ({ ...status, supervisorPid: status.supervisorPid + 1 }),
    },
    {
      label: 'dead PID',
      transform: (status, { supervisor }) => {
        supervisor.isAlive = () => false;
        return status;
      },
    },
    {
      label: 'wrong generation',
      transform: (status) => ({ ...status, generation: 'wrong-generation' }),
    },
    {
      label: 'wrong policy',
      transform: (status) =>
        status.schemaVersion === 2
          ? { ...status, policy: { ...status.policy, hardSafetyBytes: status.policy.hardSafetyBytes + 1 } }
          : { ...status, policySha256: '0'.repeat(64) },
    },
    {
      label: 'resource trip',
      transform: (status, { now }) => ({
        ...status,
        trip: {
          code: 'hard-state-threshold',
          atMs: now,
          detail: 'test trip',
          overshootBytes: 1,
          overshootWithinFrozenMaximum: true,
        },
      }),
    },
    {
      label: 'stale sample',
      transform: (status, { now }) => ({ ...status, lastSample: { ...status.lastSample!, sampledAtMs: now - 30_000 } }),
    },
    {
      label: 'unchanged sample',
      transform: (status, { initialAt }) => ({
        ...status,
        lastSample: { ...status.lastSample!, sampledAtMs: initialAt },
      }),
    },
    {
      label: 'missing sample',
      transform: (status) => ({ ...status, lastSample: null }),
    },
    {
      label: 'future sample',
      transform: (status, { now }) => ({ ...status, lastSample: { ...status.lastSample!, sampledAtMs: now + 1_000 } }),
    },
  ] satisfies Array<{
    label: string;
    transform: (
      status: ResourceWatchdogSupervisorStatus,
      context: { now: number; initialAt: number; supervisor: FakeSupervisor },
    ) => ResourceWatchdogSupervisorStatus;
  }>;

  it.each(unsafeRecoveryCases)('does not cancel cleanup for a newer publication with $label', async ({ transform }) => {
    const clock = createFakeClock();
    const initialAt = clock.clock().getTime();
    let releaseSample = (): void => {};
    const timing: Timing = {
      clock: clock.clock,
      sleep: async (milliseconds) => {
        clock.advance(milliseconds);
        publication.publish((status) => transform(status, { now: clock.clock().getTime(), initialAt, supervisor }));
        releaseSample();
      },
    };
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: timing.clock, closeLeaseOnStop: true });
    const { handle, containerId } = await bringUp(timing, runtime, supervisor);
    const publication = controlPublication(supervisor, handle.leasePath, timing);
    clock.advance(31_000);
    const sample = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: handle.leasePath });
    releaseSample = () => sample.release();

    await handle.pollSupervisorHealth();

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    expect(runtime.events).toContain(`remove:${containerId}`);
  });

  it('lets explicit teardown win while stale-health cleanup waits for sampling', async () => {
    const clock = createFakeClock();
    const timing: Timing = {
      clock: clock.clock,
      sleep: async (milliseconds) => {
        clock.advance(milliseconds);
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      },
    };
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: timing.clock, closeLeaseOnStop: true });
    const { handle, containerId } = await bringUp(timing, runtime, supervisor);
    const publication = controlPublication(supervisor, handle.leasePath, timing);
    clock.advance(31_000);
    const sample = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: handle.leasePath });

    const health = handle.pollSupervisorHealth();
    const teardown = handle.teardown();
    publication.publish();
    sample.release();
    await Promise.all([health, teardown]);

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    expect(runtime.events.filter((event) => event === `remove:${containerId}`)).toHaveLength(1);
  });

  it('rechecks recovery after lease-lock contention without recording a cleanup incident', async () => {
    const clock = createFakeClock();
    let releaseLease = (): void => {};
    const timing: Timing = {
      clock: clock.clock,
      sleep: async (milliseconds) => {
        clock.advance(milliseconds);
        releaseLease();
      },
    };
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: timing.clock, closeLeaseOnStop: true });
    const { handle, requestedName } = await bringUp(timing, runtime, supervisor);
    const publication = controlPublication(supervisor, handle.leasePath, timing);
    clock.advance(31_000);
    const lock = holdLeaseLock(handle.leasePath);
    let reads = 0;
    const readStatus = supervisor.readStatus.bind(supervisor);
    supervisor.readStatus = (path) => {
      if (++reads > 1) publication.publish();
      return readStatus(path);
    };
    releaseLease = () => lock.release();

    await handle.pollSupervisorHealth();

    expect(reads).toBeGreaterThanOrEqual(3);
    expect(loadDockerWorkloadLease(handle.leasePath)).toMatchObject({ status: 'active', incident: null });
    expect(runtime.events).toEqual([`create:${requestedName}`]);
  });

  it('keeps automatic heartbeats and health monitoring running after recovery', async () => {
    vi.useFakeTimers();
    let handle: Awaited<ReturnType<typeof bringUp>>['handle'] | undefined;
    try {
      const timing: Timing = {
        clock: () => new Date(Date.now()),
        sleep: async (milliseconds) => {
          vi.setSystemTime(Date.now() + milliseconds);
          publication.publish();
          releaseSample();
        },
      };
      let releaseSample = (): void => {};
      const runtime = createEventRuntime();
      const supervisor = createFakeSupervisor({ clock: timing.clock, closeLeaseOnStop: true });
      ({ handle } = await bringUp(timing, runtime, supervisor, undefined, true));
      const publication = controlPublication(supervisor, handle.leasePath, timing);
      vi.setSystemTime(Date.now() + 31_000);
      const sample = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: handle.leasePath });
      releaseSample = () => sample.release();
      await handle.pollSupervisorHealth();
      const recoveredAt = loadDockerWorkloadLease(handle.leasePath).coordinator.heartbeatAt;
      const healthReads = vi.spyOn(supervisor, 'readStatus');

      await vi.advanceTimersByTimeAsync(5_000);

      expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('active');
      expect(loadDockerWorkloadLease(handle.leasePath).coordinator.heartbeatAt).not.toBe(recoveredAt);
      expect(healthReads).toHaveBeenCalled();
    } finally {
      await handle?.teardown();
      vi.useRealTimers();
    }
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
