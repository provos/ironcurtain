import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted<{ infrastructure: unknown; destroyArguments: unknown }>(() => ({
  infrastructure: undefined,
  destroyArguments: undefined,
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
  buildSessionConfig: (_config: unknown, sessionId: string) => ({
    config: {},
    sandboxDir: `/tmp/${sessionId}/sandbox`,
    escalationDir: `/tmp/${sessionId}/escalations`,
    systemPromptAugmentation: '',
    resolvedSkills: [],
    memoryEnabled: false,
  }),
}));

vi.mock('../../src/docker/claude-md-seed.js', () => ({ buildDockerClaudeMd: () => '' }));

vi.mock('../../src/docker/docker-infrastructure.js', () => ({
  prepareDockerInfrastructure: async () => state.infrastructure,
  buildAgentUidRemap: () => ({}),
  buildUdsSocketMounts: () => [],
  createLedgeredAgentContainer: vi.fn(),
  writeAptProxyConfigViaExec: vi.fn(),
  checkDockerContainerWritableStorage: vi.fn(),
  checkHostOnlyConnectivity: vi.fn(),
  checkInternalNetworkConnectivity: vi.fn(),
}));

vi.mock('../../src/docker/container-lifecycle.js', () => ({
  destroyBundleOuterResources: async (options: { dockerWorkload?: { teardown(): Promise<void> } }) => {
    state.destroyArguments = options;
    await options.dockerWorkload?.teardown();
  },
}));

import { runPtySession } from '../../src/docker/pty-session.js';

describe('PTY early-initialization cleanup ownership', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    state.infrastructure = undefined;
    state.destroyArguments = undefined;
  });

  it('revokes the workload and stops both proxies when capture begin throws', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pty-cleanup-'));
    directories.push(directory);
    const teardown = vi.fn(async () => {});
    const proxyStop = vi.fn(async () => {});
    const mitmStop = vi.fn(async () => {});
    const docker = {};
    const dockerWorkload = { teardown };
    state.infrastructure = {
      docker,
      dockerWorkload,
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
        config: {
          userConfig: { modelProviders: { default: 'native' } },
        } as never,
        mode: { kind: 'docker', agent: 'claude-code' },
        workspacePath: directory,
      }),
    ).rejects.toThrow(/scripted capture begin failure/u);

    expect(state.destroyArguments).toMatchObject({ docker, dockerWorkload });
    expect(teardown).toHaveBeenCalledOnce();
    expect(mitmStop).toHaveBeenCalledOnce();
    expect(proxyStop).toHaveBeenCalledOnce();
  });
});
