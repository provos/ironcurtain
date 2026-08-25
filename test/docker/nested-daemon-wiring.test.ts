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
 * unimplemented backend fails closed, and the evidence event carries the
 * adjudicated configuration rather than a "some daemon answered" flag.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionContainers,
  ledgerOuterResourceCreate,
  stopDockerWorkloadEgress,
  type PreContainerInfrastructure,
} from '../../src/docker/docker-infrastructure.js';
import { nestedDaemonAgentEnv, resolveNestedDaemonBundle } from '../../src/docker-workload/session-daemon.js';
import {
  APPLE_VM_DAEMON_DOCKER_HOST,
  APPLE_VM_DAEMON_PACKAGE_EGRESS_START_ARGV,
  APPLE_VM_DAEMON_REGISTRY_EGRESS_START_ARGV,
  APPLE_VM_DAEMON_TOOLCHAIN_DIR,
  APPLE_VM_PACKAGE_EGRESS_SOCKET,
  APPLE_VM_REGISTRY_EGRESS_SOCKET,
} from '../../src/docker-workload/apple-vm-daemon.js';
import {
  APPLE_VM_DOCKER_WORKLOAD_NETWORK,
  APPLE_VM_DOCKER_WORKLOAD_NETWORK_ENV,
  APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR,
} from '../../src/docker-workload/apple-private-docker.js';
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
  DOCKER_BUILD_PROXY_CONFIG_DIRECTORY,
  DOCKER_BUILD_SHIM_PATH,
  DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
  DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
  DOCKER_BUILD_TRUST_CA_CERT_PATH,
  DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY,
  DOCKER_BUILD_TRUST_CONTRACT_PATH,
  DOCKER_BUILD_TRUST_FAILURE_CLEAR_COMMAND,
  DOCKER_BUILD_TRUST_FAILURE_READ_COMMAND,
  DOCKER_BUILD_TRUST_WRAPPER_PATH,
  DOCKER_BUILDX_STATE_DIRECTORY,
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
  QUALIFIED_DOCKER_INFO,
  WATCHDOG_ENTRYPOINT_PATH,
  WATCHDOG_TEMPLATE_PATH,
  createEventRuntime,
  createTestAppleVmDockerWorkloadBootstrap,
  createFakeClock,
  createFakeSupervisor,
  isBuildTrustCanaryBuildArgv,
  respondHealthyAppleVmDaemon,
  setTestAppleVmDockerImageTag,
  snapshotTestAppleVmDockerImages,
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
    readonly networkAccess?: 'offline' | 'images' | 'packages';
  } = {},
): PreContainerInfrastructure {
  const runtimeKind = overrides.runtimeKind ?? 'apple-container';
  const admittedApple = overrides.dockerWorkload !== undefined && runtimeKind === 'apple-container';
  const bootstrap = admittedApple ? createTestAppleVmDockerWorkloadBootstrap(tempDir) : undefined;
  const buildShimContract =
    admittedApple && overrides.networkAccess === 'packages' ? getDockerBuildShimStagingContract('packages') : undefined;
  if (bootstrap) docker.getImageId = async () => bootstrap.artifact.appleImageId;
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
    imageResolution: bootstrap
      ? {
          mode: 'selected-agent-artifact',
          logicalName: bootstrap.artifact.logicalName,
          imageRef: bootstrap.artifact.logicalName,
          immutableImageId: bootstrap.artifact.appleImageId,
          buildHash: bootstrap.artifact.buildHash,
          artifact: bootstrap.artifact,
        }
      : undefined,
    runtimeKind,
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
    dockerWorkloadBootstrap: bootstrap,
    dockerWorkloadEgress:
      overrides.networkAccess === 'images' || overrides.networkAccess === 'packages'
        ? {
            networkAccess: overrides.networkAccess,
            registry: {
              listener: createMockMitmProxy(),
              socketPath: join(socketsDir, 'registry-egress.sock'),
              snapshot: () => ({ attempts: 0, totalBytes: 0, activeRequests: 0 }),
            },
            ...(overrides.networkAccess === 'packages'
              ? {
                  packages: {
                    listener: createMockMitmProxy(),
                    socketPath: join(socketsDir, 'package-egress.sock'),
                    snapshot: () => ({
                      attempts: 0,
                      clientAttempts: 0,
                      activeClients: 0,
                      activeDirect: 0,
                      activeUpstreams: 0,
                      transferredBytes: 0,
                      rateTokens: 120,
                      stopped: false,
                    }),
                  },
                }
              : {}),
          }
        : undefined,
    dockerBuildShim:
      buildShimContract === undefined
        ? undefined
        : {
            contract: buildShimContract,
            artifacts: [
              {
                kind: 'docker-shim',
                source: join(tempDir, 'build-shim', 'docker'),
                target: DOCKER_BUILD_SHIM_PATH,
                readonly: true,
              },
              {
                kind: 'proxy-config',
                source: join(tempDir, 'build-shim', 'package-build-client'),
                target: DOCKER_BUILD_PROXY_CONFIG_DIRECTORY,
                readonly: true,
              },
              {
                kind: 'build-trust-wrapper',
                source: join(tempDir, 'build-shim', 'runc'),
                target: DOCKER_BUILD_TRUST_WRAPPER_PATH,
                readonly: true,
              },
              {
                kind: 'build-trust-contract',
                source: join(tempDir, 'build-shim', 'build-trust-contract.json'),
                target: DOCKER_BUILD_TRUST_CONTRACT_PATH,
                readonly: true,
              },
              {
                kind: 'build-trust-ca-cert',
                source: join(tempDir, 'build-shim', 'ca-cert.pem'),
                target: DOCKER_BUILD_TRUST_CA_CERT_PATH,
                readonly: true,
              },
              {
                kind: 'build-trust-ca-bundle',
                source: join(tempDir, 'build-shim', 'ca-bundle.pem'),
                target: DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
                readonly: true,
              },
              {
                kind: 'build-trust-apt-config',
                source: join(tempDir, 'build-shim', 'apt.conf'),
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
          },
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

function managedNetworkCreates(runtime: EventRuntime): (readonly string[])[] {
  return runtime.execs.filter((argv) => argv.includes('network') && argv.includes('create'));
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
    expect(managedNetworkCreates(runtime)).toHaveLength(1);
    const readinessIndex = runtime.execs.findIndex((argv) => argv.includes('info'));
    const provisioningIndex = runtime.execs.findIndex(
      (argv) => argv.includes('version') && argv.includes('{{json .}}'),
    );
    const networkIndex = runtime.execs.findIndex((argv) => argv.includes('network') && argv.includes('create'));
    expect(readinessIndex).toBeGreaterThanOrEqual(0);
    expect(provisioningIndex).toBeGreaterThan(readinessIndex);
    expect(networkIndex).toBeGreaterThan(provisioningIndex);
  });
});

describe('nested daemon — readiness failure is fail-closed (§8.2 step 5)', () => {
  it('aborts the create and removes the partial container when the daemon configuration is unsupported', async () => {
    // A daemon that ANSWERS with the wrong storage driver is rejected on the
    // spot: an overlayfs daemon is an unsupported configuration, not a slow one.
    const { runtime, handle } = await admitBundle({
      exec: (argv) =>
        argv.includes('info')
          ? { exitCode: 0, stdout: JSON.stringify({ ...QUALIFIED_DOCKER_INFO, Driver: 'overlay2' }), stderr: '' }
          : respondHealthyAppleVmDaemon(argv),
    });
    const core = makeCore(runtime.runtime, { dockerWorkload: handle });

    await expect(createSessionContainers(core, makeConfig())).rejects.toThrow(/unsupported storage driver/u);

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

  it('aborts and tears down when the managed internal bridge cannot be created', async () => {
    const { runtime, handle } = await admitBundle({
      exec: (argv) =>
        argv.includes('network') && argv.includes('create')
          ? { exitCode: 1, stdout: '', stderr: 'bridge unavailable' }
          : respondHealthyAppleVmDaemon(argv),
    });

    await expect(
      createSessionContainers(makeCore(runtime.runtime, { dockerWorkload: handle }), makeConfig()),
    ).rejects.toThrow(/managed network create/u);
    expect(runtime.containers).toHaveLength(0);
    expect(runtime.events.some((event) => event.startsWith('remove:'))).toBe(true);
  });

  it('fails closed before provisioning when packages-mode PATH does not resolve the staged shim', async () => {
    const { runtime, handle } = await admitBundle({
      exec: (argv) =>
        argv[0] === '/bin/sh' && argv[1] === '-c' && argv[2] === 'command -v docker'
          ? { exitCode: 0, stdout: '/usr/local/bin/docker\n', stderr: '' }
          : respondHealthyAppleVmDaemon(argv),
    });

    await expect(
      createSessionContainers(
        makeCore(runtime.runtime, { dockerWorkload: handle, networkAccess: 'packages' }),
        makeConfig(),
      ),
    ).rejects.toThrow(/PATH resolution selected.*\/usr\/local\/bin\/docker/u);

    expect(runtime.execs.some((argv) => argv.includes('image') && argv.includes('inspect'))).toBe(false);
    expect(managedNetworkCreates(runtime)).toHaveLength(0);
    expect(runtime.containers).toHaveLength(0);
    expect(runtime.events.some((event) => event.startsWith('remove:'))).toBe(true);
  });
});

describe('nested daemon — private Docker environment reaches only an enabled agent (§8.2 step 6)', () => {
  it('sets the VM-local socket and fixed managed network when a bundle is admitted', async () => {
    const { runtime, handle } = await admitBundle();
    const capturing = capturingRuntime(runtime);
    const core = makeCore(capturing.runtime, { dockerWorkload: handle });

    await createSessionContainers(core, makeConfig());

    expect(capturing.config().env.DOCKER_HOST).toBe(APPLE_VM_DAEMON_DOCKER_HOST);
    expect(capturing.config().env[APPLE_VM_DOCKER_WORKLOAD_NETWORK_ENV]).toBe(APPLE_VM_DOCKER_WORKLOAD_NETWORK);
    expect(APPLE_VM_DAEMON_DOCKER_HOST).toBe('unix:///run/ironcurtain-docker/docker.sock');
    expect(APPLE_VM_DOCKER_WORKLOAD_NETWORK).toBe('ironcurtain');
  });

  it('nestedDaemonAgentEnv contributes nothing without a bundle', () => {
    expect(nestedDaemonAgentEnv(undefined)).toEqual({});
  });
});

describe('nested daemon — feature-off equivalence', () => {
  it('adds only the admitted resources while leaving the feature-off create unchanged', async () => {
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
    expect(differing.sort()).toEqual(['env', 'fullyVisibleProc', 'labels', 'mounts', 'name']);
    // The proc-visibility opt-out is one of the differences the feature is
    // allowed to introduce, and ONLY when admitted: an ordinary session must
    // keep the runtime's masked/read-only path hardening.
    expect(enabled.config().fullyVisibleProc).toBe(true);
    expect(off.config().fullyVisibleProc).not.toBe(true);
    expect(Object.keys(off.config().env)).not.toContain('DOCKER_HOST');
    expect(Object.keys(off.config().env)).not.toContain(APPLE_VM_DOCKER_WORKLOAD_NETWORK_ENV);
    expect(off.config().mounts).not.toContainEqual(
      expect.objectContaining({ target: APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR }),
    );
    expect(enabled.config().mounts).toContainEqual({
      source: expect.stringContaining('selected-agent-artifact-'),
      target: APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR,
      readonly: true,
    });
    // ...and the two private-Docker variables are the ONLY environment difference.
    const enabledEnvRest = Object.fromEntries(
      Object.entries(enabled.config().env).filter(
        ([key]) => key !== 'DOCKER_HOST' && key !== APPLE_VM_DOCKER_WORKLOAD_NETWORK_ENV,
      ),
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

describe('nested daemon — egress transports', () => {
  it('attempts to stop both authorities when either listener fails', async () => {
    const packageStop = vi.fn(() => Promise.reject(new Error('package stop failed')));
    const registryStop = vi.fn(async () => {});

    await expect(
      stopDockerWorkloadEgress({
        networkAccess: 'packages',
        registry: {
          listener: { stop: registryStop },
          socketPath: '/tmp/registry.sock',
          snapshot: () => ({ attempts: 0, totalBytes: 0, activeRequests: 0 }),
        },
        packages: { listener: { stop: packageStop }, socketPath: '/tmp/package.sock', snapshot: () => ({}) as never },
      }),
    ).rejects.toThrow(/package stop failed/u);

    expect(packageStop).toHaveBeenCalledOnce();
    expect(registryStop).toHaveBeenCalledOnce();
  });

  it('adds only the registry mount and selects the registry-only daemon bootstrap for images', async () => {
    const { runtime, handle } = await admitBundle();
    const capturing = capturingRuntime(runtime);
    const core = makeCore(capturing.runtime, { dockerWorkload: handle, networkAccess: 'images' });

    await createSessionContainers(core, makeConfig());

    expect(capturing.config().mounts).toContainEqual({
      source: join(core.socketsDir, 'registry-egress.sock'),
      target: APPLE_VM_REGISTRY_EGRESS_SOCKET,
      readonly: false,
    });
    expect(runtime.execs).toContainEqual([...APPLE_VM_DAEMON_REGISTRY_EGRESS_START_ARGV]);
    expect(capturing.config().mounts).not.toContainEqual(
      expect.objectContaining({ target: APPLE_VM_PACKAGE_EGRESS_SOCKET }),
    );
    expect(capturing.config().mounts).not.toContainEqual(expect.objectContaining({ target: DOCKER_BUILD_SHIM_PATH }));
    expect(capturing.config().mounts).not.toContainEqual(
      expect.objectContaining({ target: DOCKER_BUILD_PROXY_CONFIG_DIRECTORY }),
    );
    expect(runtime.execs).not.toContainEqual(['/bin/sh', '-c', 'command -v docker']);
    expect(capturing.config().env).not.toHaveProperty('DOCKER_CONFIG');
    expect(capturing.config().env).not.toHaveProperty('BUILDX_CONFIG');
    expect(Object.values(capturing.config().env).join(' ')).not.toContain('18081');
  });

  it('mounts distinct registry/package sockets and selects the dual-relay bootstrap for packages', async () => {
    const { runtime, handle } = await admitBundle();
    const capturing = capturingRuntime(runtime);
    const core = makeCore(capturing.runtime, { dockerWorkload: handle, networkAccess: 'packages' });
    const canaryBase = `localhost/ironcurtain/build-trust-canary-base:${handle.generation}`;
    const canaryOutput = `localhost/ironcurtain/build-trust-canary:${handle.generation}`;
    const selectedImageId = core.dockerWorkloadBootstrap!.artifact.dockerImageId;
    const canaryOutputImageId = `sha256:${'c'.repeat(64)}`;
    if (core.dockerWorkloadEgress?.networkAccess !== 'packages') throw new Error('expected package egress fixture');
    const registrySnapshot = vi.spyOn(core.dockerWorkloadEgress.registry, 'snapshot');
    const packageSnapshot = vi.spyOn(core.dockerWorkloadEgress.packages, 'snapshot');

    await createSessionContainers(core, makeConfig());

    const agentMounts = capturing.config().mounts;
    expect(agentMounts).toContainEqual({
      source: core.orientationDir,
      target: '/etc/ironcurtain',
      readonly: true,
    });
    expect(DOCKER_BUILD_TRUST_CONTRACT_PATH).toBe('/opt/ironcurtain-build-trust/build-trust-contract.json');
    expect(DOCKER_BUILD_TRUST_CONTRACT_PATH).not.toMatch(/^\/etc\/ironcurtain(?:\/|$)/u);
    expect(agentMounts).toEqual(
      expect.arrayContaining([
        {
          source: join(core.socketsDir, 'registry-egress.sock'),
          target: APPLE_VM_REGISTRY_EGRESS_SOCKET,
          readonly: false,
        },
        {
          source: join(core.socketsDir, 'package-egress.sock'),
          target: APPLE_VM_PACKAGE_EGRESS_SOCKET,
          readonly: false,
        },
      ]),
    );
    expect(runtime.execs).toContainEqual([...APPLE_VM_DAEMON_PACKAGE_EGRESS_START_ARGV]);
    expect(runtime.execs).not.toContainEqual([...APPLE_VM_DAEMON_REGISTRY_EGRESS_START_ARGV]);
    expect(capturing.config().mounts).toEqual(
      expect.arrayContaining([
        {
          source: join(tempDir, 'build-shim', 'docker'),
          target: DOCKER_BUILD_SHIM_PATH,
          readonly: true,
        },
        {
          source: join(tempDir, 'build-shim', 'package-build-client'),
          target: DOCKER_BUILD_PROXY_CONFIG_DIRECTORY,
          readonly: true,
        },
        {
          source: join(tempDir, 'build-shim', 'runc'),
          target: DOCKER_BUILD_TRUST_WRAPPER_PATH,
          readonly: true,
        },
        {
          source: join(tempDir, 'build-shim', 'build-trust-contract.json'),
          target: DOCKER_BUILD_TRUST_CONTRACT_PATH,
          readonly: true,
        },
        {
          source: join(tempDir, 'build-shim', 'ca-cert.pem'),
          target: DOCKER_BUILD_TRUST_CA_CERT_PATH,
          readonly: true,
        },
        {
          source: join(tempDir, 'build-shim', 'ca-bundle.pem'),
          target: DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
          readonly: true,
        },
        {
          source: join(tempDir, 'build-shim', 'apt.conf'),
          target: DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
          readonly: true,
        },
      ]),
    );
    expect(
      agentMounts
        .filter(({ target }) => target.startsWith(`${DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY}/`))
        .map(({ target }) => target)
        .sort(),
    ).toEqual(
      [
        DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
        DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
        DOCKER_BUILD_TRUST_CA_CERT_PATH,
        DOCKER_BUILD_TRUST_CONTRACT_PATH,
      ].sort(),
    );
    const readinessIndex = runtime.execs.findIndex((argv) => argv.includes('info'));
    const buildStateIndex = runtime.execs.findIndex((argv) => argv.includes(DOCKER_BUILDX_STATE_DIRECTORY));
    const pathIndex = runtime.execs.findIndex((argv) => argv[2] === 'command -v docker');
    const shimVersionIndex = runtime.execs.findIndex((argv) => argv.includes('{{json .Client}}'));
    const provisioningIndex = runtime.execs.findIndex((argv) => argv.includes('image') && argv.includes('inspect'));
    const contractValidationIndex = runtime.execs.findIndex(
      (argv) => argv[0] === '/bin/sh' && argv.includes(DOCKER_BUILD_TRUST_CONTRACT_PATH),
    );
    const baseTagIndex = runtime.execs.findIndex(
      (argv) => argv.includes('image') && argv.includes('tag') && argv.includes(canaryBase),
    );
    const baseInspectIndices = runtime.execs
      .map((argv, index) => ({ argv, index }))
      .filter(({ argv }) => argv.includes('image') && argv.includes('inspect') && argv.includes(canaryBase))
      .map(({ index }) => index);
    const outputInspectIndices = runtime.execs
      .map((argv, index) => ({ argv, index }))
      .filter(({ argv }) => argv.includes('image') && argv.includes('inspect') && argv.includes(canaryOutput))
      .map(({ index }) => index);
    const baseInspectAfterTagIndex = baseInspectIndices.find((index) => index > baseTagIndex) ?? -1;
    const canaryWriteIndex = runtime.execs.findIndex(
      (argv) => argv[0] === '/bin/sh' && argv.includes('ironcurtain-build-trust-canary'),
    );
    const canaryBuildIndex = runtime.execs.findIndex(isBuildTrustCanaryBuildArgv);
    const networkIndex = runtime.execs.findIndex((argv) => argv.includes('network') && argv.includes('create'));
    const outputCleanupIndex = runtime.execs.findIndex(
      (argv) => argv.includes('image') && argv.includes('rm') && argv.includes(canaryOutputImageId),
    );
    const baseCleanupIndex = runtime.execs.findIndex(
      (argv) => argv.includes('image') && argv.includes('rm') && argv.includes(canaryBase),
    );
    expect(buildStateIndex).toBeGreaterThan(readinessIndex);
    expect(pathIndex).toBeGreaterThan(buildStateIndex);
    expect(shimVersionIndex).toBeGreaterThan(pathIndex);
    expect(provisioningIndex).toBeGreaterThan(shimVersionIndex);
    expect(contractValidationIndex).toBeGreaterThan(provisioningIndex);
    expect(runtime.execs[contractValidationIndex]).toEqual(
      expect.arrayContaining([
        DOCKER_BUILD_TRUST_CONTRACT_PATH,
        '4'.repeat(64),
        'gen-00000000-0000-4000-8000-000000000000',
      ]),
    );
    expect(baseTagIndex).toBeGreaterThan(contractValidationIndex);
    expect(baseInspectIndices[0]).toBeLessThan(baseTagIndex);
    expect(outputInspectIndices[0]).toBeLessThan(baseTagIndex);
    expect(runtime.execs[baseTagIndex]).toEqual([
      `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
      '--host',
      APPLE_VM_DAEMON_DOCKER_HOST,
      'image',
      'tag',
      selectedImageId,
      canaryBase,
    ]);
    expect(baseInspectAfterTagIndex).toBeGreaterThan(baseTagIndex);
    expect(runtime.execs[baseInspectAfterTagIndex]).toEqual([
      `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
      '--host',
      APPLE_VM_DAEMON_DOCKER_HOST,
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      canaryBase,
    ]);
    expect(canaryWriteIndex).toBeGreaterThan(baseInspectAfterTagIndex);
    expect(runtime.execs[canaryWriteIndex]?.join('\n')).toContain(`FROM ${canaryBase}\n`);
    expect(runtime.execs[canaryWriteIndex]?.join('\n')).not.toContain('FROM sha256:');
    expect(runtime.execs[canaryWriteIndex]?.join('\n')).toContain('/dev/ironcurtain/ca-bundle.pem');
    expect(runtime.execs[canaryBuildIndex]).toEqual([
      `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
      '--host',
      APPLE_VM_DAEMON_DOCKER_HOST,
      'build',
      '--pull=false',
      '--network=none',
      '--no-cache',
      '--progress=plain',
      '--tag',
      canaryOutput,
      '--file',
      '/run/ironcurtain-docker/build-trust-canary/Dockerfile',
      '/run/ironcurtain-docker/build-trust-canary',
    ]);
    expect(canaryBuildIndex).toBeGreaterThan(canaryWriteIndex);
    expect(runtime.execs.some((argv) => argv.includes('pull') && argv.some((arg) => arg.includes(canaryBase)))).toBe(
      false,
    );
    expect(outputCleanupIndex).toBeGreaterThan(canaryBuildIndex);
    expect(baseCleanupIndex).toBeGreaterThan(outputCleanupIndex);
    expect(runtime.execs[outputCleanupIndex]).toEqual([
      `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
      '--host',
      APPLE_VM_DAEMON_DOCKER_HOST,
      'image',
      'rm',
      '--force',
      canaryOutputImageId,
    ]);
    expect(runtime.execs[baseCleanupIndex]).toEqual([
      `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
      '--host',
      APPLE_VM_DAEMON_DOCKER_HOST,
      'image',
      'rm',
      '--force',
      canaryBase,
    ]);
    expect(networkIndex).toBeGreaterThan(baseCleanupIndex);
    expect(baseInspectIndices.at(-1)).toBeGreaterThan(baseCleanupIndex);
    expect(outputInspectIndices.at(-1)).toBeGreaterThan(outputCleanupIndex);
    expect(registrySnapshot).toHaveBeenCalledTimes(2);
    expect(packageSnapshot).toHaveBeenCalledTimes(2);
    const diagnosticClearIndices = runtime.execs
      .map((argv, index) => ({ argv, index }))
      .filter(({ argv }) => argv[1] === DOCKER_BUILD_TRUST_FAILURE_CLEAR_COMMAND)
      .map(({ index }) => index);
    expect(diagnosticClearIndices).toHaveLength(2);
    expect(diagnosticClearIndices[0]).toBeLessThan(canaryBuildIndex);
    expect(diagnosticClearIndices[1]).toBeGreaterThan(canaryBuildIndex);
    expect(runtime.execs.some((argv) => argv[1] === DOCKER_BUILD_TRUST_FAILURE_READ_COMMAND)).toBe(false);
    expect(diagnosticClearIndices.every((index) => runtime.execUsers[index] === '0:0')).toBe(true);
    expect([...snapshotTestAppleVmDockerImages()]).toEqual([
      [core.dockerWorkloadBootstrap!.artifact.logicalName, selectedImageId],
    ]);
    expect(capturing.config().env).not.toHaveProperty('DOCKER_CONFIG');
    expect(capturing.config().env).not.toHaveProperty('BUILDX_CONFIG');
  });

  it('fails closed before canary build when the staged contract does not match its CA generation', async () => {
    const { runtime, handle } = await admitBundle({
      exec: (argv) =>
        argv[0] === '/bin/sh' && argv.includes(DOCKER_BUILD_TRUST_CONTRACT_PATH)
          ? { exitCode: 1, stdout: '', stderr: 'contract mismatch' }
          : respondHealthyAppleVmDaemon(argv),
    });
    const core = makeCore(runtime.runtime, { dockerWorkload: handle, networkAccess: 'packages' });

    await expect(createSessionContainers(core, makeConfig())).rejects.toThrow(/contract\/CA generation validation/u);

    expect(runtime.execs.some(isBuildTrustCanaryBuildArgv)).toBe(false);
    expect(managedNetworkCreates(runtime)).toHaveLength(0);
  });

  it('refuses and preserves a pre-existing reserved canary tag', async () => {
    const { runtime, handle } = await admitBundle();
    const core = makeCore(runtime.runtime, { dockerWorkload: handle, networkAccess: 'packages' });
    const canaryBase = `localhost/ironcurtain/build-trust-canary-base:${handle.generation}`;
    const unknownImageId = `sha256:${'d'.repeat(64)}`;
    setTestAppleVmDockerImageTag(canaryBase, unknownImageId);

    await expect(createSessionContainers(core, makeConfig())).rejects.toThrow(
      /reserved canary image tag already exists/u,
    );

    expect(runtime.execs.some((argv) => argv.includes('image') && argv.includes('tag'))).toBe(false);
    expect(runtime.execs.some(isBuildTrustCanaryBuildArgv)).toBe(false);
    expect(snapshotTestAppleVmDockerImages().get(canaryBase)).toBe(unknownImageId);
    expect(managedNetworkCreates(runtime)).toHaveLength(0);
  });

  it('fails closed before network creation when the no-network canary changes a package ledger', async () => {
    const { runtime, handle } = await admitBundle();
    const core = makeCore(runtime.runtime, { dockerWorkload: handle, networkAccess: 'packages' });
    if (core.dockerWorkloadEgress?.networkAccess !== 'packages') throw new Error('expected package egress fixture');
    let observations = 0;
    const packages = {
      ...core.dockerWorkloadEgress.packages,
      snapshot: () => ({
        attempts: observations++,
        clientAttempts: 0,
        activeClients: 0,
        activeDirect: 0,
        activeUpstreams: 0,
        transferredBytes: 0,
        rateTokens: 120,
        stopped: false,
      }),
    };

    await expect(
      createSessionContainers(
        {
          ...core,
          dockerWorkloadEgress: { ...core.dockerWorkloadEgress, packages },
        },
        makeConfig(),
      ),
    ).rejects.toThrow(/canary changed an egress ledger/u);

    expect(managedNetworkCreates(runtime)).toHaveLength(0);
    expect(runtime.containers).toHaveLength(0);
    expect(runtime.execs).toContainEqual(
      expect.arrayContaining(['image', 'rm', '--force', `sha256:${'c'.repeat(64)}`]),
    );
    expect(runtime.execs).toContainEqual(
      expect.arrayContaining([
        'image',
        'rm',
        '--force',
        `localhost/ironcurtain/build-trust-canary-base:${handle.generation}`,
      ]),
    );
  });

  it('removes the owned local base tag and proves no output residue when the no-network build fails', async () => {
    const { runtime, handle } = await admitBundle({
      exec: (argv) =>
        isBuildTrustCanaryBuildArgv(argv)
          ? { exitCode: 1, stdout: '', stderr: 'scripted canary build failure' }
          : respondHealthyAppleVmDaemon(argv),
    });
    const core = makeCore(runtime.runtime, { dockerWorkload: handle, networkAccess: 'packages' });

    await expect(createSessionContainers(core, makeConfig())).rejects.toThrow(/scripted canary build failure/u);

    expect(
      runtime.execs.some(
        (argv) =>
          argv.includes('image') &&
          argv.includes('rm') &&
          argv.includes(`localhost/ironcurtain/build-trust-canary:${handle.generation}`),
      ),
    ).toBe(false);
    expect(runtime.execs).toContainEqual(
      expect.arrayContaining([
        'image',
        'rm',
        '--force',
        `localhost/ironcurtain/build-trust-canary-base:${handle.generation}`,
      ]),
    );
    expect(managedNetworkCreates(runtime)).toHaveLength(0);
    expect(runtime.containers).toHaveLength(0);
    expect([...snapshotTestAppleVmDockerImages()]).toEqual([
      [core.dockerWorkloadBootstrap!.artifact.logicalName, core.dockerWorkloadBootstrap!.artifact.dockerImageId],
    ]);
  });

  it('retains bounded BuildKit context and the terminal canary error', async () => {
    const terminalError = 'WRAPPER-TERMINAL-ROOT-CAUSE';
    const { runtime, handle } = await admitBundle({
      exec: (argv) => {
        if (isBuildTrustCanaryBuildArgv(argv)) {
          return {
            exitCode: 1,
            stdout: `BUILDKIT-CONTEXT\n${'界'.repeat(2_000)}\nSTDOUT-TERMINAL`,
            stderr: `WRAPPER-CONTEXT\u0007${'🙂'.repeat(2_000)}\n${terminalError}`,
          };
        }
        if (argv[1] === DOCKER_BUILD_TRUST_FAILURE_READ_COMMAND) {
          return { exitCode: 0, stdout: 'ICBT-CONFIG-STRICT-ENVELOPE-V1\n', stderr: '' };
        }
        return respondHealthyAppleVmDaemon(argv);
      },
    });
    const core = makeCore(runtime.runtime, { dockerWorkload: handle, networkAccess: 'packages' });

    const error = await createSessionContainers(core, makeConfig()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('[stdout] BUILDKIT-CONTEXT');
    expect(message).toContain('STDOUT-TERMINAL');
    expect(message).toContain('[stderr] WRAPPER-CONTEXT?');
    expect(message).toContain(terminalError);
    expect(message).toContain('[wrapper] ICBT-CONFIG-STRICT-ENVELOPE-V1');
    expect(message).not.toContain('\n');
    expect(message).not.toContain('\r');
    expect(message).not.toContain('\u0007');
    expect(message).not.toContain('\uFFFD');
    const diagnostic = message.slice(message.indexOf(': [') + 2);
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(512);
    expect(managedNetworkCreates(runtime)).toHaveLength(0);
    expect(runtime.containers).toHaveLength(0);
    const buildIndex = runtime.execs.findIndex(isBuildTrustCanaryBuildArgv);
    const readIndices = runtime.execs
      .map((argv, index) => ({ argv, index }))
      .filter(({ argv }) => argv[1] === DOCKER_BUILD_TRUST_FAILURE_READ_COMMAND)
      .map(({ index }) => index);
    const clearIndices = runtime.execs
      .map((argv, index) => ({ argv, index }))
      .filter(({ argv }) => argv[1] === DOCKER_BUILD_TRUST_FAILURE_CLEAR_COMMAND)
      .map(({ index }) => index);
    expect(readIndices).toHaveLength(1);
    expect(clearIndices).toHaveLength(2);
    expect(clearIndices[0]).toBeLessThan(buildIndex);
    expect(readIndices[0]).toBeGreaterThan(buildIndex);
    expect(clearIndices[1]).toBeGreaterThan(readIndices[0]);
    expect([...clearIndices, ...readIndices].every((index) => runtime.execUsers[index] === '0:0')).toBe(true);
  });

  it('reads the typed diagnostic before a failed-build output inspect and preserves build causality', async () => {
    let buildReturnedFailure = false;
    const { runtime, handle } = await admitBundle({
      exec: (argv) => {
        if (isBuildTrustCanaryBuildArgv(argv)) {
          buildReturnedFailure = true;
          return { exitCode: 1, stdout: '', stderr: 'primary scripted build failure' };
        }
        if (argv[1] === DOCKER_BUILD_TRUST_FAILURE_READ_COMMAND) {
          return { exitCode: 0, stdout: 'ICBT-CONFIG-STRICT-ENVELOPE-V1\n', stderr: '' };
        }
        if (
          buildReturnedFailure &&
          argv.includes('image') &&
          argv.includes('inspect') &&
          argv.some((arg) => arg.startsWith('localhost/ironcurtain/build-trust-canary:'))
        ) {
          throw new Error('scripted output inspect transport failure');
        }
        return respondHealthyAppleVmDaemon(argv);
      },
    });
    const core = makeCore(runtime.runtime, { dockerWorkload: handle, networkAccess: 'packages' });

    const error = await createSessionContainers(core, makeConfig()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.message).toMatch(/primary scripted build failure.*\[wrapper\] ICBT-CONFIG-STRICT-ENVELOPE-V1/u);
    expect(aggregate.errors[0]).toBeInstanceOf(Error);
    expect((aggregate.errors[0] as Error).message).toMatch(
      /primary scripted build failure.*\[wrapper\] ICBT-CONFIG-STRICT-ENVELOPE-V1/u,
    );
    expect(
      aggregate.errors
        .slice(1)
        .some((secondary) => secondary instanceof Error && secondary.message.includes('output image inspect failed')),
    ).toBe(true);

    const buildIndex = runtime.execs.findIndex(isBuildTrustCanaryBuildArgv);
    const diagnosticReadIndex = runtime.execs.findIndex((argv) => argv[1] === DOCKER_BUILD_TRUST_FAILURE_READ_COMMAND);
    const firstPostBuildOutputInspectIndex = runtime.execs.findIndex(
      (argv, index) =>
        index > buildIndex &&
        argv.includes('image') &&
        argv.includes('inspect') &&
        argv.some((arg) => arg.startsWith('localhost/ironcurtain/build-trust-canary:')),
    );
    expect(diagnosticReadIndex).toBeGreaterThan(buildIndex);
    expect(diagnosticReadIndex).toBeLessThan(firstPostBuildOutputInspectIndex);
    expect(managedNetworkCreates(runtime)).toHaveLength(0);
    expect(runtime.containers).toHaveLength(0);
  });

  it('keeps diagnostic cleanup best-effort and outside canary admission', async () => {
    const { runtime, handle } = await admitBundle({
      exec: (argv) =>
        argv[1] === DOCKER_BUILD_TRUST_FAILURE_CLEAR_COMMAND
          ? { exitCode: 125, stdout: '', stderr: '' }
          : respondHealthyAppleVmDaemon(argv),
    });
    const core = makeCore(runtime.runtime, { dockerWorkload: handle, networkAccess: 'packages' });

    await expect(createSessionContainers(core, makeConfig())).resolves.toBeDefined();

    expect(runtime.execs.filter((argv) => argv[1] === DOCKER_BUILD_TRUST_FAILURE_CLEAR_COMMAND)).toHaveLength(2);
    expect(runtime.execs.some((argv) => argv[1] === DOCKER_BUILD_TRUST_FAILURE_READ_COMMAND)).toBe(false);
    expect(managedNetworkCreates(runtime)).toHaveLength(1);
  });

  it('replaces untyped wrapper diagnostic output without masking the build failure', async () => {
    const { runtime, handle } = await admitBundle({
      exec: (argv) => {
        if (isBuildTrustCanaryBuildArgv(argv)) {
          return { exitCode: 1, stdout: '', stderr: 'primary build failure' };
        }
        if (argv[1] === DOCKER_BUILD_TRUST_FAILURE_READ_COMMAND) {
          return { exitCode: 0, stdout: 'contract-secret\nextra-line\n', stderr: '' };
        }
        return respondHealthyAppleVmDaemon(argv);
      },
    });
    const core = makeCore(runtime.runtime, { dockerWorkload: handle, networkAccess: 'packages' });

    const error = await createSessionContainers(core, makeConfig()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/primary build failure.*\[wrapper\] ICBT-DIAGNOSTIC-UNAVAILABLE-V1/u);
    expect((error as Error).message).not.toContain('contract-secret');
    expect(runtime.execs.filter((argv) => argv[1] === DOCKER_BUILD_TRUST_FAILURE_READ_COMMAND)).toHaveLength(1);
  });

  it('continues ownership checks and exact base cleanup when output-ID removal throws', async () => {
    const outputImageId = `sha256:${'c'.repeat(64)}`;
    const { runtime, handle } = await admitBundle({
      exec: (argv) => {
        if (argv.includes('image') && argv.includes('rm') && argv.includes(outputImageId)) {
          throw new Error('scripted output cleanup transport failure');
        }
        return respondHealthyAppleVmDaemon(argv);
      },
    });
    const core = makeCore(runtime.runtime, { dockerWorkload: handle, networkAccess: 'packages' });
    const canaryBase = `localhost/ironcurtain/build-trust-canary-base:${handle.generation}`;

    await expect(createSessionContainers(core, makeConfig())).rejects.toThrow(/cleanup verification failed/u);

    expect(runtime.execs).toContainEqual(expect.arrayContaining(['image', 'rm', '--force', outputImageId]));
    expect(runtime.execs).toContainEqual(expect.arrayContaining(['image', 'rm', '--force', canaryBase]));
    expect(runtime.execs).toContainEqual(['/bin/rm', '-rf', '/run/ironcurtain-docker/build-trust-canary']);
    expect(managedNetworkCreates(runtime)).toHaveLength(0);
    expect(runtime.containers).toHaveLength(0);
  });

  it('adds no egress mount or daemon proxy configuration to offline', async () => {
    const { runtime, handle } = await admitBundle();
    const capturing = capturingRuntime(runtime);
    const core = makeCore(capturing.runtime, { dockerWorkload: handle });

    await createSessionContainers(core, makeConfig());

    expect(capturing.config().mounts).not.toContainEqual(
      expect.objectContaining({ target: APPLE_VM_REGISTRY_EGRESS_SOCKET }),
    );
    expect(capturing.config().mounts).not.toContainEqual(
      expect.objectContaining({ target: APPLE_VM_PACKAGE_EGRESS_SOCKET }),
    );
    expect(runtime.execs).not.toContainEqual([...APPLE_VM_DAEMON_REGISTRY_EGRESS_START_ARGV]);
    expect(capturing.config().mounts).not.toContainEqual(expect.objectContaining({ target: DOCKER_BUILD_SHIM_PATH }));
    expect(capturing.config().mounts).not.toContainEqual(
      expect.objectContaining({ target: DOCKER_BUILD_PROXY_CONFIG_DIRECTORY }),
    );
    expect(runtime.execs).not.toContainEqual(['/bin/sh', '-c', 'command -v docker']);
    expect(capturing.config().env).not.toHaveProperty('DOCKER_CONFIG');
    expect(capturing.config().env).not.toHaveProperty('BUILDX_CONFIG');
  });
});

describe('nested daemon — unimplemented backend fails closed', () => {
  it('refuses an admitted bundle on the docker backend instead of skipping the daemon', async () => {
    const { runtime, handle } = await admitBundle();
    const core = makeCore(runtime.runtime, { dockerWorkload: handle, runtimeKind: 'docker' });

    await expect(createSessionContainers(core, makeConfig())).rejects.toThrow(/not implemented on the docker backend/u);
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
    expect(audit.events).toContainEqual(
      expect.objectContaining({
        kind: 'private-docker-bootstrap',
        artifact: {
          logicalName: 'ironcurtain-claude-code:latest',
          buildHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          outerAppleImageId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          innerDockerImageId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
        network: { name: 'ironcurtain', runtimeId: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      }),
    );
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('active');
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
