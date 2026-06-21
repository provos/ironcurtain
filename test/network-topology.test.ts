import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveNetworkTopology,
  gatewayForSubnet,
  createHostOnlyNetwork,
  makeSourceAddressGuard,
  HOST_ONLY_SUBNET_POOL,
} from '../src/docker/network-topology.js';
import { resolveRuntimeKind, resetRuntimeKindResolutionForTests } from '../src/docker/container-runtime.js';
import type { DockerAvailability } from '../src/docker/docker-probe.js';
import type { ContainerRuntime } from '../src/docker/types.js';

function overlapError(subnet: string): Error {
  return Object.assign(new Error('Command failed'), {
    code: 1,
    stdout: '',
    stderr: `Error: IPv4 subnet ${subnet} overlaps an existing network with subnet ${subnet}`,
  });
}

/** Minimal ContainerRuntime stub covering the methods createHostOnlyNetwork touches. */
function makeNetworkRuntime(behavior: {
  failSubnets?: ReadonlySet<string>;
  failAll?: boolean;
  gateway?: string;
  createError?: Error;
}): {
  runtime: ContainerRuntime;
  createAttempts: string[];
  removedNetworks: string[];
} {
  const createAttempts: string[] = [];
  const removedNetworks: string[] = [];
  const runtime = {
    async removeNetwork(name: string) {
      removedNetworks.push(name);
    },
    async createNetwork(_name: string, options?: { internal?: boolean; subnet?: string }) {
      const subnet = options?.subnet ?? '';
      createAttempts.push(subnet);
      if (behavior.createError) throw behavior.createError;
      if (behavior.failAll || behavior.failSubnets?.has(subnet)) throw overlapError(subnet);
    },
    async getNetworkGateway() {
      return behavior.gateway;
    },
  } as unknown as ContainerRuntime;
  return { runtime, createAttempts, removedNetworks };
}

describe('resolveNetworkTopology', () => {
  it('always picks tcp-hostonly for apple-container', () => {
    expect(resolveNetworkTopology('apple-container', true)).toBe('tcp-hostonly');
    expect(resolveNetworkTopology('apple-container', false)).toBe('tcp-hostonly');
  });

  it('keeps the Docker platform split', () => {
    expect(resolveNetworkTopology('docker', true)).toBe('tcp-sidecar');
    expect(resolveNetworkTopology('docker', false)).toBe('uds');
  });
});

describe('gatewayForSubnet', () => {
  it('derives the .1 address', () => {
    expect(gatewayForSubnet('192.168.205.0/24')).toBe('192.168.205.1');
  });

  it('throws on malformed subnets', () => {
    expect(() => gatewayForSubnet('not-a-subnet')).toThrow(/Cannot derive gateway/);
  });
});

describe('HOST_ONLY_SUBNET_POOL', () => {
  it('contains unique /24 candidates clear of the runtime default network', () => {
    expect(new Set(HOST_ONLY_SUBNET_POOL).size).toBe(HOST_ONLY_SUBNET_POOL.length);
    expect(HOST_ONLY_SUBNET_POOL).not.toContain('192.168.64.0/24');
    for (const subnet of HOST_ONLY_SUBNET_POOL) {
      expect(subnet).toMatch(/^192\.168\.\d+\.0\/24$/);
    }
  });
});

describe('createHostOnlyNetwork', () => {
  it('removes a stale same-named network before creating', async () => {
    const { runtime, removedNetworks } = makeNetworkRuntime({});
    await createHostOnlyNetwork(runtime, 'ironcurtain-abc');
    expect(removedNetworks).toEqual(['ironcurtain-abc']);
  });

  it('returns the created subnet with a derived gateway', async () => {
    const { runtime, createAttempts } = makeNetworkRuntime({ gateway: undefined });
    const net = await createHostOnlyNetwork(runtime, 'ironcurtain-abc');
    expect(createAttempts).toHaveLength(1);
    expect(net.subnet).toBe(createAttempts[0]);
    expect(net.gateway).toBe(gatewayForSubnet(net.subnet));
    expect(HOST_ONLY_SUBNET_POOL).toContain(net.subnet);
  });

  it("prefers the runtime's reported gateway over the derived one", async () => {
    const { runtime } = makeNetworkRuntime({ gateway: '192.168.99.1' });
    const net = await createHostOnlyNetwork(runtime, 'ironcurtain-abc');
    expect(net.gateway).toBe('192.168.99.1');
  });

  it('walks the pool past overlapping subnets', async () => {
    // Fail the first two candidates this name hashes to; succeed on the third.
    const probe = makeNetworkRuntime({ failAll: true });
    await expect(createHostOnlyNetwork(probe.runtime, 'ironcurtain-walk')).rejects.toThrow();
    const order = probe.createAttempts;

    const { runtime, createAttempts } = makeNetworkRuntime({ failSubnets: new Set(order.slice(0, 2)) });
    const net = await createHostOnlyNetwork(runtime, 'ironcurtain-walk');
    expect(createAttempts).toHaveLength(3);
    expect(net.subnet).toBe(order[2]);
  });

  it('throws a remediation error when the whole pool overlaps', async () => {
    const { runtime, createAttempts } = makeNetworkRuntime({ failAll: true });
    await expect(createHostOnlyNetwork(runtime, 'ironcurtain-abc')).rejects.toThrow(/No free host-only subnet/);
    expect(createAttempts).toHaveLength(HOST_ONLY_SUBNET_POOL.length);
  });

  it('rethrows non-overlap errors without walking', async () => {
    const createError = Object.assign(new Error('boom'), { code: 1, stdout: '', stderr: 'apiserver not running' });
    const { runtime, createAttempts } = makeNetworkRuntime({ createError });
    await expect(createHostOnlyNetwork(runtime, 'ironcurtain-abc')).rejects.toThrow(/boom/);
    expect(createAttempts).toHaveLength(1);
  });
});

describe('makeSourceAddressGuard', () => {
  const guard = makeSourceAddressGuard('192.168.205.0/24');

  it('admits addresses inside the subnet', () => {
    expect(guard('192.168.205.2')).toBe(true);
    expect(guard('::ffff:192.168.205.17')).toBe(true);
  });

  it('admits loopback', () => {
    expect(guard('127.0.0.1')).toBe(true);
    expect(guard('::1')).toBe(true);
    expect(guard('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(guard('192.168.1.10')).toBe(false);
    expect(guard('10.0.0.5')).toBe(false);
    expect(guard('::ffff:10.0.0.5')).toBe(false);
    // Prefix trickery: 192.168.20.5 must not match 192.168.205.x
    expect(guard('192.168.20.5')).toBe(false);
    expect(guard(undefined)).toBe(false);
  });
});

describe('resolveRuntimeKind', () => {
  const available = async (): Promise<DockerAvailability> => ({ available: true });
  const unavailable = async (): Promise<DockerAvailability> => ({
    available: false,
    reason: 'container CLI not installed',
    detailedMessage: 'not installed',
  });
  const neverProbe = async (): Promise<DockerAvailability> => {
    throw new Error('probe must not run for explicit settings');
  };

  beforeEach(() => {
    resetRuntimeKindResolutionForTests();
  });

  it('honors explicit config without probing', async () => {
    expect(await resolveRuntimeKind('docker', {}, neverProbe)).toBe('docker');
    expect(await resolveRuntimeKind('apple-container', {}, neverProbe)).toBe('apple-container');
  });

  it('lets the env override beat the config field', async () => {
    expect(await resolveRuntimeKind('docker', { IRONCURTAIN_CONTAINER_RUNTIME: 'apple-container' }, neverProbe)).toBe(
      'apple-container',
    );
    expect(await resolveRuntimeKind('auto', { IRONCURTAIN_CONTAINER_RUNTIME: 'docker' }, neverProbe)).toBe('docker');
    // Empty env value falls through to the config field.
    expect(await resolveRuntimeKind('docker', { IRONCURTAIN_CONTAINER_RUNTIME: '' }, neverProbe)).toBe('docker');
  });

  it('fails loudly on unknown env values', async () => {
    await expect(resolveRuntimeKind('auto', { IRONCURTAIN_CONTAINER_RUNTIME: 'podman' }, neverProbe)).rejects.toThrow(
      /Unknown/,
    );
  });

  it('auto picks apple-container when the probe passes, docker otherwise', async () => {
    expect(await resolveRuntimeKind('auto', {}, available)).toBe('apple-container');
    resetRuntimeKindResolutionForTests();
    expect(await resolveRuntimeKind('auto', {}, unavailable)).toBe('docker');
  });

  it('memoizes the auto probe across resolution sites', async () => {
    let probes = 0;
    const counting = async (): Promise<DockerAvailability> => {
      probes++;
      return { available: true };
    };
    expect(await resolveRuntimeKind('auto', {}, counting)).toBe('apple-container');
    expect(await resolveRuntimeKind('auto', {}, counting)).toBe('apple-container');
    expect(probes).toBe(1);
  });
});
