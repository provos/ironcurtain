import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IronCurtainConfig } from '../../src/config/types.js';
import type { ResolvedUserConfig } from '../../src/config/user-config.js';
import type { AgentId } from '../../src/docker/agent-adapter.js';
import type { BundleId } from '../../src/session/types.js';
import {
  assertDockerWorkloadImplementationAvailable,
  resolveDockerWorkloadConfig,
} from '../../src/docker-workload/config.js';

const registerBuiltinAdapters = vi.fn();
const resolveRuntimeKind = vi.fn();

vi.mock('../../src/docker/agent-registry.js', () => ({
  registerBuiltinAdapters,
  getAgent: vi.fn(() => {
    throw new Error('adapter lookup must not run');
  }),
}));
vi.mock('../../src/docker/container-runtime.js', () => ({
  createContainerRuntime: vi.fn(() => {
    throw new Error('runtime creation must not run');
  }),
  resolveRuntimeKind,
}));

describe('secure nested Docker admission fuse', () => {
  it('is a no-op for absent and explicitly disabled capability', () => {
    expect(() => assertDockerWorkloadImplementationAvailable(undefined)).not.toThrow();
    expect(() => assertDockerWorkloadImplementationAvailable(resolveDockerWorkloadConfig(undefined))).not.toThrow();
  });

  it('rejects opt-in before adapter, runtime, image, relay, or daemon work', async () => {
    const { ensureDockerImage } = await import('../../src/docker/docker-infrastructure.js');
    await expect(
      ensureDockerImage('claude-code', {
        dockerWorkload: resolveDockerWorkloadConfig({ enabled: true }),
      } as ResolvedUserConfig),
    ).rejects.toThrow(/not implementation-qualified.*no image, relay, or daemon action was performed/u);
    expect(registerBuiltinAdapters).not.toHaveBeenCalled();
    expect(resolveRuntimeKind).not.toHaveBeenCalled();
  });
});

describe('secure nested Docker admission fuse — prepareDockerInfrastructure', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'dw-fuse-prepare-'));
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('throws at the fuse before any lease directory write or supervisor spawn', async () => {
    const { prepareDockerInfrastructure } = await import('../../src/docker/docker-infrastructure.js');
    const { getDockerWorkloadRoot } = await import('../../src/config/paths.js');

    const config = {
      auditLogPath: join(home, 'audit.jsonl'),
      userConfig: {
        modelProviders: { default: 'native', profiles: { native: { type: 'native' } } },
        dockerWorkload: resolveDockerWorkloadConfig({ enabled: true }),
      },
    } as unknown as IronCurtainConfig;

    await expect(
      prepareDockerInfrastructure(
        config,
        { kind: 'docker', agent: 'claude-code' as AgentId },
        join(home, 'bundle'),
        join(home, 'workspace'),
        join(home, 'escalations'),
        'bundle-fuse-001' as BundleId,
      ),
    ).rejects.toThrow(/not implementation-qualified.*no image, relay, or daemon action was performed/u);

    // The admission fuse fires before the runtime is resolved and before any
    // Docker-workload lease directory is created, so the workload root must
    // not exist and no adapter/runtime work ran.
    expect(existsSync(getDockerWorkloadRoot())).toBe(false);
    // Belt-and-suspenders: nothing at all was written under IRONCURTAIN_HOME.
    expect(readdirSync(home)).toEqual([]);
    expect(registerBuiltinAdapters).not.toHaveBeenCalled();
    expect(resolveRuntimeKind).not.toHaveBeenCalled();
  });
});
