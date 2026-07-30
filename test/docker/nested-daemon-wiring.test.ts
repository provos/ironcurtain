/**
 * Same-VM nested Docker daemon wiring (plan §4.4 variant 1, §8.2 steps 4-6).
 *
 * Everything here drives the shipped seams directly with a real bundle handle
 * (admitted through the harness with a fake runtime + fake watchdog supervisor)
 * on a scripted PreContainerInfrastructure — no real VMs, containers, daemons,
 * or supervisor process, and never the admission fuse.
 *
 * The properties under test are the ones that would be silent if they broke:
 * the watchdog gate fires for the create that actually launches the daemon, a
 * rejected daemon aborts and tears down, `DOCKER_HOST` appears only when the
 * feature is on, an ordinary session's container create is unchanged, an
 * unqualified backend fails closed, and the evidence event carries the
 * adjudicated configuration rather than a "some daemon answered" flag.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSessionContainers,
  ledgerOuterResourceCreate,
  type PreContainerInfrastructure,
} from '../../src/docker/docker-infrastructure.js';
import {
  APPLE_VM_DAEMON_READINESS_TIMEOUT_MS,
  nestedDaemonAgentEnv,
  resolveNestedDaemonBundle,
} from '../../src/docker-workload/session-daemon.js';
import { APPLE_VM_DAEMON_DOCKER_HOST } from '../../src/docker-workload/apple-vm-daemon.js';
import {
  PLACEHOLDER_ADMISSION_BINDING_FIELDS,
  placeholderBinding,
  resolveDockerWorkloadAdmissionBindings,
} from '../../src/docker-workload/admission-bindings.js';
import { loadPreloadedImageCatalog } from '../../src/docker/preloaded-image-catalog.js';
import { getFrozenProfileCeilingPath } from '../../src/docker/docker-workload-paths.js';
import { getFrozenCatalogPath } from '../../src/docker/preloaded-catalog-paths.js';
import { sha256Hex } from '../../src/hash.js';
import {
  admitDockerWorkloadBundle,
  type DockerWorkloadBundleHandle,
} from '../../src/docker-workload/infrastructure.js';
import {
  createRecordingDockerWorkloadAuditSink,
  DAEMON_READY_ATTESTATION,
} from '../../src/docker-workload/lifecycle-evidence.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import { getBundleShortId, type BundleId } from '../../src/session/types.js';
import type { ContainerRuntimeKind } from '../../src/docker/container-runtime.js';
import type { ContainerRuntime, DockerContainerConfig } from '../../src/docker/types.js';
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
  QUALIFIED_DOCKER_INFO,
  WATCHDOG_ENTRYPOINT_PATH,
  WATCHDOG_TEMPLATE_PATH,
  createEventRuntime,
  createFakeClock,
  createFakeSupervisor,
  respondHealthyAppleVmDaemon,
  useDockerWorkloadHome,
  type CreateEventRuntimeOptions,
  type EventRuntime,
  type FakeClock,
  type FakeSupervisor,
} from '../docker-workload/helpers/infrastructure-harness.js';

const getHome = useDockerWorkloadHome();
const BUNDLE_ID = 'bundle-nested-daemon-1';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dw-nested-daemon-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

interface Bundle {
  readonly clock: FakeClock;
  readonly runtime: EventRuntime;
  readonly supervisor: FakeSupervisor;
  readonly handle: DockerWorkloadBundleHandle;
  readonly audit: ReturnType<typeof createRecordingDockerWorkloadAuditSink>;
}

async function admitBundle(options?: {
  readonly statusMode?: 'ready' | 'absent';
  readonly exec?: CreateEventRuntimeOptions['exec'];
}): Promise<Bundle> {
  const clock = createFakeClock();
  const runtime = createEventRuntime({ exec: options?.exec });
  const supervisor = createFakeSupervisor({
    clock: clock.clock,
    statusMode: options?.statusMode,
    closeLeaseOnStop: true,
  });
  const audit = createRecordingDockerWorkloadAuditSink();
  const handle = await admitDockerWorkloadBundle({
    runtime: runtime.runtime,
    runtimeKind: 'apple-container',
    bundleId: BUNDLE_ID,
    workspaceRoot: join(getHome(), 'workspace'),
    bindings: ADMISSION_BINDINGS,
    configHash: ADMISSION_CONFIG_HASH,
    watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
    watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
    auditSink: audit,
    clock: clock.clock,
    sleep: clock.sleep,
    pidAlive: () => true,
    supervisor,
    startHeartbeat: false,
  });
  runtime.setLeasePath(handle.leasePath);
  await handle.attestWatchdog();
  return { clock, runtime, supervisor, handle, audit };
}

/** Scripted uds bundle; `dockerWorkload`/`runtimeKind` are what the tests vary. */
function makeCore(
  docker: ContainerRuntime,
  overrides: {
    readonly dockerWorkload?: DockerWorkloadBundleHandle;
    readonly runtimeKind?: ContainerRuntimeKind;
  } = {},
): PreContainerInfrastructure {
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
    runtimeKind: overrides.runtimeKind ?? 'apple-container',
    topology: 'uds',
    useTcp: false,
    socketsDir,
    mitmAddr: { socketPath: '/tmp/test-mitm.sock' },
    authKind: 'apikey',
    setTokenSessionId: () => {},
    restageSkills: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
    dockerWorkload: overrides.dockerWorkload,
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

/** Captures the exact `DockerContainerConfig` the agent create received. */
function capturingRuntime(runtime: EventRuntime): {
  readonly runtime: ContainerRuntime;
  config(): DockerContainerConfig;
} {
  const captured: DockerContainerConfig[] = [];
  const wrapped: ContainerRuntime = {
    ...runtime.runtime,
    async create(config: DockerContainerConfig) {
      captured.push(config);
      return runtime.runtime.create(config);
    },
  };
  return {
    runtime: wrapped,
    config: () => {
      const config = captured.at(0);
      if (config === undefined) throw new Error('no container create was captured');
      return config;
    },
  };
}

function daemonInfoProbes(runtime: EventRuntime): (readonly string[])[] {
  return runtime.execs.filter((argv) => argv.includes('info'));
}

describe('nested daemon — watchdog gate on the daemon-launching create (§8.2 step 4)', () => {
  it('fires for the same-VM agent create and aborts before ledgering when the watchdog is stale', async () => {
    // Absent supervisor status: the agent create is the daemon-component create
    // in this topology, so the gate must reject it.
    const { runtime, handle } = await admitBundle({ statusMode: 'absent' });
    const core = makeCore(runtime.runtime, { dockerWorkload: handle });

    await expect(createSessionContainers(core, makeConfig())).rejects.toThrow(/watchdog supervisor status is missing/u);

    // Rejected BEFORE the ledger append and before any runtime call.
    expect(loadDockerWorkloadLease(handle.leasePath).resources).toHaveLength(0);
    expect(runtime.events).toEqual([]);
    expect(runtime.execs).toEqual([]);
  });

  it('leaves an ordinary (undeclared) agent create ungated', async () => {
    const { runtime, handle } = await admitBundle({ statusMode: 'absent' });

    // Same role, no same-VM declaration: a stale watchdog does not block it.
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

    expect(created.id).toBeTruthy();
  });

  it('starts the daemon only after the watchdog gate and the container start', async () => {
    const { runtime, handle } = await admitBundle();
    const core = makeCore(runtime.runtime, { dockerWorkload: handle });

    const result = await createSessionContainers(core, makeConfig());

    // Ledger -> create -> start (the harness runtime throws if create precedes
    // its ledger append), and the daemon probe happens after the start.
    expect(runtime.events).toEqual([
      `create:${loadDockerWorkloadLease(handle.leasePath).resources[0].requestedName}`,
      `start:${result.containerId}`,
    ]);
    expect(daemonInfoProbes(runtime)).toHaveLength(1);
  });
});

describe('nested daemon — readiness failure is fail-closed (§8.2 step 5)', () => {
  it('aborts the create and removes the partial container when the daemon is unqualified', async () => {
    // A daemon that ANSWERS with the wrong storage driver is rejected on the
    // spot: an overlayfs daemon is an unqualified configuration, not a slow one.
    const { runtime, handle } = await admitBundle({
      exec: (argv) =>
        argv.includes('info')
          ? { exitCode: 0, stdout: JSON.stringify({ ...QUALIFIED_DOCKER_INFO, Driver: 'overlay2' }), stderr: '' }
          : respondHealthyAppleVmDaemon(argv),
    });
    const core = makeCore(runtime.runtime, { dockerWorkload: handle });

    await expect(createSessionContainers(core, makeConfig())).rejects.toThrow(/unqualified storage driver/u);

    // The agent container was created and then torn down by the create's own
    // rollback, so no VM is left running an unadjudicated daemon.
    expect(runtime.containers).toHaveLength(0);
    expect(runtime.events.some((event) => event.startsWith('remove:'))).toBe(true);
  });

  it('rejects a rootful daemon', async () => {
    const { runtime, handle } = await admitBundle({
      exec: (argv) =>
        argv.includes('info')
          ? { exitCode: 0, stdout: JSON.stringify({ ...QUALIFIED_DOCKER_INFO, SecurityOptions: [] }), stderr: '' }
          : respondHealthyAppleVmDaemon(argv),
    });
    const core = makeCore(runtime.runtime, { dockerWorkload: handle });

    await expect(createSessionContainers(core, makeConfig())).rejects.toThrow(/non-rootless daemon/u);
    expect(runtime.containers).toHaveLength(0);
  });

  it('aborts when the bootstrap itself fails, without ever probing readiness', async () => {
    // Fail only the in-VM daemon commands (they all name the daemon's API dir);
    // unrelated container prep such as the apt-proxy write still succeeds.
    const { runtime, handle } = await admitBundle({
      exec: (argv) =>
        argv.some((word) => word.includes('/run/ironcurtain-docker'))
          ? { exitCode: 13, stdout: '', stderr: 'boom' }
          : respondHealthyAppleVmDaemon(argv),
    });
    const core = makeCore(runtime.runtime, { dockerWorkload: handle });

    await expect(createSessionContainers(core, makeConfig())).rejects.toThrow(/apple-vm daemon/u);
    // Bootstrap failures abort before readiness is ever consulted, and the
    // partial container is rolled back.
    expect(daemonInfoProbes(runtime)).toHaveLength(0);
    expect(runtime.containers).toHaveLength(0);
  });
});

describe('nested daemon — DOCKER_HOST reaches the agent only when enabled (§8.2 step 6)', () => {
  it('sets the VM-local socket on the agent container when a bundle is admitted', async () => {
    const { runtime, handle } = await admitBundle();
    const capturing = capturingRuntime(runtime);
    const core = makeCore(capturing.runtime, { dockerWorkload: handle });

    await createSessionContainers(core, makeConfig());

    expect(capturing.config().env.DOCKER_HOST).toBe(APPLE_VM_DAEMON_DOCKER_HOST);
    expect(APPLE_VM_DAEMON_DOCKER_HOST).toBe('unix:///run/ironcurtain-docker/docker.sock');
  });

  it('nestedDaemonAgentEnv contributes nothing without a bundle', () => {
    expect(nestedDaemonAgentEnv(undefined)).toEqual({});
  });
});

describe('nested daemon — feature-off equivalence', () => {
  it('changes nothing but the ledgered name, ownership labels, and DOCKER_HOST', async () => {
    const { runtime: enabledRuntime, handle } = await admitBundle();
    const enabled = capturingRuntime(enabledRuntime);
    await createSessionContainers(makeCore(enabled.runtime, { dockerWorkload: handle }), makeConfig());

    const offRuntime = createEventRuntime();
    const off = capturingRuntime(offRuntime);
    await createSessionContainers(makeCore(off.runtime), makeConfig());

    // Every difference between the two container creates must be one the
    // feature is supposed to introduce; anything else is a feature-off
    // regression on the ordinary session path.
    const differing = Object.keys({ ...enabled.config(), ...off.config() }).filter(
      (key) =>
        JSON.stringify(enabled.config()[key as keyof DockerContainerConfig]) !==
        JSON.stringify(off.config()[key as keyof DockerContainerConfig]),
    );
    expect(differing.sort()).toEqual(['env', 'labels', 'name']);
    expect(Object.keys(off.config().env)).not.toContain('DOCKER_HOST');
    // ...and DOCKER_HOST is the ONLY environment difference.
    const enabledEnvRest = Object.fromEntries(
      Object.entries(enabled.config().env).filter(([key]) => key !== 'DOCKER_HOST'),
    );
    expect(enabledEnvRest).toEqual(off.config().env);
  });

  it('issues no daemon commands and keeps the deterministic container name', async () => {
    const runtime = createEventRuntime();
    const core = makeCore(runtime.runtime);

    const result = await createSessionContainers(core, makeConfig());

    expect(result.containerName).toBe(`ironcurtain-${getBundleShortId(core.bundleId)}`);
    // The create used that deterministic name, not a ledgered random one.
    expect(runtime.events).toEqual([`create:${result.containerName}`, `start:${result.containerId}`]);
    expect(daemonInfoProbes(runtime)).toEqual([]);
  });
});

describe('nested daemon — unqualified backend fails closed', () => {
  it('refuses an admitted bundle on the docker backend instead of skipping the daemon', async () => {
    const { runtime, handle } = await admitBundle();
    const core = makeCore(runtime.runtime, { dockerWorkload: handle, runtimeKind: 'docker' });

    await expect(createSessionContainers(core, makeConfig())).rejects.toThrow(
      /not implementation-qualified on the docker backend/u,
    );
    expect(runtime.events).toEqual([]);
  });

  it('resolveNestedDaemonBundle is inert without a bundle on any backend', () => {
    expect(resolveNestedDaemonBundle(undefined, 'docker')).toBeUndefined();
    expect(resolveNestedDaemonBundle(undefined, 'apple-container')).toBeUndefined();
  });
});

describe('nested daemon — daemon-ready evidence (§8.4)', () => {
  it('records the adjudicated configuration, not merely that a daemon answered', async () => {
    const { runtime, handle, audit } = await admitBundle();
    const core = makeCore(runtime.runtime, { dockerWorkload: handle });

    await createSessionContainers(core, makeConfig());

    const daemonReady = audit.events.filter((event) => event.kind === 'daemon-ready');
    expect(daemonReady).toHaveLength(1);
    expect(daemonReady[0]).toMatchObject({
      kind: 'daemon-ready',
      leaseId: handle.leaseId,
      generation: handle.generation,
      // Stamped by the emitter, not carried by the readiness record: the probe
      // talks to a bundle-local socket, so the evidence must say the values are
      // attested by the bundle rather than observed by the host.
      attestation: DAEMON_READY_ATTESTATION,
      driver: QUALIFIED_DOCKER_INFO.Driver,
      securityOptions: [...QUALIFIED_DOCKER_INFO.SecurityOptions],
      serverVersion: QUALIFIED_DOCKER_INFO.ServerVersion,
    });
  });

  it('emits nothing when the daemon is rejected', async () => {
    const { runtime, handle, audit } = await admitBundle({
      exec: (argv) =>
        argv.includes('info')
          ? { exitCode: 0, stdout: JSON.stringify({ ...QUALIFIED_DOCKER_INFO, Driver: 'overlay2' }), stderr: '' }
          : respondHealthyAppleVmDaemon(argv),
    });

    await expect(
      createSessionContainers(makeCore(runtime.runtime, { dockerWorkload: handle }), makeConfig()),
    ).rejects.toThrow();

    expect(audit.events.some((event) => event.kind === 'daemon-ready')).toBe(false);
  });
});

describe('nested daemon — admission bindings are the real operational inputs', () => {
  it('binds the catalog hash and base-role toolchain digest from the catalog the session will use', () => {
    const catalogPath = getFrozenCatalogPath('apple-container');
    const catalog = loadPreloadedImageCatalog(catalogPath);
    const base = catalog.catalog.images.find((image) => image.logicalName === 'ironcurtain-base:latest');

    const { bindings } = resolveDockerWorkloadAdmissionBindings({ catalogPath, configHash: ADMISSION_CONFIG_HASH });

    expect(bindings.catalogSha256).toBe(sha256Hex(readFileSync(catalogPath)));
    expect(bindings.toolchainDigest).toBe(base?.toolchainDigest);
  });

  it('binds the frozen profile ceiling by its exact bytes', () => {
    const { bindings } = resolveDockerWorkloadAdmissionBindings({
      catalogPath: getFrozenCatalogPath('apple-container'),
      configHash: ADMISSION_CONFIG_HASH,
    });

    expect(bindings.profileSha256).toBe(sha256Hex(readFileSync(getFrozenProfileCeilingPath())));
  });

  it('keeps the performance budget a namespaced placeholder and reports placeholder provenance', () => {
    const { bindings, provenance } = resolveDockerWorkloadAdmissionBindings({
      catalogPath: getFrozenCatalogPath('apple-container'),
      configHash: ADMISSION_CONFIG_HASH,
    });

    expect(PLACEHOLDER_ADMISSION_BINDING_FIELDS).toEqual(['performanceBudgetSha256']);
    expect(bindings.performanceBudgetSha256).toBe(placeholderBinding('performanceBudgetSha256', ADMISSION_CONFIG_HASH));
    // One placeholder makes the whole set a placeholder — a partially real set
    // must never present itself as qualified evidence.
    expect(provenance).toBe('placeholder');
  });

  it('fails closed when the catalog lacks the base role it binds', () => {
    const truncated = join(tempDir, 'catalog-without-base.json');
    const catalog = JSON.parse(readFileSync(getFrozenCatalogPath('apple-container'), 'utf8')) as {
      images: { logicalName: string }[];
    };
    catalog.images = catalog.images.filter((image) => image.logicalName !== 'ironcurtain-base:latest');
    writeFileSync(truncated, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });

    expect(() =>
      resolveDockerWorkloadAdmissionBindings({ catalogPath: truncated, configHash: ADMISSION_CONFIG_HASH }),
    ).toThrow(/missing the ironcurtain-base:latest role/u);
  });
});

describe('nested daemon — readiness ceiling tracks the frozen performance budget', () => {
  it('equals the frozen apple-rootless-vfs arm64 daemonReadinessMs', () => {
    // The budget lives in the test tree (the package does not ship it), so the
    // wiring layer duplicates the value as a constant. This is the guard that
    // keeps the duplicate honest.
    const budget = JSON.parse(
      readFileSync(resolve('test/docker-workload/performance-budget.apple-rootless-vfs-arm64.json'), 'utf8'),
    ) as { maxima: { daemonReadinessMs: number } };

    expect(APPLE_VM_DAEMON_READINESS_TIMEOUT_MS).toBe(budget.maxima.daemonReadinessMs);
  });
});
