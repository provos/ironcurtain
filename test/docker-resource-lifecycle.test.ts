import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIronCurtainInternalNetwork,
  ironCurtainInternalSubnetHostAddress,
  InternalNetworkConnectivityError,
  IRONCURTAIN_CREATED_AT_LABEL,
  IRONCURTAIN_MANAGED_LABEL,
  IRONCURTAIN_OWNER_PID_LABEL,
  IRONCURTAIN_OWNER_SCOPE_LABEL,
  IRONCURTAIN_OWNER_TOKEN_LABEL,
  managedResourceLabels,
  reconcileIronCurtainDockerResources,
  reconcileIronCurtainDockerResourcesBestEffort,
  releaseManagedResourceLease,
  selectIronCurtainInternalSubnet,
  withInternalNetworkAllocationRetry,
} from '../src/docker/docker-resource-lifecycle.js';
import type { ContainerRuntime, DockerContainerInfo, DockerNetworkInfo } from '../src/docker/types.js';

function runtimeWithInventory(input: {
  containers?: DockerContainerInfo[];
  networks?: DockerNetworkInfo[];
  createNetwork?: ContainerRuntime['createNetwork'];
}): ContainerRuntime {
  return {
    supportsImageSnapshots: true,
    listContainers: vi.fn(async () => input.containers ?? []),
    listNetworks: vi.fn(async () => input.networks ?? []),
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

  it('does not reclaim live resources owned by another IronCurtain home', async () => {
    const productionHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-production-home-'));
    process.env.IRONCURTAIN_HOME = productionHome;
    const labels = managedResourceLabels('production-bundle');

    process.env.IRONCURTAIN_HOME = home;
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });

    try {
      const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => true });

      expect(labels[IRONCURTAIN_OWNER_SCOPE_LABEL]).toBeTruthy();
      expect(result.retainedActiveResources).toBe(2);
      expect(docker.remove).not.toHaveBeenCalled();
      expect(docker.removeNetwork).not.toHaveBeenCalled();
    } finally {
      process.env.IRONCURTAIN_HOME = productionHome;
      releaseManagedResourceLease('production-bundle');
      process.env.IRONCURTAIN_HOME = home;
      rmSync(productionHome, { recursive: true, force: true });
    }
  });

  it('uses the same owner scope for symlink aliases of one IronCurtain home', () => {
    const alias = `${home}-alias`;
    symlinkSync(home, alias, 'dir');
    process.env.IRONCURTAIN_HOME = alias;
    const aliasLabels = managedResourceLabels('alias-bundle');
    process.env.IRONCURTAIN_HOME = home;
    const directLabels = managedResourceLabels('direct-bundle');

    try {
      expect(aliasLabels[IRONCURTAIN_OWNER_SCOPE_LABEL]).toBe(directLabels[IRONCURTAIN_OWNER_SCOPE_LABEL]);
    } finally {
      process.env.IRONCURTAIN_HOME = alias;
      releaseManagedResourceLease('alias-bundle');
      process.env.IRONCURTAIN_HOME = home;
      releaseManagedResourceLease('direct-bundle');
      rmSync(alias, { force: true });
    }
  });

  it('never reclaims foreign-home resources even when their recorded owner is dead', async () => {
    const foreignHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-foreign-home-'));
    process.env.IRONCURTAIN_HOME = foreignHome;
    const labels = managedResourceLabels('foreign-bundle');
    process.env.IRONCURTAIN_HOME = home;
    const docker = runtimeWithInventory({ containers: [container({ labels })] });

    try {
      await reconcileIronCurtainDockerResources(docker, { pidAlive: () => false });
      expect(docker.remove).not.toHaveBeenCalled();
    } finally {
      process.env.IRONCURTAIN_HOME = foreignHome;
      releaseManagedResourceLease('foreign-bundle');
      process.env.IRONCURTAIN_HOME = home;
      rmSync(foreignHome, { recursive: true, force: true });
    }
  });

  it('preserves live managed resources created before owner scopes were labeled', async () => {
    const labels = {
      [IRONCURTAIN_MANAGED_LABEL]: 'true',
      [IRONCURTAIN_OWNER_PID_LABEL]: '424242',
      [IRONCURTAIN_OWNER_TOKEN_LABEL]: 'legacy-live-owner',
      [IRONCURTAIN_CREATED_AT_LABEL]: '2026-08-24T12:00:00.000Z',
      'ironcurtain.bundle': 'legacy-live-bundle',
    };
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });

    const result = await reconcileIronCurtainDockerResources(docker, {
      pidAlive: () => true,
      processIdentity: () => ({ bootId: 'same-boot', startedAt: '2026-08-24T11:59:00.000Z' }),
    });

    expect(result.retainedActiveResources).toBe(2);
    expect(docker.remove).not.toHaveBeenCalled();
    expect(docker.removeNetwork).not.toHaveBeenCalled();
  });

  it('preserves a live pre-scope resource when process identity is unavailable', async () => {
    const labels = {
      [IRONCURTAIN_MANAGED_LABEL]: 'true',
      [IRONCURTAIN_OWNER_PID_LABEL]: '424242',
      [IRONCURTAIN_OWNER_TOKEN_LABEL]: 'legacy-unknown-owner',
      [IRONCURTAIN_CREATED_AT_LABEL]: '2026-08-24T12:00:00.000Z',
      'ironcurtain.bundle': 'legacy-unknown-bundle',
    };
    const docker = runtimeWithInventory({ containers: [container({ labels })] });

    const result = await reconcileIronCurtainDockerResources(docker, {
      pidAlive: () => true,
      processIdentity: (pid) => (pid === process.pid ? { bootId: 'same-boot', startedAt: 'test-process' } : undefined),
    });

    expect(result.retainedActiveResources).toBe(1);
    expect(docker.remove).not.toHaveBeenCalled();
  });

  it('preserves current-scope resources when a live owner lease is unavailable', async () => {
    const labels = managedResourceLabels('bundle-current-unattributed');
    releaseManagedResourceLease('bundle-current-unattributed');
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => true });

    expect(result.retainedActiveResources).toBe(2);
    expect(docker.remove).not.toHaveBeenCalled();
    expect(docker.removeNetwork).not.toHaveBeenCalled();
  });

  it('reclaims pre-scope resources when their recorded PID was recycled', async () => {
    const labels = {
      [IRONCURTAIN_MANAGED_LABEL]: 'true',
      [IRONCURTAIN_OWNER_PID_LABEL]: '424242',
      [IRONCURTAIN_OWNER_TOKEN_LABEL]: 'legacy-recycled-owner',
      [IRONCURTAIN_CREATED_AT_LABEL]: '2026-08-24T12:00:00.000Z',
      'ironcurtain.bundle': 'legacy-recycled-bundle',
    };
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });
    const leaseDir = resolve(home, 'run', 'docker-owners');
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(
      resolve(leaseDir, 'legacy-recycled-owner.json'),
      JSON.stringify({
        token: 'legacy-recycled-owner',
        pid: 424242,
        identity: { bootId: 'same-boot', startedAt: 'original-process' },
      }),
    );

    const result = await reconcileIronCurtainDockerResources(docker, {
      pidAlive: () => true,
      processIdentity: (pid) => ({
        bootId: 'same-boot',
        startedAt: pid === 424242 ? 'recycled-process' : 'test-process',
      }),
    });

    expect(result.removedContainers).toEqual(['ironcurtain-1234567890ab']);
    expect(result.removedNetworks).toEqual(['ironcurtain-1234567890ab']);
    expect(docker.remove).toHaveBeenCalledWith('container-id');
    expect(docker.removeNetwork).toHaveBeenCalledWith('ironcurtain-1234567890ab');
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

  it('reclaims a lease when its PID was recycled by another process', async () => {
    const labels = managedResourceLabels('bundle-recycled-pid');
    const docker = runtimeWithInventory({ networks: [network({ labels })] });

    const result = await reconcileIronCurtainDockerResources(docker, {
      pidAlive: () => true,
      processIdentity: () => ({ bootId: 'same-boot', startedAt: 'different-process-start' }),
    });

    expect(result.removedNetworks).toEqual(['ironcurtain-1234567890ab']);
    expect(docker.removeNetwork).toHaveBeenCalledWith('ironcurtain-1234567890ab');
  });

  it('replaces a reconciliation lock held by a recycled PID', async () => {
    const lockRoot = resolve(home, 'run', 'docker-owners');
    mkdirSync(lockRoot, { recursive: true });
    writeFileSync(
      resolve(lockRoot, 'reconcile.lock'),
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        processIdentity: 'old-boot:old-process',
        token: '00000000-0000-4000-8000-000000000001',
        createdAtMs: Date.now(),
      }),
    );
    const docker = runtimeWithInventory({});

    await reconcileIronCurtainDockerResources(docker, {
      processIdentity: () => ({ bootId: 'current-boot', startedAt: 'current-process' }),
    });

    expect(docker.listContainers).toHaveBeenCalledOnce();
    expect(docker.listNetworks).toHaveBeenCalledOnce();
  });

  it('keeps startup reconciliation best-effort when Docker inventory fails', async () => {
    const docker = runtimeWithInventory({});
    vi.mocked(docker.listContainers!).mockRejectedValueOnce(new Error('concurrent inspect failure'));

    await expect(reconcileIronCurtainDockerResourcesBestEffort(docker, 'test startup')).resolves.toBeUndefined();
  });

  it('retains a failed teardown while its released owner process is still live', async () => {
    const labels = managedResourceLabels('bundle-released');
    releaseManagedResourceLease('bundle-released');
    const docker = runtimeWithInventory({ networks: [network({ labels })] });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => true });

    expect(result.retainedActiveResources).toBe(1);
    expect(result.removedNetworks).toEqual([]);
    expect(docker.removeNetwork).not.toHaveBeenCalled();
  });

  it('releases a lease once its matching container was removed even if its network remains attached', async () => {
    const labels = managedResourceLabels('bundle-container-removed');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    const leasePath = resolve(home, 'run', 'docker-owners', `${token}.json`);
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['other-container'] })],
    });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => false });

    expect(result.removedContainers).toEqual(['ironcurtain-1234567890ab']);
    expect(result.skippedUnsafeNetworks).toEqual(['ironcurtain-1234567890ab']);
    expect(existsSync(leasePath)).toBe(false);
  });

  it('keeps a lease when Docker still reports its container after removal', async () => {
    const labels = managedResourceLabels('bundle-container-still-exists');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    const leasePath = resolve(home, 'run', 'docker-owners', `${token}.json`);
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });
    vi.mocked(docker.containerExists).mockResolvedValue(true);

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => false });

    expect(docker.remove).toHaveBeenCalledWith('container-id');
    expect(result.removedContainers).toEqual([]);
    expect(result.skippedUnsafeNetworks).toEqual(['ironcurtain-1234567890ab']);
    expect(existsSync(leasePath)).toBe(true);
  });

  it('keeps a lease when Docker still reports its network after removal', async () => {
    const labels = managedResourceLabels('bundle-network-still-exists');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    const leasePath = resolve(home, 'run', 'docker-owners', `${token}.json`);
    const docker = runtimeWithInventory({ networks: [network({ labels })] });
    vi.mocked(docker.networkExists).mockResolvedValue(true);

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => false });

    expect(docker.removeNetwork).toHaveBeenCalledWith('ironcurtain-1234567890ab');
    expect(result.removedNetworks).toEqual([]);
    expect(existsSync(leasePath)).toBe(true);
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

  it('selects around Docker collisions without creating a network', async () => {
    const name = 'ic-dw-egress-selection-test';
    const baseline = await selectIronCurtainInternalSubnet(runtimeWithInventory({}), name, { hostCidrs: [] });
    const createNetwork = vi.fn(async () => {});
    const docker = runtimeWithInventory({
      networks: [network({ name: 'unrelated-network', subnets: [baseline] })],
      createNetwork,
    });

    const selected = await selectIronCurtainInternalSubnet(docker, name, { hostCidrs: [] });

    expect(selected).toMatch(/\/29$/u);
    expect(selected).not.toBe(baseline);
    expect(createNetwork).not.toHaveBeenCalled();
  });

  it('derives only usable host addresses from allocator-selected /29 networks', () => {
    expect(ironCurtainInternalSubnetHostAddress('172.24.10.8/29', 2)).toBe('172.24.10.10');
    expect(ironCurtainInternalSubnetHostAddress('172.24.10.8/29', 4)).toBe('172.24.10.12');
    expect(() => ironCurtainInternalSubnetHostAddress('172.24.10.0/24', 2)).toThrow(/IPv4 \/29/u);
    expect(() => ironCurtainInternalSubnetHostAddress('172.24.10.8/29', 7)).toThrow(/six usable/u);
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

  it('shares failed-pool exclusion and reconciliation across allocation retries', async () => {
    const docker = runtimeWithInventory({});
    const reconcile = vi.fn(async () => {});
    const attempts: ReadonlySet<string>[] = [];

    const result = await withInternalNetworkAllocationRetry(
      { maxAttempts: 2, description: 'Test network', reconcile },
      async (excludedSubnets, attempt) => {
        attempts.push(new Set(excludedSubnets));
        if (attempt === 1) throw new InternalNetworkConnectivityError('unreachable', '172.20.1.0/29');
        return 'allocated';
      },
    );

    expect(result).toBe('allocated');
    expect(attempts[0]).toEqual(new Set());
    expect(attempts[1]).toEqual(new Set(['172.20.0.0/14']));
    expect(reconcile).toHaveBeenCalledOnce();
    expect(docker.removeNetwork).not.toHaveBeenCalled();
  });
});
