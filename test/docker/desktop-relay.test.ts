import { describe, expect, it } from 'vitest';
import type { ExecFileFn } from '../../src/docker/docker-manager.js';
import {
  assertDesktopRelayContainerInspect,
  assertDesktopRelayNetworkInspect,
  buildDesktopRelayCreateArgs,
  buildDesktopRelayNetworkCreateArgs,
  createDesktopRelayExposure,
  DESKTOP_RELAY_PROFILE,
  DESKTOP_RELAY_UPLINK_NETWORK,
  type CreateDesktopRelayExposureOptions,
  type DesktopRelayCreateAuthority,
  type DesktopRelayConfig,
} from '../../src/docker-workload/desktop-relay.js';

const REQUIRED_PROXY_AUTHORIZATION =
  'Basic aXJvbmN1cnRhaW46QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==';

const config: DesktopRelayConfig = {
  bundleId: 'ic-bundle-test',
  containerName: 'ic-relay-test',
  isolatedNetworkName: 'ic-relay-net-test',
  uplinkNetworkName: DESKTOP_RELAY_UPLINK_NETWORK,
  imageId: `sha256:${'a'.repeat(64)}`,
  ipv4Subnet: '172.31.44.0/24',
  ipv6Subnet: 'fd00:1c:44::/64',
  relayIpv4Address: '172.31.44.2',
  listenPort: 8443,
  targetHost: '192.168.65.2',
  targetPort: 9443,
  requiredProxyAuthorization: REQUIRED_PROXY_AUTHORIZATION,
};

function containerInspect(
  overrides: Record<string, unknown> = {},
  relayConfig: DesktopRelayConfig = config,
): Record<string, unknown> {
  const createArgs = buildDesktopRelayCreateArgs(relayConfig);
  const command = createArgs.slice(createArgs.indexOf(relayConfig.imageId) + 1);
  return {
    Id: 'b'.repeat(64),
    Name: `/${relayConfig.containerName}`,
    Image: relayConfig.imageId,
    Config: {
      User: '65532:65532',
      Entrypoint: ['/ironcurtain-fixed-relay'],
      Cmd: command,
      Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
      WorkingDir: '/',
      Labels: {
        'com.ironcurtain.docker-workload.role': 'fixed-relay',
        'com.ironcurtain.docker-workload.bundle': relayConfig.bundleId,
        'com.ironcurtain.docker-workload.generation': 'gen-test',
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
      NetworkMode: relayConfig.isolatedNetworkName,
      ExtraHosts: relayConfig.targetHost === 'host.docker.internal' ? ['host.docker.internal:host-gateway'] : null,
      Binds: null,
      PortBindings: {},
      LogConfig: { Type: 'local', Config: { 'max-size': '1m', 'max-file': '1', compress: 'false' } },
      Ulimits: [{ Name: 'nofile', Soft: 128, Hard: 128 }],
    },
    Mounts: [],
    NetworkSettings: {
      Networks: {
        [relayConfig.isolatedNetworkName]: {
          IPAMConfig: { IPv4Address: relayConfig.relayIpv4Address },
          IPAddress: relayConfig.relayIpv4Address,
        },
        [relayConfig.uplinkNetworkName]: { IPAddress: '172.30.0.7' },
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
      'com.ironcurtain.docker-workload.generation': 'gen-test',
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
    expect(args).toContain(`${config.targetHost}:${config.targetPort}`);
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
    { targetHost: 'example.test' },
    { isolatedNetworkName: 'bridge' },
    { uplinkNetworkName: 'ic-uplink-test' },
  ])(
    'rejects non-frozen input $imageId$ipv4Subnet$relayIpv4Address$ipv6Subnet$targetHost$isolatedNetworkName',
    (change) => {
      expect(() => buildDesktopRelayCreateArgs({ ...config, ...change })).toThrow();
    },
  );

  it('accepts the exact effective container and network profile', () => {
    expect(() => assertDesktopRelayContainerInspect(containerInspect(), config, undefined, true)).not.toThrow();
    expect(() => assertDesktopRelayNetworkInspect(networkInspect(), config)).not.toThrow();
  });

  it('rejects a missing lifecycle generation label during effective adjudication', () => {
    const required = { 'com.ironcurtain.docker-workload.generation': 'gen-test' };
    const inspectedContainer = containerInspect();
    const inspectedNetwork = networkInspect();
    delete (inspectedContainer.Config as { Labels: Record<string, string> }).Labels[
      'com.ironcurtain.docker-workload.generation'
    ];
    delete (inspectedNetwork.Labels as Record<string, string>)['com.ironcurtain.docker-workload.generation'];

    expect(() => assertDesktopRelayContainerInspect(inspectedContainer, config, undefined, false, required)).toThrow(
      /required label/u,
    );
    expect(() => assertDesktopRelayNetworkInspect(inspectedNetwork, config, undefined, required)).toThrow(
      /required label/u,
    );
  });

  it('allows only the frozen Docker Desktop host alias and binds it to host-gateway', () => {
    const hostGatewayConfig = { ...config, targetHost: 'host.docker.internal' };
    expect(buildDesktopRelayCreateArgs(hostGatewayConfig)).toContain('host.docker.internal:host-gateway');
    expect(() =>
      assertDesktopRelayContainerInspect(containerInspect({}, hostGatewayConfig), hostGatewayConfig, undefined, true),
    ).not.toThrow();
    expect(() =>
      assertDesktopRelayContainerInspect(
        containerInspect(
          { HostConfig: { ...containerInspect({}, hostGatewayConfig).HostConfig, ExtraHosts: ['other:host-gateway'] } },
          hostGatewayConfig,
        ),
        hostGatewayConfig,
      ),
    ).toThrow(/ExtraHosts drift/);
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

function createAuthority(events: string[]): DesktopRelayCreateAuthority {
  return async (spec, create) => {
    events.push(`precommit:${spec.kind}:${spec.requestedName}`);
    const created = await create(spec.requestedName, {
      ...spec.baseLabels,
      'com.ironcurtain.docker-workload.generation': 'gen-test',
    });
    events.push(`observed:${spec.kind}:${created.id}`);
    await spec.adjudicateObserved?.(created.id);
    events.push(`adjudicated:${spec.kind}:${created.id}`);
    return { id: created.id };
  };
}

function exposureOptions(
  createOuterResource: DesktopRelayCreateAuthority,
  mode: 'images' | 'packages' = 'images',
): CreateDesktopRelayExposureOptions {
  return {
    bundleId: config.bundleId,
    mode,
    imageId: config.imageId,
    isolatedNetworkName: config.isolatedNetworkName,
    uplinkNetworkName: config.uplinkNetworkName,
    ipv4Subnet: config.ipv4Subnet,
    ipv6Subnet: config.ipv6Subnet,
    requiredProxyAuthorization: REQUIRED_PROXY_AUTHORIZATION,
    registry: {
      containerName: config.containerName,
      relayIpv4Address: config.relayIpv4Address,
      listenPort: config.listenPort,
      targetHost: config.targetHost,
      targetPort: config.targetPort,
    },
    ...(mode === 'packages'
      ? {
          package: {
            containerName: 'ic-package-relay-test',
            relayIpv4Address: '172.31.44.3',
            listenPort: 8080,
            targetHost: 'host.docker.internal',
            targetPort: 9080,
          },
        }
      : {}),
    createOuterResource,
  };
}

function fakeRelayExec(
  calls: string[][],
  options: CreateDesktopRelayExposureOptions,
  overrides: { readonly networkDrift?: boolean; readonly failPackageReadiness?: boolean } = {},
): ExecFileFn {
  const networkId = 'c'.repeat(64);
  const registryId = 'b'.repeat(64);
  const packageId = 'd'.repeat(64);
  const configsById = new Map<string, DesktopRelayConfig>([
    [registryId, { ...config }],
    ...(options.package === undefined
      ? []
      : ([
          [
            packageId,
            {
              ...config,
              containerName: options.package.containerName,
              relayIpv4Address: options.package.relayIpv4Address,
              listenPort: options.package.listenPort,
              targetHost: options.package.targetHost,
              targetPort: options.package.targetPort,
            },
          ],
        ] as const)),
  ]);
  let creates = 0;
  return async (_command, args) => {
    calls.push([...args]);
    if (args[0] === 'network' && args[1] === 'create') return { stdout: networkId, stderr: '' };
    if (args[0] === 'container' && args[1] === 'create') {
      creates += 1;
      return { stdout: creates === 1 ? registryId : packageId, stderr: '' };
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      return {
        stdout: JSON.stringify([
          { ...networkInspect(), Id: networkId, ...(overrides.networkDrift ? { Internal: false } : {}) },
        ]),
        stderr: '',
      };
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const id = args[2];
      const relayConfig = configsById.get(id);
      if (relayConfig === undefined) throw new Error(`unexpected inspect ${id}`);
      return { stdout: JSON.stringify([{ ...containerInspect({}, relayConfig), Id: id }]), stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'logs') {
      if (overrides.failPackageReadiness && args.at(-1) === packageId) throw new Error('package readiness failed');
      return { stdout: '', stderr: 'relay ready version=ironcurtain-fixed-relay-v1\n' };
    }
    return { stdout: '', stderr: '' };
  };
}

describe('Desktop fixed relay exposure lifecycle', () => {
  it('precommits and adjudicates one shared network and one images relay before start', async () => {
    const calls: string[][] = [];
    const events: string[] = [];
    const options = exposureOptions(createAuthority(events));
    const exposure = await createDesktopRelayExposure(fakeRelayExec(calls, options), options);

    expect(exposure).toEqual({
      networkId: 'c'.repeat(64),
      isolatedNetworkName: config.isolatedNetworkName,
      ipv4Subnet: config.ipv4Subnet,
      ipv6Subnet: config.ipv6Subnet,
      registry: { containerId: 'b'.repeat(64), proxyUrl: 'http://172.31.44.2:8443' },
    });
    expect(events.map((event) => event.split(':').slice(0, 2).join(':'))).toEqual([
      'precommit:network',
      'observed:network',
      'adjudicated:network',
      'precommit:container',
      'observed:container',
      'adjudicated:container',
    ]);
    const start = calls.findIndex((args) => args[0] === 'container' && args[1] === 'start');
    const containerInspectIndex = calls.findIndex((args) => args[0] === 'container' && args[1] === 'inspect');
    expect(containerInspectIndex).toBeLessThan(start);
    expect(calls).toContainEqual(['container', 'logs', '--tail', '50', 'b'.repeat(64)]);
    expect(calls.some((args) => args[1] === 'rm')).toBe(false);
  });

  it('creates two fixed relays on the same network for packages', async () => {
    const calls: string[][] = [];
    const events: string[] = [];
    const options = exposureOptions(createAuthority(events), 'packages');
    const exposure = await createDesktopRelayExposure(fakeRelayExec(calls, options), options);

    expect(exposure.registry.proxyUrl).toBe('http://172.31.44.2:8443');
    expect(exposure.package).toEqual({ containerId: 'd'.repeat(64), proxyUrl: 'http://172.31.44.3:8080' });
    expect(calls.filter((args) => args[0] === 'network' && args[1] === 'create')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'container' && args[1] === 'create')).toHaveLength(2);
    expect(calls.filter((args) => args[0] === 'network' && args[1] === 'connect')).toEqual([
      ['network', 'connect', config.uplinkNetworkName, 'b'.repeat(64)],
      ['network', 'connect', config.uplinkNetworkName, 'd'.repeat(64)],
    ]);
    const packageCreate = calls.filter((args) => args[0] === 'container' && args[1] === 'create')[1];
    expect(packageCreate).toContain('host.docker.internal:host-gateway');
  });

  it.each([
    ['images with package relay', { mode: 'images' as const, includePackage: true }],
    ['packages without package relay', { mode: 'packages' as const, includePackage: false }],
  ])('rejects an inconsistent mode contract: %s', async (_label, variant) => {
    const base = exposureOptions(createAuthority([]), variant.includePackage ? 'packages' : 'images');
    const options = { ...base, mode: variant.mode } as CreateDesktopRelayExposureOptions;
    await expect(createDesktopRelayExposure(async () => ({ stdout: '', stderr: '' }), options)).rejects.toThrow();
  });

  it('rolls back the exact shared network ID if its adjudication fails', async () => {
    const calls: string[][] = [];
    const options = exposureOptions(createAuthority([]));
    await expect(
      createDesktopRelayExposure(fakeRelayExec(calls, options, { networkDrift: true }), options),
    ).rejects.toThrow(/boundary drift/);
    expect(calls).toContainEqual(['network', 'rm', 'c'.repeat(64)]);
    expect(calls.some((args) => args[0] === 'container' && args[1] === 'create')).toBe(false);
  });

  it('rolls back both relays in reverse order and the shared network after partial package failure', async () => {
    const calls: string[][] = [];
    const options = exposureOptions(createAuthority([]), 'packages');
    await expect(
      createDesktopRelayExposure(fakeRelayExec(calls, options, { failPackageReadiness: true }), options),
    ).rejects.toThrow(/package readiness failed/);
    const removals = calls.filter((args) => args[1] === 'rm');
    expect(removals).toEqual([
      ['container', 'rm', '--force', 'd'.repeat(64)],
      ['container', 'rm', '--force', 'b'.repeat(64)],
      ['network', 'rm', 'c'.repeat(64)],
    ]);
  });
});
