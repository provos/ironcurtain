import { connect, createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createContainerRuntime } from '../../src/docker/container-runtime.js';
import { ensureDockerDesktopRelayImage } from '../../src/docker/docker-infrastructure.js';
import { defaultExecFile } from '../../src/docker/docker-manager.js';
import {
  createDesktopRelayExposure,
  DESKTOP_RELAY_UPLINK_NETWORK,
  type CreateDesktopRelayExposureOptions,
  type DesktopRelayCreateAuthority,
  type DesktopRelayExposure,
} from '../../src/docker-workload/desktop-relay.js';
import { isRuntimeAvailable } from '../helpers/container-runtimes.js';

const enabled = process.env.DESKTOP_RELAY_INTEGRATION === '1';
const ready = enabled && process.platform === 'darwin' && isRuntimeAvailable('docker');
const REQUIRED_PROXY_AUTHORIZATION =
  'Basic aXJvbmN1cnRhaW46QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==';

async function docker(args: readonly string[], timeout = 30_000): Promise<{ stdout: string; stderr: string }> {
  return defaultExecFile('docker', args, { timeout, maxBuffer: 10 * 1024 * 1024 });
}

async function bestEffort(args: readonly string[]): Promise<void> {
  try {
    await docker(args);
  } catch {
    // Exact post-test absence checks adjudicate cleanup.
  }
}

async function expectDockerFailure(args: readonly string[]): Promise<void> {
  await expect(docker(args, 15_000)).rejects.toThrow();
}

async function createHostPolicyListener(response = 'desktop-host-loopback-target\n'): Promise<{
  readonly server: Server;
  readonly port: number;
  readonly remoteAddresses: string[];
}> {
  const remoteAddresses: string[] = [];
  const server = createServer((socket) => {
    remoteAddresses.push(socket.remoteAddress ?? 'missing');
    socket.setTimeout(5_000, () => socket.destroy());
    socket.once('data', () => socket.end(response));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string' || address.address !== '0.0.0.0') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Desktop relay integration listener did not bind the production IPv4 wildcard address');
  }
  return { server, port: address.port, remoteAddresses };
}

async function requestHostLoopback(port: number, payload: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: '127.0.0.1', port }, () => socket.end(payload));
    socket.setTimeout(5_000, () => socket.destroy(new Error('host loopback request timed out')));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.once('error', reject);
  });
}

async function closeListener(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

const directCreateAuthority: DesktopRelayCreateAuthority = async (spec, create) => {
  const created = await create(spec.requestedName, spec.baseLabels ?? {});
  await spec.adjudicateObserved?.(created.id);
  return { id: created.id };
};

describe.skipIf(!ready)('Docker Desktop fixed relay', () => {
  it('shares one isolated network across fixed registry/package tuples and fails closed after relay loss', async () => {
    const suffix = `${process.pid}-${Date.now().toString(36)}`;
    const bundleId = `ic-bundle-${suffix}`;
    const isolatedNetworkName = `ic-isolated-${suffix}`;
    const registryRelayName = `ic-relay-${suffix}`;
    const packageRelayName = `ic-package-relay-${suffix}`;
    let registryListener: Server | undefined;
    let packageListener: Server | undefined;
    let relay: DesktopRelayExposure | undefined;

    try {
      const registryListening = await createHostPolicyListener('registry-fixed-target\n');
      registryListener = registryListening.server;
      const packageListening = await createHostPolicyListener('package-fixed-target\n');
      packageListener = packageListening.server;
      const imageId = await ensureDockerDesktopRelayImage(createContainerRuntime('docker'));
      const config: CreateDesktopRelayExposureOptions = {
        bundleId,
        mode: 'packages',
        isolatedNetworkName,
        uplinkNetworkName: DESKTOP_RELAY_UPLINK_NETWORK,
        imageId,
        ipv4Subnet: '172.31.44.0/24',
        ipv6Subnet: 'fd00:1c:44::/64',
        requiredProxyAuthorization: REQUIRED_PROXY_AUTHORIZATION,
        registry: {
          containerName: registryRelayName,
          relayIpv4Address: '172.31.44.2',
          listenPort: 8443,
          targetHost: 'host.docker.internal',
          targetPort: registryListening.port,
        },
        package: {
          containerName: packageRelayName,
          relayIpv4Address: '172.31.44.4',
          listenPort: 8080,
          targetHost: 'host.docker.internal',
          targetPort: packageListening.port,
        },
        createOuterResource: directCreateAuthority,
      };

      relay = await createDesktopRelayExposure(defaultExecFile, config);
      let readyLog = '';
      for (let attempt = 0; attempt < 20; attempt += 1) {
        readyLog = (await docker(['container', 'logs', relay.registry.containerId])).stderr;
        if (readyLog.includes('relay ready')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(readyLog).toContain('relay ready');

      const request = await docker([
        'run',
        '--rm',
        '--network',
        isolatedNetworkName,
        '--ip',
        '172.31.44.3',
        '--entrypoint',
        '/bin/sh',
        'alpine/socat:latest',
        '-c',
        "(printf 'GET http://registry.test/ HTTP/1.1\\r\\nHost: registry.test\\r\\nConnection: close\\r\\n\\r\\n'; sleep 2) | socat -T5 - TCP4:172.31.44.2:8443",
      ]);
      const registryRelayLogs = await docker(['container', 'logs', relay.registry.containerId]);
      expect(
        request.stdout,
        `registry relay logs: ${registryRelayLogs.stderr}; accepted remotes: ${registryListening.remoteAddresses.join(',')}`,
      ).toBe('registry-fixed-target\n');

      const packageRequest = await docker([
        'run',
        '--rm',
        '--network',
        isolatedNetworkName,
        '--ip',
        '172.31.44.3',
        '--entrypoint',
        '/bin/sh',
        'alpine/socat:latest',
        '-c',
        "(printf 'GET http://package.test/ HTTP/1.1\\r\\nHost: package.test\\r\\nConnection: close\\r\\n\\r\\n'; sleep 2) | socat -T5 - TCP4:172.31.44.4:8080",
      ]);
      expect(packageRequest.stdout).toBe('package-fixed-target\n');
      expect(registryListening.remoteAddresses).toEqual(['127.0.0.1']);
      expect(packageListening.remoteAddresses).toEqual(['127.0.0.1']);

      await expectDockerFailure([
        'run',
        '--rm',
        '--network',
        DESKTOP_RELAY_UPLINK_NETWORK,
        '--entrypoint',
        '/bin/sh',
        'alpine/socat:latest',
        '-c',
        'socat -T1 - TCP4:172.31.44.2:8443 </dev/null',
      ]);

      await docker(['container', 'stop', '--time', '1', relay.registry.containerId]);
      await expectDockerFailure([
        'run',
        '--rm',
        '--network',
        isolatedNetworkName,
        '--ip',
        '172.31.44.3',
        '--entrypoint',
        '/bin/sh',
        'alpine/socat:latest',
        '-c',
        "printf 'GET http://must-fail.test/ HTTP/1.1\\r\\nHost: must-fail.test\\r\\nConnection: close\\r\\n\\r\\n' | socat -T1 - TCP4:172.31.44.2:8443",
      ]);
    } finally {
      await Promise.all([closeListener(registryListener), closeListener(packageListener)]);
      if (relay !== undefined) {
        if (relay.package !== undefined) await bestEffort(['container', 'rm', '--force', relay.package.containerId]);
        await bestEffort(['container', 'rm', '--force', relay.registry.containerId]);
        await bestEffort(['network', 'rm', relay.networkId]);
      }
    }

    expect(registryListener.listening).toBe(false);
    expect(packageListener.listening).toBe(false);
    await expectDockerFailure(['container', 'inspect', registryRelayName]);
    await expectDockerFailure(['container', 'inspect', packageRelayName]);
    await expectDockerFailure(['network', 'inspect', isolatedNetworkName]);
    await expect(docker(['network', 'inspect', DESKTOP_RELAY_UPLINK_NETWORK])).resolves.toMatchObject({ stderr: '' });
  }, 120_000);

  it('reaches an exact host loopback listener only through the production host-gateway relay topology', async () => {
    const suffix = `${process.pid}-${Date.now().toString(36)}`;
    const bundleId = `ic-bundle-${suffix}`;
    const isolatedNetworkName = `ic-host-relay-${suffix}`;
    const relayName = `ic-host-relay-container-${suffix}`;
    const clientName = `ic-host-relay-client-${suffix}`;
    let hostListener: Server | undefined;
    let relay: DesktopRelayExposure | undefined;
    let clientId: string | undefined;

    try {
      const listening = await createHostPolicyListener();
      hostListener = listening.server;
      expect(await requestHostLoopback(listening.port, 'from-host-loopback')).toBe('desktop-host-loopback-target\n');
      expect(listening.remoteAddresses).toEqual(['127.0.0.1']);
      const imageId = await ensureDockerDesktopRelayImage(createContainerRuntime('docker'));
      relay = await createDesktopRelayExposure(defaultExecFile, {
        bundleId,
        mode: 'images',
        isolatedNetworkName,
        uplinkNetworkName: DESKTOP_RELAY_UPLINK_NETWORK,
        imageId,
        ipv4Subnet: '172.31.46.0/24',
        ipv6Subnet: 'fd00:1c:46::/64',
        requiredProxyAuthorization: REQUIRED_PROXY_AUTHORIZATION,
        registry: {
          containerName: relayName,
          relayIpv4Address: '172.31.46.2',
          listenPort: 8443,
          targetHost: 'host.docker.internal',
          targetPort: listening.port,
        },
        createOuterResource: directCreateAuthority,
      });

      const created = await docker([
        'container',
        'create',
        '--name',
        clientName,
        '--network',
        isolatedNetworkName,
        '--ip',
        '172.31.46.3',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--memory',
        '32m',
        '--cpus',
        '0.25',
        '--pids-limit',
        '32',
        '--entrypoint',
        '/bin/sh',
        'alpine/socat:latest',
        '-c',
        'sleep 60',
      ]);
      clientId = created.stdout.trim();
      expect(clientId).toMatch(/^[a-f0-9]{64}$/u);
      await docker(['container', 'start', clientId]);

      const inspected = JSON.parse((await docker(['container', 'inspect', clientId])).stdout) as readonly [
        { readonly NetworkSettings: { readonly Networks: Readonly<Record<string, unknown>> } },
      ];
      expect(Object.keys(inspected[0].NetworkSettings.Networks)).toEqual([isolatedNetworkName]);

      const request = await docker([
        'container',
        'exec',
        clientId,
        '/bin/sh',
        '-c',
        "(printf 'GET http://isolated.test/ HTTP/1.1\\r\\nHost: isolated.test\\r\\nConnection: close\\r\\n\\r\\n'; sleep 2) | socat -T5 - TCP4:172.31.46.2:8443",
      ]);
      const relayLogs = await docker(['container', 'logs', relay.registry.containerId]);
      expect(
        request.stdout,
        `relay logs: ${relayLogs.stderr}; accepted remotes: ${listening.remoteAddresses.join(',')}`,
      ).toBe('desktop-host-loopback-target\n');
      expect(listening.remoteAddresses).toEqual(['127.0.0.1', '127.0.0.1']);
    } finally {
      await closeListener(hostListener);
      if (clientId !== undefined) await bestEffort(['container', 'rm', '--force', clientId]);
      if (relay !== undefined) {
        await bestEffort(['container', 'rm', '--force', relay.registry.containerId]);
        await bestEffort(['network', 'rm', relay.networkId]);
      }
    }

    expect(hostListener.listening).toBe(false);
    await expectDockerFailure(['container', 'inspect', clientName]);
    await expectDockerFailure(['container', 'inspect', relayName]);
    await expectDockerFailure(['network', 'inspect', isolatedNetworkName]);
    await expect(docker(['network', 'inspect', DESKTOP_RELAY_UPLINK_NETWORK])).resolves.toMatchObject({ stderr: '' });
  }, 180_000);
});
