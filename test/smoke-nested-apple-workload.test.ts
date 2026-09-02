import { describe, expect, it } from 'vitest';
import {
  DENIED_REGISTRY_SMOKE_IMAGE,
  DOCKER_DESKTOP_OFFLINE_ARCHIVE,
  PUBLIC_REGISTRY_SMOKE_IMAGE,
  assertDefaultBridgeUnavailable,
  assertDefaultContainerHasNoUsableNetwork,
  assertEmptyInternalBridge,
  assertEmbeddedDnsResolver,
  assertExactAgentDockerEnvironment,
  assertInternalBridge,
  assertNoPublishedPortBindings,
  assertRegistryPolicyDenied,
  assertRequiredBusyboxApplets,
  bindPublicRegistryWorkloadNetwork,
  buildNestedAppleSmokeWorkloadConfig,
  buildPublicRegistryWorkloadPlan,
  dockerDesktopSmokeNetworkAccess,
  isDockerDesktopSmokeMode,
  isExactSmokeNonceResponse,
  parseNestedAppleSmokeMode,
} from '../scripts/smoke-nested-apple-workload.js';

describe('nested Apple smoke invocation', () => {
  it('selects each acceptance gate with one unambiguous argument', () => {
    expect(parseNestedAppleSmokeMode([])).toBe('batch');
    expect(parseNestedAppleSmokeMode(['--pty'])).toBe('pty');
    expect(parseNestedAppleSmokeMode(['--public-registry'])).toBe('public-registry');
    expect(parseNestedAppleSmokeMode(['--docker-desktop-disabled'])).toBe('docker-desktop-disabled');
    expect(parseNestedAppleSmokeMode(['--docker-desktop-pty'])).toBe('docker-desktop-pty');
    expect(parseNestedAppleSmokeMode(['--docker-desktop-offline'])).toBe('docker-desktop-offline');
    expect(parseNestedAppleSmokeMode(['--docker-desktop-images'])).toBe('docker-desktop-images');
    expect(parseNestedAppleSmokeMode(['--docker-desktop-packages'])).toBe('docker-desktop-packages');
    expect(parseNestedAppleSmokeMode(['--docker-desktop-recovery'])).toBe('docker-desktop-recovery');
  });

  it.each([
    ['--pty', '--public-registry'],
    ['--public-registry', '--pty'],
    ['--docker-desktop-packages', '--public-registry'],
    ['--docker-desktop-offline', '--docker-desktop-images'],
    ['--unknown'],
  ])('rejects ambiguous or unknown arguments: %j', (...argv) => {
    expect(() => parseNestedAppleSmokeMode(argv)).toThrow(/usage/u);
  });
});

describe('nested Apple public-registry acceptance plan', () => {
  const nonce = '0123456789abcdef0123456789abcdef';

  it('uses canonical explicit Images and Offline requests', () => {
    expect(DOCKER_DESKTOP_OFFLINE_ARCHIVE).toBe('images/ironcurtain-offline-fixture.tar');
    expect(buildNestedAppleSmokeWorkloadConfig('public-registry')).toEqual({
      enabled: true,
      networkAccess: 'images',
    });
    expect(buildNestedAppleSmokeWorkloadConfig('batch')).toEqual({
      enabled: true,
      networkAccess: 'offline',
    });
    expect(buildNestedAppleSmokeWorkloadConfig('pty')).toEqual({
      enabled: true,
      networkAccess: 'offline',
    });
    expect(buildNestedAppleSmokeWorkloadConfig('docker-desktop-packages')).toEqual({
      enabled: true,
      networkAccess: 'packages',
    });
    expect(buildNestedAppleSmokeWorkloadConfig('docker-desktop-images')).toEqual({
      enabled: true,
      networkAccess: 'images',
    });
    expect(buildNestedAppleSmokeWorkloadConfig('docker-desktop-offline')).toEqual({
      enabled: true,
      networkAccess: 'offline',
    });
    expect(buildNestedAppleSmokeWorkloadConfig('docker-desktop-recovery')).toEqual({
      enabled: true,
      networkAccess: 'offline',
    });
    expect(buildNestedAppleSmokeWorkloadConfig('docker-desktop-pty')).toEqual({
      enabled: true,
      networkAccess: 'offline',
    });
    expect(buildNestedAppleSmokeWorkloadConfig('docker-desktop-disabled')).toEqual({ enabled: false });
    expect(isDockerDesktopSmokeMode('public-registry')).toBe(false);
    expect(isDockerDesktopSmokeMode('docker-desktop-images')).toBe(true);
    expect(dockerDesktopSmokeNetworkAccess('batch')).toBeUndefined();
    expect(dockerDesktopSmokeNetworkAccess('docker-desktop-recovery')).toBe('offline');
    expect(dockerDesktopSmokeNetworkAccess('docker-desktop-pty')).toBe('offline');
    expect(dockerDesktopSmokeNetworkAccess('docker-desktop-disabled')).toBeUndefined();
  });

  it('uses one reviewed image, the managed bridge, exact nonces, and no ordinary publish flag', () => {
    const plan = buildPublicRegistryWorkloadPlan(nonce);
    expect(plan.image).toBe(PUBLIC_REGISTRY_SMOKE_IMAGE);
    expect(plan.image).toBe('busybox:1.37.0-glibc');
    expect(plan.pull).toEqual(['image', 'pull', PUBLIC_REGISTRY_SMOKE_IMAGE]);
    expect(plan.inspectApplets).toEqual([
      'container',
      'run',
      '--rm',
      '--network',
      'none',
      '--pull',
      'never',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      PUBLIC_REGISTRY_SMOKE_IMAGE,
      '/bin/busybox',
      '--list',
    ]);
    expect(DENIED_REGISTRY_SMOKE_IMAGE).toMatch(/^example\.invalid\//u);
    expect(plan.networkName).toBe('ironcurtain');
    expect(plan.inspectNetwork).toEqual(['network', 'inspect', '--format', '{{json .}}', plan.networkName]);
    expect(plan.inspectDefaultBridge).toEqual(['network', 'inspect', '--format', '{{json .}}', 'bridge']);
    expect(plan.startDefaultNetworkContainer).not.toContain('--network');
    expect(plan.startDefaultNetworkContainer).toContain(plan.defaultProbeName);
    expect(plan.inspectDefaultNetworkContainer).toEqual([
      'container',
      'inspect',
      '--format',
      '{{json .NetworkSettings.Networks}}',
      plan.defaultProbeName,
    ]);
    expect(plan.removeDefaultNetworkContainer).toEqual(['container', 'rm', '--force', plan.defaultProbeName]);
    expect(plan.serverAlias).toBe('target');
    expect(plan.startServer).not.toContain(plan.networkName);
    expect(plan.probeServerIpv4).not.toContain(plan.networkName);
    expect(plan.probeServerAlias).not.toContain(plan.networkName);
    expect(plan.probeDirectIpEgress).toContain('host');
    expect(plan.probeDirectIpEgress).not.toContain(plan.networkName);
    expect(plan.probeDirectIpEgress.join(' ')).toContain('http://1.1.1.1/');
    expect(plan.probeDirectIpEgress.join(' ')).toContain('IC_DIRECT_EGRESS_PROBE_STARTED');
    expect(plan.startHostNetworkServer).toContain('host');
    expect(plan.startHostNetworkServer).toContain(plan.hostServerName);
    expect(plan.startHostNetworkServer.at(-1)).toBe(nonce);
    expect(plan.hostServerPort).toBe(22_000 + (Number.parseInt(nonce.slice(0, 4), 16) % 8_000));
    expect(plan.hostServerPort).toBeGreaterThanOrEqual(22_000);
    expect(plan.hostServerPort).toBeLessThan(30_000);
    expect(plan.hostServerPort).not.toBe(18_080);
    expect(plan.hostServerPort).not.toBe(18_081);
    expect(plan.startHostNetworkServer.join(' ')).toContain(`-p ${plan.hostServerPort}`);
    expect(plan.inspectHostNetworkServer).toEqual([
      'container',
      'inspect',
      '--format',
      '{{.HostConfig.NetworkMode}}',
      plan.hostServerName,
    ]);
    expect(plan.probeHostNetworkServerLoopback).toContain(plan.hostServerName);
    expect(plan.probeHostNetworkServerLoopback.join(' ')).toContain(`http://127.0.0.1:${plan.hostServerPort}/`);
    expect(plan.removeHostNetworkServer).toEqual(['container', 'rm', '--force', plan.hostServerName]);
    expect(plan.inspectEmbeddedDns.join(' ')).toContain('/etc/resolv.conf');
    expect(plan.probePublicDnsEgress.join(' ')).toContain('http://example.com/');
    expect(plan.probePublicDnsEgress.join(' ')).toContain('IC_PUBLIC_DNS_PROBE_STARTED');
    expect(plan.startServer.join(' ')).toContain('/bin/busybox httpd');
    expect(plan.probeServerLoopback.join(' ')).toContain('http://127.0.0.1:8080/');
    expect(plan.probeServerIpv4.join(' ')).toContain('/bin/busybox wget');
    expect(plan.probeServerAlias.join(' ')).toContain('http://target:8080/');
    expect(plan.probeDirectIpEgress.join(' ')).toContain('/bin/busybox wget');
    expect(plan.startServer.at(-1)).toBe(nonce);
    expect(plan.startServer.at(-3)).not.toContain(nonce);

    expect(plan.startPublishedServer).toContain('--publish');
    expect(plan.publishedHostPort).toBe(30_000 + (Number.parseInt(nonce.slice(4, 8), 16) % 8_000));
    expect(plan.publishedHostPort).toBeGreaterThanOrEqual(30_000);
    expect(plan.publishedHostPort).toBeLessThan(38_000);
    expect(plan.publishedHostPort).not.toBe(plan.hostServerPort);
    expect(plan.startPublishedServer).toContain(`127.0.0.1:${plan.publishedHostPort}:8080`);
    expect(plan.startPublishedServer).toContain(plan.publishedServerName);
    expect(plan.probePublishedServerLoopback).toContain(plan.publishedServerName);
    expect(plan.probePublishedServerLoopback.join(' ')).toContain('http://127.0.0.1:8080/');
    const ordinaryArgv = [
      ...plan.startServer,
      ...plan.inspectEmbeddedDns,
      ...plan.probePublicDnsEgress,
      ...plan.probeDirectIpEgress,
      ...plan.probeServerLoopback,
      ...plan.probeServerIpv4,
      ...plan.probeServerAlias,
    ];
    expect(ordinaryArgv).not.toContain('-p');
    expect(ordinaryArgv).not.toContain('--publish');
    expect(ordinaryArgv).not.toContain('--publish-all');
  });

  it('rejects shell-capable nonce values', () => {
    expect(() => buildPublicRegistryWorkloadPlan('$(touch /tmp/no)')).toThrow(/nonce/u);
  });

  it('distinguishes only the exact nonce from unrelated localhost responses', () => {
    expect(isExactSmokeNonceResponse(nonce, nonce)).toBe(true);
    expect(isExactSmokeNonceResponse(`${nonce}\n`, nonce)).toBe(false);
    expect(isExactSmokeNonceResponse('IRONCURTAIN_OK/1\n', nonce)).toBe(false);
    expect(isExactSmokeNonceResponse('', nonce)).toBe(false);
    expect(() => isExactSmokeNonceResponse(nonce, 'not-a-nonce')).toThrow(/nonce/u);
  });

  it('accepts only empty Docker port-binding inspections', () => {
    expect(() => assertNoPublishedPortBindings('null\n')).not.toThrow();
    expect(() => assertNoPublishedPortBindings('{}\n')).not.toThrow();
    expect(() => assertNoPublishedPortBindings('{"8080/tcp":null}')).not.toThrow();
    expect(() => assertNoPublishedPortBindings('{"443/tcp":[],"8080/tcp":null}')).not.toThrow();
    expect(() => assertNoPublishedPortBindings('{"8080/tcp":[{"HostPort":"1234"}]}')).toThrow(/publishes/u);
    expect(() => assertNoPublishedPortBindings('{"8080/tcp":{}}')).toThrow(/malformed/u);
    expect(() => assertNoPublishedPortBindings('{"8080/tcp":"none"}')).toThrow(/malformed/u);
    expect(() => assertNoPublishedPortBindings('[]')).toThrow(/malformed/u);
    expect(() => assertNoPublishedPortBindings('not-json')).toThrow(/malformed/u);
  });

  it('requires exactly Docker embedded DNS and rejects host/public resolver fallbacks', () => {
    expect(() =>
      assertEmbeddedDnsResolver('# Generated by Docker\nnameserver 127.0.0.11\noptions ndots:0\n'),
    ).not.toThrow();
    expect(() => assertEmbeddedDnsResolver('nameserver 8.8.8.8\n')).toThrow(/embedded DNS/u);
    expect(() => assertEmbeddedDnsResolver('nameserver 127.0.0.11\nnameserver 8.8.8.8\n')).toThrow(/embedded DNS/u);
    expect(() => assertEmbeddedDnsResolver('nameserver 127.0.0.11 unexpected\n')).toThrow(/embedded DNS/u);
    expect(() => assertEmbeddedDnsResolver('search example.test\n')).toThrow(/embedded DNS/u);
  });

  it('requires the exact nested-Docker environment exported by the live agent container', () => {
    expect(() =>
      assertExactAgentDockerEnvironment(
        'HOME=/home/codespace\nDOCKER_HOST=unix:///run/ironcurtain-docker/docker.sock\nIRONCURTAIN_DOCKER_NETWORK=ironcurtain\n',
      ),
    ).not.toThrow();
    expect(() => assertExactAgentDockerEnvironment('IRONCURTAIN_DOCKER_NETWORK=ironcurtain\n')).toThrow(/DOCKER_HOST/u);
    expect(() =>
      assertExactAgentDockerEnvironment(
        'DOCKER_HOST=unix:///run/ironcurtain-docker/docker.sock\nIRONCURTAIN_DOCKER_NETWORK=wrong\n',
      ),
    ).toThrow(/IRONCURTAIN_DOCKER_NETWORK/u);
    expect(() =>
      assertExactAgentDockerEnvironment(
        'DOCKER_HOST=unix:///run/ironcurtain-docker/docker.sock\nDOCKER_HOST=unix:///other.sock\nIRONCURTAIN_DOCKER_NETWORK=ironcurtain\n',
      ),
    ).toThrow(/DOCKER_HOST/u);
  });

  it('accepts only an internal bridge and extracts the exact server endpoint IPv4', () => {
    const networkId = 'a'.repeat(64);
    const empty = JSON.stringify({
      Id: networkId,
      Name: 'ironcurtain',
      Driver: 'bridge',
      Scope: 'local',
      Internal: true,
      Containers: {},
    });
    expect(assertInternalBridge(empty)).toEqual({ networkId });
    expect(assertEmptyInternalBridge(empty)).toEqual({ networkId });
    const withServer = JSON.stringify({
      Id: networkId,
      Name: 'ironcurtain',
      Driver: 'bridge',
      Scope: 'local',
      Internal: true,
      Containers: { endpoint: { Name: 'server', IPv4Address: '172.20.0.2/16' } },
    });
    expect(assertInternalBridge(withServer, 'server')).toEqual({ networkId, serverIpv4: '172.20.0.2' });
    expect(() => assertEmptyInternalBridge(withServer)).toThrow(/not empty/u);
    expect(() =>
      assertInternalBridge(
        JSON.stringify({
          Id: networkId,
          Name: 'ironcurtain',
          Driver: 'bridge',
          Scope: 'local',
          Internal: true,
          Containers: { endpoint: { Name: 'server', IPv4Address: '172.20.0.2/99' } },
        }),
        'server',
      ),
    ).toThrow(/malformed/u);
    expect(() =>
      assertInternalBridge(
        JSON.stringify({ Id: 'bad', Name: 'ironcurtain', Driver: 'bridge', Scope: 'local', Internal: true }),
      ),
    ).toThrow(/ID/u);
    expect(() =>
      assertInternalBridge(
        JSON.stringify({
          Id: networkId,
          Name: 'ironcurtain',
          Driver: 'bridge',
          Scope: 'local',
          Internal: false,
        }),
      ),
    ).toThrow(/internal/u);
    expect(() =>
      assertInternalBridge(
        JSON.stringify({
          Id: networkId,
          Name: 'ironcurtain',
          Driver: 'overlay',
          Scope: 'local',
          Internal: true,
        }),
      ),
    ).toThrow(/internal/u);
    expect(() =>
      assertInternalBridge(
        JSON.stringify({ Id: networkId, Name: 'other', Driver: 'bridge', Scope: 'local', Internal: true }),
      ),
    ).toThrow(/managed/u);
    expect(() => assertInternalBridge(empty, 'server')).toThrow(/endpoint/u);
    expect(() => assertInternalBridge('not-json')).toThrow(/malformed/u);
  });

  it('accepts only exact default-bridge absence', () => {
    expect(() =>
      assertDefaultBridgeUnavailable('', 'Error response from daemon: network bridge not found'),
    ).not.toThrow();
    expect(() => assertDefaultBridgeUnavailable('', 'permission denied')).toThrow(/unavailable diagnostic/u);
  });

  it('allows only empty default-mode attachment metadata', () => {
    expect(() => assertDefaultContainerHasNoUsableNetwork('{}')).not.toThrow();
    expect(() =>
      assertDefaultContainerHasNoUsableNetwork(
        JSON.stringify({
          bridge: {
            NetworkID: '',
            EndpointID: '',
            Gateway: '',
            IPAddress: '',
            IPv6Gateway: '',
            GlobalIPv6Address: '',
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertDefaultContainerHasNoUsableNetwork(
        JSON.stringify({ bridge: { NetworkID: 'a'.repeat(64), EndpointID: '', Gateway: '', IPAddress: '' } }),
      ),
    ).toThrow(/NetworkID/u);
    expect(() =>
      assertDefaultContainerHasNoUsableNetwork(
        JSON.stringify({ bridge: { NetworkID: '', EndpointID: '', Gateway: '172.17.0.1', IPAddress: '' } }),
      ),
    ).toThrow(/Gateway/u);
    expect(() => assertDefaultContainerHasNoUsableNetwork('not-json')).toThrow(/malformed JSON/u);
  });

  it('binds trusted network inspection only into dedicated argv fields', () => {
    const plan = buildPublicRegistryWorkloadPlan(nonce);
    const networkId = 'b'.repeat(64);
    expect(bindPublicRegistryWorkloadNetwork(plan.startServer, networkId)).toContain(networkId);
    expect(bindPublicRegistryWorkloadNetwork(plan.probeServerAlias, networkId)).toContain(networkId);
    const ipv4 = bindPublicRegistryWorkloadNetwork(plan.probeServerIpv4, networkId, '172.20.0.2');
    expect(ipv4).toContain(networkId);
    expect(ipv4).toContain('http://172.20.0.2:8080/');
    expect(() => bindPublicRegistryWorkloadNetwork(plan.probeServerIpv4, networkId)).toThrow(/IPv4/u);
    expect(() => bindPublicRegistryWorkloadNetwork(plan.startServer, 'not-an-id')).toThrow(/network ID/u);
    expect(() => bindPublicRegistryWorkloadNetwork(plan.startServer, networkId, 'not-an-ip')).toThrow(/IPv4/u);
  });

  it('requires exact httpd and wget applet lines before exercising the fixture', () => {
    expect(() => assertRequiredBusyboxApplets('httpd\nsh\nwget\n')).not.toThrow();
    expect(() => assertRequiredBusyboxApplets('sh\nwget\n')).toThrow(/httpd/u);
    expect(() => assertRequiredBusyboxApplets('httpd\nsh\n')).toThrow(/wget/u);
    expect(() => assertRequiredBusyboxApplets('httpd\nhttpd\nwget\n')).toThrow(/httpd/u);
    expect(() => assertRequiredBusyboxApplets('my-httpd\nwget-helper\n')).toThrow(/httpd/u);
  });

  it('accepts an explicit policy denial and rejects generic connectivity failures', () => {
    expect(() => assertRegistryPolicyDenied('', 'unexpected status: 403 Forbidden')).not.toThrow();
    expect(() => assertRegistryPolicyDenied('', 'dial tcp: lookup example.invalid: no such host')).toThrow(
      /connectivity/u,
    );
    expect(() => assertRegistryPolicyDenied('', 'request timed out with 403 in diagnostics')).toThrow(/connectivity/u);
    expect(() => assertRegistryPolicyDenied('', 'pull access denied')).toThrow(/lacks/u);
  });
});
