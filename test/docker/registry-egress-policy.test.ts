import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizeRegistryEgressRequest,
  authorizeValidatedRegistryEgressRequest,
  authorizeValidatedRegistryRedirect,
  createRegistryContentHasher,
  loadRegistryEgressManifest,
  parseOciDigest,
  validateRegistryEgressManifest,
  verifyContentDigest,
  type RegistryEgressManifest,
} from '../../src/docker/registry-egress-policy.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('anonymous registry-egress manifest loading (fail-closed)', () => {
  it('fails closed when the manifest is missing', () => {
    const directory = tempDirectory();
    expect(() => loadRegistryEgressManifest(join(directory, 'absent.json'))).toThrow(/readable regular non-symlink/u);
  });

  it('fails closed on a group/world-writable or symlinked manifest', () => {
    const directory = tempDirectory();
    const path = join(directory, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest()), { mode: 0o400 });
    chmodSync(path, 0o666);
    expect(() => loadRegistryEgressManifest(path)).toThrow(/group\/world writable/u);
    const link = join(directory, 'link.json');
    symlinkSync(path, link);
    expect(() => loadRegistryEgressManifest(link)).toThrow(/readable regular non-symlink/u);
  });

  it('fails closed on a schema-invalid manifest (credential header allowed)', () => {
    const directory = tempDirectory();
    const path = join(directory, 'manifest.json');
    const invalid = manifest();
    invalid.origins[0].requestHeaders.allow.push('authorization');
    writeFileSync(path, JSON.stringify(invalid), { mode: 0o400 });
    expect(() => loadRegistryEgressManifest(path)).toThrow(/credential header cannot be allowed/u);
  });

  it('loads a strict draft manifest and reports its identity', () => {
    const directory = tempDirectory();
    const path = join(directory, 'manifest.json');
    const bytes = JSON.stringify(manifest());
    writeFileSync(path, bytes, { mode: 0o400 });
    const loaded = loadRegistryEgressManifest(path);
    expect(loaded.manifest.status).toBe('draft');
    expect(loaded.manifest.origins).toHaveLength(2);
    expect(loaded.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('loads the checked-in draft manifest cleanly', () => {
    const loaded = loadRegistryEgressManifest(
      join(process.cwd(), 'config/docker-workload/registry-egress-manifest.json'),
    );
    expect(loaded.manifest.status).toBe('draft');
    expect(loaded.manifest.origins.map((origin) => origin.destination.hostname)).toEqual([
      'registry-1.docker.io',
      'auth.docker.io',
      'ghcr.io',
    ]);
  });
});

describe('anonymous registry-egress authorization', () => {
  it('authorizes a by-digest blob pull and surfaces the requested digest', () => {
    const authorized = authorizeRegistryEgressRequest(manifest(), {
      method: 'GET',
      url: `https://registry.test/v2/library/app/blobs/${DIGEST}`,
      headers: { host: 'attacker.invalid', accept: 'application/octet-stream', 'user-agent': 'fixture/1' },
    });
    expect(authorized.operation).toBe('blob-pull');
    expect(authorized.expectedDigest).toEqual({ algorithm: 'sha256', hex: 'a'.repeat(64) });
    expect(authorized.resolvesDigest).toBe(false);
    expect(authorized.allowDynamicRedirectHosts).toBe(true);
    expect(authorized.destination).toEqual({ protocol: 'https:', hostname: 'registry.test', port: 443 });
    // `host` is not an allowed header, so it is dropped rather than forwarded.
    expect(authorized.headers).toEqual({ accept: 'application/octet-stream', 'user-agent': 'fixture/1' });
  });

  it('resolves a tag pull to a digest the caller records before fetching blobs', () => {
    const authorized = authorizeRegistryEgressRequest(manifest(), {
      method: 'GET',
      url: 'https://registry.test/v2/library/app/manifests/1.0',
    });
    expect(authorized.operation).toBe('manifest-pull');
    expect(authorized.reference).toBe('1.0');
    expect(authorized.expectedDigest).toBeUndefined();
    expect(authorized.resolvesDigest).toBe(true);
    // A tag has no a-priori digest, so a dynamic-host redirect is refused.
    expect(authorized.allowDynamicRedirectHosts).toBe(false);
  });

  it.each([
    [{ method: 'GET', url: 'https://evil.example/v2/library/app/blobs/' + DIGEST }, /unlisted host/u],
    [{ method: 'PUT', url: 'https://registry.test/v2/library/app/blobs/uploads/' }, /push/u],
    [{ method: 'POST', url: 'https://registry.test/v2/library/app/blobs/uploads/' }, /push/u],
    [{ method: 'DELETE', url: 'https://registry.test/v2/library/app/manifests/' + DIGEST }, /delete/u],
    [{ method: 'GET', url: 'https://registry.test/v2/_catalog' }, /catalog enumeration/u],
    [{ method: 'GET', url: 'https://registry.test/v2/library/app/tags/list' }, /tag enumeration/u],
    [{ method: 'GET', url: 'https://registry.test/v2/library/app/blobs/latest' }, /addressed by sha256 digest/u],
    [{ method: 'GET', url: 'https://registry.test/v2/library%2Fapp/blobs/' + DIGEST }, /encoded separator/u],
    [
      {
        method: 'GET',
        url: 'https://registry.test/v2/library/app/blobs/' + DIGEST,
        headers: { authorization: 'Bearer real-secret' },
      },
      /credential header is forbidden/u,
    ],
    [
      {
        method: 'GET',
        url: 'https://registry.test/v2/library/app/blobs/' + DIGEST,
        headers: { 'x-unreviewed': 'v' },
      },
      /not allowed/u,
    ],
  ] as const)('rejects a non-pull or unreviewed request %#', (request, message) => {
    expect(() => authorizeRegistryEgressRequest(manifest(), request)).toThrow(message);
  });

  it('classifies token and v2 paths on a combined host, and refuses v2 on a token-only host', () => {
    const value = manifest();
    // token-only host authorizes only the token operation, never v2 content.
    expect(
      authorizeRegistryEgressRequest(value, { method: 'GET', url: 'https://auth.test/token?service=registry.test' })
        .operation,
    ).toBe('token');
    expect(() =>
      authorizeRegistryEgressRequest(value, { method: 'GET', url: `https://auth.test/v2/library/app/blobs/${DIGEST}` }),
    ).toThrow(/does not authorize/u);
  });

  it('authorizes against a pre-validated manifest without re-parsing on the hot path', () => {
    const directory = tempDirectory();
    const path = join(directory, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest()), { mode: 0o400 });
    const loaded = loadRegistryEgressManifest(path);
    expect(
      authorizeValidatedRegistryEgressRequest(loaded.manifest, {
        method: 'GET',
        url: `https://registry.test/v2/library/app/blobs/${DIGEST}`,
      }).operation,
    ).toBe('blob-pull');
    // The raw entry still validates fail-closed for untrusted callers.
    expect(() => validateRegistryEgressManifest({ ...manifest(), origins: [] })).toThrow();
  });
});

describe('registry-egress redirect closure', () => {
  it('follows a bounded dynamic-host redirect only for digest-verified content', () => {
    const value = validateRegistryEgressManifest(manifest());
    const blob = authorizeValidatedRegistryEgressRequest(value, {
      method: 'GET',
      url: `https://registry.test/v2/library/app/blobs/${DIGEST}`,
    });
    const redirected = authorizeValidatedRegistryRedirect(value, blob, 'https://cdn.example.com/layers/abc?verify=1');
    expect(redirected.destination.hostname).toBe('cdn.example.com');
    expect(redirected.redirectHop).toBe(1);
    // The digest is preserved so the CDN cannot substitute content.
    expect(redirected.expectedDigest).toEqual(blob.expectedDigest);
    expect(redirected.headers).toEqual({});
  });

  it('refuses a dynamic-host redirect for a tag pull and enforces the hop ceiling', () => {
    const value = validateRegistryEgressManifest(manifest());
    const tag = authorizeValidatedRegistryEgressRequest(value, {
      method: 'GET',
      url: 'https://registry.test/v2/library/app/manifests/1.0',
    });
    expect(() => authorizeValidatedRegistryRedirect(value, tag, 'https://cdn.example.com/x')).toThrow(
      /refused without digest verification/u,
    );
    const blob = authorizeValidatedRegistryEgressRequest(value, {
      method: 'GET',
      url: `https://registry.test/v2/library/app/blobs/${DIGEST}`,
    });
    const hop1 = authorizeValidatedRegistryRedirect(value, blob, 'https://cdn.example.com/a');
    const hop2 = authorizeValidatedRegistryRedirect(value, hop1, 'https://cdn2.example.com/b');
    expect(() => authorizeValidatedRegistryRedirect(value, hop2, 'https://cdn3.example.com/c')).toThrow(/hop limit/u);
  });
});

describe('content-addressed digest verification', () => {
  it('accepts content that hashes to the requested digest and rejects a substitution', () => {
    const bytes = Buffer.from('the-verified-blob-bytes');
    const hasher = createRegistryContentHasher();
    hasher.update(bytes.subarray(0, 4));
    hasher.update(bytes.subarray(4));
    const computedHex = hasher.digestHex();
    expect(hasher.bytesHashed).toBe(bytes.length);
    expect(computedHex).toBe(createHash('sha256').update(bytes).digest('hex'));

    const requested = parseOciDigest(`sha256:${computedHex}`);
    expect(requested).toBeDefined();
    if (requested === undefined) throw new Error('expected a parseable digest');
    expect(verifyContentDigest(requested, computedHex).verified).toBe(true);

    const substituted = parseOciDigest(DIGEST);
    if (substituted === undefined) throw new Error('expected a parseable digest');
    expect(verifyContentDigest(substituted, computedHex).verified).toBe(false);
  });

  it('rejects a non-sha256 or malformed digest reference', () => {
    expect(parseOciDigest('sha512:' + 'a'.repeat(128))).toBeUndefined();
    expect(parseOciDigest('sha256:zzz')).toBeUndefined();
    expect(parseOciDigest('1.0')).toBeUndefined();
  });
});

function manifest(): RegistryEgressManifest {
  return {
    schemaVersion: 1,
    policyId: 'registry-egress-test-v1',
    status: 'draft',
    origins: [
      {
        id: 'registry',
        destination: { protocol: 'https:', hostname: 'registry.test', port: 443 },
        operations: ['api-version', 'manifest-pull', 'blob-pull'],
        redirects: { maxHops: 2, followDynamicHosts: true },
        requestHeaders: { allow: ['accept', 'user-agent', 'range'] },
        limits: { requestBytes: 8 * 1024 * 1024, requestTimeoutMs: 30_000 },
      },
      {
        id: 'token',
        destination: { protocol: 'https:', hostname: 'auth.test', port: 443 },
        operations: ['token'],
        tokenPaths: [{ kind: 'exact', value: '/token' }],
        redirects: { maxHops: 0, followDynamicHosts: false },
        requestHeaders: { allow: ['accept', 'user-agent'] },
        limits: { requestBytes: 1024 * 1024, requestTimeoutMs: 15_000 },
      },
    ],
    imageLimits: { totalBytes: 512 * 1024 * 1024, totalTimeoutMs: 300_000 },
    rejectedOperations: ['push', 'delete', 'catalog-enumeration', 'tags-enumeration'],
  };
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'registry-egress-policy-'));
  temporaryDirectories.push(directory);
  return directory;
}
