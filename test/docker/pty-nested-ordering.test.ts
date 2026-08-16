import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockerContainerConfig } from '../../src/docker/types.js';

const state = vi.hoisted<{
  infrastructure: unknown;
  startAppleVmDockerWorkload: ReturnType<typeof vi.fn<(options: unknown) => Promise<void>>>;
  createdConfigs: DockerContainerConfig[];
}>(() => ({
  infrastructure: undefined,
  startAppleVmDockerWorkload: vi.fn<(options: unknown) => Promise<void>>(),
  createdConfigs: [],
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
  ) => {
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(sandboxDir, { recursive: true });
    mkdirSync(escalationDir, { recursive: true });
    return state.infrastructure;
  },
  buildAgentUidRemap: () => ({}),
  buildUdsSocketMounts: () => [],
  buildDockerWorkloadRegistryEgressMount: (infra: { dockerWorkloadRegistryEgress?: { socketPath: string } }) =>
    infra.dockerWorkloadRegistryEgress
      ? [
          {
            source: infra.dockerWorkloadRegistryEgress.socketPath,
            target: '/tmp/ironcurtain-registry-egress.sock',
            readonly: false,
          },
        ]
      : [],
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
    options: { publicRegistry?: boolean } = {},
  ): void {
    const docker = {
      removeStaleContainer: vi.fn(async () => {}),
      create: vi.fn(async (config: DockerContainerConfig) => {
        state.createdConfigs.push(config);
        return 'apple-container-id';
      }),
      start: vi.fn(async () => {}),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    };
    state.infrastructure = {
      docker,
      dockerWorkload: workload,
      dockerWorkloadRegistryEgress: options.publicRegistry
        ? { listener: { stop: vi.fn(async () => {}) }, socketPath: join(socketsDir, 'registry-egress.sock') }
        : undefined,
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

  it('uses the ordinary socat command and attaches only after workload activation completes', async () => {
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
    const attach = vi.fn<PtyAttachFn>(async () => {
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
    expect(state.createdConfigs[0].command).toEqual(EXPECTED_PTY_COMMAND);
    expect(state.createdConfigs[0].env.DOCKER_HOST).toBe('unix:///run/ironcurtain-docker/docker.sock');
    expect(state.createdConfigs[0].env.IRONCURTAIN_DOCKER_NETWORK).toBe('ironcurtain');
    expect(events).toEqual(['activation-start', 'activation-complete', 'attach']);
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
  });

  it('mounts and selects public-registry transport before PTY attach', async () => {
    const workload = { status: 'admitted', teardown: vi.fn(async () => {}) };
    installInfrastructure(workload, { publicRegistry: true });
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
    expect(state.startAppleVmDockerWorkload).toHaveBeenCalledWith(expect.objectContaining({ registryEgress: true }));
  });
});
