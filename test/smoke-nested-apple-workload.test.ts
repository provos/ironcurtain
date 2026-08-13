import { describe, expect, it } from 'vitest';
import {
  DENIED_REGISTRY_SMOKE_IMAGE,
  PUBLIC_REGISTRY_SMOKE_IMAGE,
  assertEmbeddedDnsResolver,
  assertInternalBridge,
  assertNoPublishedPortBindings,
  assertRegistryPolicyDenied,
  assertRequiredBusyboxApplets,
  bindPublicRegistryWorkloadNetwork,
  buildNestedAppleSmokeWorkloadConfig,
  buildPublicRegistryWorkloadPlan,
  parseNestedAppleSmokeMode,
} from '../scripts/smoke-nested-apple-workload.js';

describe('nested Apple smoke invocation', () => {
  it('selects each acceptance gate with one unambiguous argument', () => {
    expect(parseNestedAppleSmokeMode([])).toBe('batch');
    expect(parseNestedAppleSmokeMode(['--pty'])).toBe('pty');
    expect(parseNestedAppleSmokeMode(['--public-registry'])).toBe('public-registry');
  });

  it.each([['--pty', '--public-registry'], ['--public-registry', '--pty'], ['--unknown']])(
    'rejects ambiguous or unknown arguments: %j',
    (...argv) => {
      expect(() => parseNestedAppleSmokeMode(argv)).toThrow(/usage/u);
    },
  );
});

describe('nested Apple public-registry acceptance plan', () => {
  const nonce = '0123456789abcdef0123456789abcdef';

  it('opens only public image ingress while retaining the no-publication envelope', () => {
    const config = buildNestedAppleSmokeWorkloadConfig('public-registry');
    expect(config).toMatchObject({
      enabled: true,
      backend: 'apple-container',
      imageIngress: 'public-registry',
      hostPortPublishing: false,
      buildEgress: 'disabled',
    });
    expect(buildNestedAppleSmokeWorkloadConfig('batch').imageIngress).toBe('preloaded-only');
    expect(buildNestedAppleSmokeWorkloadConfig('pty').imageIngress).toBe('preloaded-only');
  });

  it('uses one reviewed image, an internal inner bridge, exact nonce arguments, and no publish flag', () => {
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
    expect(plan.createNetwork).toEqual(['network', 'create', '--driver', 'bridge', '--internal', plan.networkName]);
    expect(plan.inspectNetwork).toEqual(['network', 'inspect', '--format', '{{json .}}', plan.networkName]);
    expect(plan.serverAlias).toBe('target');
    expect(plan.startServer).not.toContain(plan.networkName);
    expect(plan.probeServerIpv4).not.toContain(plan.networkName);
    expect(plan.probeServerAlias).not.toContain(plan.networkName);
    expect(plan.probeDirectIpEgress).toContain('host');
    expect(plan.probeDirectIpEgress).not.toContain(plan.networkName);
    expect(plan.probeDirectIpEgress.join(' ')).toContain('http://1.1.1.1/');
    expect(plan.probeDirectIpEgress.join(' ')).toContain('IC_DIRECT_EGRESS_PROBE_STARTED');
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

    const argv = [
      ...plan.startServer,
      ...plan.inspectEmbeddedDns,
      ...plan.probePublicDnsEgress,
      ...plan.probeDirectIpEgress,
      ...plan.probeServerLoopback,
      ...plan.probeServerIpv4,
      ...plan.probeServerAlias,
    ];
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('--publish');
    expect(argv).not.toContain('--publish-all');
  });

  it('rejects shell-capable nonce values', () => {
    expect(() => buildPublicRegistryWorkloadPlan('$(touch /tmp/no)')).toThrow(/nonce/u);
  });

  it('accepts only empty Docker port-binding inspections', () => {
    expect(() => assertNoPublishedPortBindings('null\n')).not.toThrow();
    expect(() => assertNoPublishedPortBindings('{}\n')).not.toThrow();
    expect(() => assertNoPublishedPortBindings('{"8080/tcp":[{"HostPort":"1234"}]}')).toThrow(/publishes/u);
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

  it('accepts only an internal bridge and extracts the exact server endpoint IPv4', () => {
    const networkId = 'a'.repeat(64);
    const empty = JSON.stringify({ Id: networkId, Driver: 'bridge', Internal: true, Containers: {} });
    expect(assertInternalBridge(empty)).toEqual({ networkId });
    const withServer = JSON.stringify({
      Id: networkId,
      Driver: 'bridge',
      Internal: true,
      Containers: { endpoint: { Name: 'server', IPv4Address: '172.20.0.2/16' } },
    });
    expect(assertInternalBridge(withServer, 'server')).toEqual({ networkId, serverIpv4: '172.20.0.2' });
    expect(() =>
      assertInternalBridge(
        JSON.stringify({
          Id: networkId,
          Driver: 'bridge',
          Internal: true,
          Containers: { endpoint: { Name: 'server', IPv4Address: '172.20.0.2/99' } },
        }),
        'server',
      ),
    ).toThrow(/malformed/u);
    expect(() => assertInternalBridge('{"Id":"bad","Driver":"bridge","Internal":true}')).toThrow(/ID/u);
    expect(() => assertInternalBridge(`{"Id":"${networkId}","Driver":"bridge","Internal":false}`)).toThrow(/internal/u);
    expect(() => assertInternalBridge(`{"Id":"${networkId}","Driver":"overlay","Internal":true}`)).toThrow(/internal/u);
    expect(() => assertInternalBridge(empty, 'server')).toThrow(/endpoint/u);
    expect(() => assertInternalBridge('not-json')).toThrow(/malformed/u);
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
