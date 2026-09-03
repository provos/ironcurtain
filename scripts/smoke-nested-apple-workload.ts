import { isIP } from 'node:net';
import type { DockerWorkloadNetworkAccess, DockerWorkloadRequestedConfig } from '../src/docker-workload/config.js';
import { APPLE_VM_DAEMON_DOCKER_HOST } from '../src/docker-workload/apple-vm-daemon.js';
import {
  APPLE_VM_DOCKER_WORKLOAD_NETWORK,
  APPLE_VM_DOCKER_WORKLOAD_NETWORK_ENV,
} from '../src/docker-workload/apple-private-docker.js';

export const DOCKER_DESKTOP_SMOKE_CASES = [
  { mode: 'docker-desktop-recovery', flag: '--docker-desktop-recovery', networkAccess: 'offline' },
  { mode: 'docker-desktop-disabled', flag: '--docker-desktop-disabled', networkAccess: null },
  { mode: 'docker-desktop-pty', flag: '--docker-desktop-pty', networkAccess: 'offline' },
  { mode: 'docker-desktop-offline', flag: '--docker-desktop-offline', networkAccess: 'offline' },
  { mode: 'docker-desktop-images', flag: '--docker-desktop-images', networkAccess: 'images' },
  { mode: 'docker-desktop-packages', flag: '--docker-desktop-packages', networkAccess: 'packages' },
] as const satisfies readonly {
  readonly mode: string;
  readonly flag: string;
  readonly networkAccess: DockerWorkloadNetworkAccess | null;
}[];

export type DockerDesktopSmokeMode = (typeof DOCKER_DESKTOP_SMOKE_CASES)[number]['mode'];
export type NestedAppleSmokeMode = 'batch' | 'pty' | 'public-registry' | DockerDesktopSmokeMode;

/** Recovery leads; every later gate proves that a fresh admission still works. */
export const DOCKER_DESKTOP_QUALIFICATION_ARGUMENTS = DOCKER_DESKTOP_SMOKE_CASES.map(({ flag }) => [flag] as const);

/** Small Docker Official multi-architecture image with reviewed built-in applets. */
export const PUBLIC_REGISTRY_SMOKE_IMAGE = 'busybox:1.37.0-glibc';

/** Deliberately outside the frozen registry-origin manifest. */
export const DENIED_REGISTRY_SMOKE_IMAGE = 'example.invalid/ironcurtain/denied:latest';

/** Test-only archive staged in the ordinary workspace for the Desktop Offline gate. */
export const DOCKER_DESKTOP_OFFLINE_ARCHIVE = 'images/ironcurtain-offline-fixture.tar';
export const DOCKER_DESKTOP_OFFLINE_MARKER = 'ironcurtain-offline-load-run-ok';
export const DOCKER_DESKTOP_WORKSPACE_INPUT = 'ironcurtain-workspace-input.txt';
export const DOCKER_DESKTOP_WORKSPACE_OUTPUT = 'ironcurtain-workspace-output.txt';

const NETWORK_ID_ARGUMENT = '__IRONCURTAIN_SMOKE_NETWORK_ID__';
const SERVER_IPV4_ARGUMENT = '__IRONCURTAIN_SMOKE_SERVER_IPV4__';

export interface PublicRegistryWorkloadPlan {
  readonly image: string;
  readonly networkName: string;
  readonly serverName: string;
  readonly publishedServerName: string;
  readonly publishedHostPort: number;
  readonly hostServerName: string;
  readonly hostServerPort: number;
  readonly defaultProbeName: string;
  readonly serverAlias: string;
  readonly pull: readonly string[];
  readonly inspectApplets: readonly string[];
  readonly inspectNetwork: readonly string[];
  readonly inspectDefaultBridge: readonly string[];
  readonly startDefaultNetworkContainer: readonly string[];
  readonly inspectDefaultNetworkContainer: readonly string[];
  readonly inspectEmbeddedDns: readonly string[];
  readonly probePublicDnsEgress: readonly string[];
  readonly startServer: readonly string[];
  readonly inspectServerPorts: readonly string[];
  readonly inspectServerNetwork: readonly string[];
  readonly probeDirectIpEgress: readonly string[];
  readonly startHostNetworkServer: readonly string[];
  readonly inspectHostNetworkServer: readonly string[];
  readonly probeHostNetworkServerLoopback: readonly string[];
  readonly probeServerLoopback: readonly string[];
  readonly probeServerIpv4: readonly string[];
  readonly probeServerAlias: readonly string[];
  readonly startPublishedServer: readonly string[];
  readonly probePublishedServerLoopback: readonly string[];
  readonly inspectPublishedServerPorts: readonly string[];
  readonly removeServer: readonly string[];
  readonly removePublishedServer: readonly string[];
  readonly removeHostNetworkServer: readonly string[];
  readonly removeDefaultNetworkContainer: readonly string[];
  readonly removeImage: readonly string[];
}

export function parseNestedAppleSmokeMode(argv: readonly string[]): NestedAppleSmokeMode {
  if (argv.length === 0) return 'batch';
  if (argv.length === 1 && argv[0] === '--pty') return 'pty';
  if (argv.length === 1 && argv[0] === '--public-registry') return 'public-registry';
  const desktop = argv.length === 1 ? DOCKER_DESKTOP_SMOKE_CASES.find(({ flag }) => flag === argv[0]) : undefined;
  if (desktop !== undefined) return desktop.mode;
  throw new Error(
    'usage: smoke-nested-apple.ts [--pty | --public-registry | ' +
      `${DOCKER_DESKTOP_SMOKE_CASES.map(({ flag }) => flag).join(' | ')}] ` +
      '(the modes are separate acceptance gates)',
  );
}

export function isDockerDesktopSmokeMode(mode: NestedAppleSmokeMode): boolean {
  return DOCKER_DESKTOP_SMOKE_CASES.some((candidate) => candidate.mode === mode);
}

export function dockerDesktopSmokeNetworkAccess(
  mode: NestedAppleSmokeMode,
): 'offline' | 'images' | 'packages' | undefined {
  return DOCKER_DESKTOP_SMOKE_CASES.find((candidate) => candidate.mode === mode)?.networkAccess ?? undefined;
}

export function buildNestedAppleSmokeWorkloadConfig(mode: NestedAppleSmokeMode): DockerWorkloadRequestedConfig {
  // Exercise the same canonical request shape operators use. This legacy
  // smoke's registry gate maps to Images; deterministic batch/PTY gates are
  // explicitly Offline.
  if (mode === 'public-registry') return { enabled: true, networkAccess: 'images' };
  if (mode === 'docker-desktop-disabled') return { enabled: false };
  const desktopNetworkAccess = dockerDesktopSmokeNetworkAccess(mode);
  if (desktopNetworkAccess !== undefined) return { enabled: true, networkAccess: desktopNetworkAccess };
  return { enabled: true, networkAccess: 'offline' };
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
  const networkName = APPLE_VM_DOCKER_WORKLOAD_NETWORK;
  const serverName = `ic-smoke-server-${suffix}`;
  const publishedServerName = `ic-smoke-published-${suffix}`;
  const publishedHostPort = 30_000 + (Number.parseInt(nonce.slice(4, 8), 16) % 8_000);
  const hostServerName = `ic-smoke-host-${suffix}`;
  const hostServerPort = 22_000 + (Number.parseInt(nonce.slice(0, 4), 16) % 8_000);
  const defaultProbeName = `ic-smoke-default-${suffix}`;
  const serverAlias = 'target';
  const serverScript = '/bin/busybox printf "%s" "$1" > /tmp/index.html; exec /bin/busybox httpd -f -p 8080 -h /tmp';
  const hostServerScript = `/bin/busybox printf "%s" "$1" > /tmp/index.html; exec /bin/busybox httpd -f -p ${hostServerPort} -h /tmp`;
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
    publishedServerName,
    publishedHostPort,
    hostServerName,
    hostServerPort,
    defaultProbeName,
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
    inspectNetwork: ['network', 'inspect', '--format', '{{json .}}', networkName],
    inspectDefaultBridge: ['network', 'inspect', '--format', '{{json .}}', 'bridge'],
    startDefaultNetworkContainer: [
      'container',
      'run',
      '--detach',
      '--name',
      defaultProbeName,
      '--pull',
      'never',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      PUBLIC_REGISTRY_SMOKE_IMAGE,
      '/bin/busybox',
      'sleep',
      '300',
    ],
    inspectDefaultNetworkContainer: [
      'container',
      'inspect',
      '--format',
      '{{json .NetworkSettings.Networks}}',
      defaultProbeName,
    ],
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
    startHostNetworkServer: [
      'container',
      'run',
      '--detach',
      '--name',
      hostServerName,
      '--network',
      'host',
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
      hostServerScript,
      'sh',
      nonce,
    ],
    inspectHostNetworkServer: ['container', 'inspect', '--format', '{{.HostConfig.NetworkMode}}', hostServerName],
    probeHostNetworkServerLoopback: [
      'container',
      'exec',
      hostServerName,
      '/bin/busybox',
      'sh',
      '-c',
      probeScript,
      'sh',
      `http://127.0.0.1:${hostServerPort}/`,
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
    startPublishedServer: [
      'container',
      'run',
      '--detach',
      '--name',
      publishedServerName,
      '--network',
      NETWORK_ID_ARGUMENT,
      '--publish',
      `127.0.0.1:${publishedHostPort}:8080`,
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
    probePublishedServerLoopback: [
      'container',
      'exec',
      publishedServerName,
      '/bin/busybox',
      'sh',
      '-c',
      probeScript,
      'sh',
      'http://127.0.0.1:8080/',
    ],
    inspectPublishedServerPorts: [
      'container',
      'inspect',
      '--format',
      '{{json .NetworkSettings.Ports}}',
      publishedServerName,
    ],
    removeServer: ['container', 'rm', '--force', serverName],
    removePublishedServer: ['container', 'rm', '--force', publishedServerName],
    removeHostNetworkServer: ['container', 'rm', '--force', hostServerName],
    removeDefaultNetworkContainer: ['container', 'rm', '--force', defaultProbeName],
    removeImage: ['image', 'rm', PUBLIC_REGISTRY_SMOKE_IMAGE],
  };
}

export interface InternalBridgeInspection {
  readonly networkId: string;
  readonly serverIpv4?: string;
}

/** Prove the live agent container received the exact nested-Docker contract. */
export function assertExactAgentDockerEnvironment(value: string): void {
  const lines = value.split(/\r?\n/u);
  const expected = {
    DOCKER_HOST: APPLE_VM_DAEMON_DOCKER_HOST,
    [APPLE_VM_DOCKER_WORKLOAD_NETWORK_ENV]: APPLE_VM_DOCKER_WORKLOAD_NETWORK,
  } as const;
  for (const [name, expectedValue] of Object.entries(expected)) {
    const matches = lines.filter((line) => line.startsWith(`${name}=`));
    if (matches.length !== 1 || matches[0] !== `${name}=${expectedValue}`) {
      throw new Error(`agent container lacks exact ${name}=${expectedValue}`);
    }
  }
}

/** Compare identity evidence without treating unrelated localhost content as reachability. */
export function isExactSmokeNonceResponse(value: string, nonce: string): boolean {
  if (!/^[a-f0-9]{32,128}$/u.test(nonce)) throw new Error('smoke response nonce is invalid');
  return value === nonce;
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
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('inner server returned malformed Docker port-binding inspection shape');
  }
  for (const binding of Object.values(parsed)) {
    if (binding === null || (Array.isArray(binding) && binding.length === 0)) continue;
    if (Array.isArray(binding)) {
      throw new Error(`inner server unexpectedly publishes a port: ${value.trim()}`);
    }
    throw new Error('inner server returned malformed Docker port-binding inspection shape');
  }
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

/** Inspect the precreated bundle-local user-defined bridge topology. */
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
    (parsed as { Name?: unknown }).Name !== APPLE_VM_DOCKER_WORKLOAD_NETWORK ||
    (parsed as { Driver?: unknown }).Driver !== 'bridge' ||
    (parsed as { Scope?: unknown }).Scope !== 'local' ||
    (parsed as { Internal?: unknown }).Internal !== true
  ) {
    throw new Error('inner network is not the bundle-local managed internal bridge');
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

/** Require no endpoint before the acceptance fixture attaches its first child. */
export function assertEmptyInternalBridge(value: string): InternalBridgeInspection {
  const inspection = assertInternalBridge(value);
  const parsed = JSON.parse(value.trim()) as { Containers?: unknown };
  if (
    typeof parsed.Containers !== 'object' ||
    parsed.Containers === null ||
    Array.isArray(parsed.Containers) ||
    Object.keys(parsed.Containers).length !== 0
  ) {
    throw new Error('bundle-local managed bridge was not empty before the smoke fixture');
  }
  return inspection;
}

/** Accept only the daemon's exact no-default-bridge diagnostic. */
export function assertDefaultBridgeUnavailable(stdout: string, stderr: string): void {
  const output = `${stdout}\n${stderr}`;
  if (!/(?:network bridge not found|no such network(?::| ) bridge)/iu.test(output)) {
    throw new Error(`default bridge negative lacked an exact unavailable diagnostic: ${output.trim()}`);
  }
}

/** Require a default-mode child to have no runtime endpoint, address, or gateway. */
export function assertDefaultContainerHasNoUsableNetwork(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim()) as unknown;
  } catch (error) {
    throw new Error('default-network container inspection returned malformed JSON', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('default-network container inspection was not a network map');
  }
  for (const attachment of Object.values(parsed)) {
    if (typeof attachment !== 'object' || attachment === null || Array.isArray(attachment)) {
      throw new Error('default-network container inspection contained a malformed attachment');
    }
    const fields = attachment as Record<string, unknown>;
    for (const name of ['NetworkID', 'EndpointID', 'Gateway', 'IPAddress', 'IPv6Gateway', 'GlobalIPv6Address']) {
      const field = fields[name];
      if (field !== undefined && field !== '') {
        throw new Error(`default-network container unexpectedly received ${name}`);
      }
    }
  }
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
