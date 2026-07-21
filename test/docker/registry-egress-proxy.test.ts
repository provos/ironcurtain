import { createHash } from 'node:crypto';
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
import type { DestinationBoundRequest, OutboundTransport } from '../../src/docker/outbound-transport.js';

const temporaryDirectories: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
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

  it('reports the frozen manifest identity for audit once constructed', () => {
    const guard = fixtureGuard();
    expect(guard.mode).toBe('public-registry');
    expect(guard.manifest?.status).toBe('draft');
    expect(guard.manifest?.origins.map((origin) => origin.hostname)).toEqual(['registry.test']);
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
  it('forwards a by-digest pull whose bytes hash-match, with no credential to the registry', async () => {
    const body = Buffer.from('verified-blob-bytes');
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'set-cookie': 'leak=1' });
      res.end(body);
    });
    const observed = firstRequest(upstream);

    const provenance: RegistryPullProvenance[] = [];
    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: routingTransport({ 'registry.test': upstream.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf(body)}`,
      headers: { accept: 'application/octet-stream', 'user-agent': 'fixture/1' },
      recordProvenance: (record) => provenance.push(record),
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('verified-blob-bytes');
    // Credential-bearing response headers never propagate back into the daemon.
    expect(result.headers['set-cookie']).toBeUndefined();
    const request = await observed;
    expect(request.method).toBe('GET');
    expect(request.headers.authorization).toBeUndefined();
    expect(provenance).toEqual([
      {
        originId: 'registry',
        repository: 'library/app',
        reference: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        requestedDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        resolvedDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        sizeBytes: body.length,
      },
    ]);
  });

  it('rejects a pull whose bytes do not match the requested digest (substitution defense)', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('substituted-bytes'); // does not hash to the requested digest
    });
    const provenance: RegistryPullProvenance[] = [];
    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: routingTransport({ 'registry.test': upstream.port }),
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('the-real-bytes')}`,
      recordProvenance: (record) => provenance.push(record),
    });
    expect(result.statusCode).toBe(502);
    expect(result.body).toMatch(/digest does not match/u);
    // Unverified content is never recorded as provenance.
    expect(provenance).toEqual([]);
  });

  it('follows a bounded dynamic-host redirect and verifies the digest at the CDN', async () => {
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
      path: `/v2/library/app/blobs/${digestOf(body)}`,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('cdn-delivered-layer');
    const cdnRequest = await cdnObserved;
    // No credential is forwarded to the dynamic CDN host.
    expect(cdnRequest.headers.authorization).toBeUndefined();
  });

  it('surfaces the resolved digest for a tag pull before blobs are fetched', async () => {
    const body = Buffer.from('{"schemaVersion":2}');
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.oci.image.manifest.v1+json' });
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
    expect(provenance).toHaveLength(1);
    expect(provenance[0].reference).toBe('1.0');
    expect(provenance[0].requestedDigest).toBeUndefined();
    expect(provenance[0].resolvedDigest).toBe(`sha256:${createHash('sha256').update(body).digest('hex')}`);
  });

  it.each([
    ['an unlisted registry', 'evil.example', `/v2/library/app/blobs/${digestOf('x')}`, 'GET', /unlisted host/u],
    ['a catalog enumeration', 'registry.test', '/v2/_catalog', 'GET', /catalog enumeration/u],
    ['a tags enumeration', 'registry.test', '/v2/library/app/tags/list', 'GET', /tag enumeration/u],
  ] as const)('rejects %s with no upstream contact', async (_label, targetHost, path, method, message) => {
    const spy = spyTransport();
    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: spy.transport,
      targetHost,
      path,
      method,
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).toMatch(message);
    expect(spy.state.calls).toBe(0);
  });

  it('rejects an injected credential header with no upstream contact', async () => {
    const spy = spyTransport();
    const result = await driveThroughSeam({
      guard: fixtureGuard(),
      transport: spy.transport,
      targetHost: 'registry.test',
      path: `/v2/library/app/blobs/${digestOf('x')}`,
      headers: { authorization: 'Bearer real-secret' },
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).toMatch(/credential header is forbidden/u);
    expect(spy.state.calls).toBe(0);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

function digestOf(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function manifest(): RegistryEgressManifest {
  return {
    schemaVersion: 1,
    policyId: 'registry-egress-proxy-test-v1',
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
    ],
    imageLimits: { totalBytes: 512 * 1024 * 1024, totalTimeoutMs: 300_000 },
    rejectedOperations: ['push', 'delete', 'catalog-enumeration', 'tags-enumeration'],
  };
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'registry-egress-proxy-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureGuard(): RegistryEgressGuard {
  const directory = tempDirectory();
  const path = join(directory, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest()), { mode: 0o400 });
  return createRegistryEgressGuard({ mode: 'public-registry', manifestPath: path });
}

/** A destination-bound transport that dials a loopback upstream per hostname. */
function routingTransport(routes: Record<string, number>): OutboundTransport {
  const table = new Map(Object.entries(routes));
  return {
    kind: 'direct',
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

function spyTransport(): { transport: OutboundTransport; state: { calls: number } } {
  const state = { calls: 0 };
  return {
    state,
    transport: {
      kind: 'direct',
      request() {
        state.calls += 1;
        throw new Error('spy transport must not be reached for a rejected request');
      },
    },
  };
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
}

interface SeamResult {
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
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

  return new Promise<SeamResult>((resolve, reject) => {
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
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}
