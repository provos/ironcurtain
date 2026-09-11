import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadDockerWorkloadLease,
  requestDockerWorkloadOuterResource,
  revokeDockerWorkloadLease,
} from '../../src/docker-workload/bundle-lease.js';
import {
  performSerializedDockerWorkloadCleanup,
  tryAcquireDockerWorkloadLifecycleClaim,
} from '../../src/docker-workload/cleanup-ownership.js';
import { DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY } from '../../src/docker-workload/infrastructure.js';
import { createQualificationObserverContainer } from '../../src/docker-workload/qualification-observer.js';
import type { DockerContainerConfig, DockerContainerInfo, DockerVolumeInfo } from '../../src/docker/types.js';
import { createMockDocker } from '../helpers/docker-mocks.js';
import { createQualificationObserverLease } from '../helpers/qualification-observer-lease.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(runtimeKind: 'docker' | 'apple-container' = 'docker') {
  const root = mkdtempSync(join(tmpdir(), 'ic-observer-lifecycle-'));
  roots.push(root);
  const { leasePath, generation } = createQualificationObserverLease(root, runtimeKind);
  const labels = { [DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY]: generation };
  const containers: DockerContainerInfo[] = [];
  const volumes: DockerVolumeInfo[] = [
    { id: 'daemon-api', name: 'daemon-api', labels, created: '', driver: 'local', mountpoint: '' },
  ];
  const remove = vi.fn(async (id: string) => {
    const index = containers.findIndex((container) => container.id === id);
    if (index !== -1) containers.splice(index, 1);
  });
  const removeVolume = vi.fn(async () => {
    if (containers.some((container) => container.id === 'helper-id')) throw new Error('volume is still mounted');
    volumes.splice(0);
  });
  const runtime = {
    ...createMockDocker(),
    create: vi.fn(async (config: DockerContainerConfig) => {
      expect(loadDockerWorkloadLease(leasePath).resources.at(-1)).toMatchObject({
        requestedName: config.name,
        role: 'qualification-observer',
        observedId: null,
      });
      expect(() => tryAcquireDockerWorkloadLifecycleClaim({ leasePath })).toThrow();
      containers.push({ id: 'helper-id', name: config.name, labels: config.labels!, running: false, created: '' });
      return 'helper-id';
    }),
    listContainers: async () => structuredClone(containers),
    listVolumes: async () => structuredClone(volumes),
    remove,
    removeVolume,
  };
  const config: DockerContainerConfig = {
    name: 'qualification-snapshot',
    image: 'selected-agent-image',
    mounts: [],
    network: 'none',
    env: {},
    command: [],
    trustedCreateOptions: {
      namedVolumeMounts: [{ name: 'daemon-api', target: '/state', readonly: true, noCopy: true }],
    },
  };
  const create = () => createQualificationObserverContainer({ runtime, leasePath, generation, config });
  const cleanup = () => {
    const lease = loadDockerWorkloadLease(leasePath);
    if (lease.schemaVersion !== 2) throw new Error('expected current lease');
    const policy = lease.bindings.watchdogPolicy;
    let nowMs = Date.now();
    return performSerializedDockerWorkloadCleanup({
      runtime,
      leasePath,
      generation,
      targetDevice: policy.targetDevice,
      targetInode: policy.targetInode,
      gapMs: policy.cleanupInventoryGapMs,
      clock: () => new Date(nowMs),
      sleep: async (milliseconds) => {
        await delay(milliseconds);
        nowMs += milliseconds;
      },
      waitForOwner: true,
    });
  };
  return { root, leasePath, generation, runtime, config, containers, volumes, create, cleanup };
}

describe('qualification observer durable lifecycle', () => {
  it.each(['before-create', 'response-lost', 'observed', 'removed-locally'] as const)(
    'revokes and closes the lease after interruption at %s',
    async (window) => {
      const f = fixture();
      const create = f.runtime.create.getMockImplementation()!;
      f.runtime.create.mockImplementation(async (config) => {
        if (window === 'before-create') throw new Error('observer interrupted');
        const id = await create(config);
        if (window === 'response-lost') throw new Error('create response lost');
        return id;
      });
      if (window === 'before-create' || window === 'response-lost') await expect(f.create()).rejects.toThrow();
      else expect(await f.create()).toBe('helper-id');
      if (window === 'removed-locally') await f.runtime.remove('helper-id');
      const pending = loadDockerWorkloadLease(f.leasePath).resources.at(-1)!;
      expect(pending.observedId).toBe(window === 'before-create' || window === 'response-lost' ? null : 'helper-id');
      expect(await f.cleanup()).toMatchObject({ cleanup: { exactOuterResourcesAbsent: true, stateRootAbsent: true } });
      const closed = loadDockerWorkloadLease(f.leasePath);
      expect(closed.status).toBe('closed');
      expect(closed.resources.at(-1)).toMatchObject({
        observedId: window === 'before-create' ? null : 'helper-id',
        removal: {
          proof: window === 'before-create' ? 'requested-name-absent' : 'immutable-id-absent',
          identity: window === 'before-create' ? f.config.name : 'helper-id',
        },
      });
      expect(f.containers).toEqual([]);
      expect(f.volumes).toEqual([]);
      expect(existsSync(closed.paths.stateRoot)).toBe(false);
    },
  );

  it('holds cleanup behind runtime creation, then removes the helper before its mounted API volume', async () => {
    const f = fixture();
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let signalProceed!: () => void;
    const proceed = new Promise<void>((resolve) => {
      signalProceed = resolve;
    });
    const create = f.runtime.create.getMockImplementation()!;
    f.runtime.create.mockImplementation(async (config) => {
      const id = await create(config);
      signalEntered();
      await proceed;
      return id;
    });
    const creating = f.create();
    await entered;
    const cleaning = f.cleanup();
    try {
      await delay(75);
      expect(loadDockerWorkloadLease(f.leasePath).status).toBe('active');
      expect(f.runtime.remove).not.toHaveBeenCalled();
      expect(f.runtime.removeVolume).not.toHaveBeenCalled();
    } finally {
      signalProceed();
    }
    expect(await creating).toBe('helper-id');
    await cleaning;
    expect(f.runtime.remove).toHaveBeenCalledWith('helper-id');
    expect(f.runtime.removeVolume).toHaveBeenCalledOnce();
    expect(loadDockerWorkloadLease(f.leasePath).status).toBe('closed');
  });

  it('rechecks status after acquiring a claim that cleanup held first', async () => {
    const f = fixture();
    const claim = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: f.leasePath });
    const creating = f.create();
    revokeDockerWorkloadLease(f.leasePath, f.generation);
    claim.release();
    await expect(creating).rejects.toThrow('same active Docker lease generation');
    expect(f.runtime.create).not.toHaveBeenCalled();
    expect(loadDockerWorkloadLease(f.leasePath).resources).toHaveLength(3);
  });

  it('rejects a changed generation and Apple leases before any runtime create', async () => {
    const f = fixture();
    await expect(createQualificationObserverContainer({ ...f, generation: 'replacement-generation' })).rejects.toThrow(
      'same active Docker lease generation',
    );
    const apple = fixture('apple-container');
    await expect(apple.create()).rejects.toThrow('same active Docker lease generation');
    expect(f.runtime.create).not.toHaveBeenCalled();
    expect(apple.runtime.create).not.toHaveBeenCalled();
  });

  it.each([
    { runtimeKind: 'docker', kind: 'container', role: 'agent' },
    { runtimeKind: 'docker', kind: 'volume', role: 'qualification-observer' },
    { runtimeKind: 'apple-container', kind: 'container', role: 'qualification-observer' },
  ] as const)('keeps other active-lease resource mutations forbidden: %j', ({ runtimeKind, kind, role }) => {
    const f = fixture(runtimeKind);
    expect(() =>
      requestDockerWorkloadOuterResource(f.leasePath, f.generation, {
        requestId: 'unexpected-resource',
        kind,
        role,
        requestedName: 'unexpected',
        ownershipLabelKey: DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY,
      }),
    ).toThrow('only during admission');
    expect(loadDockerWorkloadLease(f.leasePath).resources).toHaveLength(3);
  });
});
