import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { arch } from 'node:os';
import { join } from 'node:path';
import type { ResolvedUserConfig } from '../../src/config/user-config.js';
import { resolveDockerWorkloadConfig } from '../../src/docker-workload/config.js';
import {
  getFrozenCatalogPath,
  getStagedCatalogPath,
  preloadedCatalogFileName,
} from '../../src/docker/preloaded-catalog-paths.js';
import { catalogImageSources } from '../../src/docker/preloaded-catalog-sources.js';
import { buildPreloadedImageLabels, type PreloadedImageCatalog } from '../../src/docker/preloaded-image-catalog.js';
import { REQUIRED_PRELOADED_IMAGE_ROLES } from '../../src/docker/preloaded-catalog-builder.js';
import type { ContainerRuntime } from '../../src/docker/types.js';
import { writeOciArchiveFixture } from '../helpers/oci-archive-fixture.js';

const registerBuiltinAdapters = vi.fn();
const getImage = vi.fn(async () => 'ironcurtain-claude-code:latest');
const getAgent = vi.fn(() => ({ getImage }));
const resolveRuntimeKind = vi.fn(async () => 'docker' as const);
const createContainerRuntime = vi.fn<() => ContainerRuntime>();

vi.mock('../../src/docker/agent-registry.js', () => ({ registerBuiltinAdapters, getAgent }));
vi.mock('../../src/docker/container-runtime.js', () => ({ createContainerRuntime, resolveRuntimeKind }));

const temporaryDirectories: string[] = [];
const originalHome = process.env.IRONCURTAIN_HOME;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
  else process.env.IRONCURTAIN_HOME = originalHome;
  vi.clearAllMocks();
});

describe('preloaded catalog canonical paths', () => {
  it('names backend-bound catalog files consistently', () => {
    expect(preloadedCatalogFileName('docker')).toBe('preloaded-catalog.docker.json');
    expect(preloadedCatalogFileName('apple-container')).toBe('preloaded-catalog.apple-container.json');
  });

  it('places the runtime staging catalog under the trusted home, outside any workspace', () => {
    process.env.IRONCURTAIN_HOME = '/trusted/home';
    expect(getStagedCatalogPath('docker')).toBe(
      '/trusted/home/docker-workload/preloaded-catalog/preloaded-catalog.docker.json',
    );
    expect(getStagedCatalogPath('apple-container')).toBe(
      '/trusted/home/docker-workload/preloaded-catalog/preloaded-catalog.apple-container.json',
    );
  });

  it('places the frozen record under the committed config/docker-workload directory', () => {
    expect(getFrozenCatalogPath('docker').endsWith('/config/docker-workload/preloaded-catalog.docker.json')).toBe(true);
    expect(
      getFrozenCatalogPath('apple-container').endsWith(
        '/config/docker-workload/preloaded-catalog.apple-container.json',
      ),
    ).toBe(true);
  });
});

describe('imageProvisioningForConfig mapping', () => {
  it('leaves absent/disabled capability on the legacy build path', async () => {
    const { imageProvisioningForConfig } = await import('../../src/docker/docker-infrastructure.js');
    expect(imageProvisioningForConfig(undefined, 'docker')).toBeUndefined();
    expect(imageProvisioningForConfig(resolveDockerWorkloadConfig(undefined), 'docker')).toBeUndefined();
  });

  it('binds the resolved runtime catalog for an auto backend', async () => {
    process.env.IRONCURTAIN_HOME = '/trusted/home';
    const { imageProvisioningForConfig } = await import('../../src/docker/docker-infrastructure.js');
    const provisioning = imageProvisioningForConfig(resolveDockerWorkloadConfig({ enabled: true }), 'apple-container');
    expect(provisioning).toEqual({
      imageMode: 'preloaded-catalog',
      runtimeKind: 'apple-container',
      catalogPath: getStagedCatalogPath('apple-container'),
    });
  });

  it('honors an explicit backend over the resolved runtime', async () => {
    process.env.IRONCURTAIN_HOME = '/trusted/home';
    const { imageProvisioningForConfig } = await import('../../src/docker/docker-infrastructure.js');
    const provisioning = imageProvisioningForConfig(
      resolveDockerWorkloadConfig({ enabled: true, backend: 'docker' }),
      'apple-container',
    );
    expect(provisioning?.runtimeKind).toBe('docker');
    expect(provisioning?.catalogPath).toBe(getStagedCatalogPath('docker'));
  });
});

describe('catalog image sources', () => {
  it('covers every required role with an existing Dockerfile', () => {
    const sources = catalogImageSources();
    expect(sources.map((source) => source.role).sort()).toEqual([...REQUIRED_PRELOADED_IMAGE_ROLES].sort());
    for (const source of sources) {
      expect(existsSync(source.dockerfile), `${source.role} Dockerfile missing`).toBe(true);
      expect(existsSync(source.contextDir), `${source.role} context missing`).toBe(true);
    }
  });

  it('names agent roles by their exact runtime image and marks them agent-hashed', () => {
    const byRole = new Map(catalogImageSources().map((source) => [source.role, source]));
    expect(byRole.get('agent-claude-code')?.logicalName).toBe('ironcurtain-claude-code:latest');
    expect(byRole.get('agent-codex')?.logicalName).toBe('ironcurtain-codex:latest');
    expect(byRole.get('agent-goose')?.logicalName).toBe('ironcurtain-goose:latest');
    for (const role of ['agent-claude-code', 'agent-codex', 'agent-goose'] as const) {
      expect(byRole.get(role)?.hashKind).toBe('agent');
    }
    expect(byRole.get('base')?.hashKind).toBe('content');
  });
});

describe('ensureDockerImage preloaded call path', () => {
  it('resolves the immutable ID with zero build or pull calls', async () => {
    const image = 'ironcurtain-claude-code:latest';
    const { computeAgentImageBuildHash, ensureDockerImage } = await import('../../src/docker/docker-infrastructure.js');
    const directory = mkdtempSync(join(tmpdir(), 'ensure-docker-preloaded-'));
    temporaryDirectories.push(directory);
    const generation = 'catalog-preflight.1';
    const architecture = arch() === 'arm64' ? 'arm64' : 'amd64';
    const entry = writeOciArchiveFixture({
      directory,
      logicalName: image,
      buildHash: computeAgentImageBuildHash(image),
      architecture,
      catalogGeneration: generation,
    });
    const catalog: PreloadedImageCatalog = {
      schemaVersion: 1,
      runtimeKind: 'docker',
      generation,
      createdAt: '2026-07-20T12:00:00.000Z',
      images: [entry],
    };
    const catalogPath = join(directory, 'preloaded-catalog.docker.json');
    writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o444 });

    const buildImage = vi.fn(async () => {
      throw new Error('buildImage must not be called in preloaded mode');
    });
    const pullImage = vi.fn(async () => {
      throw new Error('pullImage must not be called in preloaded mode');
    });
    const mockRuntime = {
      buildImage,
      pullImage,
      loadImageArchive: vi.fn(async () => {}),
      inspectImage: vi.fn(async () => ({
        id: entry.runtimeImageId,
        repoTags: [image],
        created: entry.provenance.createdAt,
        labels: buildPreloadedImageLabels(entry, generation),
      })),
    } as unknown as ContainerRuntime;
    createContainerRuntime.mockReturnValue(mockRuntime);

    // Explicit provisioning is the test override seam; the fuse stays inert
    // because the config leaves the capability disabled.
    await ensureDockerImage('claude-code', { containerRuntime: 'docker' } as ResolvedUserConfig, {
      imageMode: 'preloaded-catalog',
      catalogPath,
      runtimeKind: 'docker',
      architecture,
    });

    expect(buildImage).not.toHaveBeenCalled();
    expect(pullImage).not.toHaveBeenCalled();
  });
});
