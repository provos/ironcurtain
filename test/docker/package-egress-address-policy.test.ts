import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalizePackageEgressHostname,
  discoverNat64Prefixes,
  screenPackageEgressDestination,
  type PackageEgressNat64Prefix,
  type PackageEgressResolvedAddress,
} from '../../src/docker/package-egress-address-policy.js';

function screen(
  addresses: readonly string[],
  hostIdentities: readonly string[] = [],
  nat64Prefixes: readonly PackageEgressNat64Prefix[] = [],
): void {
  const answers: PackageEgressResolvedAddress[] = addresses.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4,
  }));
  screenPackageEgressDestination({ hostname: 'example.com', answers, hostIdentities, nat64Prefixes });
}

describe('package egress immediate-address policy', () => {
  it('uses one dual-stack Darwin route snapshot and precomputed static IPv6 prefixes', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/docker/package-egress-address-policy.ts'), 'utf8');
    expect(source.match(/bestEffortExec\('\/usr\/sbin\/netstat'/gu)).toHaveLength(1);
    expect(source).toContain("bestEffortExec('/usr/sbin/netstat', ['-rn'])");
    expect(source).not.toContain("parseIpv6('64:ff9b::')");
    expect(source).not.toContain('function prefixHex(');
  });

  it('accepts exactly canonical multi-label package-egress hostnames', () => {
    expect(canonicalizePackageEgressHostname('example.com')).toBe('example.com');
    for (const hostname of ['Example.com', 'example.com.', 'localhost', 'host.internal', 'single', '127.0.0.1']) {
      expect(() => canonicalizePackageEgressHostname(hostname)).toThrow();
    }
  });

  it('rejects direct non-public IPv4 and the entire mixed answer set', () => {
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.0.1',
      '198.18.0.1',
      '224.0.0.1',
    ]) {
      expect(() => screen([address])).toThrow(/non-public/u);
    }
    expect(() => screen(['93.184.216.34', '10.0.0.1'])).toThrow(/non-public/u);
    expect(() => screen([])).toThrow(/empty/u);
  });

  it('rejects current host/interface/gateway identities even when globally routed', () => {
    expect(() => screen(['8.8.8.8'], ['8.8.8.8'])).toThrow(/host-owned/u);
    expect(() => screen(['2606:4700:4700::1111'], ['2606:4700:4700::1111'])).toThrow(/host-owned/u);
    expect(() => screen(['64:ff9b::808:808'], ['8.8.8.8'])).toThrow(/host-owned/u);
  });

  it('rejects special-use IPv6 and malformed resolver output', () => {
    for (const address of [
      '::',
      '::1',
      '100::1',
      '100:0:0:1::1',
      '2001:100::1',
      '2001:1::1',
      '2001:2::1',
      '2001:3::1',
      '2001:4:112::1',
      '2001:20::1',
      '2001:30::1',
      '2001:db8::1',
      '2620:4f:8000::1',
      '3fff::1',
      '5f00::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
    ]) {
      expect(() => screen([address])).toThrow(/non-public/u);
    }
    expect(() =>
      screenPackageEgressDestination({
        hostname: 'example.com',
        answers: [{ address: '93.184.216.34', family: 6 }],
        hostIdentities: [],
      }),
    ).toThrow(/malformed/u);
  });

  it('decodes mapped, NAT64, 6to4, and Teredo embedded IPv4 identities', () => {
    expect(() => screen(['::ffff:10.0.0.1'])).toThrow();
    expect(() => screen(['64:ff9b::a00:1'])).toThrow();
    expect(() => screen(['64:ff9b::808:808'])).not.toThrow();
    expect(() => screen(['2002:0a00:0001::'])).toThrow();
    expect(() => screen(['2002:0808:0808::'])).not.toThrow();

    // Teredo server 8.8.8.8, obfuscated private client 10.0.0.1.
    expect(() => screen(['2001:0000:0808:0808:0000:0000:f5ff:fffe'])).toThrow();
    // Teredo server 8.8.8.8, obfuscated public client 1.1.1.1.
    expect(() => screen(['2001:0000:0808:0808:0000:0000:fefe:fefe'])).not.toThrow();
  });

  it('decodes configured RFC 6052 prefixes and rejects malformed prefixes', () => {
    const prefix: PackageEgressNat64Prefix = { prefix: '2001:db9:1:2::', length: 64 };
    expect(() => screen(['2001:db9:1:2:000a:0001:0000:0'], [], [prefix])).toThrow();
    expect(() => screen(['2001:db9:1:2:0008:0808:0800:0'], [], [prefix])).not.toThrow();
    expect(() => screen(['8.8.8.8'], [], [{ prefix: '2001:db9::1', length: 64 }])).toThrow(/prefix/u);
  });

  it('discovers every supported RFC 6052 layout from ipv4only.arpa synthesis', () => {
    for (const length of [32, 40, 48, 56, 64, 96] as const) {
      const prefixBytes = makeNat64Prefix(length);
      const prefix = formatIpv6(prefixBytes);
      const synthesized = encodeRfc6052(prefixBytes, length, [192, 0, 0, 170]);
      expect(discoverNat64Prefixes([{ address: formatIpv6(synthesized), family: 6 }])).toEqual([{ prefix, length }]);
      expect(() =>
        screen([formatIpv6(encodeRfc6052(prefixBytes, length, [10, 0, 0, 1]))], [], [{ prefix, length }]),
      ).toThrow(/non-public/u);
      expect(() =>
        screen([formatIpv6(encodeRfc6052(prefixBytes, length, [8, 8, 8, 8]))], [], [{ prefix, length }]),
      ).not.toThrow();
    }
    expect(() => discoverNat64Prefixes([{ address: '2001:db9::1', family: 6 }])).toThrow(/ambiguous/u);
  });

  it('rejects nonzero RFC 6052 reserved suffixes for every configured non-/96 layout', () => {
    for (const length of [32, 40, 48, 56, 64] as const) {
      const prefixBytes = makeNat64Prefix(length);
      const encoded = encodeRfc6052(prefixBytes, length, [8, 8, 8, 8]);
      encoded[15] = 1;
      expect(() => screen([formatIpv6(encoded)], [], [{ prefix: formatIpv6(prefixBytes), length }])).toThrow(
        /non-public/u,
      );
    }
  });

  it('honestly admits a public immediate peer without claiming downstream locality', () => {
    // The classifier has no way to know whether this public peer later relays or NAT-hairpins.
    expect(() => screen(['8.8.8.8'], ['192.168.1.1', '10.0.0.2'])).not.toThrow();
    expect(() => screen(['2606:4700:4700::1111'])).not.toThrow();
  });
});

function makeNat64Prefix(length: 32 | 40 | 48 | 56 | 64 | 96): Uint8Array {
  const bytes = Uint8Array.from([0x20, 0x01, 0x0d, 0xb9, 0x11, 0x22, 0x33, 0x44, 0, 0, 0, 0, 0, 0, 0, 0]);
  bytes.fill(0, length / 8);
  return bytes;
}

function encodeRfc6052(
  prefix: Uint8Array,
  length: 32 | 40 | 48 | 56 | 64 | 96,
  ipv4: readonly [number, number, number, number],
): Uint8Array {
  const bytes = Uint8Array.from(prefix);
  if (length === 96) {
    bytes.set(ipv4, 12);
    return bytes;
  }
  const beforeU = (64 - length) / 8;
  bytes.set(ipv4.slice(0, beforeU), length / 8);
  bytes[8] = 0;
  bytes.set(ipv4.slice(beforeU), 9);
  return bytes;
}

function formatIpv6(bytes: Uint8Array): string {
  const words: string[] = [];
  for (let index = 0; index < bytes.length; index += 2) {
    words.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
  }
  return words.join(':');
}
