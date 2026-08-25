import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockerContainerConfig } from '../../src/docker/types.js';
import {
  DOCKER_BUILD_PROXY_CONFIG_DIRECTORY,
  DOCKER_BUILD_SHIM_PATH,
  DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
  DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
  DOCKER_BUILD_TRUST_CA_CERT_PATH,
  DOCKER_BUILD_TRUST_CONTRACT_PATH,
  DOCKER_BUILD_TRUST_WRAPPER_PATH,
  getDockerBuildShimStagingContract,
} from '../../src/docker/docker-build-shim.js';

const state = vi.hoisted<{
  infrastructure: unknown;
  startAppleVmDockerWorkload: ReturnType<typeof vi.fn<(options: unknown) => Promise<void>>>;
  execPty: ReturnType<typeof vi.fn<(containerId: string, command: readonly string[]) => Promise<number>>>;
  createdConfigs: DockerContainerConfig[];
  prepareOptions: unknown;
}>(() => ({
  infrastructure: undefined,
  startAppleVmDockerWorkload: vi.fn<(options: unknown) => Promise<void>>(),
  execPty: vi.fn<(containerId: string, command: readonly string[]) => Promise<number>>(),
  createdConfigs: [],
  prepareOptions: undefined,
}));

vi.mock('ora', () => ({
  default: () => ({
    isSpinning: true,
    start() {
      return this;
    },
    fail() {},
    succeed() {},
  }),
}));

vi.mock('../../src/session/index.js', () => ({
  buildSessionConfig: (config: unknown, sessionId: string) => ({
    config,
    sandboxDir: `${process.env.IRONCURTAIN_HOME}/sessions/${sessionId}/sandbox`,
    escalationDir: `${process.env.IRONCURTAIN_HOME}/sessions/${sessionId}/escalations`,
    systemPromptAugmentation: '',
    resolvedSkills: [],
    memoryEnabled: false,
  }),
}));

vi.mock('../../src/session/session-metadata.js', () => ({ updateSessionMetadata: vi.fn() }));
vi.mock('../../src/docker/claude-md-seed.js', () => ({ buildDockerClaudeMd: () => '' }));

vi.mock('../../src/docker/docker-infrastructure.js', () => ({
  prepareDockerInfrastructure: async (
    _config: unknown,
    _mode: unknown,
    sessionDir: string,
    sandboxDir: string,
    escalationDir: string,
    _bundleId: unknown,
    _workflowId: unknown,
    _scope: unknown,
    _resolvedSkills: unknown,
    _captureInput: unknown,
    _scriptsDir: unknown,
    options: unknown,
  ) => {
    state.prepareOptions = options;
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(sandboxDir, { recursive: true });
    mkdirSync(escalationDir, { recursive: true });
    return state.infrastructure;
  },
  buildAgentUidRemap: () => ({}),
  buildUdsSocketMounts: () => [],
  buildDockerWorkloadEgressMounts: (infra: {
    dockerWorkloadEgress?: { registry?: { socketPath: string }; packages?: { socketPath: string } };
  }) => [
    ...(infra.dockerWorkloadEgress?.registry
      ? [
          {
            source: infra.dockerWorkloadEgress.registry.socketPath,
            target: '/tmp/ironcurtain-registry-egress.sock',
            readonly: false,
          },
        ]
      : []),
    ...(infra.dockerWorkloadEgress?.packages
      ? [
          {
            source: infra.dockerWorkloadEgress.packages.socketPath,
            target: '/tmp/ironcurtain-package-egress.sock',
            readonly: false,
          },
        ]
      : []),
  ],
  buildDockerBuildShimMounts: (infra: {
    dockerBuildShim?: {
      artifacts: readonly { source: string; target: string; readonly: boolean }[];
      contract: unknown;
    };
  }) =>
    infra.dockerBuildShim === undefined
      ? []
      : infra.dockerBuildShim.artifacts.map(({ source, target, readonly }) => ({ source, target, readonly })),
  activateAppleVmDockerWorkload: async (options: {
    runtime: unknown;
    containerId: string;
    nestedDaemon?: unknown;
    bootstrap?: unknown;
    dockerWorkloadEgress?: {
      networkAccess: 'images' | 'packages';
      registry: { snapshot(): unknown };
      packages?: { snapshot(): unknown };
    };
    dockerBuildShim?: { contract: unknown; buildTrustCanary: unknown };
  }) => {
    if (options.nestedDaemon === undefined || options.bootstrap === undefined) return;
    await state.startAppleVmDockerWorkload({
      runtime: options.runtime,
      containerId: options.containerId,
      nestedDaemon: options.nestedDaemon,
      bootstrap: options.bootstrap,
      networkAccess: options.dockerWorkloadEgress?.networkAccess ?? 'offline',
      dockerBuildShim: options.dockerBuildShim?.contract,
      dockerBuildTrustCanary: options.dockerBuildShim?.buildTrustCanary,
      egressLedgers:
        options.dockerWorkloadEgress?.networkAccess === 'packages'
          ? {
              registry: options.dockerWorkloadEgress.registry.snapshot,
              packages: options.dockerWorkloadEgress.packages?.snapshot,
            }
          : undefined,
    });
  },
  dockerWorkloadEgressNetworkAccess: (egress?: { networkAccess: 'images' | 'packages' }) =>
    egress?.networkAccess ?? 'offline',
  stopDockerWorkloadEgress: async (egress?: {
    registry?: { listener: { stop(): Promise<void> } };
    packages?: { listener: { stop(): Promise<void> } };
  }) => {
    await egress?.packages?.listener.stop();
    await egress?.registry?.listener.stop();
  },
  createLedgeredAgentContainer: async (options: {
    deterministicName: string;
    create(name: string, labels: Readonly<Record<string, string>> | undefined): Promise<string>;
  }) => options.create(options.deterministicName, undefined),
  dockerWorkloadSessionMetadata: vi.fn(() => ({
    leaseId: 'lease-pty-ordering',
    generation: 'generation-pty-ordering',
    configHash: 'c'.repeat(64),
    watchdogPolicySha256: 'w'.repeat(64),
    backend: 'apple-container',
  })),
  removeBundleRuntimeRoot: vi.fn(),
  selectOuterContainerResources: () => ({ memoryMb: undefined, cpus: undefined }),
  writeAptProxyConfigViaExec: vi.fn(async () => {}),
  checkDockerContainerWritableStorage: vi.fn(async () => {}),
  checkHostOnlyConnectivity: vi.fn(async () => {}),
  checkInternalNetworkConnectivity: vi.fn(async () => {}),
}));

vi.mock('../../src/docker/container-lifecycle.js', () => ({
  destroyBundleOuterResources: async (options: { dockerWorkload?: { teardown(): Promise<void> } }) => {
    await options.dockerWorkload?.teardown();
  },
}));

vi.mock('../../src/docker-workload/session-daemon.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/docker-workload/session-daemon.js')>();
  return { ...actual, startAppleVmDockerWorkload: state.startAppleVmDockerWorkload };
});

import { runPtySession, type PtyAttachFn } from '../../src/docker/pty-session.js';

const EXPECTED_PTY_COMMAND = [
  'socat',
  'UNIX-LISTEN:/tmp/ironcurtain-pty.sock,fork',
  'EXEC:/etc/ironcurtain/start-claude.sh,pty,setsid,ctty,stderr,rawer',
] as const;

describe('Apple nested Docker PTY startup ordering', () => {
  let homeDir: string;
  let orientationDir: string;
  let socketsDir: string;
  let ptyServer: Server;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'pty-nested-ordering-'));
    orientationDir = join(homeDir, 'orientation');
    socketsDir = join(homeDir, 'sockets');
    mkdirSync(orientationDir);
    mkdirSync(socketsDir);
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = homeDir;
    state.createdConfigs.length = 0;
    state.startAppleVmDockerWorkload.mockReset();
    state.execPty.mockReset();
    state.execPty.mockResolvedValue(0);
    state.prepareOptions = undefined;

    ptyServer = createServer();
    await new Promise<void>((resolve, reject) => {
      ptyServer.once('error', reject);
      ptyServer.listen(join(socketsDir, 'pty.sock'), () => resolve());
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => ptyServer.close(() => resolve()));
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    state.infrastructure = undefined;
    rmSync(homeDir, { recursive: true, force: true });
  });

  function installInfrastructure(
    workload: { status: string; teardown(): Promise<void> },
    options: { networkAccess?: 'offline' | 'images' | 'packages' } = {},
  ): void {
    const buildShimContract =
      options.networkAccess === 'packages' ? getDockerBuildShimStagingContract('packages') : undefined;
    const docker = {
      removeStaleContainer: vi.fn(async () => {}),
      create: vi.fn(async (config: DockerContainerConfig) => {
        state.createdConfigs.push(config);
        return 'apple-container-id';
      }),
      start: vi.fn(async () => {}),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      execPty: state.execPty,
    };
    state.infrastructure = {
      docker,
      dockerWorkload: workload,
      dockerWorkloadEgress:
        options.networkAccess === 'images' || options.networkAccess === 'packages'
          ? {
              networkAccess: options.networkAccess,
              registry: {
                listener: { stop: vi.fn(async () => {}) },
                socketPath: join(socketsDir, 'registry-egress.sock'),
                snapshot: () => ({ attempts: 0, totalBytes: 0, activeRequests: 0 }),
              },
              ...(options.networkAccess === 'packages'
                ? {
                    packages: {
                      listener: { stop: vi.fn(async () => {}) },
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
                  source: join(homeDir, 'runtime', 'build-shim', 'docker'),
                  target: DOCKER_BUILD_SHIM_PATH,
                  readonly: true,
                },
                {
                  kind: 'proxy-config',
                  source: join(homeDir, 'runtime', 'build-shim', 'package-build-client'),
                  target: DOCKER_BUILD_PROXY_CONFIG_DIRECTORY,
                  readonly: true,
                },
                {
                  kind: 'build-trust-wrapper',
                  source: join(homeDir, 'runtime', 'build-shim', 'runc'),
                  target: DOCKER_BUILD_TRUST_WRAPPER_PATH,
                  readonly: true,
                },
                {
                  kind: 'build-trust-contract',
                  source: join(homeDir, 'runtime', 'build-shim', 'build-trust-contract.json'),
                  target: DOCKER_BUILD_TRUST_CONTRACT_PATH,
                  readonly: true,
                },
                {
                  kind: 'build-trust-ca-cert',
                  source: join(homeDir, 'runtime', 'build-shim', 'ca-cert.pem'),
                  target: DOCKER_BUILD_TRUST_CA_CERT_PATH,
                  readonly: true,
                },
                {
                  kind: 'build-trust-ca-bundle',
                  source: join(homeDir, 'runtime', 'build-shim', 'ca-bundle.pem'),
                  target: DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
                  readonly: true,
                },
                {
                  kind: 'build-trust-apt-config',
                  source: join(homeDir, 'runtime', 'build-shim', 'apt.conf'),
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
      dockerWorkloadBootstrap: {
        hostCatalogDirectory: homeDir,
        guestCatalogDirectory: '/run/ironcurtain-catalog',
        outerAppleCatalogPath: join(homeDir, 'apple-catalog.json'),
        innerDockerCatalogPath: join(homeDir, 'docker-catalog.json'),
        selectedImageLogicalName: 'ironcurtain-claude-code:latest',
        clientToolchainManifestPath: join(homeDir, 'toolchain.json'),
      },
      proxy: { socketPath: join(socketsDir, 'mcp.sock'), stop: vi.fn(async () => {}) },
      mitmProxy: { stop: vi.fn(async () => {}) },
      useTcp: false,
      runtimeKind: 'apple-container',
      topology: 'uds',
      setTokenSessionId: vi.fn(),
      beginCaptureSession: vi.fn(),
      endCaptureSession: vi.fn(async () => {}),
      adapter: {
        id: 'claude-code',
        displayName: 'Claude Code',
        buildEnv: () => ({}),
        buildPtyCommand: () => [...EXPECTED_PTY_COMMAND],
        buildPtyExecCommand: () => ['/etc/ironcurtain/start-claude.sh'],
      },
      fakeKeys: {},
      orientationDir,
      socketsDir,
      systemPrompt: 'test system prompt',
      image: 'ironcurtain-claude-code:latest',
      mitmAddr: { socketPath: join(socketsDir, 'mitm.sock') },
    };
  }

  function config(): never {
    return {
      protectedPaths: [],
      userConfig: {
        modelProviders: { default: 'native' },
        dockerWorkload: { enabled: true, acceptObservedDiskRisk: true, resources: { diskMb: null } },
      },
    } as never;
  }

  it('uses runtime-native exec and attaches only after workload activation completes', async () => {
    const events: string[] = [];
    const workload = { status: 'admitted', teardown: vi.fn(async () => {}) };
    installInfrastructure(workload);
    let finishActivation!: () => void;
    const activationBlocked = new Promise<void>((resolve) => {
      finishActivation = resolve;
    });
    state.startAppleVmDockerWorkload.mockImplementation(async () => {
      events.push('activation-start');
      await activationBlocked;
      workload.status = 'active';
      events.push('activation-complete');
    });
    const attach = vi.fn<PtyAttachFn>(async () => 0);
    state.execPty.mockImplementation(async () => {
      expect(workload.status).toBe('active');
      events.push('attach');
      return 0;
    });

    const session = runPtySession({
      config: config(),
      mode: { kind: 'docker', agent: 'claude-code' },
      workspacePath: homeDir,
      attach,
    });
    await vi.waitFor(() => expect(state.startAppleVmDockerWorkload).toHaveBeenCalledOnce());
    expect(attach).not.toHaveBeenCalled();
    finishActivation();
    await session;

    expect(state.createdConfigs).toHaveLength(1);
    expect(state.createdConfigs[0].command).toEqual(['sleep', 'infinity']);
    expect(state.createdConfigs[0].publishSockets).toBeUndefined();
    expect(state.createdConfigs[0].tty).toBe(false);
    expect(state.createdConfigs[0].env.DOCKER_HOST).toBe('unix:///run/ironcurtain-docker/docker.sock');
    expect(state.createdConfigs[0].env.IRONCURTAIN_DOCKER_NETWORK).toBe('ironcurtain');
    expect(state.execPty).toHaveBeenCalledWith(
      'apple-container-id',
      ['/etc/ironcurtain/start-claude.sh'],
      expect.any(AbortSignal),
    );
    expect(state.prepareOptions).toEqual(expect.objectContaining({ proxyAgentKind: 'pty' }));
    expect(attach).not.toHaveBeenCalled();
    expect(events).toEqual(['activation-start', 'activation-complete', 'attach']);
    expect(state.startAppleVmDockerWorkload).toHaveBeenCalledWith(
      expect.objectContaining({ networkAccess: 'offline', dockerBuildShim: undefined }),
    );
  });

  it('does not attach when workload bootstrap or adjudication fails', async () => {
    const workload = { status: 'admitted', teardown: vi.fn(async () => {}) };
    installInfrastructure(workload);
    state.startAppleVmDockerWorkload.mockRejectedValue(new Error('scripted daemon adjudication failure'));
    const attach = vi.fn<PtyAttachFn>(async () => 0);

    await expect(
      runPtySession({
        config: config(),
        mode: { kind: 'docker', agent: 'claude-code' },
        workspacePath: homeDir,
        attach,
      }),
    ).rejects.toThrow(/scripted daemon adjudication failure/);
    expect(attach).not.toHaveBeenCalled();
    expect(state.execPty).not.toHaveBeenCalled();
  });

  it('does not release the PTY when the package build shim preflight fails', async () => {
    const workload = { status: 'admitted', teardown: vi.fn(async () => {}) };
    installInfrastructure(workload, { networkAccess: 'packages' });
    state.startAppleVmDockerWorkload.mockRejectedValue(new Error('scripted build shim preflight failure'));

    await expect(
      runPtySession({
        config: config(),
        mode: { kind: 'docker', agent: 'claude-code' },
        workspacePath: homeDir,
        attach: async () => 0,
      }),
    ).rejects.toThrow(/build shim preflight failure/u);

    expect(state.startAppleVmDockerWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        networkAccess: 'packages',
        dockerBuildShim: getDockerBuildShimStagingContract('packages'),
      }),
    );
    expect(state.createdConfigs[0].env).not.toHaveProperty('DOCKER_CONFIG');
    expect(state.createdConfigs[0].env).not.toHaveProperty('BUILDX_CONFIG');
    expect(state.execPty).not.toHaveBeenCalled();
    expect(workload.teardown).toHaveBeenCalledOnce();
  });

  it('mounts and selects package transport before PTY attach', async () => {
    const workload = { status: 'admitted', teardown: vi.fn(async () => {}) };
    installInfrastructure(workload, { networkAccess: 'packages' });
    state.startAppleVmDockerWorkload.mockImplementation(async () => {
      workload.status = 'active';
    });

    await runPtySession({
      config: config(),
      mode: { kind: 'docker', agent: 'claude-code' },
      workspacePath: homeDir,
      attach: async () => 0,
    });

    expect(state.createdConfigs[0].mounts).toContainEqual({
      source: join(socketsDir, 'registry-egress.sock'),
      target: '/tmp/ironcurtain-registry-egress.sock',
      readonly: false,
    });
    expect(state.createdConfigs[0].mounts).toContainEqual({
      source: join(socketsDir, 'package-egress.sock'),
      target: '/tmp/ironcurtain-package-egress.sock',
      readonly: false,
    });
    expect(state.createdConfigs[0].mounts).toContainEqual({
      source: orientationDir,
      target: '/etc/ironcurtain',
      readonly: true,
    });
    expect(DOCKER_BUILD_TRUST_CONTRACT_PATH).toBe('/opt/ironcurtain-build-trust/build-trust-contract.json');
    expect(DOCKER_BUILD_TRUST_CONTRACT_PATH).not.toMatch(/^\/etc\/ironcurtain(?:\/|$)/u);
    expect(state.createdConfigs[0].mounts).toEqual(
      expect.arrayContaining([
        {
          source: join(homeDir, 'runtime', 'build-shim', 'docker'),
          target: DOCKER_BUILD_SHIM_PATH,
          readonly: true,
        },
        {
          source: join(homeDir, 'runtime', 'build-shim', 'package-build-client'),
          target: DOCKER_BUILD_PROXY_CONFIG_DIRECTORY,
          readonly: true,
        },
        {
          source: join(homeDir, 'runtime', 'build-shim', 'runc'),
          target: DOCKER_BUILD_TRUST_WRAPPER_PATH,
          readonly: true,
        },
        {
          source: join(homeDir, 'runtime', 'build-shim', 'build-trust-contract.json'),
          target: DOCKER_BUILD_TRUST_CONTRACT_PATH,
          readonly: true,
        },
      ]),
    );
    expect(state.startAppleVmDockerWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        networkAccess: 'packages',
        dockerBuildShim: getDockerBuildShimStagingContract('packages'),
      }),
    );
  });

  it('mounts only registry transport for images before PTY attach', async () => {
    const workload = { status: 'admitted', teardown: vi.fn(async () => {}) };
    installInfrastructure(workload, { networkAccess: 'images' });
    state.startAppleVmDockerWorkload.mockImplementation(async () => {
      workload.status = 'active';
    });

    await runPtySession({
      config: config(),
      mode: { kind: 'docker', agent: 'claude-code' },
      workspacePath: homeDir,
      attach: async () => 0,
    });

    expect(state.createdConfigs[0].mounts).toContainEqual({
      source: join(socketsDir, 'registry-egress.sock'),
      target: '/tmp/ironcurtain-registry-egress.sock',
      readonly: false,
    });
    expect(state.createdConfigs[0].mounts).not.toContainEqual(
      expect.objectContaining({ target: '/tmp/ironcurtain-package-egress.sock' }),
    );
    expect(state.createdConfigs[0].mounts).not.toContainEqual(
      expect.objectContaining({ target: DOCKER_BUILD_SHIM_PATH }),
    );
    expect(state.createdConfigs[0].mounts).not.toContainEqual(
      expect.objectContaining({ target: DOCKER_BUILD_PROXY_CONFIG_DIRECTORY }),
    );
    expect(state.startAppleVmDockerWorkload).toHaveBeenCalledWith(
      expect.objectContaining({ networkAccess: 'images', dockerBuildShim: undefined }),
    );
    expect(state.createdConfigs[0].env).not.toHaveProperty('DOCKER_CONFIG');
    expect(state.createdConfigs[0].env).not.toHaveProperty('BUILDX_CONFIG');
  });
});
