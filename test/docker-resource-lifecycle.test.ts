import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIronCurtainInternalNetwork,
  IRONCURTAIN_MANAGED_LABEL,
  IRONCURTAIN_OWNER_PID_LABEL,
  IRONCURTAIN_OWNER_TOKEN_LABEL,
  managedResourceLabels,
  reconcileIronCurtainDockerResources,
  releaseManagedResourceLease,
} from '../src/docker/docker-resource-lifecycle.js';
import type { ContainerRuntime, DockerContainerInfo, DockerNetworkInfo } from '../src/docker/types.js';

function runtimeWithInventory(input: {
  containers?: DockerContainerInfo[];
  networks?: DockerNetworkInfo[];
  createNetwork?: ContainerRuntime['createNetwork'];
}): ContainerRuntime {
  return {
    supportsImageSnapshots: true,
    async listContainers() {
      return input.containers ?? [];
    },
    async listNetworks() {
      return input.networks ?? [];
    },
    createNetwork: input.createNetwork ?? vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    removeNetwork: vi.fn(async () => {}),
    containerExists: vi.fn(async () => false),
    networkExists: vi.fn(async () => false),
  } as unknown as ContainerRuntime;
}

function network(overrides: Partial<DockerNetworkInfo> = {}): DockerNetworkInfo {
  return {
    id: 'network-id',
    name: 'ironcurtain-1234567890ab',
    created: '2020-01-01T00:00:00.000Z',
    labels: {},
    subnets: ['172.20.0.0/29'],
    containerIds: [],
    ...overrides,
  };
}

function container(overrides: Partial<DockerContainerInfo> = {}): DockerContainerInfo {
  return {
    id: 'container-id',
    name: 'ironcurtain-1234567890ab',
    created: '2020-01-01T00:00:00.000Z',
    running: true,
    labels: {},
    ...overrides,
  };
}

describe('Docker resource crash reconciliation', () => {
  let home: string;
  const previousHome = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-docker-gc-'));
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('preserves resources whose owner process and lease are live', async () => {
    const labels = managedResourceLabels('bundle-live');
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => true });

    expect(result.retainedActiveResources).toBe(2);
    expect(docker.remove).not.toHaveBeenCalled();
    expect(docker.removeNetwork).not.toHaveBeenCalled();
  });

  it('force-removes managed containers and networks after owner death', async () => {
    const labels = {
      [IRONCURTAIN_MANAGED_LABEL]: 'true',
      [IRONCURTAIN_OWNER_PID_LABEL]: '424242',
      [IRONCURTAIN_OWNER_TOKEN_LABEL]: 'dead-owner',
      'ironcurtain.bundle': 'bundle-dead',
    };
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => false });

    expect(result.removedContainers).toEqual(['ironcurtain-1234567890ab']);
    expect(result.removedNetworks).toEqual(['ironcurtain-1234567890ab']);
    expect(docker.remove).toHaveBeenCalledWith('container-id');
    expect(docker.removeNetwork).toHaveBeenCalledWith('ironcurtain-1234567890ab');
  });

  it('reclaims a failed teardown in the same live process after its bundle lease is released', async () => {
    const labels = managedResourceLabels('bundle-released');
    releaseManagedResourceLease('bundle-released');
    const docker = runtimeWithInventory({ networks: [network({ labels })] });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => true });

    expect(result.removedNetworks).toEqual(['ironcurtain-1234567890ab']);
  });

  it('migrates only empty, aged legacy networks', async () => {
    const docker = runtimeWithInventory({ networks: [network()] });
    const result = await reconcileIronCurtainDockerResources(docker, {
      now: new Date('2020-01-01T00:10:00.000Z'),
      legacyGraceMs: 60_000,
    });
    expect(result.removedNetworks).toEqual(['ironcurtain-1234567890ab']);
  });

  it('never removes a network with an attachment it cannot prove is orphaned', async () => {
    const labels = {
      [IRONCURTAIN_MANAGED_LABEL]: 'true',
      [IRONCURTAIN_OWNER_PID_LABEL]: '424242',
      [IRONCURTAIN_OWNER_TOKEN_LABEL]: 'dead-owner',
      'ironcurtain.bundle': 'bundle-dead',
    };
    const docker = runtimeWithInventory({
      networks: [network({ labels, containerIds: ['foreign-container'] })],
    });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => false });

    expect(result.skippedUnsafeNetworks).toEqual(['ironcurtain-1234567890ab']);
    expect(docker.removeNetwork).not.toHaveBeenCalled();
  });
});

describe('IronCurtain Docker subnet allocator', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-docker-ipam-'));
    process.env.IRONCURTAIN_HOME = home;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('allocates a labeled /29 outside 192.168/16 and host interface routes', async () => {
    const createNetwork = vi.fn(async () => {});
    const docker = runtimeWithInventory({ createNetwork });
    const allocated = await createIronCurtainInternalNetwork(docker, 'ironcurtain-abcdef123456', 'bundle-1', {
      hostCidrs: ['172.20.0.0/14'],
    });

    expect(allocated.subnet).toMatch(/\/29$/);
    expect(allocated.subnet).not.toMatch(/^192\.168\./);
    expect(allocated.subnet).not.toMatch(/^172\.(2[0-3])\./);
    expect(createNetwork).toHaveBeenCalledWith(
      'ironcurtain-abcdef123456',
      expect.objectContaining({
        internal: true,
        subnet: allocated.subnet,
        labels: expect.objectContaining({ [IRONCURTAIN_MANAGED_LABEL]: 'true' }),
      }),
    );
  });

  it('walks to another /29 when Docker reports an overlap race', async () => {
    const attempts: string[] = [];
    const createNetwork = vi.fn(async (_name: string, options?: { subnet?: string }) => {
      attempts.push(options?.subnet ?? '');
      if (attempts.length === 1) {
        throw Object.assign(new Error('overlap'), {
          code: 1,
          stdout: '',
          stderr: 'Pool overlaps with other one on this address space',
        });
      }
    });
    const docker = runtimeWithInventory({ createNetwork });
    const allocated = await createIronCurtainInternalNetwork(docker, 'ironcurtain-race000000', 'bundle-2', {
      hostCidrs: [],
    });

    expect(attempts).toHaveLength(2);
    expect(allocated.subnet).toBe(attempts[1]);
    expect(attempts[0]).not.toBe(attempts[1]);
  });
});
