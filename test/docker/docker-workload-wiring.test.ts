/**
 * Product wiring for the secure nested Docker-workload lifecycle (§8.2–8.3).
 *
 * The admission fuse is bypassed here by driving the shipped seams directly
 * with a real bundle handle (admitted through the test harness with a fake
 * runtime + fake watchdog supervisor) threaded onto a scripted
 * PreContainerInfrastructure — no real proxies, containers, or supervisor
 * process, and never the fuse. Exercised:
 *   - createSessionContainers ledgers the agent container before create and
 *     observes the runtime-returned ID (harness runtime enforces the order).
 *   - the shared same-VM bootstrap activates the lease exactly once before
 *     assembly returns, and assembly tears it down first on a create failure.
 *   - destroyDockerInfrastructure runs teardown first and skips cleanupContainers
 *     for the ledgered resources.
 *   - ledgerOuterResourceCreate proves the watchdog is fresh before a
 *     nested-daemon-role create and leaves an undeclared agent-role create
 *     ungated (the §8.2 step-4 gate by role; the same-VM topology's declared
 *     agent create is covered in nested-daemon-wiring.test.ts).
 *   - dockerWorkloadSessionMetadata carries the lease tuple.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assembleDockerInfrastructure,
  createSessionContainers,
  destroyDockerInfrastructure,
  dockerWorkloadSessionMetadata,
  ledgerOuterResourceCreate,
  type DockerInfrastructure,
  type PreContainerInfrastructure,
} from '../../src/docker/docker-infrastructure.js';
import {
  admitDockerWorkloadBundle,
  type DockerWorkloadBundleHandle,
} from '../../src/docker-workload/infrastructure.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import type { BundleId } from '../../src/session/types.js';
import type { ContainerRuntime } from '../../src/docker/types.js';
import {
  createMockAdapter,
  createMockCA,
  createMockMitmProxy,
  createMockProxy,
  createMockRuntimeTrust,
} from '../helpers/docker-mocks.js';
import {
  ADMISSION_BINDINGS,
  ADMISSION_CONFIG_HASH,
  WATCHDOG_ENTRYPOINT_PATH,
  WATCHDOG_TEMPLATE_PATH,
  createTestAppleVmDockerWorkloadBootstrap,
  createEventRuntime,
  createFakeClock,
  createFakeSupervisor,
  useDockerWorkloadHome,
  type EventRuntime,
  type FakeClock,
  type FakeSupervisor,
} from '../docker-workload/helpers/infrastructure-harness.js';

const getHome = useDockerWorkloadHome();
const BUNDLE_ID = 'bundle-wiring-0001';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dw-wiring-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function admit(
  clock: FakeClock,
  runtime: EventRuntime,
  supervisor: FakeSupervisor,
): Promise<DockerWorkloadBundleHandle> {
  const handle = await admitDockerWorkloadBundle({
    runtime: runtime.runtime,
    // apple-container is the only backend where the nested daemon is implemented, so
    // it is the only backend on which a bundle handle can exist at all.
    runtimeKind: 'apple-container',
    bundleId: BUNDLE_ID,
    workspaceRoot: join(getHome(), 'workspace'),
    bindings: ADMISSION_BINDINGS,
    configHash: ADMISSION_CONFIG_HASH,
    watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
    watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
    clock: clock.clock,
    sleep: clock.sleep,
    pidAlive: () => true,
    supervisor,
    startHeartbeat: false,
  });
  runtime.setLeasePath(handle.leasePath);
  await handle.attestWatchdog();
  return handle;
}

/** Scripted uds/apple-container PreContainerInfrastructure carrying an admitted handle. */
function makeCore(docker: ContainerRuntime, handle: DockerWorkloadBundleHandle): PreContainerInfrastructure {
  const bundleDir = join(tempDir, 'bundle');
  const workspaceDir = join(tempDir, 'workspace');
  const escalationDir = join(tempDir, 'escalations');
  const orientationDir = join(bundleDir, 'orientation');
  const socketsDir = join(bundleDir, 'sockets');
  for (const dir of [bundleDir, workspaceDir, escalationDir, orientationDir, socketsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    bundleId: BUNDLE_ID as BundleId,
    bundleDir,
    workspaceDir,
    escalationDir,
    auditLogPath: join(tempDir, 'audit.jsonl'),
    proxy: createMockProxy(join(socketsDir, 'proxy.sock')),
    mitmProxy: createMockMitmProxy(),
    docker,
    adapter: createMockAdapter(),
    ca: createMockCA(tempDir),
    runtimeTrust: createMockRuntimeTrust(),
    fakeKeys: new Map([['api.test.com', 'sk-test-fake']]),
    orientationDir,
    systemPrompt: 'You are a test agent.',
    image: 'ironcurtain-claude-code:latest',
    runtimeKind: 'apple-container',
    topology: 'uds',
    useTcp: false,
    socketsDir,
    mitmAddr: { socketPath: '/tmp/test-mitm.sock' },
    authKind: 'apikey',
    setTokenSessionId: () => {},
    restageSkills: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
    dockerWorkload: handle,
    dockerWorkloadBootstrap: createTestAppleVmDockerWorkloadBootstrap(tempDir),
  };
}

function makeConfig(): IronCurtainConfig {
  return {
    mcpServers: {},
    userConfig: {
      anthropicApiKey: 'sk-test',
      dockerResources: { memoryMb: null, cpus: null },
      packageInstall: { enabled: false },
    },
  } as unknown as IronCurtainConfig;
}

describe('Docker-workload wiring — createSessionContainers (§8.2 step 1)', () => {
  it('ledgers the agent container before create and observes the runtime ID', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const handle = await admit(clock, runtime, createFakeSupervisor({ clock: clock.clock }));
    const core = makeCore(runtime.runtime, handle);

    const result = await createSessionContainers(core, makeConfig());

    const lease = loadDockerWorkloadLease(handle.leasePath);
    expect(lease.resources).toHaveLength(1);
    expect(lease.resources[0]).toMatchObject({
      kind: 'container',
      role: 'agent',
      observedId: result.containerId,
    });
    // The harness runtime throws if create runs before its ledger append, so
    // reaching here proves ledger-precedes-create; assert the ordered events.
    expect(runtime.events).toEqual([`create:${lease.resources[0].requestedName}`, `start:${result.containerId}`]);
    // The created container carries the precommitted name, not the deterministic one.
    expect(lease.resources[0].requestedName).not.toBe(result.containerName);
  });
});

describe('Docker-workload wiring — assembleDockerInfrastructure (§8.2 / §8.3)', () => {
  it('returns the lease activated by the shared bootstrap after every resource is observed', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const handle = await admit(clock, runtime, createFakeSupervisor({ clock: clock.clock }));
    const core = makeCore(runtime.runtime, handle);

    // Admitting until the shared bootstrap succeeds and activates the lease.
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');

    const infra = await assembleDockerInfrastructure(core, makeConfig());

    expect(infra.containerId).toBeDefined();
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('active');
  });

  it('tears the lease down first on a create failure (teardown supersedes cleanupContainers)', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const handle = await admit(clock, runtime, supervisor);
    // Fail the agent container start after it has been created + observed; the
    // shared closure state means teardown's revoker still sees the container.
    const failingDocker: ContainerRuntime = {
      ...runtime.runtime,
      async start() {
        throw new Error('scripted start failure');
      },
    };
    const core = makeCore(failingDocker, handle);

    await expect(assembleDockerInfrastructure(core, makeConfig())).rejects.toThrow(/scripted start failure/u);

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    expect(supervisor.calls.stopRequested).toBe(1);
  });

  it('refuses activation when the watchdog status disappeared during bootstrap', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const handle = await admit(clock, runtime, createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }));

    await expect(handle.activate()).rejects.toThrow(/watchdog supervisor status is missing/u);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
  });

  it('refuses activation when the watchdog attestation expired during bootstrap', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const baseSupervisor = createFakeSupervisor({ clock: clock.clock });
    let attestedStatus: ReturnType<typeof baseSupervisor.readStatus>;
    const supervisor: FakeSupervisor = {
      ...baseSupervisor,
      async launch(options) {
        const launched = await baseSupervisor.launch(options);
        attestedStatus = launched.status;
        return launched;
      },
      readStatus: () => attestedStatus,
    };
    const handle = await admit(clock, runtime, supervisor);
    clock.advance(handle.loadedPolicy.policy.staleAfterMs);

    await expect(handle.activate()).rejects.toThrow(/watchdog supervisor heartbeat is stale/u);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
  });
});

describe('Docker-workload wiring — destroyDockerInfrastructure (§8.3)', () => {
  it('runs teardown first, then a belt-and-braces cleanupContainers sweep', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const handle = await admit(clock, runtime, supervisor);
    const core = makeCore(runtime.runtime, handle);
    const infra: DockerInfrastructure = await assembleDockerInfrastructure(core, makeConfig());
    const agentId = infra.containerId;

    await destroyDockerInfrastructure(infra);

    // teardown closed the lease and removed the ledgered container; the
    // belt-and-braces cleanupContainers sweep then re-attempts it (a no-op) —
    // assert the lease is closed and the container is gone.
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    expect(runtime.containers.map((container) => container.id)).not.toContain(agentId);
    expect(supervisor.calls.stopRequested).toBe(1);
  });

  it('sweeps the non-ledgered tcp-sidecar sidecar + internal network on destroy', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const handle = await admit(clock, runtime, supervisor);
    const core = makeCore(runtime.runtime, handle);
    const infra: DockerInfrastructure = await assembleDockerInfrastructure(core, makeConfig());

    // The lease only ledgers the agent container. A tcp-sidecar bundle also
    // owns a socat sidecar + internal network that teardown does NOT track;
    // seed them directly (bypassing the ledger) as un-ledgered leftovers.
    runtime.containers.push({
      id: 'sidecar-id',
      name: 'ic-sidecar',
      created: '2026-07-20T12:00:00Z',
      running: true,
      labels: {},
    });
    runtime.networks.push({
      id: 'net-id',
      name: 'ic-internal',
      created: '2026-07-20T12:00:00Z',
      labels: {},
      subnets: [],
      containerIds: [],
    });
    const infraWithSidecar: DockerInfrastructure = {
      ...infra,
      sidecarContainerId: 'sidecar-id',
      internalNetwork: 'net-id',
    };

    await destroyDockerInfrastructure(infraWithSidecar);

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    // Ledgered agent torn down via the lease; non-ledgered sidecar + network
    // swept by the belt-and-braces cleanupContainers.
    expect(runtime.containers.map((container) => container.id)).not.toContain(infra.containerId);
    expect(runtime.containers.map((container) => container.id)).not.toContain('sidecar-id');
    expect(runtime.networks.map((network) => network.id)).not.toContain('net-id');
  });
});

describe('Docker-workload wiring — ledgerOuterResourceCreate watchdog gate (§8.2 step 4)', () => {
  it('proves the watchdog is fresh before a nested-daemon-role create', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const handle = await admit(clock, runtime, createFakeSupervisor({ clock: clock.clock }));

    const created = await ledgerOuterResourceCreate(
      handle,
      { kind: 'container', role: 'nested-daemon' },
      async (name, labels) => ({
        id: await runtime.runtime.create({
          name,
          image: 'nested-daemon',
          mounts: [],
          network: 'none',
          env: {},
          command: [],
          labels,
        }),
      }),
    );

    expect(created.id).toBeTruthy();
    expect(loadDockerWorkloadLease(handle.leasePath).resources[0]).toMatchObject({
      role: 'nested-daemon',
      observedId: created.id,
    });
  });

  it('aborts the nested-daemon-role create — before ledgering — when the watchdog status is missing', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    // attestWatchdog uses launch (still ready); readStatus reports absent so the
    // pre-create freshness assertion fails.
    const handle = await admit(clock, runtime, createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }));

    let createRan = false;
    await expect(
      ledgerOuterResourceCreate(handle, { kind: 'container', role: 'nested-daemon' }, async () => {
        createRan = true;
        return { id: 'unreachable' };
      }),
    ).rejects.toThrow(/watchdog supervisor status is missing/u);

    // The gate fired before the create AND before any ledger append.
    expect(createRan).toBe(false);
    expect(loadDockerWorkloadLease(handle.leasePath).resources).toHaveLength(0);
    expect(runtime.events).toEqual([]);
  });

  it('does NOT gate a non-daemon (agent) role on watchdog freshness', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    // Absent status would trip the nested-daemon gate, but the agent role is
    // not gated, so the create proceeds.
    const handle = await admit(clock, runtime, createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }));

    const created = await ledgerOuterResourceCreate(
      handle,
      { kind: 'container', role: 'agent' },
      async (name, labels) => ({
        id: await runtime.runtime.create({
          name,
          image: 'agent',
          mounts: [],
          network: 'none',
          env: {},
          command: [],
          labels,
        }),
      }),
    );

    expect(loadDockerWorkloadLease(handle.leasePath).resources[0]).toMatchObject({
      role: 'agent',
      observedId: created.id,
    });
  });

  it('does not let teardown prove absence while an outer create is in flight', async () => {
    const baseClock = createFakeClock();
    const clock: FakeClock = {
      ...baseClock,
      sleep: async (milliseconds) => {
        baseClock.advance(milliseconds);
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      },
    };
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const handle = await admit(clock, runtime, supervisor);
    let releaseCreate!: () => void;
    let markCreateEntered!: () => void;
    const createEntered = new Promise<void>((resolvePromise) => {
      markCreateEntered = resolvePromise;
    });
    const createBarrier = new Promise<void>((resolvePromise) => {
      releaseCreate = resolvePromise;
    });

    const creating = ledgerOuterResourceCreate(
      handle,
      { kind: 'container', role: 'nested-daemon' },
      async (name, labels) => {
        markCreateEntered();
        await createBarrier;
        return {
          id: await runtime.runtime.create({
            name,
            image: 'nested-daemon',
            mounts: [],
            network: 'none',
            env: {},
            command: [],
            labels,
          }),
        };
      },
    );
    await createEntered;
    const tearingDown = handle.teardown();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');

    releaseCreate();
    const created = await creating;
    const teardown = await tearingDown;

    expect(teardown.revocation?.removedResourceIds).toEqual([created.id]);
    expect(runtime.events).toEqual(expect.arrayContaining([`stop:${created.id}`, `remove:${created.id}`]));
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
  });

  it('keeps a valid long create live and requires a fresh post-create supervisor sample', async () => {
    vi.useFakeTimers();
    try {
      const startedAtMs = Date.parse('2026-07-20T12:00:00.000Z');
      vi.setSystemTime(startedAtMs);
      let publishFreshSample = false;
      let sampleAtMs = startedAtMs;
      const timing: FakeClock = {
        clock: () => new Date(Date.now()),
        sleep: (milliseconds) =>
          new Promise((resolvePromise) => {
            setTimeout(() => {
              if (publishFreshSample) sampleAtMs = Date.now();
              resolvePromise();
            }, milliseconds);
          }),
        advance: (milliseconds) => vi.setSystemTime(Date.now() + milliseconds),
      };
      const runtime = createEventRuntime();
      const supervisor = createFakeSupervisor({ clock: timing.clock });
      const readStatus = supervisor.readStatus.bind(supervisor);
      supervisor.readStatus = (path) => {
        const status = readStatus(path);
        if (status === undefined || status.lastSample === null) return status;
        return {
          ...status,
          updatedAt: new Date(sampleAtMs).toISOString(),
          lastSample: { ...status.lastSample, sampledAtMs: sampleAtMs },
        };
      };
      const handle = await admit(timing, runtime, supervisor);
      let createReadyToReturn!: () => void;
      const readyToReturn = new Promise<void>((resolvePromise) => {
        createReadyToReturn = resolvePromise;
      });

      const creating = ledgerOuterResourceCreate(
        handle,
        { kind: 'container', role: 'nested-daemon' },
        async (name, labels) => {
          await vi.advanceTimersByTimeAsync(31_000);
          expect(Date.parse(loadDockerWorkloadLease(handle.leasePath).coordinator.heartbeatAt)).toBeGreaterThan(
            startedAtMs,
          );
          await handle.pollSupervisorHealth();
          expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
          publishFreshSample = true;
          createReadyToReturn();
          return {
            id: await runtime.runtime.create({
              name,
              image: 'nested-daemon',
              mounts: [],
              network: 'none',
              env: {},
              command: [],
              labels,
            }),
          };
        },
      );
      await readyToReturn;
      await vi.advanceTimersByTimeAsync(100);
      const created = await creating;

      expect(loadDockerWorkloadLease(handle.leasePath)).toMatchObject({
        status: 'admitting',
        resources: [{ observedId: created.id }],
      });
      expect(sampleAtMs).toBeGreaterThan(startedAtMs);
      expect(supervisor.readStatus(join(dirname(handle.leasePath), 'status.json'))).toMatchObject({
        state: 'ready',
        trip: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Docker-workload wiring — session metadata (§8.4)', () => {
  it('dockerWorkloadSessionMetadata carries the lease tuple', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const handle = await admit(clock, runtime, createFakeSupervisor({ clock: clock.clock }));

    const tuple = dockerWorkloadSessionMetadata(handle, 'a'.repeat(64), 'docker');

    expect(tuple).toEqual({
      leaseId: handle.leaseId,
      generation: handle.generation,
      configHash: 'a'.repeat(64),
      watchdogPolicySha256: handle.loadedPolicy.sha256,
      backend: 'docker',
    });
  });
});
