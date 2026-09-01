/**
 * Product wiring for the secure nested Docker-workload lifecycle (§8.2–8.3).
 *
 * The test drives the shipped seams directly with a real bundle handle
 * (admitted through the test harness with a fake
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
  buildDockerDesktopTransportCreateLimits,
  buildNestedDockerAgentTrustedCreateOptions,
  buildDockerWorkloadEgressMounts,
  createLedgeredAgentContainer,
  createSessionContainers,
  destroyDockerInfrastructure,
  dockerWorkloadSessionMetadata,
  ensureDockerDesktopSidecarImage,
  ledgerOuterResourceCreate,
  selectDockerDesktopResourcePartition,
  selectOuterContainerResources,
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
  APPLE_VM_DAEMON_PACKAGE_EGRESS_START_ARGV,
  APPLE_VM_PACKAGE_EGRESS_PROXY_URL,
  APPLE_VM_REGISTRY_EGRESS_PROXY_URL,
} from '../../src/docker-workload/apple-vm-daemon.js';
import { DESKTOP_RELAY_PROFILE } from '../../src/docker-workload/desktop-relay.js';
import {
  DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
  DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
  DOCKER_BUILD_TRUST_CA_CERT_PATH,
  getDockerBuildShimStagingContract,
} from '../../src/docker/docker-build-shim.js';
import {
  createMockAdapter,
  createMockCA,
  createMockMitmProxy,
  createMockProxy,
  createMockRuntimeTrust,
} from '../helpers/docker-mocks.js';
import {
  ADMISSION_CONFIG_HASH,
  WATCHDOG_ENTRYPOINT_PATH,
  WATCHDOG_TEMPLATE_PATH,
  createTestAppleVmDockerWorkloadBootstrap,
  createEventRuntime,
  createFakeClock,
  createFakeSupervisor,
  respondHealthyAppleVmDaemon,
  useDockerWorkloadHome,
  type EventRuntime,
  type FakeClock,
  type FakeSupervisor,
} from '../docker-workload/helpers/infrastructure-harness.js';

const getHome = useDockerWorkloadHome();
const BUNDLE_ID = 'bundle-wiring-0001';
const TEST_APPLE_IMAGE_ID = `sha256:${'a'.repeat(64)}`;

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
  docker.getImageId = async () => TEST_APPLE_IMAGE_ID;
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
    imageResolution: {
      mode: 'selected-agent-artifact',
      logicalName: 'ironcurtain-claude-code:latest',
      imageRef: 'ironcurtain-claude-code:latest',
      immutableImageId: TEST_APPLE_IMAGE_ID,
      buildHash: '1'.repeat(64),
      artifact: {
        logicalName: 'ironcurtain-claude-code:latest',
        buildHash: '1'.repeat(64),
        architecture: 'arm64',
        appleImageId: TEST_APPLE_IMAGE_ID,
        dockerImageId: `sha256:${'3'.repeat(64)}`,
        manifestDigest: `sha256:${'4'.repeat(64)}`,
        archivePath: join(tempDir, 'agent.tar'),
        archiveSha256: '7'.repeat(64),
        archiveSizeBytes: 1024,
      },
    },
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

function packageBuildShim(): NonNullable<PreContainerInfrastructure['dockerBuildShim']> {
  const contract = getDockerBuildShimStagingContract(
    'packages',
    APPLE_VM_PACKAGE_EGRESS_PROXY_URL,
    APPLE_VM_REGISTRY_EGRESS_PROXY_URL,
  )!;
  return {
    contract,
    artifacts: [
      {
        kind: 'docker-shim',
        source: '/tmp/package-build/docker',
        target: contract.shimArtifact.targetPath,
        readonly: true,
      },
      {
        kind: 'proxy-config',
        source: '/tmp/package-build/client',
        target: dirname(contract.proxyConfigArtifact.targetPath),
        readonly: true,
      },
      {
        kind: 'build-trust-wrapper',
        source: '/tmp/package-build/runc',
        target: contract.buildTrustWrapperArtifact.targetPath,
        readonly: true,
      },
      {
        kind: 'build-trust-contract',
        source: '/tmp/package-build/build-trust-contract.json',
        target: contract.buildTrustContractArtifact.targetPath,
        readonly: true,
      },
      {
        kind: 'build-trust-ca-cert',
        source: '/tmp/package-build/ca-cert.pem',
        target: DOCKER_BUILD_TRUST_CA_CERT_PATH,
        readonly: true,
      },
      {
        kind: 'build-trust-ca-bundle',
        source: '/tmp/package-build/ca-bundle.pem',
        target: DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
        readonly: true,
      },
      {
        kind: 'build-trust-apt-config',
        source: '/tmp/package-build/apt.conf',
        target: DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
        readonly: true,
      },
    ],
    buildTrustCanary: {
      caGeneration: 'gen-00000000-0000-4000-8000-000000000000',
      buildTrustContractSha256: '4'.repeat(64),
      caCertificateSha256: '1'.repeat(64),
      caBundleSha256: '2'.repeat(64),
      aptConfigSha256: '3'.repeat(64),
    },
  };
}

const registrySnapshot = () => ({ attempts: 0, totalBytes: 0, activeRequests: 0 });
const packageSnapshot = () => ({
  attempts: 0,
  clientAttempts: 0,
  activeClients: 0,
  activeDirect: 0,
  activeUpstreams: 0,
  transferredBytes: 0,
  rateTokens: 120,
  stopped: false,
});

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
      requestedName: result.containerName,
      observedId: result.containerId,
    });
    // The harness runtime throws if create runs before its ledger append, so
    // reaching here proves ledger-precedes-create; assert the ordered events.
    expect(runtime.events).toEqual([`create:${lease.resources[0].requestedName}`, `start:${result.containerId}`]);
    // Service discovery and cleanup share one caller-selected identity.
    expect(lease.resources[0].requestedName).toBe(result.containerName);
  });

  it('observes the stopped Apple VM before accepting its prepared image descriptor', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const handle = await admit(clock, runtime, createFakeSupervisor({ clock: clock.clock }));
    const expectedImageId = `sha256:${'a'.repeat(64)}`;
    let observedBeforeInspect = false;
    runtime.runtime.getImageId = async (containerId) => {
      observedBeforeInspect = loadDockerWorkloadLease(handle.leasePath).resources[0]?.observedId === containerId;
      return expectedImageId.slice('sha256:'.length);
    };

    const containerId = await createLedgeredAgentContainer({
      dockerWorkload: handle,
      runtimeKind: 'apple-container',
      runtime: runtime.runtime,
      expectedImageId,
      requestedName: 'apple-agent',
      baseLabels: undefined,
      mounts: [],
      create: (name, labels) =>
        runtime.runtime.create({
          image: 'selected-logical:latest',
          name,
          mounts: [],
          network: 'none',
          env: {},
          command: [],
          labels,
        }),
    });

    expect(observedBeforeInspect).toBe(true);
    expect(runtime.events).toEqual([expect.stringMatching(/^create:/u)]);
    expect(loadDockerWorkloadLease(handle.leasePath).resources[0]?.observedId).toBe(containerId);
  });

  it('rejects an admitted Apple create when its prepared immutable image ID is missing', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const handle = await admit(clock, runtime, createFakeSupervisor({ clock: clock.clock }));

    await expect(
      createLedgeredAgentContainer({
        dockerWorkload: handle,
        runtimeKind: 'apple-container',
        runtime: runtime.runtime,
        requestedName: 'apple-agent',
        baseLabels: undefined,
        mounts: [],
        create: (name, labels) =>
          runtime.runtime.create({
            image: 'selected-logical:latest',
            name,
            mounts: [],
            network: 'none',
            env: {},
            command: [],
            labels,
          }),
      }),
    ).rejects.toThrow(/missing its prepared immutable image ID/u);

    expect(runtime.events).toEqual([]);
    expect(loadDockerWorkloadLease(handle.leasePath).resources).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['mismatched', `sha256:${'b'.repeat(64)}`],
  ] as const)('removes a stopped Apple VM with a %s image descriptor and never starts it', async (_case, actual) => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const handle = await admit(clock, runtime, createFakeSupervisor({ clock: clock.clock }));
    runtime.runtime.getImageId = async () => actual;

    await expect(
      createLedgeredAgentContainer({
        dockerWorkload: handle,
        runtimeKind: 'apple-container',
        runtime: runtime.runtime,
        expectedImageId: `sha256:${'a'.repeat(64)}`,
        requestedName: 'apple-agent',
        baseLabels: undefined,
        mounts: [],
        create: (name, labels) =>
          runtime.runtime.create({
            image: 'selected-logical:latest',
            name,
            mounts: [],
            network: 'none',
            env: {},
            command: [],
            labels,
          }),
      }),
    ).rejects.toThrow(/Apple stopped-create image mismatch/u);

    const resource = loadDockerWorkloadLease(handle.leasePath).resources[0];
    expect(resource.observedId).toBe('container-id-1');
    expect(runtime.events).toEqual([expect.stringMatching(/^create:/u), 'remove:container-id-1']);
    expect(runtime.events.some((event) => event.startsWith('start:'))).toBe(false);
    expect(runtime.containers).toHaveLength(0);
  });

  it('keeps Docker on its immutable create ID without an Apple descriptor check', async () => {
    const runtime = createEventRuntime();
    let inspected = false;
    runtime.runtime.getImageId = async () => {
      inspected = true;
      return undefined;
    };
    const immutableImageId = `sha256:${'a'.repeat(64)}`;
    let createImage: string | undefined;

    const containerId = await createLedgeredAgentContainer({
      dockerWorkload: undefined,
      runtimeKind: 'docker',
      runtime: runtime.runtime,
      expectedImageId: immutableImageId,
      requestedName: 'docker-agent',
      baseLabels: undefined,
      mounts: [],
      create: () => {
        createImage = immutableImageId;
        return Promise.resolve('docker-container-id');
      },
    });

    expect(containerId).toBe('docker-container-id');
    expect(createImage).toBe(immutableImageId);
    expect(inspected).toBe(false);
  });
});

describe('Docker-workload wiring — assembleDockerInfrastructure (§8.2 / §8.3)', () => {
  it('does not turn Docker Desktop TCP egress endpoints into agent bind mounts', () => {
    const stop = async (): Promise<void> => {};
    expect(
      buildDockerWorkloadEgressMounts({
        runtimeKind: 'docker',
        dockerWorkloadEgress: {
          networkAccess: 'packages',
          registry: { listener: { stop }, port: 31_081, snapshot: registrySnapshot },
          packages: { listener: { stop }, port: 31_082, snapshot: packageSnapshot },
        },
      }),
    ).toEqual([]);
  });

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
    const packageStop = vi.fn(async () => void runtime.events.push('stop:package'));
    const registryStop = vi.fn(async () => void runtime.events.push('stop:registry'));
    const core = {
      ...makeCore(failingDocker, handle),
      dockerWorkloadEgress: {
        networkAccess: 'packages' as const,
        registry: { listener: { stop: registryStop }, socketPath: '/tmp/registry.sock', snapshot: registrySnapshot },
        packages: { listener: { stop: packageStop }, socketPath: '/tmp/package.sock', snapshot: packageSnapshot },
      },
      dockerBuildShim: packageBuildShim(),
    };

    await expect(assembleDockerInfrastructure(core, makeConfig())).rejects.toThrow(/scripted start failure/u);

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    expect(supervisor.calls.stopRequested).toBe(1);
    expect(packageStop).toHaveBeenCalledOnce();
    expect(registryStop).toHaveBeenCalledOnce();
    const firstRemove = runtime.events.findIndex((event) => event.startsWith('remove:'));
    expect(runtime.events.indexOf('stop:package')).toBeLessThan(firstRemove);
    expect(runtime.events.indexOf('stop:registry')).toBeLessThan(firstRemove);
  });

  it('revokes both listeners when stale-container removal rejects before any VM exists', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const handle = await admit(clock, runtime, supervisor);
    const staleRemovalFailure: ContainerRuntime = {
      ...runtime.runtime,
      async removeStaleContainer() {
        runtime.events.push('remove-stale:rejected');
        throw new Error('scripted stale removal failure');
      },
    };
    const packageStop = vi.fn(async () => void runtime.events.push('stop:package'));
    const registryStop = vi.fn(async () => void runtime.events.push('stop:registry'));
    const core: PreContainerInfrastructure = {
      ...makeCore(staleRemovalFailure, handle),
      dockerWorkloadEgress: {
        networkAccess: 'packages',
        registry: { listener: { stop: registryStop }, socketPath: '/tmp/registry.sock', snapshot: registrySnapshot },
        packages: { listener: { stop: packageStop }, socketPath: '/tmp/package.sock', snapshot: packageSnapshot },
      },
      dockerBuildShim: packageBuildShim(),
    };

    await expect(assembleDockerInfrastructure(core, makeConfig())).rejects.toThrow(/scripted stale removal failure/u);

    expect(packageStop).toHaveBeenCalledOnce();
    expect(registryStop).toHaveBeenCalledOnce();
    expect(runtime.events.indexOf('stop:package')).toBeGreaterThan(runtime.events.indexOf('remove-stale:rejected'));
    expect(runtime.events.indexOf('stop:registry')).toBeGreaterThan(runtime.events.indexOf('remove-stale:rejected'));
    expect(runtime.events.filter((event) => event.startsWith('remove:'))).toEqual([]);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
  });

  it('stops both listeners and closes the lease when the package mount create fails', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const handle = await admit(clock, runtime, supervisor);
    const packageStop = vi.fn(async () => {});
    const registryStop = vi.fn(async () => {});
    const mountFailingRuntime: ContainerRuntime = {
      ...runtime.runtime,
      async create(config) {
        expect(config.mounts).toContainEqual(
          expect.objectContaining({ target: '/tmp/ironcurtain-package-egress.sock' }),
        );
        throw new Error('scripted package mount failure');
      },
    };
    const core: PreContainerInfrastructure = {
      ...makeCore(mountFailingRuntime, handle),
      dockerWorkloadEgress: {
        networkAccess: 'packages',
        registry: { listener: { stop: registryStop }, socketPath: '/tmp/registry.sock', snapshot: registrySnapshot },
        packages: { listener: { stop: packageStop }, socketPath: '/tmp/package.sock', snapshot: packageSnapshot },
      },
      dockerBuildShim: packageBuildShim(),
    };

    await expect(assembleDockerInfrastructure(core, makeConfig())).rejects.toThrow(/scripted package mount failure/u);

    expect(packageStop).toHaveBeenCalledOnce();
    expect(registryStop).toHaveBeenCalledOnce();
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
  });

  it('stops both listeners and closes the lease when package relay health fails', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime({
      exec: (argv) =>
        JSON.stringify(argv) === JSON.stringify(APPLE_VM_DAEMON_PACKAGE_EGRESS_START_ARGV)
          ? { exitCode: 1, stdout: '', stderr: 'package relay health failed' }
          : respondHealthyAppleVmDaemon(argv),
    });
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const handle = await admit(clock, runtime, supervisor);
    const packageStop = vi.fn(async () => {});
    const registryStop = vi.fn(async () => {});
    const core: PreContainerInfrastructure = {
      ...makeCore(runtime.runtime, handle),
      dockerWorkloadEgress: {
        networkAccess: 'packages',
        registry: { listener: { stop: registryStop }, socketPath: '/tmp/registry.sock', snapshot: registrySnapshot },
        packages: { listener: { stop: packageStop }, socketPath: '/tmp/package.sock', snapshot: packageSnapshot },
      },
      dockerBuildShim: packageBuildShim(),
    };

    await expect(assembleDockerInfrastructure(core, makeConfig())).rejects.toThrow(/apple-vm daemon start/u);

    expect(packageStop).toHaveBeenCalledOnce();
    expect(registryStop).toHaveBeenCalledOnce();
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    expect(runtime.containers).toEqual([]);
  });

  it('refuses activation when the watchdog status disappeared during bootstrap', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const handle = await admit(clock, runtime, createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }));

    await expect(handle.activate()).rejects.toThrow(/watchdog supervisor status is missing/u);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
  });

  it('stops both listeners and closes the lease when activation fails', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const handle = await admit(
      clock,
      runtime,
      createFakeSupervisor({ clock: clock.clock, statusMode: 'absent', closeLeaseOnStop: true }),
    );
    const packageStop = vi.fn(async () => {});
    const registryStop = vi.fn(async () => {});
    const core: PreContainerInfrastructure = {
      ...makeCore(runtime.runtime, handle),
      dockerWorkloadEgress: {
        networkAccess: 'packages',
        registry: { listener: { stop: registryStop }, socketPath: '/tmp/registry.sock', snapshot: registrySnapshot },
        packages: { listener: { stop: packageStop }, socketPath: '/tmp/package.sock', snapshot: packageSnapshot },
      },
      dockerBuildShim: packageBuildShim(),
    };

    await expect(assembleDockerInfrastructure(core, makeConfig())).rejects.toThrow(
      /watchdog supervisor status is missing/u,
    );

    expect(packageStop).toHaveBeenCalledOnce();
    expect(registryStop).toHaveBeenCalledOnce();
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
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

  it('revokes package and registry authorities before removing the outer VM', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const handle = await admit(clock, runtime, supervisor);
    const core = makeCore(runtime.runtime, handle);
    const infra: DockerInfrastructure = await assembleDockerInfrastructure(core, makeConfig());
    const teardownOrder: string[] = [];
    const originalRemove = runtime.runtime.remove.bind(runtime.runtime);
    runtime.runtime.remove = async (containerId) => {
      teardownOrder.push(`remove:${containerId}`);
      await originalRemove(containerId);
    };

    await destroyDockerInfrastructure({
      ...infra,
      dockerWorkloadEgress: {
        networkAccess: 'packages',
        registry: {
          listener: { stop: async () => void teardownOrder.push('stop:registry') },
          socketPath: '/tmp/registry.sock',
          snapshot: registrySnapshot,
        },
        packages: {
          listener: { stop: async () => void teardownOrder.push('stop:package') },
          socketPath: '/tmp/package.sock',
          snapshot: packageSnapshot,
        },
      },
    });

    const firstRemove = teardownOrder.findIndex((event) => event.startsWith('remove:'));
    expect(firstRemove).toBeGreaterThanOrEqual(0);
    expect(teardownOrder.indexOf('stop:package')).toBeLessThan(firstRemove);
    expect(teardownOrder.indexOf('stop:registry')).toBeLessThan(firstRemove);
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
      { kind: 'container', role: 'nested-daemon', requestedName: 'nested-daemon-test' },
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
      ledgerOuterResourceCreate(
        handle,
        { kind: 'container', role: 'nested-daemon', requestedName: 'nested-daemon-test' },
        async () => {
          createRan = true;
          return { id: 'unreachable' };
        },
      ),
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
      { kind: 'container', role: 'agent', requestedName: 'agent-test' },
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
      { kind: 'container', role: 'nested-daemon', requestedName: 'nested-daemon-test' },
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
        { kind: 'container', role: 'nested-daemon', requestedName: 'nested-daemon-test' },
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

describe('Docker-workload wiring — outer resource envelope', () => {
  it('uses admitted workload CPU/memory instead of divergent ordinary defaults', () => {
    const resources = selectOuterContainerResources(
      {
        dockerResources: { memoryMb: 7777, cpus: 7 },
        dockerWorkload: {
          enabled: true,
          networkAccess: 'offline',
          acceptObservedDiskRisk: true,
          resources: { memoryMb: 1536, cpus: 1.25, pids: { desired: 512, required: false }, diskMb: null },
        },
      },
      { cpus: 8, memoryMb: 16_384 },
    );

    expect(resources).toEqual({ memoryMb: 1536, cpus: 1.25 });
  });

  it('preserves dockerResources exactly when the capability is disabled', () => {
    expect(
      selectOuterContainerResources(
        {
          dockerResources: { memoryMb: 2048, cpus: 1.5 },
          dockerWorkload: { enabled: false },
        },
        { cpus: 8, memoryMb: 16_384 },
      ),
    ).toEqual({ memoryMb: 2048, cpus: 1.5 });
  });

  const relayMemoryMb = DESKTOP_RELAY_PROFILE.memoryBytes / (1024 * 1024);
  const relayCpus = DESKTOP_RELAY_PROFILE.nanoCpus / 1_000_000_000;

  it.each([
    { networkAccess: 'offline', relayCount: 0, sidecarPids: 352, agentMemoryMb: 960, agentCpus: 0.75 },
    { networkAccess: 'images', relayCount: 1, sidecarPids: 320, agentMemoryMb: 896, agentCpus: 0.5 },
    { networkAccess: 'packages', relayCount: 2, sidecarPids: 288, agentMemoryMb: 832, agentCpus: 0.25 },
  ] as const)(
    'partitions the Docker Desktop $networkAccess aggregate across every outer container',
    ({ networkAccess, relayCount, sidecarPids, agentMemoryMb, agentCpus }) => {
      const partition = selectDockerDesktopResourcePartition(
        {
          dockerResources: { memoryMb: 7777, cpus: 7 },
          dockerWorkload: {
            enabled: true,
            networkAccess,
            acceptObservedDiskRisk: true,
            resources: { memoryMb: 1536, cpus: 1.25, pids: { desired: 512, required: false }, diskMb: null },
          },
        },
        { cpus: 8, memoryMb: 16_384 },
      );

      expect(partition).toEqual({
        sidecar: { memoryMb: 512, cpus: 0.25, pidsLimit: sidecarPids },
        transport: { memoryMb: relayMemoryMb, cpus: relayCpus, pidsLimit: DESKTOP_RELAY_PROFILE.pidsLimit },
        agent: { memoryMb: agentMemoryMb, cpus: agentCpus, pidsLimit: 128 },
      });
      expect(
        partition.sidecar.memoryMb +
          partition.transport.memoryMb +
          (partition.agent.memoryMb ?? 0) +
          relayCount * relayMemoryMb,
      ).toBe(1536);
      expect(
        partition.sidecar.cpus + partition.transport.cpus + (partition.agent.cpus ?? 0) + relayCount * relayCpus,
      ).toBe(1.25);
      expect(
        partition.sidecar.pidsLimit +
          partition.transport.pidsLimit +
          partition.agent.pidsLimit +
          relayCount * DESKTOP_RELAY_PROFILE.pidsLimit,
      ).toBe(512);
      expect(buildDockerDesktopTransportCreateLimits(partition)).toEqual({
        resources: { memoryMb: relayMemoryMb, cpus: relayCpus },
        trustedCreateOptions: { pidsLimit: DESKTOP_RELAY_PROFILE.pidsLimit },
      });
      expect(
        buildNestedDockerAgentTrustedCreateOptions(
          [{ name: 'daemon-api', target: '/run/ironcurtain-docker', readonly: true, noCopy: true }],
          partition,
        ),
      ).toEqual({
        namedVolumeMounts: [{ name: 'daemon-api', target: '/run/ironcurtain-docker', readonly: true, noCopy: true }],
        pidsLimit: 128,
      });
    },
  );

  it.each([
    { networkAccess: 'offline', minimumMemoryMb: 1088, minimumCpus: 0.75 },
    { networkAccess: 'images', minimumMemoryMb: 1152, minimumCpus: 1 },
    { networkAccess: 'packages', minimumMemoryMb: 1216, minimumCpus: 1.25 },
  ] as const)('fails a $networkAccess aggregate that cannot cover every reserve', (minimum) => {
    expect(() =>
      selectDockerDesktopResourcePartition(
        {
          dockerResources: { memoryMb: 7777, cpus: 7 },
          dockerWorkload: {
            enabled: true,
            networkAccess: minimum.networkAccess,
            acceptObservedDiskRisk: true,
            resources: {
              memoryMb: minimum.minimumMemoryMb - 1,
              cpus: minimum.minimumCpus - 0.01,
              pids: { desired: 512, required: false },
              diskMb: null,
            },
          },
        },
        { cpus: 8, memoryMb: 16_384 },
      ),
    ).toThrow(
      `Docker Desktop nested Docker ${minimum.networkAccess} mode requires at least ${minimum.minimumMemoryMb} MiB and ${minimum.minimumCpus} CPU`,
    );
  });

  it('builds the purpose-built Desktop daemon once and reuses its hash-labeled image', async () => {
    let storedHash: string | undefined;
    const buildImage = vi.fn(
      async (_tag: string, _dockerfile: string, _context: string, labels?: Record<string, string>) => {
        storedHash = labels?.['ironcurtain.build-hash'];
      },
    );
    const runtime = {
      getImageLabel: vi.fn(async () => storedHash),
      buildImage,
    } as unknown as ContainerRuntime;

    await expect(ensureDockerDesktopSidecarImage(runtime)).resolves.toBe('ironcurtain-nested-daemon:latest');
    await expect(ensureDockerDesktopSidecarImage(runtime)).resolves.toBe('ironcurtain-nested-daemon:latest');

    expect(buildImage).toHaveBeenCalledOnce();
    expect(buildImage.mock.calls[0]?.[1]).toMatch(/docker\/nested-daemon\/Dockerfile$/u);
    expect(buildImage.mock.calls[0]?.[2]).toMatch(/docker\/nested-daemon$/u);
    expect(storedHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});
