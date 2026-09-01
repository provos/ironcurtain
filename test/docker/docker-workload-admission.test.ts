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
const getAgent = vi.fn();
const createContainerRuntime = vi.fn();
const resolveRuntimeKind = vi.fn();
const checkAppleContainerAvailable = vi.fn();
const checkDockerAvailable = vi.fn();
const hostPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

if (hostPlatformDescriptor === undefined) {
  throw new Error('process.platform descriptor is unavailable');
}

vi.mock('../../src/docker/agent-registry.js', () => ({
  registerBuiltinAdapters,
  getAgent,
}));
vi.mock('../../src/docker/container-runtime.js', () => ({
  createContainerRuntime,
  resolveRuntimeKind,
}));
vi.mock('../../src/docker/apple-container-manager.js', () => ({ checkAppleContainerAvailable }));
vi.mock('../../src/docker/docker-probe.js', () => ({ checkDockerAvailable }));

beforeEach(() => {
  // These integration seams exercise Docker Desktop, which is admitted only
  // on macOS. Keep that host assumption explicit when CI runs on Linux.
  Object.defineProperty(process, 'platform', {
    ...hostPlatformDescriptor,
    value: 'darwin',
  });
  vi.clearAllMocks();
  getAgent.mockImplementation(() => {
    throw new Error('adapter lookup must not run');
  });
  createContainerRuntime.mockImplementation(() => {
    throw new Error('runtime creation must not run');
  });
  checkAppleContainerAvailable.mockResolvedValue({ available: true });
  checkDockerAvailable.mockResolvedValue({ available: true });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatformDescriptor);
});

function admittedAppleConfig() {
  return resolveDockerWorkloadConfig({ enabled: true });
}

describe('secure nested Docker resolved-variant admission', () => {
  it('is a no-op for absent and explicitly disabled capability', () => {
    expect(() => assertDockerWorkloadVariantAdmitted(undefined, 'docker')).not.toThrow();
    expect(() => assertDockerWorkloadVariantAdmitted(resolveDockerWorkloadConfig(undefined), 'docker')).not.toThrow();
  });

  it('admits the simple opt-in and its preloaded-only image-ingress opt-out on Apple', () => {
    expect(() => assertDockerWorkloadVariantAdmitted(admittedAppleConfig(), 'apple-container')).not.toThrow();
    expect(() =>
      assertDockerWorkloadVariantAdmitted(
        resolveDockerWorkloadConfig({
          enabled: true,
          imageIngress: 'preloaded-only',
        }),
        'apple-container',
      ),
    ).not.toThrow();
  });

  it('admits an enabled capability resolved to Docker on Darwin', () => {
    expect(() => assertDockerWorkloadVariantAdmitted(admittedAppleConfig(), 'docker', 'darwin')).not.toThrow();
  });

  it('rejects an unavailable Docker runtime before adapter, runtime, image, relay, or daemon work', async () => {
    resolveRuntimeKind.mockResolvedValueOnce('docker');
    checkDockerAvailable.mockResolvedValueOnce({
      available: false,
      reason: 'Docker not available',
      detailedMessage: 'Start Docker Desktop.',
    });
    const { ensureDockerImage } = await import('../../src/docker/docker-infrastructure.js');
    await expect(
      ensureDockerImage('claude-code', {
        containerRuntime: 'auto',
        dockerWorkload: admittedAppleConfig(),
      } as ResolvedUserConfig),
    ).rejects.toThrow(/Docker runtime is unavailable: Docker not available/u);
    expect(registerBuiltinAdapters).not.toHaveBeenCalled();
    expect(resolveRuntimeKind).toHaveBeenCalledOnce();
    expect(checkDockerAvailable).toHaveBeenCalledOnce();
    expect(checkAppleContainerAvailable).not.toHaveBeenCalled();
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
    expect(checkDockerAvailable).not.toHaveBeenCalled();
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

  it.each([
    { networkAccess: 'offline' as const, expectsRelay: false },
    { networkAccess: 'images' as const, expectsRelay: true },
    { networkAccess: 'packages' as const, expectsRelay: true },
  ])(
    'pins Docker Desktop agent identity for $networkAccess without Apple archive transport',
    async ({ networkAccess, expectsRelay }) => {
      const image = 'ironcurtain-claude-code:latest';
      const relayImage = 'ironcurtain-fixed-relay:latest';
      const immutableImageId = `sha256:${'a'.repeat(64)}`;
      const relayImageId = `sha256:${'b'.repeat(64)}`;
      const buildHashes = new Map<string, string>();
      const getImageLabel = vi
        .fn<(reference: string, label: string) => Promise<string | undefined>>()
        .mockResolvedValue(undefined);
      const buildImage = vi.fn(
        async (tag: string, _dockerfile: string, _context: string, labels?: Record<string, string>) => {
          const buildHash = labels?.['ironcurtain.build-hash'];
          if (buildHash !== undefined) buildHashes.set(tag, buildHash);
        },
      );
      const inspectImage = vi.fn(async (reference: string) => {
        const buildHash = buildHashes.get(reference);
        if (buildHash === undefined) return undefined;
        if (reference === image) {
          return {
            id: immutableImageId,
            repoTags: [image],
            labels: { 'ironcurtain.build-hash': buildHash },
            created: '2026-08-31T00:00:00.000Z',
          };
        }
        if (reference === relayImage) {
          return {
            id: relayImageId,
            repoTags: [relayImage],
            labels: {
              'ironcurtain.build-hash': buildHash,
              'com.ironcurtain.docker-workload.component': 'fixed-relay',
            },
            created: '2026-08-31T00:00:00.000Z',
          };
        }
        return undefined;
      });
      const saveImageArchive = vi.fn();
      const tagImage = vi.fn();
      const loadImageArchive = vi.fn();
      const listImages = vi.fn();
      const removeImage = vi.fn();
      getAgent.mockReturnValue({ getImage: async () => image });
      createContainerRuntime.mockReturnValue({
        getImageLabel,
        buildImage,
        inspectImage,
        saveImageArchive,
        tagImage,
        loadImageArchive,
        listImages,
        removeImage,
      });
      resolveRuntimeKind.mockResolvedValue('docker');
      const { ensureDockerImage } = await import('../../src/docker/docker-infrastructure.js');

      const resolution = await ensureDockerImage('claude-code', {
        containerRuntime: 'docker',
        dockerWorkload: resolveDockerWorkloadConfig({ enabled: true, networkAccess }),
      } as ResolvedUserConfig);

      expect(resolution).toMatchObject({
        mode: 'build-if-stale',
        logicalName: image,
        imageRef: image,
        immutableImageId,
        buildHash: buildHashes.get(image),
      });
      expect(resolution.artifact).toBeUndefined();
      expect(buildImage.mock.calls.some(([tag]) => tag === relayImage)).toBe(expectsRelay);
      expect(getImageLabel.mock.calls.some(([reference]) => reference === relayImage)).toBe(expectsRelay);
      expect(inspectImage.mock.calls.some(([reference]) => reference === relayImage)).toBe(expectsRelay);
      expect(saveImageArchive).not.toHaveBeenCalled();
      expect(tagImage).not.toHaveBeenCalled();
      expect(loadImageArchive).not.toHaveBeenCalled();
      expect(listImages).not.toHaveBeenCalled();
      expect(removeImage).not.toHaveBeenCalled();
    },
  );
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

  it('rejects unavailable Docker after read-only runtime resolution but before feature infrastructure provisioning', async () => {
    checkDockerAvailable.mockResolvedValueOnce({
      available: false,
      reason: 'Docker not available',
      detailedMessage: 'Start Docker Desktop.',
    });
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
    ).rejects.toThrow(/Docker runtime is unavailable: Docker not available/u);

    // Effective runtime resolution is read-only. At this seam rejection
    // precedes the active-profile stamp and feature-attributable adapter,
    // runtime, image, artifact, proxy, lease, and filesystem work.
    expect(config.activeProviderProfile).toBeUndefined();
    expect(existsSync(getDockerWorkloadRoot())).toBe(false);
    expect(readdirSync(home)).toEqual([]);
    expect(registerBuiltinAdapters).not.toHaveBeenCalled();
    expect(resolveRuntimeKind).toHaveBeenCalledOnce();
    expect(checkDockerAvailable).toHaveBeenCalledOnce();
    expect(checkAppleContainerAvailable).not.toHaveBeenCalled();
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
    expect(checkDockerAvailable).not.toHaveBeenCalled();
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
