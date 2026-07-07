/**
 * Integration tests for the Apple `container` runtime backend.
 *
 * Gated on a live runtime (Apple silicon, macOS 26+, `container`
 * apiserver running) — skipped everywhere else, matching the Docker
 * integration tests' graceful-skip pattern. Exercises the real CLI:
 * host-only network creation from the subnet pool, the VM lifecycle,
 * egress blocking, and host↔container connectivity through a
 * subnet-guarded 0.0.0.0 listener (the tcp-hostonly topology's exact
 * proxy arrangement).
 *
 * Uses the small `alpine/socat` image (also used by the Docker sidecar
 * path), pulling it if absent.
 */

import { createServer, type Server } from 'node:net';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createAppleContainerManager, checkAppleContainerAvailable } from '../src/docker/apple-container-manager.js';
import {
  createHostOnlyNetwork,
  makeSourceAddressGuard,
  gatewayForSubnet,
  HOST_ONLY_SUBNET_POOL,
  type HostOnlyNetwork,
} from '../src/docker/network-topology.js';
import { TcpServerTransport } from '../src/trusted-process/tcp-server-transport.js';
import type { ContainerRuntime } from '../src/docker/types.js';

const probe = await checkAppleContainerAvailable();

const NETWORK_NAME = 'ironcurtain-itest-net';
const CONTAINER_NAME = 'ironcurtain-itest-c1';
const TEST_IMAGE = 'alpine/socat';

describe.skipIf(!probe.available)('apple-container runtime integration', () => {
  let docker: ContainerRuntime;
  let net: HostOnlyNetwork;

  beforeAll(async () => {
    docker = createAppleContainerManager();
    // Clean any leftovers from a previous crashed run.
    await docker.removeStaleContainer(CONTAINER_NAME);
    await docker.removeNetwork(NETWORK_NAME);

    if (!(await docker.imageExists(TEST_IMAGE))) {
      await docker.pullImage(TEST_IMAGE);
    }

    net = await createHostOnlyNetwork(docker, NETWORK_NAME);

    const containerId = await docker.create({
      image: TEST_IMAGE,
      name: CONTAINER_NAME,
      network: net.name,
      mounts: [],
      env: {},
      entrypoint: '/bin/sh',
      command: ['-c', 'sleep 300'],
      bundleLabel: 'itest-bundle',
    });
    await docker.start(containerId);
  }, 180_000);

  afterAll(async () => {
    await docker.stop(CONTAINER_NAME);
    await docker.remove(CONTAINER_NAME);
    await docker.removeNetwork(NETWORK_NAME);
  }, 60_000);

  it('creates the host-only network from the pool with the runtime-reported gateway', async () => {
    expect(HOST_ONLY_SUBNET_POOL).toContain(net.subnet);
    expect(net.gateway).toBe(gatewayForSubnet(net.subnet));
    expect(await docker.getNetworkGateway?.(net.name)).toBe(net.gateway);
  });

  it('reports lifecycle state and labels through inspect', async () => {
    expect(await docker.isRunning(CONTAINER_NAME)).toBe(true);
    expect(await docker.containerExists(CONTAINER_NAME)).toBe(true);
    expect(await docker.getContainerLabel(CONTAINER_NAME, 'ironcurtain.bundle')).toBe('itest-bundle');
    const ip = await docker.getContainerIp(CONTAINER_NAME, net.name);
    expect(ip.startsWith(net.subnet.split('/')[0].split('.').slice(0, 3).join('.') + '.')).toBe(true);
  });

  it('blocks internet egress from the host-only network', async () => {
    const egress = await docker.exec(
      CONTAINER_NAME,
      ['socat', '-u', '/dev/null', 'TCP:1.1.1.1:443,connect-timeout=3'],
      10_000,
      null,
    );
    expect(egress.exitCode).not.toBe(0);
  }, 30_000);

  it('reaches a subnet-guarded 0.0.0.0 host listener at the gateway (proxy arrangement)', async () => {
    const transport = new TcpServerTransport('0.0.0.0', 0, {
      allowRemoteAddress: makeSourceAddressGuard(net.subnet),
    });
    await transport.start();
    try {
      const reach = await docker.exec(
        CONTAINER_NAME,
        ['socat', '-u', '/dev/null', `TCP:${net.gateway}:${transport.port},connect-timeout=5`],
        10_000,
        null,
      );
      expect(reach.exitCode).toBe(0);
    } finally {
      await transport.close();
    }
  }, 30_000);

  it('removes stale containers by bundle label', async () => {
    // The running test container carries the bundle label, so the
    // stale-removal path accepts it. This also doubles as teardown
    // verification; afterAll's stop/remove become no-ops.
    expect(await docker.removeStaleContainer(CONTAINER_NAME)).toBe(true);
    expect(await docker.containerExists(CONTAINER_NAME)).toBe(false);
  }, 60_000);
});

/**
 * The `uds` topology's exact proxy arrangement on 1.1.0+: `--network
 * none`, per-file `-v` socket mounts creating vsock relays, mode-bit
 * propagation for a non-root guest, and egress fully blocked (loopback
 * only). Mirrors what `createSessionContainers` now emits.
 */
describe.skipIf(!probe.available)('apple-container UDS topology integration', () => {
  const UDS_CONTAINER_NAME = 'ironcurtain-itest-uds';
  let docker: ContainerRuntime;
  let socketDir: string;
  let socketPath: string;
  let listener: Server;

  beforeAll(async () => {
    docker = createAppleContainerManager();
    await docker.removeStaleContainer(UDS_CONTAINER_NAME);
    if (!(await docker.imageExists(TEST_IMAGE))) {
      await docker.pullImage(TEST_IMAGE);
    }

    socketDir = mkdtempSync(join(tmpdir(), 'ironcurtain-itest-uds-'));
    socketPath = join(socketDir, 'proxy.sock');
    listener = createServer((s) => {
      s.write('hello-from-host\n');
      s.end();
    });
    await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
    // Mode bits propagate to the guest side of the vsock relay; the
    // non-root guest needs "other" write to connect().
    chmodSync(socketPath, 0o666);

    const containerId = await docker.create({
      image: TEST_IMAGE,
      name: UDS_CONTAINER_NAME,
      network: 'none',
      mounts: [{ source: socketPath, target: '/run/ironcurtain/proxy.sock', readonly: false }],
      env: {},
      entrypoint: '/bin/sh',
      command: ['-c', 'sleep 300'],
      bundleLabel: 'itest-bundle',
      user: '1000:1000',
    });
    await docker.start(containerId);
  }, 180_000);

  afterAll(async () => {
    await docker.stop(UDS_CONTAINER_NAME);
    await docker.remove(UDS_CONTAINER_NAME);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    rmSync(socketDir, { recursive: true, force: true });
  }, 60_000);

  it('has no network interface beyond loopback and blocks internet egress', async () => {
    const egress = await docker.exec(
      UDS_CONTAINER_NAME,
      ['socat', '-u', '/dev/null', 'TCP:1.1.1.1:443,connect-timeout=3'],
      10_000,
      null,
    );
    expect(egress.exitCode).not.toBe(0);
    expect(egress.stderr).toMatch(/Network unreachable|Network is unreachable/);
  }, 30_000);

  it('connects to a host-listening UDS through a per-file -v vsock relay as non-root', async () => {
    const reach = await docker.exec(
      UDS_CONTAINER_NAME,
      ['sh', '-c', 'socat -u UNIX-CONNECT:/run/ironcurtain/proxy.sock -'],
      10_000,
      null,
    );
    expect(reach.exitCode).toBe(0);
    expect(reach.stdout).toContain('hello-from-host');
  }, 30_000);
});
