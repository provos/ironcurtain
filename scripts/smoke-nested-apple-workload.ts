import { isIP } from 'node:net';
import type { DockerWorkloadRequestedConfig } from '../src/docker-workload/config.js';

export type NestedAppleSmokeMode = 'batch' | 'pty' | 'public-registry';

/** Small Docker Official multi-architecture image with reviewed built-in applets. */
export const PUBLIC_REGISTRY_SMOKE_IMAGE = 'busybox:1.37.0-glibc';

/** Deliberately outside the frozen registry-origin manifest. */
export const DENIED_REGISTRY_SMOKE_IMAGE = 'example.invalid/ironcurtain/denied:latest';

const NETWORK_ID_ARGUMENT = '__IRONCURTAIN_SMOKE_NETWORK_ID__';
const SERVER_IPV4_ARGUMENT = '__IRONCURTAIN_SMOKE_SERVER_IPV4__';

export interface PublicRegistryWorkloadPlan {
  readonly image: string;
  readonly networkName: string;
  readonly serverName: string;
  readonly serverAlias: string;
  readonly pull: readonly string[];
  readonly inspectApplets: readonly string[];
  readonly createNetwork: readonly string[];
  readonly inspectNetwork: readonly string[];
  readonly inspectEmbeddedDns: readonly string[];
  readonly probePublicDnsEgress: readonly string[];
  readonly startServer: readonly string[];
  readonly inspectServerPorts: readonly string[];
  readonly inspectServerNetwork: readonly string[];
  readonly probeDirectIpEgress: readonly string[];
  readonly probeServerLoopback: readonly string[];
  readonly probeServerIpv4: readonly string[];
  readonly probeServerAlias: readonly string[];
  readonly removeServer: readonly string[];
  readonly removeNetwork: readonly string[];
  readonly removeImage: readonly string[];
}

export function parseNestedAppleSmokeMode(argv: readonly string[]): NestedAppleSmokeMode {
  if (argv.length === 0) return 'batch';
  if (argv.length === 1 && argv[0] === '--pty') return 'pty';
  if (argv.length === 1 && argv[0] === '--public-registry') return 'public-registry';
  throw new Error('usage: smoke-nested-apple.ts [--pty | --public-registry] (the modes are separate acceptance gates)');
}

export function buildNestedAppleSmokeWorkloadConfig(mode: NestedAppleSmokeMode): DockerWorkloadRequestedConfig {
  return {
    enabled: true,
    tier: 'developer-only',
    backend: 'apple-container',
    imageMode: 'preloaded-catalog',
    imageIngress: mode === 'public-registry' ? 'public-registry' : 'preloaded-only',
    daemonState: 'ephemeral',
    hostPortPublishing: false,
    buildEgress: 'disabled',
    acceptObservedDiskRisk: true,
    resources: { memoryMb: 4096, cpus: 2, pids: { desired: 512, required: false }, diskMb: null },
  };
}

/**
 * Construct the only inner workload exercised by the public-registry gate.
 * Values that cross a shell boundary are positional parameters, not source.
 */
export function buildPublicRegistryWorkloadPlan(nonce: string): PublicRegistryWorkloadPlan {
  if (!/^[a-f0-9]{32,128}$/u.test(nonce)) {
    throw new Error('public-registry smoke nonce must be 32-128 lowercase hexadecimal characters');
  }
  const suffix = nonce.slice(0, 12);
  const networkName = `ic-smoke-net-${suffix}`;
  const serverName = `ic-smoke-server-${suffix}`;
  const serverAlias = 'target';
  const serverScript = '/bin/busybox printf "%s" "$1" > /tmp/index.html; exec /bin/busybox httpd -f -p 8080 -h /tmp';
  const probeScript = [
    'attempt=0',
    'while [ "$attempt" -lt 10 ]; do',
    '  if /bin/busybox wget -T 3 -S -O- "$1"; then exit 0; fi',
    '  attempt=$((attempt + 1))',
    '  /bin/busybox sleep 1',
    'done',
    'exit 1',
  ].join('\n');

  return {
    image: PUBLIC_REGISTRY_SMOKE_IMAGE,
    networkName,
    serverName,
    serverAlias,
    pull: ['image', 'pull', PUBLIC_REGISTRY_SMOKE_IMAGE],
    inspectApplets: [
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
    ],
    createNetwork: ['network', 'create', '--driver', 'bridge', '--internal', networkName],
    inspectNetwork: ['network', 'inspect', '--format', '{{json .}}', networkName],
    inspectEmbeddedDns: [
      'container',
      'run',
      '--rm',
      '--network',
      NETWORK_ID_ARGUMENT,
      '--pull',
      'never',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      PUBLIC_REGISTRY_SMOKE_IMAGE,
      '/bin/busybox',
      'cat',
      '/etc/resolv.conf',
    ],
    probePublicDnsEgress: [
      'container',
      'run',
      '--rm',
      '--network',
      NETWORK_ID_ARGUMENT,
      '--pull',
      'never',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      PUBLIC_REGISTRY_SMOKE_IMAGE,
      '/bin/busybox',
      'sh',
      '-c',
      '/bin/busybox printf "IC_PUBLIC_DNS_PROBE_STARTED\\n" >&2; exec /bin/busybox wget -T 3 -qO- http://example.com/',
    ],
    startServer: [
      'container',
      'run',
      '--detach',
      '--name',
      serverName,
      '--network',
      NETWORK_ID_ARGUMENT,
      '--network-alias',
      serverAlias,
      '--pull',
      'never',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=64k',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      PUBLIC_REGISTRY_SMOKE_IMAGE,
      '/bin/busybox',
      'sh',
      '-c',
      serverScript,
      'sh',
      nonce,
    ],
    inspectServerPorts: ['container', 'inspect', '--format', '{{json .HostConfig.PortBindings}}', serverName],
    inspectServerNetwork: ['container', 'inspect', '--format', '{{.HostConfig.NetworkMode}}', serverName],
    probeDirectIpEgress: [
      'container',
      'run',
      '--rm',
      '--network',
      'host',
      '--pull',
      'never',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      PUBLIC_REGISTRY_SMOKE_IMAGE,
      '/bin/busybox',
      'sh',
      '-c',
      '/bin/busybox printf "IC_DIRECT_EGRESS_PROBE_STARTED\\n" >&2; exec /bin/busybox wget -T 3 -qO- http://1.1.1.1/',
    ],
    probeServerLoopback: [
      'container',
      'exec',
      serverName,
      '/bin/busybox',
      'sh',
      '-c',
      probeScript,
      'sh',
      'http://127.0.0.1:8080/',
    ],
    probeServerIpv4: [
      'container',
      'run',
      '--rm',
      '--network',
      NETWORK_ID_ARGUMENT,
      '--pull',
      'never',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      PUBLIC_REGISTRY_SMOKE_IMAGE,
      '/bin/busybox',
      'sh',
      '-c',
      probeScript,
      'sh',
      `http://${SERVER_IPV4_ARGUMENT}:8080/`,
    ],
    probeServerAlias: [
      'container',
      'run',
      '--rm',
      '--network',
      NETWORK_ID_ARGUMENT,
      '--pull',
      'never',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      PUBLIC_REGISTRY_SMOKE_IMAGE,
      '/bin/busybox',
      'sh',
      '-c',
      probeScript,
      'sh',
      `http://${serverAlias}:8080/`,
    ],
    removeServer: ['container', 'rm', '--force', serverName],
    removeNetwork: ['network', 'rm', networkName],
    removeImage: ['image', 'rm', PUBLIC_REGISTRY_SMOKE_IMAGE],
  };
}

export interface InternalBridgeInspection {
  readonly networkId: string;
  readonly serverIpv4?: string;
}

/** Fail before topology checks if the resolved tag lacks either required applet. */
export function assertRequiredBusyboxApplets(value: string): void {
  const applets = value.split(/\r?\n/u).filter((line) => line.length > 0);
  for (const required of ['httpd', 'wget']) {
    if (applets.filter((applet) => applet === required).length !== 1) {
      throw new Error(`public-registry fixture lacks exact BusyBox applet: ${required}`);
    }
  }
}

export function assertNoPublishedPortBindings(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim());
  } catch (error) {
    throw new Error('inner server returned malformed Docker port-binding inspection', { cause: error });
  }
  if (parsed === null) return;
  if (typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return;
  throw new Error(`inner server unexpectedly publishes a port: ${value.trim()}`);
}

/** Require Docker's per-sandbox resolver without accepting a host/public resolver fallback. */
export function assertEmbeddedDnsResolver(value: string): void {
  const nameserverLines = value
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter(([directive]) => directive === 'nameserver');
  if (nameserverLines.length !== 1 || nameserverLines[0]?.length !== 2 || nameserverLines[0][1] !== '127.0.0.11') {
    throw new Error(`inner sibling does not use only Docker embedded DNS: ${value.trim()}`);
  }
}

/** Require the product's supported inner-only, user-defined bridge topology. */
export function assertInternalBridge(value: string, serverName?: string): InternalBridgeInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim());
  } catch (error) {
    throw new Error('inner network returned malformed Docker inspection', { cause: error });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { Driver?: unknown }).Driver !== 'bridge' ||
    (parsed as { Internal?: unknown }).Internal !== true
  ) {
    throw new Error('inner network is not an internal user-defined bridge');
  }
  const networkId = (parsed as { Id?: unknown }).Id;
  if (typeof networkId !== 'string' || !/^[a-f0-9]{64}$/u.test(networkId)) {
    throw new Error('inner network inspection lacks one immutable network ID');
  }
  if (serverName === undefined) return { networkId };

  const containers = (parsed as { Containers?: unknown }).Containers;
  if (typeof containers !== 'object' || containers === null || Array.isArray(containers)) {
    throw new Error('inner network inspection lacks server endpoints');
  }
  const matching = Object.values(containers).filter(
    (endpoint) =>
      typeof endpoint === 'object' &&
      endpoint !== null &&
      !Array.isArray(endpoint) &&
      (endpoint as { Name?: unknown }).Name === serverName,
  );
  if (matching.length !== 1) throw new Error('inner network inspection lacks exactly one named server endpoint');
  const addressWithPrefix = (matching[0] as { IPv4Address?: unknown }).IPv4Address;
  if (typeof addressWithPrefix !== 'string') throw new Error('inner server endpoint lacks an IPv4 address');
  const [serverIpv4, prefix, ...remainder] = addressWithPrefix.split('/');
  const prefixValue = prefix === undefined ? Number.NaN : Number(prefix);
  if (
    remainder.length !== 0 ||
    prefix === undefined ||
    !Number.isInteger(prefixValue) ||
    String(prefixValue) !== prefix ||
    prefixValue < 0 ||
    prefixValue > 32 ||
    isIP(serverIpv4) !== 4
  ) {
    throw new Error('inner server endpoint returned a malformed IPv4 address');
  }
  return { networkId, serverIpv4 };
}

/** Substitute trusted inspect results only into dedicated argv elements. */
export function bindPublicRegistryWorkloadNetwork(
  argv: readonly string[],
  networkId: string,
  serverIpv4?: string,
): readonly string[] {
  if (!/^[a-f0-9]{64}$/u.test(networkId)) throw new Error('smoke network ID is malformed');
  if (serverIpv4 !== undefined && isIP(serverIpv4) !== 4) throw new Error('smoke server IPv4 is malformed');
  let networkBindings = 0;
  let addressBindings = 0;
  const bound = argv.map((argument) => {
    if (argument === NETWORK_ID_ARGUMENT) {
      networkBindings += 1;
      return networkId;
    }
    if (argument === `http://${SERVER_IPV4_ARGUMENT}:8080/`) {
      addressBindings += 1;
      if (serverIpv4 === undefined) throw new Error('smoke server IPv4 is required by argv');
      return `http://${serverIpv4}:8080/`;
    }
    return argument;
  });
  if (networkBindings !== 1) throw new Error('smoke argv must bind exactly one network ID');
  if (addressBindings !== (serverIpv4 === undefined ? 0 : 1)) {
    throw new Error('smoke argv server IPv4 binding does not match the supplied address');
  }
  return bound;
}

/** Distinguish an intentional proxy-policy denial from broken connectivity. */
export function assertRegistryPolicyDenied(stdout: string, stderr: string): void {
  const output = `${stdout}\n${stderr}`;
  if (
    /no such host|network is unreachable|connection refused|timed? out|i\/o timeout|context deadline/iu.test(output)
  ) {
    throw new Error(`denied registry probe failed for connectivity rather than proxy policy: ${output.trim()}`);
  }
  if (!/(?:\b403\b|forbidden)/iu.test(output)) {
    throw new Error(`denied registry probe lacks an explicit proxy-policy 403/Forbidden result: ${output.trim()}`);
  }
}
