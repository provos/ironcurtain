import { describe, expect, it } from 'vitest';
import type { ExecFileFn } from '../../src/docker/docker-manager.js';
import {
  assertDesktopRelayContainerInspect,
  assertDesktopRelayNetworkInspect,
  buildDesktopRelayCreateArgs,
  buildDesktopRelayNetworkCreateArgs,
  createDesktopRelay,
  DESKTOP_RELAY_PROFILE,
  removeDesktopRelay,
  type DesktopRelayConfig,
} from '../../src/docker-workload/desktop-relay.js';

const config: DesktopRelayConfig = {
  bundleId: 'ic-bundle-test',
  containerName: 'ic-relay-test',
  isolatedNetworkName: 'ic-relay-net-test',
  uplinkNetworkName: 'ic-uplink-test',
  imageId: `sha256:${'a'.repeat(64)}`,
  ipv4Subnet: '172.31.44.0/24',
  ipv6Subnet: 'fd00:1c:44::/64',
  relayIpv4Address: '172.31.44.2',
  listenPort: 8443,
  targetIpv4Address: '192.168.65.2',
  targetPort: 9443,
};

function containerInspect(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 'b'.repeat(64),
    Name: `/${config.containerName}`,
    Image: config.imageId,
    Config: {
      User: '65532:65532',
      Entrypoint: ['/ironcurtain-fixed-relay'],
      Cmd: [
        '--listen',
        '172.31.44.2:8443',
        '--target',
        '192.168.65.2:9443',
        '--allow-cidr',
        '172.31.44.0/24',
        '--max-concurrent',
        '64',
        '--max-bytes',
        '268435456',
        '--max-duration',
        '10m',
        '--dial-timeout',
        '5s',
      ],
      Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
      WorkingDir: '/',
      Labels: {
        'com.ironcurtain.docker-workload.role': 'fixed-relay',
        'com.ironcurtain.docker-workload.bundle': config.bundleId,
      },
      ExposedPorts: null,
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: null,
      SecurityOpt: ['no-new-privileges:true'],
      Memory: DESKTOP_RELAY_PROFILE.memoryBytes,
      NanoCpus: DESKTOP_RELAY_PROFILE.nanoCpus,
      PidsLimit: DESKTOP_RELAY_PROFILE.pidsLimit,
      NetworkMode: config.isolatedNetworkName,
      Binds: null,
      PortBindings: {},
      LogConfig: { Type: 'local', Config: { 'max-size': '1m', 'max-file': '1', compress: 'false' } },
      Ulimits: [{ Name: 'nofile', Soft: 128, Hard: 128 }],
    },
    Mounts: [],
    NetworkSettings: {
      Networks: {
        [config.isolatedNetworkName]: {
          IPAMConfig: { IPv4Address: config.relayIpv4Address },
          IPAddress: config.relayIpv4Address,
        },
        [config.uplinkNetworkName]: { IPAddress: '172.30.0.7' },
      },
    },
    State: { Running: true },
    ...overrides,
  };
}

function networkInspect(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 'c'.repeat(64),
    Name: config.isolatedNetworkName,
    Internal: true,
    EnableIPv6: true,
    Attachable: false,
    Ingress: false,
    Labels: {
      'com.ironcurtain.docker-workload.role': 'isolated-network',
      'com.ironcurtain.docker-workload.bundle': config.bundleId,
    },
    Options: {
      'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
      'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
      'com.docker.network.enable_ipv4': 'true',
    },
    IPAM: { Config: [{ Subnet: config.ipv4Subnet }, { Subnet: config.ipv6Subnet }] },
    ...overrides,
  };
}

describe('Desktop fixed relay profile', () => {
  it('renders only the isolated dual-stack network contract', () => {
    expect(buildDesktopRelayNetworkCreateArgs(config)).toEqual([
      'network',
      'create',
      '--internal',
      '--ipv6',
      '--subnet',
      config.ipv4Subnet,
      '--subnet',
      config.ipv6Subnet,
      '--opt',
      'com.docker.network.bridge.gateway_mode_ipv4=isolated',
      '--opt',
      'com.docker.network.bridge.gateway_mode_ipv6=isolated',
      '--opt',
      'com.docker.network.enable_ipv4=true',
      '--label',
      'com.ironcurtain.docker-workload.role=isolated-network',
      '--label',
      `com.ironcurtain.docker-workload.bundle=${config.bundleId}`,
      config.isolatedNetworkName,
    ]);
  });

  it('renders a mountless, non-root, bounded fixed-destination container', () => {
    const args = buildDesktopRelayCreateArgs(config);
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('no-new-privileges:true');
    expect(args).toContain('65532:65532');
    expect(args).toContain(config.imageId);
    expect(args).toContain(`${config.relayIpv4Address}:${config.listenPort}`);
    expect(args).toContain(`${config.targetIpv4Address}:${config.targetPort}`);
    expect(args).not.toContain('--publish');
    expect(args).not.toContain('--volume');
    expect(args).not.toContain('--privileged');
  });

  it.each([
    { imageId: 'relay:latest' },
    { ipv4Subnet: '0.0.0.0/0' },
    { ipv4Subnet: '172.31.44.1/24' },
    { relayIpv4Address: '172.31.45.2' },
    { ipv6Subnet: 'fd00:1c:44::/48' },
    { targetIpv4Address: 'host.docker.internal' },
    { isolatedNetworkName: 'bridge' },
  ])(
    'rejects non-frozen input $imageId$ipv4Subnet$relayIpv4Address$ipv6Subnet$targetIpv4Address$isolatedNetworkName',
    (change) => {
      expect(() => buildDesktopRelayCreateArgs({ ...config, ...change })).toThrow();
    },
  );

  it('accepts the exact effective container and network profile', () => {
    expect(() => assertDesktopRelayContainerInspect(containerInspect(), config, undefined, true)).not.toThrow();
    expect(() => assertDesktopRelayNetworkInspect(networkInspect(), config)).not.toThrow();
  });

  it.each([
    { HostConfig: { ...containerInspect().HostConfig, Privileged: true } },
    { Mounts: [{ Source: '/workspace' }] },
    {
      NetworkSettings: {
        Networks: {
          [config.isolatedNetworkName]: {
            IPAMConfig: { IPv4Address: config.relayIpv4Address },
            IPAddress: config.relayIpv4Address,
          },
        },
      },
    },
  ])('rejects effective container profile drift', (change) => {
    expect(() => assertDesktopRelayContainerInspect(containerInspect(change), config)).toThrow();
  });

  it.each([
    { Internal: false },
    { EnableIPv6: false },
    { Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'nat' } },
    { IPAM: { Config: [{ Subnet: config.ipv4Subnet, Gateway: '172.31.44.1' }, { Subnet: config.ipv6Subnet }] } },
  ])('rejects effective network boundary drift', (change) => {
    expect(() => assertDesktopRelayNetworkInspect(networkInspect(change), config)).toThrow();
  });
});

describe('Desktop fixed relay lifecycle', () => {
  it('inspects before start and deletes only exact inspected resources', async () => {
    const calls: string[][] = [];
    const networkId = 'c'.repeat(64);
    const containerId = 'b'.repeat(64);
    const exec: ExecFileFn = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'network' && args[1] === 'create') return { stdout: `${networkId}\n`, stderr: '' };
      if (args[0] === 'container' && args[1] === 'create') return { stdout: `${containerId}\n`, stderr: '' };
      if (args[0] === 'container' && args[1] === 'inspect') {
        return { stdout: JSON.stringify([{ ...containerInspect(), Id: containerId }]), stderr: '' };
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        return { stdout: JSON.stringify([{ ...networkInspect(), Id: networkId }]), stderr: '' };
      }
      if (args[0] === 'container' && args[1] === 'logs') {
        return { stdout: '', stderr: 'relay ready version=ironcurtain-fixed-relay-v1\n' };
      }
      return { stdout: '', stderr: '' };
    };

    const resources = await createDesktopRelay(exec, config);
    await removeDesktopRelay(exec, config, resources);
    const start = calls.findIndex((args) => args[0] === 'container' && args[1] === 'start');
    const containerInspectIndex = calls.findIndex((args) => args[0] === 'container' && args[1] === 'inspect');
    const networkInspectIndex = calls.findIndex((args) => args[0] === 'network' && args[1] === 'inspect');
    expect(containerInspectIndex).toBeLessThan(start);
    expect(networkInspectIndex).toBeLessThan(start);
    expect(calls).toContainEqual(['container', 'logs', '--tail', '50', containerId]);
    expect(calls).toContainEqual(['container', 'rm', '--force', containerId]);
    expect(calls).toContainEqual(['network', 'rm', networkId]);
  });

  it('detects readiness when the relay keeps logging after the marker', async () => {
    const networkId = 'c'.repeat(64);
    const containerId = 'b'.repeat(64);
    const relayLog = ['relay ready version=ironcurtain-fixed-relay-v1', 'accepted conn 1', 'accepted conn 2'];
    let logCalls = 0;
    const exec: ExecFileFn = async (_command, args) => {
      if (args[0] === 'network' && args[1] === 'create') return { stdout: `${networkId}\n`, stderr: '' };
      if (args[0] === 'container' && args[1] === 'create') return { stdout: `${containerId}\n`, stderr: '' };
      if (args[0] === 'container' && args[1] === 'inspect') {
        return { stdout: JSON.stringify([{ ...containerInspect(), Id: containerId }]), stderr: '' };
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        return { stdout: JSON.stringify([{ ...networkInspect(), Id: networkId }]), stderr: '' };
      }
      if (args[0] === 'container' && args[1] === 'logs') {
        logCalls += 1;
        // Honour --tail the way Docker does, so a window too narrow to reach
        // back past the later lines really does hide the marker.
        const tail = Number(args[args.indexOf('--tail') + 1]);
        return { stdout: '', stderr: `${relayLog.slice(-tail).join('\n')}\n` };
      }
      return { stdout: '', stderr: '' };
    };

    await expect(createDesktopRelay(exec, config)).resolves.toMatchObject({ containerId, networkId });
    expect(logCalls).toBe(1);
  });

  it('rolls back exact IDs if inspection fails', async () => {
    const calls: string[][] = [];
    const networkId = 'c'.repeat(64);
    const containerId = 'b'.repeat(64);
    const exec: ExecFileFn = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'network' && args[1] === 'create') return { stdout: networkId, stderr: '' };
      if (args[0] === 'container' && args[1] === 'create') return { stdout: containerId, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') {
        return { stdout: JSON.stringify([{ ...networkInspect(), Id: networkId, Internal: false }]), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    await expect(createDesktopRelay(exec, config)).rejects.toThrow(/boundary drift/);
    expect(calls).toContainEqual(['container', 'rm', '--force', containerId]);
    expect(calls).toContainEqual(['network', 'rm', networkId]);
    expect(calls.some((args) => args[0] === 'container' && args[1] === 'start')).toBe(false);
  });
});
