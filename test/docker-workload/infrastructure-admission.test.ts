import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  admitDockerWorkloadBundle,
  reconcileDockerWorkloadLeases,
  type DockerWorkloadAdmissionOptions,
} from '../../src/docker-workload/infrastructure.js';
import {
  getDockerWorkloadLeaseDir,
  getDockerWorkloadRoot,
  getDockerWorkloadStateRoot,
} from '../../src/config/paths.js';
import { loadDockerWorkloadLease, revokeDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import { tryAcquireDockerWorkloadLifecycleClaim } from '../../src/docker-workload/cleanup-ownership.js';
import { createRecordingDockerWorkloadAuditSink } from '../../src/docker-workload/lifecycle-evidence.js';
import {
  ADMISSION_CONFIG_HASH,
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
    configHash: ADMISSION_CONFIG_HASH,
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
  it('validates the watchdog template before creating lease-specific directories', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    const leaseId = 'dw-invalid-template';

    await expect(
      admitDockerWorkloadBundle({
        ...baseOptions(clock, runtime, supervisor),
        leaseId,
        watchdogPolicyTemplatePath: join(getHome(), 'missing-watchdog-policy.json'),
      }),
    ).rejects.toThrow();

    expect(existsSync(getDockerWorkloadLeaseDir(leaseId))).toBe(false);
    expect(existsSync(getDockerWorkloadStateRoot(leaseId))).toBe(false);
  });

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
    await handle.activate();
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
    await handle.attestWatchdog();
    handle.requestOuterResource('container', 'nested-daemon');
    await expect(handle.activate()).rejects.toThrow(/before every requested outer resource is observed/u);
  });

  it('cannot release the agent when cleanup wins the activation lifecycle claim', async () => {
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');
    let releaseCleanupClaim: (() => void) | undefined;
    const clock: FakeClock = {
      clock: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        currentMs += milliseconds;
        releaseCleanupClaim?.();
        releaseCleanupClaim = undefined;
      },
      advance: (milliseconds) => {
        currentMs += milliseconds;
      },
    };
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const handle = await admitDockerWorkloadBundle(baseOptions(clock, runtime, supervisor));
    runtime.setLeasePath(handle.leasePath);
    await handle.attestWatchdog();
    const grant = handle.requestOuterResource('container', 'nested-daemon');
    const id = await runtime.runtime.create({
      name: grant.requestedName,
      image: 'nested-daemon',
      mounts: [],
      network: 'none',
      env: {},
      command: [],
      labels: grant.labels,
    });
    grant.observed(id);
    const cleanupClaim = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: handle.leasePath });
    releaseCleanupClaim = () => {
      revokeDockerWorkloadLease(handle.leasePath, handle.generation, clock.clock());
      cleanupClaim.release();
    };
    let agentReleased = false;

    await expect(
      (async () => {
        await handle.activate();
        agentReleased = true;
      })(),
    ).rejects.toThrow(/revoking.*activation is rejected/u);

    expect(agentReleased).toBe(false);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('revoking');
    await handle.teardown();
  });
});

describe('Docker-workload admission lock steal race', () => {
  const DEAD_OWNER_PID = 999_001;
  const LIVE_RACER_PID = 999_002;
  const SELF_IDENTITY = 'self-test-process-start';
  const DEAD_IDENTITY = 'dead-test-process-start';
  const LIVE_IDENTITY = 'live-racer-process-start';

  function lockOwner(pid: number, processIdentity: string, token: string) {
    return { schemaVersion: 1, pid, processIdentity, token, createdAtMs: Date.now() } as const;
  }

  function seedAdmissionLock(pid: number, processIdentity: string, token: string): string {
    const root = getDockerWorkloadRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const lockPath = join(root, 'admission.lock');
    writeFileSync(lockPath, `${JSON.stringify(lockOwner(pid, processIdentity, token))}\n`, { mode: 0o600 });
    return lockPath;
  }

  it('reclaims a stale lock whose owner is dead and proceeds with admission', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    seedAdmissionLock(DEAD_OWNER_PID, DEAD_IDENTITY, '00000000-0000-4000-8000-000000000001');

    const handle = await admitDockerWorkloadBundle({
      ...baseOptions(clock, runtime, supervisor),
      processIdentityForPid: (pid) => (pid === process.pid ? SELF_IDENTITY : undefined),
    });

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
  });

  it("does not delete a racer's freshly created live lock during a raced steal (reports busy)", async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    const lockPath = seedAdmissionLock(DEAD_OWNER_PID, DEAD_IDENTITY, '00000000-0000-4000-8000-000000000002');

    // The moment we test the dead owner's liveness, a racer reclaims the stale
    // lock and installs its own LIVE lock. The reclaim must detect this and
    // leave the racer's lock intact rather than stealing it.
    let collided = false;
    const processIdentityForPid = (pid: number): string | undefined => {
      if (pid === process.pid) return SELF_IDENTITY;
      if (pid === DEAD_OWNER_PID) {
        if (!collided) {
          collided = true;
          writeFileSync(
            lockPath,
            `${JSON.stringify(lockOwner(LIVE_RACER_PID, LIVE_IDENTITY, '00000000-0000-4000-8000-000000000003'))}\n`,
            { mode: 0o600 },
          );
        }
        return undefined;
      }
      return pid === LIVE_RACER_PID ? LIVE_IDENTITY : undefined;
    };

    await expect(
      admitDockerWorkloadBundle({ ...baseOptions(clock, runtime, supervisor), processIdentityForPid }),
    ).rejects.toThrow(/is busy/u);

    // The racer's live lock survived — it was never stolen or deleted.
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: LIVE_RACER_PID });
  });
});
