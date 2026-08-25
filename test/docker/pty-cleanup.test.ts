import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted<{
  infrastructure: unknown;
  destroyArguments: unknown;
  destroyError: unknown;
  removeBundleRuntimeRoot: ReturnType<typeof vi.fn>;
  updateSessionMetadata: ReturnType<typeof vi.fn>;
}>(() => ({
  infrastructure: undefined,
  destroyArguments: undefined,
  destroyError: undefined,
  removeBundleRuntimeRoot: vi.fn(),
  updateSessionMetadata: vi.fn(),
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
    sandboxDir: `/tmp/${sessionId}/sandbox`,
    escalationDir: `/tmp/${sessionId}/escalations`,
    systemPromptAugmentation: '',
    resolvedSkills: [],
    memoryEnabled: false,
  }),
}));

vi.mock('../../src/session/session-metadata.js', () => ({
  updateSessionMetadata: state.updateSessionMetadata,
}));

vi.mock('../../src/docker/claude-md-seed.js', () => ({ buildDockerClaudeMd: () => '' }));

vi.mock('../../src/docker/docker-infrastructure.js', () => ({
  prepareDockerInfrastructure: async () => state.infrastructure,
  activateAppleVmDockerWorkload: vi.fn(),
  buildAgentUidRemap: () => ({}),
  buildUdsSocketMounts: () => [],
  buildDockerWorkloadEgressMounts: () => [],
  dockerWorkloadEgressNetworkAccess: () => 'offline',
  stopDockerWorkloadEgress: async (egress?: {
    registry?: { listener: { stop(): Promise<void> } };
    packages?: { listener: { stop(): Promise<void> } };
  }) => {
    await Promise.allSettled([
      ...(egress?.packages ? [egress.packages.listener.stop()] : []),
      ...(egress?.registry ? [egress.registry.listener.stop()] : []),
    ]);
  },
  createLedgeredAgentContainer: vi.fn(),
  dockerWorkloadSessionMetadata: vi.fn(() => ({
    leaseId: 'lease-1',
    generation: 'generation-1',
    configHash: 'c'.repeat(64),
    watchdogPolicySha256: 'w'.repeat(64),
    backend: 'apple-container',
  })),
  removeBundleRuntimeRoot: state.removeBundleRuntimeRoot,
  selectOuterContainerResources: () => ({ memoryMb: undefined, cpus: undefined }),
  writeAptProxyConfigViaExec: vi.fn(),
  checkDockerContainerWritableStorage: vi.fn(),
  checkHostOnlyConnectivity: vi.fn(),
  checkInternalNetworkConnectivity: vi.fn(),
}));

vi.mock('../../src/docker/container-lifecycle.js', () => ({
  destroyBundleOuterResources: async (options: { dockerWorkload?: { teardown(): Promise<void> } }) => {
    state.destroyArguments = options;
    await options.dockerWorkload?.teardown();
    if (state.destroyError !== undefined) {
      throw state.destroyError instanceof Error ? state.destroyError : new Error('scripted non-Error cleanup failure');
    }
  },
}));

import { runPtySession } from '../../src/docker/pty-session.js';

describe('PTY early-initialization cleanup ownership', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    state.infrastructure = undefined;
    state.destroyArguments = undefined;
    state.destroyError = undefined;
    state.removeBundleRuntimeRoot.mockReset();
    state.updateSessionMetadata.mockReset();
  });

  it('revokes the workload and stops both proxies when capture begin throws', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pty-cleanup-'));
    directories.push(directory);
    const teardown = vi.fn(async () => {});
    const proxyStop = vi.fn(async () => {});
    const mitmStop = vi.fn(async () => {});
    const registryStop = vi.fn(async () => {});
    const packageStop = vi.fn(async () => {});
    const docker = {};
    const dockerWorkload = { teardown };
    state.infrastructure = {
      docker,
      dockerWorkload,
      proxy: { stop: proxyStop },
      mitmProxy: { stop: mitmStop },
      dockerWorkloadEgress: {
        networkAccess: 'packages',
        registry: { listener: { stop: registryStop }, socketPath: '/tmp/registry.sock' },
        packages: { listener: { stop: packageStop }, socketPath: '/tmp/package.sock' },
      },
      useTcp: false,
      runtimeKind: 'apple-container',
      setTokenSessionId: () => {},
      beginCaptureSession: () => {
        throw new Error('scripted capture begin failure');
      },
    };

    await expect(
      runPtySession({
        config: {
          userConfig: {
            modelProviders: { default: 'native' },
            dockerWorkload: { enabled: true },
          },
        } as never,
        mode: { kind: 'docker', agent: 'claude-code' },
        workspacePath: directory,
      }),
    ).rejects.toThrow(/scripted capture begin failure/u);

    expect(state.destroyArguments).toMatchObject({ docker, dockerWorkload });
    expect(teardown).toHaveBeenCalledOnce();
    expect(mitmStop).toHaveBeenCalledOnce();
    expect(proxyStop).toHaveBeenCalledOnce();
    expect(registryStop).toHaveBeenCalledOnce();
    expect(packageStop).toHaveBeenCalledOnce();
    expect(state.removeBundleRuntimeRoot).toHaveBeenCalledOnce();
    expect(state.updateSessionMetadata).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        dockerWorkload: expect.objectContaining({
          leaseId: 'lease-1',
          generation: 'generation-1',
          backend: 'apple-container',
        }),
      }),
    );
  });

  it('stops proxies and removes the runtime root when resource verification fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pty-cleanup-'));
    directories.push(directory);
    const proxyStop = vi.fn(async () => {});
    const mitmStop = vi.fn(async () => {});
    state.destroyError = new Error('scripted runtime verification failure');
    state.infrastructure = {
      docker: {},
      proxy: { stop: proxyStop },
      mitmProxy: { stop: mitmStop },
      useTcp: false,
      setTokenSessionId: () => {},
      beginCaptureSession: () => {
        throw new Error('scripted capture begin failure');
      },
    };

    await expect(
      runPtySession({
        config: { userConfig: { modelProviders: { default: 'native' } } } as never,
        mode: { kind: 'docker', agent: 'claude-code' },
        workspacePath: directory,
      }),
    ).rejects.toThrow(/scripted runtime verification failure/u);

    expect(mitmStop).toHaveBeenCalledOnce();
    expect(proxyStop).toHaveBeenCalledOnce();
    expect(state.removeBundleRuntimeRoot).toHaveBeenCalledOnce();
  });
});
