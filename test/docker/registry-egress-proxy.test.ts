import { createHash } from 'node:crypto';
import * as dns from 'node:dns';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRegistryEgressGuard,
  handleRegistryEgressRequest,
  type RegistryEgressGuard,
  type RegistryPullProvenance,
} from '../../src/docker/registry-egress-proxy.js';
import type { RegistryEgressManifest } from '../../src/docker/registry-egress-policy.js';
import {
  createParentProxyOutboundTransport,
  type DestinationBoundRequest,
  type OutboundTransport,
} from '../../src/docker/outbound-transport.js';
import {
  createTlsIdentity,
  startFakeParentProxy,
  type FakeParentProxy,
  type TlsIdentity,
} from '../helpers/fake-parent-proxy.js';

const temporaryDirectories: string[] = [];
const servers: http.Server[] = [];
const parents: FakeParentProxy[] = [];

afterEach(async () => {
  await Promise.all(parents.splice(0).map((parent) => parent.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('registry-egress guard construction (fail-closed)', () => {
  it('fails closed when the frozen manifest is missing', () => {
    const directory = tempDirectory();
    expect(() =>
      createRegistryEgressGuard({ mode: 'public-registry', manifestPath: join(directory, 'absent.json') }),
    ).toThrow(/readable regular non-symlink/u);
  });

  it('reports the frozen manifest identity and session ceilings for audit once constructed', () => {
    const guard = fixtureGuard();
    expect(guard.mode).toBe('public-registry');
    expect(guard.manifest?.status).toBe('frozen');
    expect(guard.manifest?.origins.map((origin) => origin.hostname)).toEqual(['registry.test']);
    expect(guard.session.maxConcurrentRequests).toBe(4);
  });

  it('fails closed on a draft (unreviewed) manifest by default', () => {
    const directory = tempDirectory();
    const path = join(directory, 'draft.json');
    writeFileSync(path, JSON.stringify({ ...manifest(), status: 'draft' }), { mode: 0o400 });
    expect(() => createRegistryEgressGuard({ mode: 'public-registry', manifestPath: path })).toThrow(
      /frozen manifest/u,
    );
  });

  it('serves a draft manifest only with the explicit unfrozen opt-in', () => {
    const directory = tempDirectory();
    const path = join(directory, 'draft.json');
    writeFileSync(path, JSON.stringify({ ...manifest(), status: 'draft' }), { mode: 0o400 });
    const guard = createRegistryEgressGuard({
      mode: 'public-registry',
      manifestPath: path,
      allowUnfrozenManifest: true,
    });
    expect(guard.manifest?.status).toBe('draft');
  });
});

describe('registry-egress disabled mode (preloaded-only refuses registry traffic)', () => {
  it('authorizes nothing', () => {
    const guard = createRegistryEgressGuard({ mode: 'disabled' });
    expect(guard.mode).toBe('disabled');
    expect(() =>
      guard.authorize({ method: 'GET', url: `https://registry.test/v2/library/app/blobs/${digestOf('x')}` }),
    ).toThrow(/disabled/u);
  });

  it('fails fast at the proxy seam with no upstream contact', async () => {
    const spy = spyTransport();
    const result = await driveThroughSeam({
      guard: createRegistryEgressGuard({ mode: 'disabled' }),
      transport: spy.transport,
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('x')}`,
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).toMatch(/disabled/u);
    expect(spy.state.calls).toBe(0);
  });
});

describe('registry-egress proxy seam (enabled)', () => {
  it('forwards a by-digest pull, stripping response cookies and injecting no credential', async () => {
    const body = Buffer.from('delivered-blob-bytes');
    const digest = digestOf(body);
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'set-cookie': 'leak=1',
        'docker-content-digest': digest,
      });
      res.end(body);
    });
    const observed = firstRequest(upstream);

    const provenance: RegistryPullProvenance[] = [];
    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: routingTransport({ 'registry.test': upstream.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digest}`,
      headers: { accept: 'application/octet-stream', 'user-agent': 'fixture/1' },
      recordProvenance: (record) => provenance.push(record),
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('delivered-blob-bytes');
    // Credential-bearing response headers never propagate back into the daemon.
    expect(result.headers['set-cookie']).toBeUndefined();
    const request = await observed;
    expect(request.method).toBe('GET');
    expect(request.headers.authorization).toBeUndefined();
    expect(provenance).toEqual([
      {
        originId: 'registry',
        repository: 'library/app',
        reference: digest,
        requestedDigest: digest,
        resolvedDigest: digest,
        sizeBytes: body.length,
      },
    ]);
  });

  it('records tag-pull provenance with the registry-reported digest and no requested digest', async () => {
    const body = Buffer.from('{"schemaVersion":2}');
    const reported = digestOf(body);
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/vnd.oci.image.manifest.v1+json',
        'docker-content-digest': reported,
      });
      res.end(body);
    });
    const provenance: RegistryPullProvenance[] = [];
    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: routingTransport({ 'registry.test': upstream.port }),
      targetHost: 'registry.test',
      path: '/v2/library/app/manifests/1.0',
      recordProvenance: (record) => provenance.push(record),
    });
    expect(result.statusCode).toBe(200);
    expect(provenance).toEqual([
      {
        originId: 'registry',
        repository: 'library/app',
        reference: '1.0',
        requestedDigest: undefined,
        resolvedDigest: reported,
        sizeBytes: body.length,
      },
    ]);
  });

  it('streams response chunks to the daemon before the upstream finishes (backpressure, not buffered)', async () => {
    const firstDelivered = createGate();
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write('first-chunk');
      // A buffering proxy would withhold the body until end(), so this gate would
      // never resolve and the test would time out. A streaming proxy flushes it.
      void firstDelivered.promise.then(() => {
        res.write('second-chunk');
        res.end();
      });
    });

    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: routingTransport({ 'registry.test': upstream.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('stream')}`,
      onData: () => firstDelivered.resolve(),
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('first-chunksecond-chunk');
  });

  it('streams a body far larger than any internal watermark intact under the byte ceiling', async () => {
    const body = Buffer.alloc(1024 * 1024, 0x41);
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
    });
    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: routingTransport({ 'registry.test': upstream.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('large')}`,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.length).toBe(body.length);
    expect(createHash('sha256').update(result.body).digest('hex')).toBe(
      createHash('sha256').update(body).digest('hex'),
    );
  });

  it('rejects a response whose declared content-length exceeds the per-request byte ceiling', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-length': '4096' });
      res.end(Buffer.alloc(4096));
    });
    const result = await driveThroughSeam({
      guard: fixtureGuard({ perRequest: { maxBytes: 64, maxDurationMs: 30_000, maxRedirectHops: 2 } }),
      transport: routingTransport({ 'registry.test': upstream.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('big')}`,
    });
    expect(result.statusCode).toBe(502);
    expect(result.body).toMatch(/byte ceiling/u);
  });

  it('aborts a chunked response that exceeds the per-request byte ceiling mid-stream', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200); // chunked: no content-length, so the pre-check cannot fire
      res.write('AAAA');
      res.write('BBBB');
      res.end();
    });
    const result = await driveThroughSeam({
      guard: fixtureGuard({ perRequest: { maxBytes: 4, maxDurationMs: 30_000, maxRedirectHops: 2 } }),
      transport: routingTransport({ 'registry.test': upstream.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('chunked')}`,
    });
    // Headers were already sent, so the transfer fails closed by tearing the
    // connection down: the daemon never receives the full oversized body.
    expect(result.aborted || result.body.length < 8).toBe(true);
    expect(result.body).not.toBe('AAAABBBB');
  });

  it('rejects a response that would exceed the per-session total-byte ceiling', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-length': '4096' });
      res.end(Buffer.alloc(4096));
    });
    const result = await driveThroughSeam({
      guard: fixtureGuard({ perSession: { maxTotalBytes: 128, maxConcurrentRequests: 4 } }),
      transport: routingTransport({ 'registry.test': upstream.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('session')}`,
    });
    expect(result.statusCode).toBe(502);
    expect(result.body).toMatch(/byte ceiling/u);
  });

  it('aborts a pull that exceeds the absolute per-request time ceiling', async () => {
    const upstream = await startUpstream((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('too-late');
      }, 400);
    });
    const result = await driveThroughSeam({
      guard: fixtureGuard({ perRequest: { maxBytes: 8 * 1024 * 1024, maxDurationMs: 120, maxRedirectHops: 2 } }),
      transport: routingTransport({ 'registry.test': upstream.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('slow')}`,
    });
    expect(result.statusCode).toBe(504);
    expect(result.body).toMatch(/time ceiling/u);
  });

  it('rejects a request once the per-session concurrency ceiling is reached', async () => {
    const guard = fixtureGuard({ perSession: { maxTotalBytes: 512 * 1024 * 1024, maxConcurrentRequests: 1 } });
    const gate = createGate();
    const upstream = await startUpstream((_req, res) => {
      void gate.promise.then(() => {
        res.writeHead(200);
        res.end('released');
      });
    });
    const transport = routingTransport({ 'registry.test': upstream.port });
    const inflightReceived = firstRequest(upstream);

    const first = driveThroughSeam({
      guard,
      transport,
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('a')}`,
    });
    await inflightReceived; // the first pull now holds the only concurrency slot

    const second = await driveThroughSeam({
      guard,
      transport,
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('b')}`,
    });
    expect(second.statusCode).toBe(503);
    expect(second.body).toMatch(/concurrency ceiling/u);

    gate.resolve();
    const firstResult = await first;
    expect(firstResult.statusCode).toBe(200);
  });

  it('follows a bounded derived redirect for a tag pull and strips credentials at the CDN', async () => {
    const body = Buffer.from('cdn-delivered-layer');
    const cdn = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    const registry = await startUpstream((_req, res) => {
      res.writeHead(307, { location: 'https://cdn.example.com/layers/real?token=abc' });
      res.end();
    });
    const cdnObserved = firstRequest(cdn);

    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: routingTransport({ 'registry.test': registry.port, 'cdn.example.com': cdn.port }),
      targetHost: 'registry.test',
      // A tag pull (previously digest-gated) may now follow the derived redirect.
      path: '/v2/library/app/manifests/1.0',
      headers: { authorization: 'Bearer anon-token' },
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('cdn-delivered-layer');
    const cdnRequest = await cdnObserved;
    // No credential is forwarded to the derived CDN destination.
    expect(cdnRequest.headers.authorization).toBeUndefined();
  });

  it('fails closed when a redirect body exceeds the byte ceiling before following (F1)', async () => {
    let cdnContacted = false;
    const cdn = await startUpstream((_req, res) => {
      cdnContacted = true;
      res.writeHead(200);
      res.end('cdn-delivered-layer');
    });
    const registry = await startUpstream((_req, res) => {
      res.writeHead(307, { location: 'https://cdn.example.com/layers/real' });
      // A 128 KiB 3xx body overshoots the 64 KiB redirect cap; the drain must
      // abort the exchange rather than discard the bytes uncounted.
      res.end(Buffer.alloc(128 * 1024, 0x61));
    });
    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: routingTransport({ 'registry.test': registry.port, 'cdn.example.com': cdn.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('redir')}`,
    });
    expect(result.statusCode).toBe(502);
    expect(result.body).toMatch(/byte ceiling/u);
    expect(cdnContacted).toBe(false);
  });

  it('carries a drained redirect body into the terminal response ceiling (one budget per request)', async () => {
    let cdnContacted = false;
    const cdn = await startUpstream((_req, res) => {
      cdnContacted = true;
      const body = Buffer.alloc(16, 0x62);
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
    });
    const registry = await startUpstream((_req, res) => {
      res.writeHead(307, { location: 'https://cdn.example.com/layers/real' });
      res.end(Buffer.alloc(24, 0x61)); // fits the hop cap on its own
    });
    const result = await driveThroughSeam({
      // 24 drained + 16 delivered = 40 > 32: neither hop overshoots alone, so
      // only a budget carried across hops can catch this.
      guard: fixtureGuard({ perRequest: { maxBytes: 32, maxDurationMs: 30_000, maxRedirectHops: 2 } }),
      transport: routingTransport({ 'registry.test': registry.port, 'cdn.example.com': cdn.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('redir-aggregate')}`,
    });
    expect(cdnContacted).toBe(true); // the hop itself was within its own cap
    expect(result.statusCode).toBe(502);
    expect(result.body).toMatch(/byte ceiling/u);
  });

  it('delivers a redirected pull whose drained hop and terminal body fit the per-request ceiling together', async () => {
    const cdn = await startUpstream((_req, res) => {
      res.writeHead(200); // chunked: the carried budget is enforced by the stream ceiling
      res.write('cdn-layer-12');
      res.end();
    });
    const registry = await startUpstream((_req, res) => {
      res.writeHead(307, { location: 'https://cdn.example.com/layers/real' });
      res.end(Buffer.alloc(20, 0x61));
    });
    const result = await driveThroughSeam({
      // 20 drained + 12 delivered = 32, exactly the ceiling: still allowed.
      guard: fixtureGuard({ perRequest: { maxBytes: 32, maxDurationMs: 30_000, maxRedirectHops: 2 } }),
      transport: routingTransport({ 'registry.test': registry.port, 'cdn.example.com': cdn.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('redir-fits')}`,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('cdn-layer-12');
  });

  it('rejects a derived redirect to a literal private address before connecting', async () => {
    const registry = await startUpstream((_req, res) => {
      res.writeHead(307, { location: 'https://127.0.0.1:9/layers/real' });
      res.end();
    });
    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: routingTransport({ 'registry.test': registry.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('redir')}`,
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).toMatch(/literal address/u);
  });

  it('forwards an anonymous Bearer token to a listed origin', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const observed = firstRequest(upstream);
    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: routingTransport({ 'registry.test': upstream.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('bearer')}`,
      headers: { authorization: 'Bearer anon-token' },
    });
    expect(result.statusCode).toBe(200);
    const request = await observed;
    expect(request.headers.authorization).toBe('Bearer anon-token');
  });

  it('refuses a transport that delegates the address policy, before any upstream contact', async () => {
    const spy = spyTransport('delegated');
    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: spy.transport,
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('delegated')}`,
    });
    expect(result.statusCode).toBe(502);
    expect(result.body).toMatch(/resolves and screens destination addresses locally/u);
    expect(spy.state.calls).toBe(0);
  });

  it.each([
    ['an unlisted registry', 'evil.example', `/v2/library/app/blobs/${digestOf('x')}`, undefined, /unlisted host/u],
    ['a catalog enumeration', 'registry.test', '/v2/_catalog', undefined, /catalog enumeration/u],
    ['a tags enumeration', 'registry.test', '/v2/library/app/tags/list', undefined, /tag enumeration/u],
    [
      'a Basic Authorization scheme',
      'registry.test',
      `/v2/library/app/blobs/${digestOf('x')}`,
      { authorization: 'Basic dXNlcjpwYXNz' },
      /single anonymous Bearer token/u,
    ],
  ] as const)('rejects %s with no upstream contact', async (_label, targetHost, path, headers, message) => {
    const spy = spyTransport();
    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: spy.transport,
      targetHost,
      path,
      headers,
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).toMatch(message);
    expect(spy.state.calls).toBe(0);
  });
});

describe('registry-egress over a real fixed-parent transport (nested mode)', () => {
  it('refuses a derived redirect that resolves to a non-public address, and never asks the parent for it', async () => {
    const identity = fixtureTlsIdentity();
    const socketPath = join(tempDirectory(), 'parent.sock');
    const parent = await startFakeParentProxy({
      socketPath,
      identity,
      // `cdn.evil.test` is deliberately unrouted: the parent reaching it at all
      // would already be the bug this guards.
      routes: {
        'registry.test': (_request, response) => {
          response.writeHead(307, { location: 'https://cdn.evil.test/layer' });
          response.end();
        },
      },
    });
    parents.push(parent);

    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: createParentProxyOutboundTransport({
        proxy: { socketPath },
        ca: identity.certPem,
        lookup: nestedLookup,
      }),
      targetHost: 'registry.test',
      path: '/v2/library/app/manifests/1.0',
    });

    expect(result.statusCode).toBe(502);
    expect(result.body).toMatch(/non-public address/u);
    // The child is the address authority: it refuses before the redirect target
    // can become a CONNECT authority the parent would be asked to open.
    expect(parent.connectAuthorities).toEqual(['registry.test:443']);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

/**
 * Resolver for the nested fixture: the reviewed origin is public, the derived
 * CDN target rebinds onto the cloud metadata service.
 */
const nestedLookup = ((
  hostname: string,
  options: dns.LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void => {
  const answers: Record<string, string | undefined> = {
    'registry.test': '93.184.216.34',
    'cdn.evil.test': '169.254.169.254',
  };
  const address = answers[hostname];
  if (address === undefined) {
    const error: NodeJS.ErrnoException = new Error(`no stub DNS answer for ${hostname}`);
    error.code = 'ENOTFOUND';
    callback(error, []);
    return;
  }
  if (options.all) callback(null, [{ address, family: 4 }]);
  else callback(null, address, 4);
}) as typeof dns.lookup;

/** RSA keygen is slow, so the fixture identity is generated once per file. */
let tlsIdentity: TlsIdentity | undefined;
function fixtureTlsIdentity(): TlsIdentity {
  tlsIdentity ??= createTlsIdentity(['registry.test', 'cdn.evil.test']);
  return tlsIdentity;
}

function digestOf(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

interface ManifestOverrides {
  readonly perRequest?: RegistryEgressManifest['origins'][number]['perRequest'];
  readonly perSession?: RegistryEgressManifest['perSession'];
}

function manifest(overrides: ManifestOverrides = {}): RegistryEgressManifest {
  return {
    schemaVersion: 1,
    policyId: 'registry-egress-proxy-test-v1',
    status: 'frozen',
    origins: [
      {
        id: 'registry',
        destination: { protocol: 'https:', hostname: 'registry.test', port: 443 },
        operations: ['api-version', 'manifest-pull', 'blob-pull'],
        perRequest: overrides.perRequest ?? { maxBytes: 8 * 1024 * 1024, maxDurationMs: 30_000, maxRedirectHops: 2 },
        requestHeaders: { allow: ['accept', 'user-agent', 'range'] },
      },
    ],
    perSession: overrides.perSession ?? { maxTotalBytes: 512 * 1024 * 1024, maxConcurrentRequests: 4 },
    rejectedOperations: ['push', 'delete', 'catalog-enumeration', 'tags-enumeration'],
  };
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'registry-egress-proxy-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureGuard(overrides: ManifestOverrides = {}): RegistryEgressGuard {
  const directory = tempDirectory();
  const path = join(directory, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest(overrides)), { mode: 0o400 });
  return createRegistryEgressGuard({ mode: 'public-registry', manifestPath: path });
}

/** A destination-bound transport that dials a loopback upstream per hostname. */
function routingTransport(routes: Record<string, number>): OutboundTransport {
  const table = new Map(Object.entries(routes));
  return {
    kind: 'direct',
    addressGuard: 'local-resolver',
    request(request: DestinationBoundRequest, onResponse) {
      const port = table.get(request.destination.hostname);
      if (port === undefined) throw new Error(`no test route for ${request.destination.hostname}`);
      return http.request(
        { host: '127.0.0.1', port, method: request.method, path: request.path, headers: request.headers },
        onResponse,
      );
    },
  };
}

function spyTransport(addressGuard: OutboundTransport['addressGuard'] = 'local-resolver'): {
  transport: OutboundTransport;
  state: { calls: number };
} {
  const state = { calls: 0 };
  return {
    state,
    transport: {
      kind: 'direct',
      addressGuard,
      request() {
        state.calls += 1;
        throw new Error('spy transport must not be reached for a rejected request');
      },
    },
  };
}

interface Gate {
  readonly promise: Promise<void>;
  resolve(): void;
}

function createGate(): Gate {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface UpstreamServer {
  readonly port: number;
  onRequest?: (req: http.IncomingMessage) => void;
}

function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<UpstreamServer> {
  const state: { port: number; onRequest?: (req: http.IncomingMessage) => void } = { port: 0 };
  const server = http.createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    state.onRequest?.(req);
    handler(req, res);
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
      state.port = address.port;
      resolve(state);
    });
  });
}

function firstRequest(upstream: UpstreamServer): Promise<{ method?: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve) => {
    upstream.onRequest = (req) => resolve({ method: req.method, headers: req.headers });
  });
}

interface SeamDriveOptions {
  readonly guard: RegistryEgressGuard;
  readonly transport: OutboundTransport;
  readonly targetHost: string;
  readonly path: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly recordProvenance?: (record: RegistryPullProvenance) => void;
  readonly onData?: (chunk: Buffer) => void;
}

interface SeamResult {
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
  readonly aborted: boolean;
}

/**
 * Stand up a real HTTP front server that decrypts to `handleRegistryEgressRequest`
 * (as the outer MITM does after TLS termination), issue one client request, and
 * capture the response the nested daemon would have received.
 */
async function driveThroughSeam(options: SeamDriveOptions): Promise<SeamResult> {
  const front = http.createServer((req, res) => {
    handleRegistryEgressRequest(req, res, {
      guard: options.guard,
      transport: options.transport,
      scheme: 'https:',
      targetHost: options.targetHost,
      targetPort: 443,
      requestTarget: req.url ?? '/',
      recordProvenance: options.recordProvenance,
    });
  });
  servers.push(front);
  const frontPort = await new Promise<number>((resolve) => {
    front.listen(0, '127.0.0.1', () => {
      const address = front.address();
      if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
      resolve(address.port);
    });
  });

  return new Promise<SeamResult>((resolve) => {
    let statusCode = 0;
    let headers: http.IncomingHttpHeaders = {};
    let aborted = false;
    const chunks: Buffer[] = [];
    const settle = (): void => resolve({ statusCode, headers, body: Buffer.concat(chunks).toString('utf8'), aborted });
    const request = http.request(
      {
        host: '127.0.0.1',
        port: frontPort,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: false,
      },
      (response) => {
        statusCode = response.statusCode ?? 0;
        headers = response.headers;
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          options.onData?.(chunk);
        });
        response.on('aborted', () => {
          aborted = true;
        });
        response.on('end', settle);
        response.on('error', () => {
          aborted = true;
          settle();
        });
      },
    );
    request.on('error', () => {
      aborted = true;
      settle();
    });
    request.end();
  });
}
