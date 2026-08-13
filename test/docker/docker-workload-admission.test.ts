import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IronCurtainConfig } from '../../src/config/types.js';
import type { ResolvedUserConfig } from '../../src/config/user-config.js';
import type { AgentId } from '../../src/docker/agent-adapter.js';
import type { BundleId } from '../../src/session/types.js';
import { assertDockerWorkloadVariantAdmitted, resolveDockerWorkloadConfig } from '../../src/docker-workload/config.js';

const registerBuiltinAdapters = vi.fn();
const resolveRuntimeKind = vi.fn();
const checkAppleContainerAvailable = vi.fn();

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
vi.mock('../../src/docker/apple-container-manager.js', () => ({ checkAppleContainerAvailable }));

beforeEach(() => {
  vi.clearAllMocks();
  checkAppleContainerAvailable.mockResolvedValue({ available: true });
});

function admittedAppleConfig() {
  return resolveDockerWorkloadConfig({
    enabled: true,
    acceptObservedDiskRisk: true,
    resources: { diskMb: null },
  });
}

describe('secure nested Docker resolved-variant admission', () => {
  it('is a no-op for absent and explicitly disabled capability', () => {
    expect(() => assertDockerWorkloadVariantAdmitted(undefined, 'docker')).not.toThrow();
    expect(() => assertDockerWorkloadVariantAdmitted(resolveDockerWorkloadConfig(undefined), 'docker')).not.toThrow();
  });

  it('admits the frozen Apple developer variant with offline or credential-free public-registry image ingress', () => {
    expect(() => assertDockerWorkloadVariantAdmitted(admittedAppleConfig(), 'apple-container')).not.toThrow();
    expect(() =>
      assertDockerWorkloadVariantAdmitted(
        resolveDockerWorkloadConfig({
          enabled: true,
          imageIngress: 'public-registry',
          acceptObservedDiskRisk: true,
          resources: { diskMb: null },
        }),
        'apple-container',
      ),
    ).not.toThrow();
  });

  it.each([
    ['auto resolved to Docker', admittedAppleConfig(), 'docker'],
    [
      'explicit Apple backend resolved to Docker',
      resolveDockerWorkloadConfig({
        enabled: true,
        backend: 'apple-container',
        acceptObservedDiskRisk: true,
        resources: { diskMb: null },
      }),
      'docker',
    ],
    [
      'explicit Docker backend resolved to Apple',
      resolveDockerWorkloadConfig({
        enabled: true,
        backend: 'docker',
        acceptObservedDiskRisk: true,
        resources: { diskMb: null },
      }),
      'apple-container',
    ],
    ['bounded disk', resolveDockerWorkloadConfig({ enabled: true }), 'apple-container'],
    [
      'build egress',
      resolveDockerWorkloadConfig({
        enabled: true,
        buildEgress: 'ironcurtain-dockerfiles',
        acceptObservedDiskRisk: true,
        resources: { diskMb: null },
      }),
      'apple-container',
    ],
    [
      'required PID enforcement',
      resolveDockerWorkloadConfig({
        enabled: true,
        acceptObservedDiskRisk: true,
        resources: { pids: { required: true }, diskMb: null },
      }),
      'apple-container',
    ],
  ] as const)('rejects %s', (_label, config, runtimeKind) => {
    expect(() => assertDockerWorkloadVariantAdmitted(config, runtimeKind)).toThrow(
      /currently admits only the Apple Container developer-only/u,
    );
  });

  it('rejects a Docker-resolved opt-in before adapter, runtime, image, relay, or daemon work', async () => {
    resolveRuntimeKind.mockResolvedValueOnce('docker');
    const { ensureDockerImage } = await import('../../src/docker/docker-infrastructure.js');
    await expect(
      ensureDockerImage('claude-code', {
        containerRuntime: 'auto',
        dockerWorkload: admittedAppleConfig(),
      } as ResolvedUserConfig),
    ).rejects.toThrow(/currently admits only the Apple Container developer-only/u);
    expect(registerBuiltinAdapters).not.toHaveBeenCalled();
    expect(resolveRuntimeKind).toHaveBeenCalledOnce();
  });

  it('preserves feature-off adapter-before-runtime error ordering', async () => {
    const { ensureDockerImage } = await import('../../src/docker/docker-infrastructure.js');
    await expect(
      ensureDockerImage('claude-code', {
        containerRuntime: 'auto',
        dockerWorkload: { enabled: false },
      } as ResolvedUserConfig),
    ).rejects.toThrow(/adapter lookup must not run/u);
    expect(registerBuiltinAdapters).toHaveBeenCalledOnce();
    expect(resolveRuntimeKind).not.toHaveBeenCalled();
    expect(checkAppleContainerAvailable).not.toHaveBeenCalled();
  });

  it('rejects an unavailable explicit Apple runtime before adapter or image work', async () => {
    resolveRuntimeKind.mockResolvedValueOnce('apple-container');
    checkAppleContainerAvailable.mockResolvedValueOnce({
      available: false,
      reason: 'container services not running',
      detailedMessage: 'Start them first.',
    });
    const { ensureDockerImage } = await import('../../src/docker/docker-infrastructure.js');
    await expect(
      ensureDockerImage('claude-code', {
        containerRuntime: 'apple-container',
        dockerWorkload: admittedAppleConfig(),
      } as ResolvedUserConfig),
    ).rejects.toThrow(/Apple runtime is unavailable: container services not running/u);
    expect(registerBuiltinAdapters).not.toHaveBeenCalled();
  });
});

describe('secure nested Docker admission — prepareDockerInfrastructure', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    resolveRuntimeKind.mockResolvedValue('docker');
    previousHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'dw-fuse-prepare-'));
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('rejects after read-only runtime resolution but before feature infrastructure provisioning', async () => {
    const { prepareDockerInfrastructure } = await import('../../src/docker/docker-infrastructure.js');
    const { getDockerWorkloadRoot } = await import('../../src/config/paths.js');

    const config = {
      auditLogPath: join(home, 'audit.jsonl'),
      userConfig: {
        modelProviders: { default: 'native', profiles: { native: { type: 'native' } } },
        containerRuntime: 'auto',
        dockerWorkload: admittedAppleConfig(),
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
    ).rejects.toThrow(/currently admits only the Apple Container developer-only/u);

    // Effective runtime resolution is read-only. At this seam rejection
    // precedes the active-profile stamp and feature-attributable adapter,
    // runtime, image, catalog, proxy, lease, and filesystem work.
    expect(config.activeProviderProfile).toBeUndefined();
    expect(existsSync(getDockerWorkloadRoot())).toBe(false);
    expect(readdirSync(home)).toEqual([]);
    expect(registerBuiltinAdapters).not.toHaveBeenCalled();
    expect(resolveRuntimeKind).toHaveBeenCalledOnce();
  });

  it('preserves feature-off provider-before-runtime error ordering', async () => {
    const { prepareDockerInfrastructure } = await import('../../src/docker/docker-infrastructure.js');
    const config = {
      auditLogPath: join(home, 'audit.jsonl'),
      userConfig: {
        modelProviders: { default: 'missing', profiles: { native: { type: 'native' } } },
        containerRuntime: 'auto',
        dockerWorkload: { enabled: false },
      },
    } as unknown as IronCurtainConfig;

    await expect(
      prepareDockerInfrastructure(
        config,
        { kind: 'docker', agent: 'claude-code' as AgentId },
        join(home, 'bundle'),
        join(home, 'workspace'),
        join(home, 'escalations'),
        'bundle-disabled-001' as BundleId,
      ),
    ).rejects.toThrow(/Unknown provider profile/u);

    expect(resolveRuntimeKind).not.toHaveBeenCalled();
    expect(checkAppleContainerAvailable).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });

  it('rejects an unavailable explicit Apple runtime before direct-prepare provisioning', async () => {
    resolveRuntimeKind.mockResolvedValueOnce('apple-container');
    checkAppleContainerAvailable.mockResolvedValueOnce({
      available: false,
      reason: 'container services not running',
      detailedMessage: 'Start them first.',
    });
    const { prepareDockerInfrastructure } = await import('../../src/docker/docker-infrastructure.js');
    const config = {
      auditLogPath: join(home, 'audit.jsonl'),
      userConfig: {
        modelProviders: { default: 'native', profiles: { native: { type: 'native' } } },
        containerRuntime: 'apple-container',
        dockerWorkload: admittedAppleConfig(),
      },
    } as unknown as IronCurtainConfig;

    await expect(
      prepareDockerInfrastructure(
        config,
        { kind: 'docker', agent: 'claude-code' as AgentId },
        join(home, 'bundle'),
        join(home, 'workspace'),
        join(home, 'escalations'),
        'bundle-unavailable-001' as BundleId,
      ),
    ).rejects.toThrow(/Apple runtime is unavailable: container services not running/u);

    expect(config.activeProviderProfile).toBeUndefined();
    expect(registerBuiltinAdapters).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });
});
