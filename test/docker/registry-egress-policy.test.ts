import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizeRegistryEgressRequest,
  authorizeValidatedRegistryEgressRequest,
  authorizeValidatedRegistryRedirect,
  loadRegistryEgressManifest,
  parseOciDigest,
  validateRegistryEgressManifest,
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
    expect(loaded.manifest.perSession.maxConcurrentRequests).toBe(4);
    expect(loaded.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('loads the checked-in frozen manifest cleanly', () => {
    const loaded = loadRegistryEgressManifest(
      join(process.cwd(), 'config/docker-workload/registry-egress-manifest.json'),
    );
    expect(loaded.manifest.status).toBe('frozen');
    expect(loaded.manifest.origins.map((origin) => origin.destination.hostname)).toEqual([
      'registry-1.docker.io',
      'auth.docker.io',
      'ghcr.io',
    ]);
    expect(loaded.manifest.perSession.maxConcurrentRequests).toBeGreaterThan(0);
    expect(loaded.manifest.origins[0].perRequest.maxRedirectHops).toBe(3);
  });
});

describe('anonymous registry-egress authorization', () => {
  it('authorizes a by-digest blob pull and surfaces the requested digest as provenance', () => {
    const authorized = authorizeRegistryEgressRequest(manifest(), {
      method: 'GET',
      url: `https://registry.test/v2/library/app/blobs/${DIGEST}`,
      headers: { host: 'attacker.invalid', accept: 'application/octet-stream', 'user-agent': 'fixture/1' },
    });
    expect(authorized.operation).toBe('blob-pull');
    expect(authorized.requestedDigest).toEqual({ algorithm: 'sha256', hex: 'a'.repeat(64) });
    expect(authorized.maxBytes).toBe(8 * 1024 * 1024);
    expect(authorized.maxRedirectHops).toBe(2);
    expect(authorized.destination).toEqual({ protocol: 'https:', hostname: 'registry.test', port: 443 });
    // `host` is not an allowed header, so it is dropped rather than forwarded.
    expect(authorized.headers).toEqual({ accept: 'application/octet-stream', 'user-agent': 'fixture/1' });
  });

  it('authorizes a tag pull with no requested digest (resolved later from provenance)', () => {
    const authorized = authorizeRegistryEgressRequest(manifest(), {
      method: 'GET',
      url: 'https://registry.test/v2/library/app/manifests/1.0',
    });
    expect(authorized.operation).toBe('manifest-pull');
    expect(authorized.reference).toBe('1.0');
    expect(authorized.requestedDigest).toBeUndefined();
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

describe('anonymous bearer-token admission (§6.4)', () => {
  it('admits a single anonymous Bearer token on a request to a listed origin', () => {
    const authorized = authorizeRegistryEgressRequest(manifest(), {
      method: 'GET',
      url: `https://registry.test/v2/library/app/blobs/${DIGEST}`,
      headers: { authorization: 'Bearer anon-jwt.token_value', accept: 'application/octet-stream' },
    });
    expect(authorized.headers.authorization).toBe('Bearer anon-jwt.token_value');
    expect(authorized.headers.accept).toBe('application/octet-stream');
  });

  it('rejects a non-Bearer Authorization scheme', () => {
    expect(() =>
      authorizeRegistryEgressRequest(manifest(), {
        method: 'GET',
        url: `https://registry.test/v2/library/app/blobs/${DIGEST}`,
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      }),
    ).toThrow(/single anonymous Bearer token/u);
  });

  it('rejects Cookie and Proxy-Authorization credential headers', () => {
    for (const header of [{ cookie: 'session=1' }, { 'proxy-authorization': 'Bearer x' }]) {
      expect(() =>
        authorizeRegistryEgressRequest(manifest(), {
          method: 'GET',
          url: `https://registry.test/v2/library/app/blobs/${DIGEST}`,
          headers: header,
        }),
      ).toThrow(/credential header is forbidden/u);
    }
  });

  it('fails closed on the host for a bearer token to an unlisted registry', () => {
    expect(() =>
      authorizeRegistryEgressRequest(manifest(), {
        method: 'GET',
        url: `https://evil.example/v2/library/app/blobs/${DIGEST}`,
        headers: { authorization: 'Bearer stolen' },
      }),
    ).toThrow(/unlisted host/u);
  });
});

describe('registry-egress derived-redirect closure', () => {
  it('follows a bounded derived redirect for a TAG pull (no longer digest-gated)', () => {
    const value = validateRegistryEgressManifest(manifest());
    const tag = authorizeValidatedRegistryEgressRequest(value, {
      method: 'GET',
      url: 'https://registry.test/v2/library/app/manifests/1.0',
    });
    const redirected = authorizeValidatedRegistryRedirect(value, tag, 'https://cdn.example.com/layers/abc?verify=1');
    expect(redirected.destination.hostname).toBe('cdn.example.com');
    expect(redirected.redirectHop).toBe(1);
    // The derived request carries no credential header.
    expect(redirected.headers).toEqual({});
  });

  it('follows a bounded derived redirect for a by-digest blob pull', () => {
    const value = validateRegistryEgressManifest(manifest());
    const blob = authorizeValidatedRegistryEgressRequest(value, {
      method: 'GET',
      url: `https://registry.test/v2/library/app/blobs/${DIGEST}`,
    });
    const redirected = authorizeValidatedRegistryRedirect(value, blob, 'https://cdn.example.com/layers/real');
    expect(redirected.destination.hostname).toBe('cdn.example.com');
    // Requested digest is preserved for provenance, not for verification.
    expect(redirected.requestedDigest).toEqual(blob.requestedDigest);
  });

  it('strips every credential header from a derived redirect request', () => {
    const value = validateRegistryEgressManifest(manifest());
    const blob = authorizeValidatedRegistryEgressRequest(value, {
      method: 'GET',
      url: `https://registry.test/v2/library/app/blobs/${DIGEST}`,
      headers: { authorization: 'Bearer anon-token', accept: 'application/octet-stream' },
    });
    expect(blob.headers.authorization).toBe('Bearer anon-token');
    const redirected = authorizeValidatedRegistryRedirect(value, blob, 'https://cdn.example.com/real');
    expect(redirected.headers).toEqual({});
  });

  it('refuses a redirect to a literal private or loopback address', () => {
    const value = validateRegistryEgressManifest(manifest());
    const blob = authorizeValidatedRegistryEgressRequest(value, {
      method: 'GET',
      url: `https://registry.test/v2/library/app/blobs/${DIGEST}`,
    });
    for (const location of ['https://127.0.0.1/layer', 'https://10.0.0.5/layer', 'https://[::1]/layer']) {
      expect(() => authorizeValidatedRegistryRedirect(value, blob, location)).toThrow(/literal address/u);
    }
  });

  it('refuses a redirect that leaves https', () => {
    const value = validateRegistryEgressManifest(manifest());
    const blob = authorizeValidatedRegistryEgressRequest(value, {
      method: 'GET',
      url: `https://registry.test/v2/library/app/blobs/${DIGEST}`,
    });
    expect(() => authorizeValidatedRegistryRedirect(value, blob, 'http://cdn.example.com/x')).toThrow(/https/u);
  });

  it('refuses a redirect for a non-content operation', () => {
    const value = validateRegistryEgressManifest(manifest());
    const token = authorizeValidatedRegistryEgressRequest(value, { method: 'GET', url: 'https://auth.test/token' });
    expect(() => authorizeValidatedRegistryRedirect(value, token, 'https://cdn.example.com/x')).toThrow(
      /manifest or blob pull/u,
    );
  });

  it('enforces the hop ceiling across successive derived redirects', () => {
    const value = validateRegistryEgressManifest(manifest());
    const blob = authorizeValidatedRegistryEgressRequest(value, {
      method: 'GET',
      url: `https://registry.test/v2/library/app/blobs/${DIGEST}`,
    });
    const hop1 = authorizeValidatedRegistryRedirect(value, blob, 'https://cdn.example.com/a');
    const hop2 = authorizeValidatedRegistryRedirect(value, hop1, 'https://cdn2.example.com/b');
    expect(() => authorizeValidatedRegistryRedirect(value, hop2, 'https://cdn3.example.com/c')).toThrow(/hop limit/u);
  });
});

describe('digest syntax parsing (provenance only)', () => {
  it('parses a sha256 reference and rejects a non-sha256 or malformed digest', () => {
    expect(parseOciDigest(DIGEST)).toEqual({ algorithm: 'sha256', hex: 'a'.repeat(64) });
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
        perRequest: { maxBytes: 8 * 1024 * 1024, maxDurationMs: 30_000, maxRedirectHops: 2 },
        requestHeaders: { allow: ['accept', 'user-agent', 'range'] },
      },
      {
        id: 'token',
        destination: { protocol: 'https:', hostname: 'auth.test', port: 443 },
        operations: ['token'],
        tokenPaths: [{ kind: 'exact', value: '/token' }],
        perRequest: { maxBytes: 1024 * 1024, maxDurationMs: 15_000, maxRedirectHops: 0 },
        requestHeaders: { allow: ['accept', 'user-agent'] },
      },
    ],
    perSession: { maxTotalBytes: 512 * 1024 * 1024, maxConcurrentRequests: 4 },
    rejectedOperations: ['push', 'delete', 'catalog-enumeration', 'tags-enumeration'],
  };
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'registry-egress-policy-'));
  temporaryDirectories.push(directory);
  return directory;
}
