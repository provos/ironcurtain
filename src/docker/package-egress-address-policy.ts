/** Immediate-destination policy for the dedicated nested-Docker package-egress listener. */

import { execFile } from 'node:child_process';
import * as dns from 'node:dns';
import * as net from 'node:net';
import { networkInterfaces } from 'node:os';
import { domainToASCII } from 'node:url';

export interface PackageEgressResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type PackageEgressResolver = (hostname: string) => Promise<readonly PackageEgressResolvedAddress[]>;
export type PackageEgressHostIdentityProvider = () => Promise<readonly string[]>;

export interface PackageEgressNat64Prefix {
  readonly prefix: string;
  readonly length: 32 | 40 | 48 | 56 | 64 | 96;
}

export type PackageEgressNat64PrefixProvider = () => Promise<readonly PackageEgressNat64Prefix[]>;

export interface ScreenPackageEgressDestinationOptions {
  readonly hostname: string;
  readonly answers: readonly PackageEgressResolvedAddress[];
  readonly hostIdentities: readonly string[];
  readonly nat64Prefixes?: readonly PackageEgressNat64Prefix[];
}

export interface ScreenedPackageEgressDestination {
  readonly hostname: string;
  readonly answers: readonly PackageEgressResolvedAddress[];
  readonly selected: PackageEgressResolvedAddress;
}

type ParsedNat64Prefix = { readonly bytes: Uint8Array; readonly length: PackageEgressNat64Prefix['length'] };
type StaticIpv6Prefix = { readonly bytes: Uint8Array; readonly length: number };

const DENIED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.docker.internal'] as const;
const DENIED_HOSTS = new Set(['localhost', 'metadata.google.internal']);
const NAT64_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const;
const WELL_KNOWN_NAT64_PREFIX = Uint8Array.from([0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const LOCAL_USE_NAT64_PREFIX = Uint8Array.from([0x00, 0x64, 0xff, 0x9b, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const DENIED_GLOBAL_IPV6_PREFIXES: readonly StaticIpv6Prefix[] = [
  { bytes: Uint8Array.from([0x20, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), length: 23 },
  { bytes: Uint8Array.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), length: 32 },
  { bytes: Uint8Array.from([0x26, 0x20, 0x00, 0x4f, 0x80, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), length: 48 },
  { bytes: Uint8Array.from([0x3f, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), length: 20 },
];

/** Canonical DNS-only authority accepted by the package-egress listener. */
export function canonicalizePackageEgressHostname(input: string): string {
  if (input.length === 0 || input.length > 253 || input.endsWith('.') || containsForbiddenAuthorityCharacter(input)) {
    throw new Error('package egress requires a canonical DNS hostname');
  }
  if (net.isIP(input) !== 0) throw new Error('package egress rejects IP-literal authorities');

  const ascii = domainToASCII(input);
  const canonical = ascii.toLowerCase();
  if (ascii.length === 0 || canonical !== input || canonical.length > 253 || !canonical.includes('.')) {
    throw new Error('package egress requires one lowercase canonical multi-label DNS hostname');
  }
  for (const label of canonical.split('.')) {
    if (label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)) {
      throw new Error('package egress rejects a malformed DNS hostname');
    }
  }
  if (DENIED_HOSTS.has(canonical) || DENIED_HOST_SUFFIXES.some((suffix) => canonical.endsWith(suffix))) {
    throw new Error('package egress rejects local or metadata hostnames');
  }
  return canonical;
}

function containsForbiddenAuthorityCharacter(input: string): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (input.charCodeAt(index) <= 0x20 || '/:?#@[]\\'.includes(character)) return true;
  }
  return false;
}

/** Resolve with the host resolver. The caller supplies timeout/cancellation. */
export const defaultPackageEgressResolver: PackageEgressResolver = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }));
};

/**
 * Current directly enumerable host identities. Router-owned public aliases are
 * deliberately not claimed: the product contract accepts that residual.
 */
export const defaultPackageEgressHostIdentityProvider: PackageEgressHostIdentityProvider = async () => {
  const identities = new Set<string>();
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) identities.add(address.address);
  }
  if (process.platform === 'darwin') {
    const [interfaces, routes] = await Promise.all([
      bestEffortExec('/sbin/ifconfig', []),
      bestEffortExec('/usr/sbin/netstat', ['-rn']),
    ]);
    if (!interfaces.ok || !routes.ok) {
      throw new Error('package egress could not inventory current host interfaces and route gateways');
    }
    addDarwinInterfacePeers(identities, interfaces.stdout);
    addRouteGateways(identities, routes.stdout);
  } else if (process.platform === 'linux') {
    const [interfaces, ipv4Routes, ipv6Routes] = await Promise.all([
      bestEffortExec('ip', ['-o', 'addr', 'show']),
      bestEffortExec('ip', ['-o', 'route', 'show', 'table', 'all']),
      bestEffortExec('ip', ['-o', '-6', 'route', 'show', 'table', 'all']),
    ]);
    if (!interfaces.ok || !ipv4Routes.ok || !ipv6Routes.ok) {
      throw new Error('package egress could not inventory current host interfaces and route gateways');
    }
    addLinuxInterfacePeers(identities, interfaces.stdout);
    addLinuxRouteGateways(identities, ipv4Routes.stdout);
    addLinuxRouteGateways(identities, ipv6Routes.stdout);
  } else {
    throw new Error(`package egress host identity inventory is unsupported on ${process.platform}`);
  }
  return [...identities];
};

/** Fail closed when any answer is malformed, non-public, or a current host identity. */
export function screenPackageEgressDestination(
  options: ScreenPackageEgressDestinationOptions,
): ScreenedPackageEgressDestination {
  const hostname = canonicalizePackageEgressHostname(options.hostname);
  if (options.answers.length === 0) throw new Error('package egress DNS answer set is empty');

  const hostIdentities = new Set<string>();
  for (const identity of options.hostIdentities) {
    const key = addressKey(identity);
    if (key !== undefined) hostIdentities.add(key);
  }
  const nat64Prefixes = parseNat64Prefixes(options.nat64Prefixes ?? []);
  const answers = options.answers.map((answer) => normalizeResolvedAddress(answer));
  for (const answer of answers) {
    if (!isPublicImmediateAddress(answer.address, hostIdentities, nat64Prefixes)) {
      throw new Error(`package egress rejected non-public or host-owned DNS answer ${answer.address}`);
    }
  }
  return { hostname, answers, selected: answers[0] };
}

/** Recheck the already selected address against a freshly collected identity inventory. */
export function assertPackageEgressAddressStillAllowed(
  selected: PackageEgressResolvedAddress,
  hostIdentities: readonly string[],
  nat64Prefixes: readonly PackageEgressNat64Prefix[] = [],
): void {
  const keys = new Set<string>();
  for (const identity of hostIdentities) {
    const key = addressKey(identity);
    if (key !== undefined) keys.add(key);
  }
  if (!isPublicImmediateAddress(selected.address, keys, parseNat64Prefixes(nat64Prefixes))) {
    throw new Error('package egress destination became non-public or host-owned before forwarding');
  }
}

/**
 * RFC 7050 discovery from the trusted host resolver's `ipv4only.arpa`
 * answers. Any synthesized IPv6 answer must unambiguously embed one of the
 * reserved discovery IPv4 values or discovery fails closed.
 */
export function discoverNat64Prefixes(
  answers: readonly PackageEgressResolvedAddress[],
): readonly PackageEgressNat64Prefix[] {
  const discovered = new Map<string, PackageEgressNat64Prefix>();
  for (const answer of answers) {
    if (answer.family === 4) continue;
    const bytes = parseIpv6(answer.address);
    if (bytes === undefined) throw new Error('NAT64 discovery returned a malformed IPv6 answer');
    const candidates: PackageEgressNat64Prefix[] = [];
    for (const length of NAT64_PREFIX_LENGTHS) {
      const decoded = decodeRfc6052(bytes, length);
      if (decoded === undefined || !isIpv4OnlyDiscoveryValue(decoded) || !rfc6052SuffixIsZero(bytes, length)) continue;
      const prefixBytes = new Uint8Array(16);
      copyPrefixBits(prefixBytes, bytes, length);
      candidates.push({ prefix: formatIpv6(prefixBytes), length });
    }
    if (candidates.length !== 1) throw new Error('NAT64 discovery answer has an ambiguous RFC 6052 layout');
    const candidate = candidates[0];
    discovered.set(`${candidate.prefix}/${candidate.length}`, candidate);
  }
  return [...discovered.values()];
}

function normalizeResolvedAddress(answer: PackageEgressResolvedAddress): PackageEgressResolvedAddress {
  const actualFamily = net.isIP(answer.address);
  if (actualFamily === 0 || actualFamily !== answer.family || answer.address.includes('%')) {
    throw new Error('package egress resolver returned a malformed address');
  }
  return { address: answer.address.toLowerCase(), family: answer.family };
}

function parseNat64Prefixes(prefixes: readonly PackageEgressNat64Prefix[]): readonly ParsedNat64Prefix[] {
  return prefixes.map((prefix) => {
    const bytes = parseIpv6(prefix.prefix);
    if (bytes === undefined || !prefixBitsAreZero(bytes, prefix.length)) {
      throw new Error(`invalid canonical NAT64 prefix ${prefix.prefix}/${prefix.length}`);
    }
    return { bytes, length: prefix.length };
  });
}

function isPublicImmediateAddress(
  address: string,
  hostIdentities: ReadonlySet<string>,
  nat64Prefixes: readonly ParsedNat64Prefix[],
): boolean {
  const key = addressKey(address);
  if (key === undefined || hostIdentities.has(key)) return false;
  if (net.isIP(address) === 4) return isPublicIpv4(parseIpv4(address));

  const bytes = parseIpv6(address);
  if (bytes === undefined) return false;

  const mapped = ipv4Mapped(bytes) ?? ipv4Compatible(bytes);
  if (mapped !== undefined) return embeddedIpv4IsPublic(mapped, hostIdentities);

  // RFC 6052 well-known prefix.
  if (prefixMatches(bytes, WELL_KNOWN_NAT64_PREFIX, 96)) {
    return embeddedIpv4IsPublic(bytes.slice(12, 16), hostIdentities);
  }
  // RFC 8215 local-use prefix is never admitted.
  if (prefixMatches(bytes, LOCAL_USE_NAT64_PREFIX, 48)) return false;

  for (const prefix of nat64Prefixes) {
    if (!prefixMatches(bytes, prefix.bytes, prefix.length)) continue;
    const decoded = decodeRfc6052(bytes, prefix.length);
    return (
      decoded !== undefined &&
      rfc6052SuffixIsZero(bytes, prefix.length) &&
      embeddedIpv4IsPublic(decoded, hostIdentities)
    );
  }

  // 6to4 carries the endpoint IPv4 immediately after 2002::/16.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return embeddedIpv4IsPublic(bytes.slice(2, 6), hostIdentities);
  }
  // Teredo carries a server IPv4 and an XOR-obfuscated client IPv4.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) {
    const client = Uint8Array.from(bytes.slice(12, 16), (value) => value ^ 0xff);
    return embeddedIpv4IsPublic(bytes.slice(4, 8), hostIdentities) && embeddedIpv4IsPublic(client, hostIdentities);
  }

  // Only ordinary global unicast remains. Exclude every IANA special-purpose
  // block in 2000::/3; explicitly decoded NAT64, Teredo, and 6to4 never reach
  // this path.
  if ((bytes[0] & 0xe0) !== 0x20) return false; // 2000::/3
  if (DENIED_GLOBAL_IPV6_PREFIXES.some((prefix) => prefixMatches(bytes, prefix.bytes, prefix.length))) {
    return false;
  }
  return true;
}

function embeddedIpv4IsPublic(bytes: Uint8Array, hostIdentities: ReadonlySet<string>): boolean {
  if (bytes.length !== 4) return false;
  const value = ipv4BytesToNumber(bytes);
  return !hostIdentities.has(`4:${value}`) && isPublicIpv4(value);
}

function isPublicIpv4(value: number | undefined): boolean {
  if (value === undefined) return false;
  return !(
    inV4(value, 0x00000000, 8) ||
    inV4(value, 0x0a000000, 8) ||
    inV4(value, 0x64400000, 10) ||
    inV4(value, 0x7f000000, 8) ||
    inV4(value, 0xa9fe0000, 16) ||
    inV4(value, 0xac100000, 12) ||
    inV4(value, 0xc0000000, 24) ||
    inV4(value, 0xc0000200, 24) ||
    inV4(value, 0xc0586300, 24) ||
    inV4(value, 0xc0a80000, 16) ||
    inV4(value, 0xc6120000, 15) ||
    inV4(value, 0xc6336400, 24) ||
    inV4(value, 0xcb007100, 24) ||
    inV4(value, 0xe0000000, 4) ||
    inV4(value, 0xf0000000, 4)
  );
}

function inV4(value: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (network & mask) >>> 0;
}

function addressKey(address: string): string | undefined {
  const v4 = parseIpv4(address);
  if (v4 !== undefined) return `4:${v4}`;
  const v6 = parseIpv6(address);
  return v6 === undefined ? undefined : `6:${Buffer.from(v6).toString('hex')}`;
}

function parseIpv4(input: string): number | undefined {
  if (net.isIP(input) !== 4) return undefined;
  const parts = input.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
}

function parseIpv6(input: string): Uint8Array | undefined {
  if (input.includes('%')) return undefined;
  let normalized = input.toLowerCase();
  const lastColon = normalized.lastIndexOf(':');
  const possibleV4 = normalized.slice(lastColon + 1);
  if (possibleV4.includes('.')) {
    const v4 = parseIpv4(possibleV4);
    if (v4 === undefined) return undefined;
    normalized = `${normalized.slice(0, lastColon)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  if (halves.length === 2 && left.length + right.length >= 8) return undefined;
  const words = [
    ...left,
    ...Array.from({ length: halves.length === 2 ? 8 - left.length - right.length : 0 }, () => '0'),
    ...right,
  ];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) return undefined;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < words.length; index += 1) {
    const word = Number.parseInt(words[index] ?? '', 16);
    bytes[index * 2] = word >>> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

function ipv4Mapped(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes.slice(12, 16);
  }
  return undefined;
}

function ipv4Compatible(bytes: Uint8Array): Uint8Array | undefined {
  if (!bytes.slice(0, 12).every((value) => value === 0)) return undefined;
  return bytes.slice(12, 16);
}

function decodeRfc6052(bytes: Uint8Array, length: PackageEgressNat64Prefix['length']): Uint8Array | undefined {
  if (length === 96) return bytes.slice(12, 16);
  if (bytes[8] !== 0) return undefined;
  switch (length) {
    case 32:
      return bytes.slice(4, 8);
    case 40:
      return Uint8Array.from([bytes[5], bytes[6], bytes[7], bytes[9]]);
    case 48:
      return Uint8Array.from([bytes[6], bytes[7], bytes[9], bytes[10]]);
    case 56:
      return Uint8Array.from([bytes[7], bytes[9], bytes[10], bytes[11]]);
    case 64:
      return bytes.slice(9, 13);
  }
}

function isIpv4OnlyDiscoveryValue(bytes: Uint8Array): boolean {
  return bytes[0] === 192 && bytes[1] === 0 && bytes[2] === 0 && (bytes[3] === 170 || bytes[3] === 171);
}

function rfc6052SuffixIsZero(bytes: Uint8Array, length: PackageEgressNat64Prefix['length']): boolean {
  const suffixStart = length === 96 ? 16 : 9 + (length - 32) / 8;
  return bytes.slice(suffixStart).every((value) => value === 0);
}

function copyPrefixBits(target: Uint8Array, source: Uint8Array, length: number): void {
  const whole = Math.floor(length / 8);
  target.set(source.slice(0, whole));
  const remainder = length % 8;
  if (remainder !== 0) target[whole] = source[whole] & (0xff << (8 - remainder));
}

function formatIpv6(bytes: Uint8Array): string {
  const words: string[] = [];
  for (let index = 0; index < 16; index += 2) words.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
  return words.join(':');
}

function prefixMatches(address: Uint8Array, prefix: Uint8Array, length: number): boolean {
  const whole = Math.floor(length / 8);
  const remainder = length % 8;
  for (let index = 0; index < whole; index += 1) {
    if (address[index] !== prefix[index]) return false;
  }
  if (remainder === 0) return true;
  const mask = 0xff << (8 - remainder);
  return ((address[whole] ?? 0) & mask) === ((prefix[whole] ?? 0) & mask);
}

function prefixBitsAreZero(bytes: Uint8Array, length: number): boolean {
  const whole = Math.floor(length / 8);
  const remainder = length % 8;
  if (remainder !== 0) {
    const mask = (1 << (8 - remainder)) - 1;
    if (((bytes[whole] ?? 0) & mask) !== 0) return false;
  }
  return bytes.slice(Math.ceil(length / 8)).every((value) => value === 0);
}

function ipv4BytesToNumber(bytes: Uint8Array): number {
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
}

function addDarwinInterfacePeers(identities: Set<string>, output: string): void {
  for (const match of output.matchAll(/\s--?>\s+([^\s%]+)(?:%\S+)?/gu)) addIdentity(identities, match[1]);
}

function addRouteGateways(identities: Set<string>, output: string): void {
  let inTable = false;
  for (const line of output.split('\n')) {
    if (/^Destination\s+Gateway\b/u.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable || line.trim().length === 0) continue;
    addIdentity(identities, line.trim().split(/\s+/u)[1]);
  }
}

function addLinuxInterfacePeers(identities: Set<string>, output: string): void {
  for (const match of output.matchAll(/\bpeer\s+([^\s/]+)/gu)) addIdentity(identities, match[1]);
}

function addLinuxRouteGateways(identities: Set<string>, output: string): void {
  for (const match of output.matchAll(/(?:^|\s)via\s+([^\s%]+)(?:%\S+)?/gu)) addIdentity(identities, match[1]);
}

function addIdentity(identities: Set<string>, candidate: string | undefined): void {
  const unscoped = candidate?.split('%', 1)[0];
  if (unscoped !== undefined && net.isIP(unscoped) !== 0) identities.add(unscoped);
}

async function bestEffortExec(
  file: string,
  args: readonly string[],
): Promise<{ readonly ok: boolean; readonly stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: 1_000, maxBuffer: 128 * 1024 }, (error, stdout) => {
      resolve({ ok: error === null, stdout: error === null ? stdout : '' });
    });
  });
}
