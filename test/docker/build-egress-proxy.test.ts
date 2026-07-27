import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBuildEgressGuard,
  handleBuildEgressRequest,
  type BuildEgressGuard,
} from '../../src/docker/build-egress-proxy.js';
import type { BuildEgressManifest } from '../../src/docker-workload/build-egress-policy.js';
import { createDirectOutboundTransport, type OutboundTransport } from '../../src/docker/outbound-transport.js';

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

describe('build-egress guard construction (fail-closed)', () => {
  it('fails closed when the frozen manifest is missing', () => {
    const directory = tempDirectory();
    expect(() =>
      createBuildEgressGuard({
        mode: 'ironcurtain-dockerfiles',
        manifestPath: join(directory, 'absent-manifest.json'),
        repositoryRoot: directory,
      }),
    ).toThrow(/readable regular non-symlink file/u);
  });

  it('fails closed when a current Dockerfile drifts from its reviewed hash', () => {
    const directory = fixtureRepository();
    const manifestPath = writeManifest(directory, [artifactRule('downloads.example.com', 443)]);
    // Rewrite the reviewed Dockerfile so its bytes no longer match the manifest hash.
    writeFileSync(join(directory, 'docker', 'Dockerfile.fixture'), 'FROM busybox\n', { mode: 0o600 });
    expect(() =>
      createBuildEgressGuard({ mode: 'ironcurtain-dockerfiles', manifestPath, repositoryRoot: directory }),
    ).toThrow(/hash mismatch/u);
  });

  it('reports the frozen manifest identity for audit once constructed', () => {
    const guard = buildFixtureGuard([artifactRule('downloads.example.com', 443)]);
    expect(guard.mode).toBe('ironcurtain-dockerfiles');
    expect(guard.manifest?.policyId).toBe('ironcurtain-current-dockerfiles-v1');
    expect(guard.manifest?.dockerfiles).toEqual([
      { path: 'docker/Dockerfile.fixture', sha256: createHash('sha256').update(DOCKERFILE_BYTES).digest('hex') },
    ]);
  });
});

describe('build-egress disabled mode (fail-fast)', () => {
  it('authorizes nothing', () => {
    const guard = createBuildEgressGuard({ mode: 'disabled' });
    expect(guard.mode).toBe('disabled');
    expect(guard.manifest).toBeUndefined();
    expect(() =>
      guard.authorize({ seam: 'run', method: 'GET', url: 'https://downloads.example.com/artifacts/tool.tar.gz' }),
    ).toThrow(/disabled/u);
  });

  it('fails fast at the proxy seam for any build-egress-tagged request', async () => {
    const spy = spyTransport();
    const result = await driveThroughSeam({
      guard: createBuildEgressGuard({ mode: 'disabled' }),
      transport: spy.transport,
      targetHost: 'downloads.example.com',
      targetPort: 443,
      scheme: 'https:',
      path: '/artifacts/tool.tar.gz',
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).toMatch(/disabled/u);
    expect(spy.state.calls).toBe(0);
  });
});

describe('build-egress proxy seam (enabled)', () => {
  it('forwards an authorized request through the destination-bound transport', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'set-cookie': 'leak=1' });
      res.end('artifact-bytes');
    });
    const guard = buildFixtureGuard([artifactRule('127.0.0.1', upstream.port)]);

    const observed = new Promise<{ method?: string; url?: string; host?: string; authorization?: string }>(
      (resolve) => {
        upstream.onRequest = (req) =>
          resolve({
            method: req.method,
            url: req.url,
            host: req.headers.host,
            authorization: req.headers.authorization,
          });
      },
    );

    const result = await driveThroughSeam({
      guard,
      transport: createDirectOutboundTransport({ allowPrivateDestinationsForTests: true }),
      targetHost: '127.0.0.1',
      targetPort: upstream.port,
      scheme: 'http:',
      path: '/artifacts/tool.tar.gz?version=1',
      headers: { accept: 'application/octet-stream', 'user-agent': 'fixture/1' },
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('artifact-bytes');
    // Credential-bearing response headers never propagate back into the build.
    expect(result.headers['set-cookie']).toBeUndefined();
    await expect(observed).resolves.toEqual({
      method: 'GET',
      url: '/artifacts/tool.tar.gz?version=1',
      host: `127.0.0.1:${upstream.port}`,
      authorization: undefined,
    });
  });

  it('rejects a client-selected target with no upstream contact', async () => {
    const spy = spyTransport();
    const result = await driveThroughSeam({
      guard: buildFixtureGuard([artifactRule('downloads.example.com', 443)]),
      transport: spy.transport,
      targetHost: 'evil.example',
      targetPort: 443,
      scheme: 'https:',
      path: '/artifacts/tool.tar.gz',
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).toMatch(/not authorized/u);
    expect(spy.state.calls).toBe(0);
  });

  it('rejects a credential header end-to-end with no upstream contact', async () => {
    const spy = spyTransport();
    const result = await driveThroughSeam({
      guard: buildFixtureGuard([artifactRule('downloads.example.com', 443)]),
      transport: spy.transport,
      targetHost: 'downloads.example.com',
      targetPort: 443,
      scheme: 'https:',
      path: '/artifacts/tool.tar.gz',
      headers: { authorization: 'Bearer real-secret' },
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).toMatch(/credential header/u);
    expect(spy.state.calls).toBe(0);
  });

  it('refuses to egress a fixed-parent-only rule over a direct transport', async () => {
    // A direct transport must never carry a reviewed fixed-parent origin.
    const guard = buildFixtureGuard([artifactRule('downloads.example.com', 443, 'fixed-parent-only')]);
    const result = await driveThroughSeam({
      guard,
      transport: createDirectOutboundTransport({ allowPrivateDestinationsForTests: true }),
      targetHost: 'downloads.example.com',
      targetPort: 443,
      scheme: 'https:',
      path: '/artifacts/tool.tar.gz',
    });
    expect(result.statusCode).toBe(502);
    expect(result.body).toMatch(/fixed parent proxy/u);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

const DOCKERFILE_BYTES = Buffer.from('FROM scratch\n');

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'build-egress-proxy-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureRepository(): string {
  const directory = tempDirectory();
  mkdirSync(join(directory, 'docker'));
  writeFileSync(join(directory, 'docker', 'Dockerfile.fixture'), DOCKERFILE_BYTES, { mode: 0o600 });
  return directory;
}

function writeManifest(repositoryRoot: string, rules: BuildEgressManifest['rules']): string {
  const manifest: BuildEgressManifest = {
    schemaVersion: 1,
    policyId: 'ironcurtain-current-dockerfiles-v1',
    sourceDockerfiles: [
      { path: 'docker/Dockerfile.fixture', sha256: createHash('sha256').update(DOCKERFILE_BYTES).digest('hex') },
    ],
    rules,
  };
  const manifestPath = join(repositoryRoot, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o400 });
  return manifestPath;
}

function buildFixtureGuard(rules: BuildEgressManifest['rules']): BuildEgressGuard {
  const directory = fixtureRepository();
  const manifestPath = writeManifest(directory, rules);
  return createBuildEgressGuard({ mode: 'ironcurtain-dockerfiles', manifestPath, repositoryRoot: directory });
}

function artifactRule(
  hostname: string,
  port: number,
  addressPolicy: 'fixed-parent-only' | 'public-direct' = 'public-direct',
): BuildEgressManifest['rules'][number] {
  return {
    id: 'artifact-download',
    seams: ['run'],
    destination: { protocol: port === 443 ? 'https:' : 'http:', hostname, port, addressPolicy },
    methods: ['GET', 'HEAD'],
    paths: [{ kind: 'prefix', value: '/artifacts/', allowQuery: true }],
    redirects: { maxHops: 0, allowedRuleIds: [] },
    requestHeaders: { allow: ['accept', 'user-agent'], strip: ['host', 'connection'] },
    limits: { responseBytes: 10 * 1024 * 1024, timeoutMs: 30_000 },
  };
}

function spyTransport(): { transport: OutboundTransport; state: { calls: number } } {
  const state = { calls: 0 };
  return {
    state,
    transport: {
      kind: 'direct',
      addressGuard: 'local-resolver',
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

interface SeamDriveOptions {
  readonly guard: BuildEgressGuard;
  readonly transport: OutboundTransport;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly scheme: 'http:' | 'https:';
  readonly path: string;
  readonly headers?: Record<string, string>;
}

interface SeamResult {
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/**
 * Stand up a real HTTP front server that decrypts to `handleBuildEgressRequest`
 * (as the outer MITM does after TLS termination), issue one client request, and
 * capture the response the build would have received.
 */
async function driveThroughSeam(options: SeamDriveOptions): Promise<SeamResult> {
  const front = http.createServer((req, res) => {
    handleBuildEgressRequest(req, res, {
      guard: options.guard,
      seam: 'run',
      transport: options.transport,
      scheme: options.scheme,
      targetHost: options.targetHost,
      targetPort: options.targetPort,
      requestTarget: req.url ?? '/',
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
      { host: '127.0.0.1', port: frontPort, path: options.path, method: 'GET', headers: options.headers, agent: false },
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
