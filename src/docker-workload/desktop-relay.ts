import { isIP } from 'node:net';
import type { ExecFileFn } from '../docker/docker-manager.js';
import type { LedgeredOuterCreateAuthority } from './infrastructure.js';

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const RESOURCE_NAME = /^ic-[a-z0-9][a-z0-9_.-]{0,62}$/;
const RELAY_LABEL = 'com.ironcurtain.docker-workload.role';
const BUNDLE_LABEL = 'com.ironcurtain.docker-workload.bundle';
const IPV4_GATEWAY_MODE = 'com.docker.network.bridge.gateway_mode_ipv4';
const IPV6_GATEWAY_MODE = 'com.docker.network.bridge.gateway_mode_ipv6';
const ENABLE_IPV4 = 'com.docker.network.enable_ipv4';
const RELAY_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
export const DESKTOP_RELAY_HOST_GATEWAY_ALIAS = 'host.docker.internal';
export const DESKTOP_RELAY_UPLINK_NETWORK = 'bridge';
const DESKTOP_RELAY_HOST_GATEWAY_MAPPING = `${DESKTOP_RELAY_HOST_GATEWAY_ALIAS}:host-gateway`;
const PROXY_AUTHORIZATION = /^Basic [A-Za-z0-9+/]+={0,2}$/u;

export const DESKTOP_RELAY_PROFILE = Object.freeze({
  memoryBytes: 64 * 1024 * 1024,
  nanoCpus: 250_000_000,
  pidsLimit: 32,
  openFilesLimit: 128,
  maxConcurrent: 64,
  maxBytes: 256 * 1024 * 1024,
  maxDuration: '10m',
  dialTimeout: '5s',
});

export interface DesktopRelayConfig {
  readonly bundleId: string;
  readonly containerName: string;
  readonly isolatedNetworkName: string;
  readonly uplinkNetworkName: string;
  readonly imageId: string;
  readonly ipv4Subnet: string;
  readonly ipv6Subnet: string;
  readonly relayIpv4Address: string;
  readonly listenPort: number;
  /** An IPv4 literal or the one frozen Docker Desktop host-gateway alias. */
  readonly targetHost: string;
  readonly targetPort: number;
  /** Host policy hop credential injected by the relay, never disclosed to the bundle. */
  readonly requiredProxyAuthorization: string;
}

export interface DesktopRelayEndpointConfig {
  readonly containerName: string;
  readonly relayIpv4Address: string;
  readonly listenPort: number;
  readonly targetHost: string;
  readonly targetPort: number;
}

/** Narrow adapter view of the common ledgered outer-create capability. */
export type DesktopRelayCreateAuthority = LedgeredOuterCreateAuthority<
  'container' | 'network',
  'fixed-relay' | 'network'
>;

export interface CreateDesktopRelayExposureOptions {
  readonly bundleId: string;
  readonly mode: 'images' | 'packages';
  readonly imageId: string;
  readonly isolatedNetworkName: string;
  readonly uplinkNetworkName: string;
  readonly ipv4Subnet: string;
  readonly ipv6Subnet: string;
  readonly requiredProxyAuthorization: string;
  readonly registry: DesktopRelayEndpointConfig;
  readonly package?: DesktopRelayEndpointConfig;
  readonly createOuterResource: DesktopRelayCreateAuthority;
}

export interface DesktopRelayEndpoint {
  readonly containerId: string;
  readonly proxyUrl: string;
}

export interface DesktopRelayExposure {
  readonly networkId: string;
  readonly isolatedNetworkName: string;
  readonly ipv4Subnet: string;
  readonly ipv6Subnet: string;
  readonly registry: DesktopRelayEndpoint;
  readonly package?: DesktopRelayEndpoint;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectAt(value: unknown, key: string): JsonObject {
  if (!isObject(value) || !isObject(value[key])) throw new Error(`relay inspect is missing object ${key}`);
  return value[key];
}

function stringAt(value: unknown, key: string): string {
  if (!isObject(value) || typeof value[key] !== 'string') throw new Error(`relay inspect is missing string ${key}`);
  return value[key];
}

function integerAt(value: unknown, key: string): number {
  if (!isObject(value) || typeof value[key] !== 'number' || !Number.isInteger(value[key])) {
    throw new Error(`relay inspect is missing integer ${key}`);
  }
  return value[key];
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error('relay inspect expected an array of strings');
  }
  return value;
}

function normalizeIpEndpoint(ip: string, port: number, field: string): string {
  if (isIP(ip) !== 4) throw new Error(`${field} must be an IPv4 literal`);
  if (ipv4ToNumber(ip) === 0) throw new Error(`${field} must not be unspecified`);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${field} port is invalid`);
  return `${ip}:${port}`;
}

function normalizeTargetEndpoint(host: string, port: number): string {
  if (host !== DESKTOP_RELAY_HOST_GATEWAY_ALIAS) return normalizeIpEndpoint(host, port, 'relay target');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('relay target port is invalid');
  return `${host}:${port}`;
}

function parseIpv4Cidr(cidr: string): { readonly address: string; readonly prefix: number; readonly mask: number } {
  const match = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(cidr);
  if (!match || isIP(match[1]) !== 4) throw new Error('relay IPv4 subnet must be a canonical IPv4 CIDR');
  const prefix = Number(match[2]);
  if (!Number.isInteger(prefix) || prefix < 16 || prefix > 30) {
    throw new Error('relay IPv4 subnet prefix must be between /16 and /30');
  }
  const address = match[1];
  const value = ipv4ToNumber(address);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  if ((value & mask) >>> 0 !== value) throw new Error('relay IPv4 subnet must use its canonical network address');
  return { address, prefix, mask };
}

function ipv4ToNumber(ip: string): number {
  return ip.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function assertConfig(config: DesktopRelayConfig): void {
  for (const [field, value] of [
    ['bundleId', config.bundleId],
    ['containerName', config.containerName],
    ['isolatedNetworkName', config.isolatedNetworkName],
  ] as const) {
    if (!RESOURCE_NAME.test(value)) throw new Error(`relay ${field} is not a canonical IronCurtain resource name`);
  }
  if (config.uplinkNetworkName !== DESKTOP_RELAY_UPLINK_NETWORK) {
    throw new Error(`relay uplink network must be the fixed ${DESKTOP_RELAY_UPLINK_NETWORK} network`);
  }
  if (!IMAGE_ID.test(config.imageId)) throw new Error('relay image must be an immutable sha256 image ID');

  const ipv4Subnet = parseIpv4Cidr(config.ipv4Subnet);
  const relayIp = ipv4ToNumber(config.relayIpv4Address);
  if (isIP(config.relayIpv4Address) !== 4 || (relayIp & ipv4Subnet.mask) >>> 0 !== ipv4ToNumber(ipv4Subnet.address)) {
    throw new Error('relay IPv4 address must be inside the isolated subnet');
  }
  const hostPart = relayIp & ~ipv4Subnet.mask;
  const broadcastPart = ~ipv4Subnet.mask >>> 0;
  if (hostPart === 0 || hostPart === broadcastPart) throw new Error('relay IPv4 address cannot be network/broadcast');

  const ipv6Match = /^([^/]+)\/(\d+)$/.exec(config.ipv6Subnet);
  if (!ipv6Match || isIP(ipv6Match[1]) !== 6 || Number(ipv6Match[2]) !== 64) {
    throw new Error('relay IPv6 subnet must be an explicit /64');
  }
  normalizeIpEndpoint(config.relayIpv4Address, config.listenPort, 'relay listen');
  normalizeTargetEndpoint(config.targetHost, config.targetPort);
  if (!PROXY_AUTHORIZATION.test(config.requiredProxyAuthorization)) {
    throw new Error('relay proxy authorization is not one canonical Basic credential');
  }
}

function networkLabels(bundleId: string): Readonly<Record<string, string>> {
  return { [RELAY_LABEL]: 'isolated-network', [BUNDLE_LABEL]: bundleId };
}

function containerLabels(bundleId: string): Readonly<Record<string, string>> {
  return { [RELAY_LABEL]: 'fixed-relay', [BUNDLE_LABEL]: bundleId };
}

function assertRequiredLabels(
  labels: Readonly<Record<string, string>>,
  required: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(required)) {
    if (labels[key] !== value) throw new Error(`relay create authority changed required label ${key}`);
  }
}

function renderLabels(labels: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

export function buildDesktopRelayNetworkCreateArgs(
  config: DesktopRelayConfig,
  labels: Readonly<Record<string, string>> = networkLabels(config.bundleId),
): readonly string[] {
  assertConfig(config);
  assertRequiredLabels(labels, networkLabels(config.bundleId));
  return [
    'network',
    'create',
    '--internal',
    '--ipv6',
    '--subnet',
    config.ipv4Subnet,
    '--subnet',
    config.ipv6Subnet,
    '--opt',
    `${IPV4_GATEWAY_MODE}=isolated`,
    '--opt',
    `${IPV6_GATEWAY_MODE}=isolated`,
    '--opt',
    `${ENABLE_IPV4}=true`,
    ...renderLabels(labels),
    config.isolatedNetworkName,
  ];
}

export function buildDesktopRelayCreateArgs(
  config: DesktopRelayConfig,
  labels: Readonly<Record<string, string>> = containerLabels(config.bundleId),
): readonly string[] {
  assertConfig(config);
  assertRequiredLabels(labels, containerLabels(config.bundleId));
  return [
    'container',
    'create',
    '--name',
    config.containerName,
    '--network',
    config.isolatedNetworkName,
    '--ip',
    config.relayIpv4Address,
    ...(config.targetHost === DESKTOP_RELAY_HOST_GATEWAY_ALIAS
      ? (['--add-host', DESKTOP_RELAY_HOST_GATEWAY_MAPPING] as const)
      : []),
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--user',
    '65532:65532',
    '--env',
    `PATH=${RELAY_PATH}`,
    '--workdir',
    '/',
    '--memory',
    String(DESKTOP_RELAY_PROFILE.memoryBytes),
    '--cpus',
    String(DESKTOP_RELAY_PROFILE.nanoCpus / 1_000_000_000),
    '--pids-limit',
    String(DESKTOP_RELAY_PROFILE.pidsLimit),
    '--ulimit',
    `nofile=${DESKTOP_RELAY_PROFILE.openFilesLimit}:${DESKTOP_RELAY_PROFILE.openFilesLimit}`,
    '--restart',
    'no',
    '--log-driver',
    'local',
    '--log-opt',
    'max-size=1m',
    '--log-opt',
    'max-file=1',
    '--log-opt',
    'compress=false',
    ...renderLabels(labels),
    config.imageId,
    '--listen',
    normalizeIpEndpoint(config.relayIpv4Address, config.listenPort, 'relay listen'),
    '--target',
    normalizeTargetEndpoint(config.targetHost, config.targetPort),
    '--allow-cidr',
    config.ipv4Subnet,
    '--max-concurrent',
    String(DESKTOP_RELAY_PROFILE.maxConcurrent),
    '--max-bytes',
    String(DESKTOP_RELAY_PROFILE.maxBytes),
    '--max-duration',
    DESKTOP_RELAY_PROFILE.maxDuration,
    '--dial-timeout',
    DESKTOP_RELAY_PROFILE.dialTimeout,
    '--proxy-authorization',
    config.requiredProxyAuthorization,
  ];
}

function parseOneInspect(stdout: string, kind: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${kind} inspect returned malformed JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isObject(parsed[0])) {
    throw new Error(`${kind} inspect must contain exactly one object`);
  }
  return parsed[0];
}

function exactStringSet(actual: unknown, expected: readonly string[], field: string): void {
  const values = [...stringArray(actual)].sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(values) !== JSON.stringify(wanted)) {
    throw new Error(`relay ${field} drift: expected ${JSON.stringify(wanted)}, received ${JSON.stringify(values)}`);
  }
}

export function assertDesktopRelayContainerInspect(
  raw: unknown,
  config: DesktopRelayConfig,
  expectedContainerId?: string,
  requireRunning = false,
  requiredOwnershipLabels?: Readonly<Record<string, string>>,
): void {
  assertConfig(config);
  if (!isObject(raw)) throw new Error('relay container inspect must be an object');
  if (expectedContainerId !== undefined && stringAt(raw, 'Id') !== expectedContainerId) {
    throw new Error('relay container identity changed');
  }
  if (stringAt(raw, 'Name') !== `/${config.containerName}`) throw new Error('relay container name drift');

  const image = stringAt(raw, 'Image');
  if (image !== config.imageId) throw new Error(`relay immutable image drift: ${image}`);
  const containerConfig = objectAt(raw, 'Config');
  if (stringAt(containerConfig, 'User') !== '65532:65532') throw new Error('relay must run as numeric non-root');
  exactStringSet(containerConfig.Entrypoint, ['/ironcurtain-fixed-relay'], 'Entrypoint');
  const createArgs = buildDesktopRelayCreateArgs(config);
  const imageIndex = createArgs.indexOf(config.imageId);
  const expectedCommand = createArgs.slice(imageIndex + 1);
  if (JSON.stringify(stringArray(containerConfig.Cmd)) !== JSON.stringify(expectedCommand)) {
    throw new Error('relay fixed command/config drift');
  }
  if (
    JSON.stringify(stringArray(containerConfig.Env)) !== JSON.stringify([`PATH=${RELAY_PATH}`]) ||
    containerConfig.WorkingDir !== '/'
  ) {
    throw new Error('relay fixed non-secret environment/working-directory drift');
  }
  const labels = objectAt(containerConfig, 'Labels');
  if (labels[RELAY_LABEL] !== 'fixed-relay' || labels[BUNDLE_LABEL] !== config.bundleId) {
    throw new Error('relay ownership labels drift');
  }
  if (requiredOwnershipLabels !== undefined)
    assertRequiredLabels(labels as Record<string, string>, requiredOwnershipLabels);
  if (containerConfig.ExposedPorts !== null && containerConfig.ExposedPorts !== undefined) {
    throw new Error('relay image must expose no ports');
  }

  const hostConfig = objectAt(raw, 'HostConfig');
  if (hostConfig.ReadonlyRootfs !== true || hostConfig.Privileged !== false) {
    throw new Error('relay root/privilege profile drift');
  }
  exactStringSet(hostConfig.CapDrop, ['ALL'], 'CapDrop');
  if (hostConfig.CapAdd !== null && (!Array.isArray(hostConfig.CapAdd) || hostConfig.CapAdd.length !== 0)) {
    throw new Error('relay must add no capability');
  }
  exactStringSet(hostConfig.SecurityOpt, ['no-new-privileges:true'], 'SecurityOpt');
  if (integerAt(hostConfig, 'Memory') !== DESKTOP_RELAY_PROFILE.memoryBytes) throw new Error('relay memory drift');
  if (integerAt(hostConfig, 'NanoCpus') !== DESKTOP_RELAY_PROFILE.nanoCpus) throw new Error('relay CPU drift');
  if (integerAt(hostConfig, 'PidsLimit') !== DESKTOP_RELAY_PROFILE.pidsLimit) throw new Error('relay PID drift');
  if (stringAt(hostConfig, 'NetworkMode') !== config.isolatedNetworkName)
    throw new Error('relay primary network drift');
  const expectedExtraHosts =
    config.targetHost === DESKTOP_RELAY_HOST_GATEWAY_ALIAS ? [DESKTOP_RELAY_HOST_GATEWAY_MAPPING] : [];
  const actualExtraHosts = hostConfig.ExtraHosts ?? [];
  exactStringSet(actualExtraHosts, expectedExtraHosts, 'ExtraHosts');
  if (hostConfig.Binds !== null && (!Array.isArray(hostConfig.Binds) || hostConfig.Binds.length !== 0)) {
    throw new Error('relay must have no bind mount');
  }
  if (isObject(hostConfig.PortBindings) && Object.keys(hostConfig.PortBindings).length !== 0) {
    throw new Error('relay must publish no port');
  }
  const logConfig = objectAt(hostConfig, 'LogConfig');
  const logOptions = objectAt(logConfig, 'Config');
  if (
    logConfig.Type !== 'local' ||
    logOptions['max-size'] !== '1m' ||
    logOptions['max-file'] !== '1' ||
    logOptions.compress !== 'false' ||
    Object.keys(logOptions).length !== 3
  ) {
    throw new Error('relay bounded logging profile drift');
  }
  const ulimits = hostConfig.Ulimits;
  if (
    !Array.isArray(ulimits) ||
    ulimits.length !== 1 ||
    !isObject(ulimits[0]) ||
    ulimits[0].Name !== 'nofile' ||
    ulimits[0].Soft !== DESKTOP_RELAY_PROFILE.openFilesLimit ||
    ulimits[0].Hard !== DESKTOP_RELAY_PROFILE.openFilesLimit
  ) {
    throw new Error('relay nofile limit drift');
  }

  if (!Array.isArray(raw.Mounts) || raw.Mounts.length !== 0) throw new Error('relay must have no mount');
  const networks = objectAt(objectAt(raw, 'NetworkSettings'), 'Networks');
  const names = Object.keys(networks).sort();
  const expectedNetworks = [config.isolatedNetworkName, config.uplinkNetworkName].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNetworks)) throw new Error('relay network attachment drift');
  const isolated = objectAt(networks, config.isolatedNetworkName);
  const isolatedIpam = objectAt(isolated, 'IPAMConfig');
  if (isolatedIpam.IPv4Address !== config.relayIpv4Address) {
    throw new Error('relay requested isolated IPv4 drift');
  }
  if (isolated.IPAddress !== '' && isolated.IPAddress !== config.relayIpv4Address) {
    throw new Error('relay isolated IPv4 drift');
  }
  const uplink = objectAt(networks, config.uplinkNetworkName);
  if (typeof uplink.IPAddress !== 'string' || (uplink.IPAddress !== '' && isIP(uplink.IPAddress) !== 4)) {
    throw new Error('relay uplink lacks an exact IPv4 address');
  }
  if (requireRunning) {
    const state = objectAt(raw, 'State');
    if (state.Running !== true) throw new Error('relay did not enter running state');
    if (isolated.IPAddress !== config.relayIpv4Address || isIP(uplink.IPAddress) !== 4) {
      throw new Error('running relay lacks its exact network addresses');
    }
  }
}

export function assertDesktopRelayNetworkInspect(
  raw: unknown,
  config: DesktopRelayConfig,
  expectedNetworkId?: string,
  requiredOwnershipLabels?: Readonly<Record<string, string>>,
): void {
  assertConfig(config);
  if (!isObject(raw)) throw new Error('relay network inspect must be an object');
  if (expectedNetworkId !== undefined && stringAt(raw, 'Id') !== expectedNetworkId) {
    throw new Error('relay network identity changed');
  }
  if (stringAt(raw, 'Name') !== config.isolatedNetworkName) throw new Error('relay network name drift');
  if (raw.Internal !== true || raw.EnableIPv6 !== true || raw.Attachable !== false || raw.Ingress !== false) {
    throw new Error('relay isolated network boundary drift');
  }
  const labels = objectAt(raw, 'Labels');
  if (labels[RELAY_LABEL] !== 'isolated-network' || labels[BUNDLE_LABEL] !== config.bundleId) {
    throw new Error('relay network ownership labels drift');
  }
  if (requiredOwnershipLabels !== undefined)
    assertRequiredLabels(labels as Record<string, string>, requiredOwnershipLabels);
  const options = objectAt(raw, 'Options');
  if (options[IPV4_GATEWAY_MODE] !== 'isolated' || options[IPV6_GATEWAY_MODE] !== 'isolated') {
    throw new Error('relay isolated gateway mode drift');
  }
  if (
    options[ENABLE_IPV4] !== 'true' ||
    Object.keys(options).sort().join(',') !== [IPV4_GATEWAY_MODE, IPV6_GATEWAY_MODE, ENABLE_IPV4].sort().join(',')
  ) {
    throw new Error('relay isolated network has unexpected driver options');
  }
  const ipam = objectAt(raw, 'IPAM');
  if (!Array.isArray(ipam.Config) || ipam.Config.length !== 2)
    throw new Error('relay network must have exact dual-stack IPAM');
  const subnets = new Map<string, JsonObject>();
  for (const entry of ipam.Config) {
    if (!isObject(entry) || typeof entry.Subnet !== 'string') throw new Error('relay network IPAM entry is malformed');
    subnets.set(entry.Subnet, entry);
  }
  if (subnets.size !== 2 || !subnets.has(config.ipv4Subnet) || !subnets.has(config.ipv6Subnet)) {
    throw new Error('relay network subnet drift');
  }
  for (const entry of subnets.values()) {
    if (entry.Gateway !== undefined && entry.Gateway !== '')
      throw new Error('relay isolated network must have no gateway');
  }
}

async function inspectExact(exec: ExecFileFn, kind: 'container' | 'network', id: string): Promise<JsonObject> {
  const { stdout } = await exec('docker', [kind, 'inspect', id], { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
  return parseOneInspect(stdout, `${kind} ${id}`);
}

async function removeBestEffort(exec: ExecFileFn, kind: 'container' | 'network', id: string): Promise<void> {
  try {
    const args = kind === 'container' ? ['container', 'rm', '--force', id] : ['network', 'rm', id];
    await exec('docker', args, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  } catch {
    // The caller performs authoritative post-cleanup inventory. This helper is
    // intentionally idempotent so partial creation can be rolled back.
  }
}

/** Single line the frozen relay image prints once it is serving. */
const DESKTOP_RELAY_READY_MARKER = 'relay ready version=ironcurtain-fixed-relay-v1';

/**
 * Bounded log window scanned for the readiness marker. The marker is not
 * necessarily the last line — the relay keeps logging once it is up — so a
 * single-line tail would make readiness depend on the relay staying silent.
 */
const DESKTOP_RELAY_LOG_TAIL_LINES = '50';

function hasDesktopRelayReadyMarker(logs: { readonly stdout: string; readonly stderr: string }): boolean {
  return `${logs.stdout}\n${logs.stderr}`.split('\n').some((line) => line.includes(DESKTOP_RELAY_READY_MARKER));
}

async function waitForDesktopRelayReady(
  exec: ExecFileFn,
  config: DesktopRelayConfig,
  containerId: string,
  requiredOwnershipLabels: Readonly<Record<string, string>>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let pollDelayMs = 50;
  for (;;) {
    const inspected = await inspectExact(exec, 'container', containerId);
    const state = objectAt(inspected, 'State');
    if (state.Running !== true) throw new Error('relay exited before readiness');
    const logs = await exec('docker', ['container', 'logs', '--tail', DESKTOP_RELAY_LOG_TAIL_LINES, containerId], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    if (hasDesktopRelayReadyMarker(logs)) {
      assertDesktopRelayContainerInspect(inspected, config, containerId, true, requiredOwnershipLabels);
      return;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('relay readiness deadline expired');
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollDelayMs, remainingMs)));
    pollDelayMs = Math.min(pollDelayMs * 2, 500);
  }
}

function relayConfig(
  options: CreateDesktopRelayExposureOptions,
  endpoint: DesktopRelayEndpointConfig,
): DesktopRelayConfig {
  return {
    bundleId: options.bundleId,
    containerName: endpoint.containerName,
    isolatedNetworkName: options.isolatedNetworkName,
    uplinkNetworkName: options.uplinkNetworkName,
    imageId: options.imageId,
    ipv4Subnet: options.ipv4Subnet,
    ipv6Subnet: options.ipv6Subnet,
    relayIpv4Address: endpoint.relayIpv4Address,
    listenPort: endpoint.listenPort,
    targetHost: endpoint.targetHost,
    targetPort: endpoint.targetPort,
    requiredProxyAuthorization: options.requiredProxyAuthorization,
  };
}

function assertExposureConfig(options: CreateDesktopRelayExposureOptions): {
  readonly registry: DesktopRelayConfig;
  readonly package?: DesktopRelayConfig;
} {
  if (options.mode === 'images' && options.package !== undefined) {
    throw new Error('images relay exposure must not include a package relay');
  }
  if (options.mode === 'packages' && options.package === undefined) {
    throw new Error('packages relay exposure requires a package relay');
  }
  const registry = relayConfig(options, options.registry);
  const packageRelay = options.package === undefined ? undefined : relayConfig(options, options.package);
  assertConfig(registry);
  if (packageRelay !== undefined) {
    assertConfig(packageRelay);
    if (registry.containerName === packageRelay.containerName) {
      throw new Error('registry and package relays must have distinct container names');
    }
    if (registry.relayIpv4Address === packageRelay.relayIpv4Address) {
      throw new Error('registry and package relays must have distinct isolated IPv4 addresses');
    }
  }
  return { registry, ...(packageRelay === undefined ? {} : { package: packageRelay }) };
}

function assertRawId(id: string, kind: 'container' | 'network'): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`Docker returned an invalid relay ${kind} ID`);
  return id;
}

async function createRelayContainer(
  exec: ExecFileFn,
  options: CreateDesktopRelayExposureOptions,
  config: DesktopRelayConfig,
  rollbackContainerIds: string[],
): Promise<string> {
  const baseLabels = containerLabels(config.bundleId);
  let rawContainerId: string | undefined;
  let effectiveLabels: Readonly<Record<string, string>> | undefined;
  const created = await options.createOuterResource(
    {
      kind: 'container',
      role: 'fixed-relay',
      requestedName: config.containerName,
      baseLabels,
      adjudicateObserved: async (containerId) => {
        if (effectiveLabels === undefined) throw new Error('relay create authority omitted effective ownership labels');
        assertDesktopRelayContainerInspect(
          await inspectExact(exec, 'container', containerId),
          config,
          containerId,
          false,
          effectiveLabels,
        );
      },
    },
    async (requestedName, labels) => {
      if (requestedName !== config.containerName) throw new Error('relay create authority changed the container name');
      effectiveLabels = labels;
      const container = await exec('docker', buildDesktopRelayCreateArgs(config, labels), {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const containerId = assertRawId(container.stdout.trim(), 'container');
      rawContainerId = containerId;
      rollbackContainerIds.push(containerId);
      await exec('docker', ['network', 'connect', config.uplinkNetworkName, containerId], {
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { id: containerId };
    },
  );
  if (rawContainerId === undefined || assertRawId(created.id, 'container') !== rawContainerId) {
    throw new Error('relay container identity changed across create authority');
  }
  await exec('docker', ['container', 'start', rawContainerId], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  if (effectiveLabels === undefined) throw new Error('relay create authority omitted effective ownership labels');
  await waitForDesktopRelayReady(exec, config, rawContainerId, effectiveLabels);
  return rawContainerId;
}

/**
 * Create one bundle-scoped Docker Desktop egress exposure. The common bundle
 * lease owns successful resources. This function only removes exact IDs when
 * setup fails before the caller can continue the bundle lifecycle.
 */
export async function createDesktopRelayExposure(
  exec: ExecFileFn,
  options: CreateDesktopRelayExposureOptions,
): Promise<DesktopRelayExposure> {
  const configs = assertExposureConfig(options);
  let networkId: string | undefined;
  const containerIds: string[] = [];
  try {
    const networkConfig = configs.registry;
    const baseLabels = networkLabels(options.bundleId);
    let effectiveNetworkLabels: Readonly<Record<string, string>> | undefined;
    const network = await options.createOuterResource(
      {
        kind: 'network',
        role: 'network',
        requestedName: options.isolatedNetworkName,
        baseLabels,
        adjudicateObserved: async (id) => {
          if (effectiveNetworkLabels === undefined) {
            throw new Error('relay create authority omitted effective network ownership labels');
          }
          assertDesktopRelayNetworkInspect(
            await inspectExact(exec, 'network', id),
            networkConfig,
            id,
            effectiveNetworkLabels,
          );
        },
      },
      async (requestedName, labels) => {
        if (requestedName !== options.isolatedNetworkName)
          throw new Error('relay create authority changed the network name');
        effectiveNetworkLabels = labels;
        const created = await exec('docker', buildDesktopRelayNetworkCreateArgs(networkConfig, labels), {
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        networkId = assertRawId(created.stdout.trim(), 'network');
        return { id: networkId };
      },
    );
    if (networkId === undefined || assertRawId(network.id, 'network') !== networkId) {
      throw new Error('relay network identity changed across create authority');
    }

    const registryContainerId = await createRelayContainer(exec, options, configs.registry, containerIds);
    const packageConfig = configs.package;
    const packageEndpoint =
      packageConfig === undefined
        ? undefined
        : {
            containerId: await createRelayContainer(exec, options, packageConfig, containerIds),
            proxyUrl: `http://${packageConfig.relayIpv4Address}:${packageConfig.listenPort}`,
          };
    return {
      networkId,
      isolatedNetworkName: options.isolatedNetworkName,
      ipv4Subnet: options.ipv4Subnet,
      ipv6Subnet: options.ipv6Subnet,
      registry: {
        containerId: registryContainerId,
        proxyUrl: `http://${configs.registry.relayIpv4Address}:${configs.registry.listenPort}`,
      },
      ...(packageEndpoint === undefined ? {} : { package: packageEndpoint }),
    };
  } catch (error) {
    for (const containerId of containerIds.reverse()) await removeBestEffort(exec, 'container', containerId);
    if (networkId !== undefined) await removeBestEffort(exec, 'network', networkId);
    throw error;
  }
}
