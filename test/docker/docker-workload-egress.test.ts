/**
 * Construction-seam tests for the nested Docker workload's egress listeners.
 *
 * Everything here is hermetic: no Docker, no nested daemon, no network. The
 * "upstream" is a loopback HTTP server reached through a stub destination-bound
 * transport, so the frozen manifests' real hostnames are exercised without ever
 * resolving or dialing them.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import * as tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadOrCreateCA, type CertificateAuthority } from '../../src/docker/ca.js';
import {
  createDockerWorkloadEgressListeners,
  resolveDockerWorkloadEgressListenerOptions,
  type CreateDockerWorkloadEgressListenersOptions,
  type DockerWorkloadEgressSet,
} from '../../src/docker/docker-workload-egress.js';
import { getFrozenRegistryEgressManifestPath } from '../../src/docker/docker-workload-paths.js';
import type { MitmProxy } from '../../src/docker/mitm-proxy.js';
import type { PackageEgressProxy } from '../../src/docker/package-egress-proxy.js';
import type { DestinationBoundRequest, OutboundTransport } from '../../src/docker/outbound-transport.js';
import type { ResolvedDockerWorkloadConfig } from '../../src/docker-workload/config.js';
import { sha256Hex } from '../../src/hash.js';

/** node-forge RSA keygen is slow in pure JS; one CA and per-host leaf per file. */
let ca: CertificateAuthority;
let caDirectory: string;

const temporaryDirectories: string[] = [];
const servers: http.Server[] = [];
const proxies: MitmProxy[] = [];
const packageProxies: PackageEgressProxy[] = [];

beforeAll(() => {
  caDirectory = mkdtempSync(join(tmpdir(), 'workload-egress-ca-'));
  ca = loadOrCreateCA(caDirectory);
});

afterAll(() => {
  rmSync(caDirectory, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()));
  await Promise.all(packageProxies.splice(0).map((proxy) => proxy.stop()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// ── 1. Gating table ───────────────────────────────────────────────────

describe('Docker-workload egress gating', () => {
  it('builds no listener for a disabled workload', () => {
    const listeners = createDockerWorkloadEgressListeners({
      workload: { enabled: false },
      ca,
      outboundTransport: unreachableTransport(),
    });
    expect(listeners).toBeUndefined();
  });

  it('builds no listener when both egress modes are off', () => {
    // `offline` is "no route", not "a route that 403s": a
    // bound socket that TLS-terminates every host is more surface than none.
    const listeners = createDockerWorkloadEgressListeners({
      workload: workload('offline'),
      ca,
      outboundTransport: unreachableTransport(),
    });
    expect(listeners).toBeUndefined();
  });

  it('builds only the registry listener for images network access', () => {
    const options = {
      workload: workload('images'),
      ca,
      outboundTransport: unreachableTransport(),
      registryListen: { socketPath: socketPathIn(tempDirectory()) },
    } satisfies CreateDockerWorkloadEgressListenersOptions;

    const listeners = createDockerWorkloadEgressListeners(options);
    expect(listeners?.networkAccess).toBe('images');
    trackProxies(listeners);

    const resolved = resolveDockerWorkloadEgressListenerOptions(options);
    const guard = resolved?.registry.registryEgress?.guard;
    expect(guard?.mode).toBe('public-registry');
    expect(guard?.manifest?.policyId).toBe('workload-registry-egress-v1');
    expect(guard?.manifest?.status).toBe('frozen');
    expect(guard?.manifest?.origins.map((origin) => origin.hostname)).toEqual([
      'registry-1.docker.io',
      'auth.docker.io',
      'ghcr.io',
    ]);
  });

  it('constructs distinct registry and package listeners for packages network access', () => {
    const listeners = createDockerWorkloadEgressListeners({
      workload: workload('packages'),
      ca,
      outboundTransport: unreachableTransport(),
      registryListen: { socketPath: socketPathIn(tempDirectory()) },
      packageAuditLogPath: join(tempDirectory(), 'package-egress-audit.jsonl'),
    });
    trackProxies(listeners);
    expect(listeners?.networkAccess).toBe('packages');
    if (listeners?.networkAccess !== 'packages') throw new Error('expected package egress listeners');
    expect(listeners.registry).toBeDefined();
    expect(listeners.packages).toBeDefined();
  });

  it('refuses to build an enabled mode without a listen target', () => {
    expect(() =>
      createDockerWorkloadEgressListeners({
        workload: workload('images'),
        ca,
        outboundTransport: unreachableTransport(),
      }),
    ).toThrow(/no listen target/u);
  });
});

// ── 2. Frozen-manifest binding ────────────────────────────────────────

describe('frozen-manifest binding', () => {
  it('binds each guard to the exact committed manifest bytes', () => {
    const resolved = resolveDockerWorkloadEgressListenerOptions(registryOnly());
    const registryManifest = resolved?.registry.registryEgress?.guard.manifest;
    expect(registryManifest?.path).toBe(getFrozenRegistryEgressManifestPath());
    expect(registryManifest?.sha256).toBe(sha256Hex(readFileSync(getFrozenRegistryEgressManifestPath())));
  });

  it('never opts out of the frozen-manifest requirement', () => {
    // `allowUnfrozenManifest` exists for hermetic tests and the pre-freeze live
    // gate. The production construction seam must never reach for it.
    const source = readFileSync(resolve('src/docker/docker-workload-egress.ts'), 'utf8');
    expect(source).not.toContain('allowUnfrozenManifest');
  });
});

// ── 3. Admit / deny end-to-end through createMitmProxy ────────────────

describe('registry-egress listener (end-to-end through createMitmProxy)', () => {
  it('changes the exported ledger snapshot for a denied zero-byte request', async () => {
    const transport = recordingTransport({});
    const socketPath = socketPathIn(tempDirectory());
    const listeners = createDockerWorkloadEgressListeners({
      workload: workload('images'),
      ca,
      outboundTransport: transport.transport,
      registryListen: { socketPath },
    });
    if (listeners === undefined) throw new Error('expected registry listener');
    await startListener(listeners.registry.listener, socketPath);
    expect(listeners.registry.snapshot()).toEqual({ attempts: 0, totalBytes: 0, activeRequests: 0 });

    const response = await httpsThroughProxy(socketPath, 'registry-1.docker.io', {
      method: 'HEAD',
      path: '/v2/_catalog',
    });

    expect(response.statusCode).toBe(403);
    expect(transport.requests).toHaveLength(0);
    expect(listeners.registry.snapshot()).toEqual({ attempts: 1, totalBytes: 0, activeRequests: 0 });
  });

  it('admits a manifest pull to a listed registry and forwards it destination-bound', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.oci.image.manifest.v1+json' });
      res.end('{"schemaVersion":2}');
    });
    const transport = recordingTransport({ 'registry-1.docker.io': upstream.port });
    const socketPath = await startRegistryListener(transport.transport);

    const response = await httpsThroughProxy(socketPath, 'registry-1.docker.io', {
      path: '/v2/library/alpine/manifests/3.19',
      headers: { accept: 'application/vnd.oci.image.manifest.v1+json' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"schemaVersion":2}');
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0].destination).toEqual({
      protocol: 'https:',
      hostname: 'registry-1.docker.io',
      port: 443,
    });
    expect(transport.requests[0].path).toBe('/v2/library/alpine/manifests/3.19');
  });

  it('refuses an unlisted registry with no upstream contact', async () => {
    const transport = recordingTransport({});
    const socketPath = await startRegistryListener(transport.transport);

    expect(await connectStatus(socketPath, 'evil.example', 443)).toBe(403);
    expect(transport.requests).toHaveLength(0);
  });

  it.each([
    'registry-1.docker.io:443junk',
    'registry-1.docker.io:443/path',
    'registry-1.docker.io:443.5',
    'registry-1.docker.io:0443',
    'user@registry-1.docker.io:443',
    'registry-1.docker.io:443?query',
    'registry-1.docker.io:443#fragment',
    'registry-1.docker.io:0',
    'registry-1.docker.io:65536',
    ':443',
  ])('rejects malformed CONNECT authority %s before TLS or upstream contact', async (authority) => {
    const transport = recordingTransport({});
    const socketPath = await startRegistryListener(transport.transport);

    expect(await rawConnectStatus(socketPath, authority)).not.toBe(200);
    expect(transport.requests).toHaveLength(0);
  });

  it('normalizes an uppercase canonical CONNECT hostname', async () => {
    const transport = recordingTransport({});
    const socketPath = await startRegistryListener(transport.transport);

    expect(await rawConnectStatus(socketPath, 'REGISTRY-1.DOCKER.IO:443')).toBe(200);
    expect(transport.requests).toHaveLength(0);
  });

  it('rejects TLS SNI that differs from the authorized CONNECT host', async () => {
    const transport = recordingTransport({});
    const socketPath = await startRegistryListener(transport.transport);
    const tunnel = await sendConnect(socketPath, 'registry-1.docker.io', 443);

    await expect(
      new Promise<void>((done, fail) => {
        const socket = tls.connect({ socket: tunnel, servername: 'auth.docker.io', ca: ca.certPem }, () => done());
        socket.on('error', fail);
      }),
    ).rejects.toThrow();
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses a push to a listed registry with no upstream contact', async () => {
    const transport = recordingTransport({ 'registry-1.docker.io': 1 });
    const socketPath = await startRegistryListener(transport.transport);

    const response = await httpsThroughProxy(socketPath, 'registry-1.docker.io', {
      method: 'PUT',
      path: '/v2/library/alpine/blobs/uploads/e2f0b6a1',
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatch(/registry egress denied/u);
    expect(response.body).toMatch(/refuses push operations/u);
    expect(transport.requests).toHaveLength(0);
  });
});

// ── 4. Transport preconditions (checked at construction) ──────────────

describe('transport preconditions', () => {
  it('refuses registry egress over a transport that delegates the address policy', () => {
    expect(() =>
      createDockerWorkloadEgressListeners({
        ...registryOnly(),
        outboundTransport: unreachableTransport({ addressGuard: 'delegated' }),
      }),
    ).toThrow(/resolves and screens destination addresses locally/u);
  });
});

// ── 5. Per-mode option discipline ─────────────────────────────────────

describe('per-mode proxy options', () => {
  const SECURITY_SENSITIVE_OPTIONS = [
    'controlSocketPath',
    'controlPort',
    'registries',
    'packageValidation',
    'capture',
    'recordedAgentName',
    'workflowRunId',
    'bundleId',
    'initialTokenSessionId',
    'agentKind',
    'allowPrivateDestinationsForTests',
  ] as const;

  it('gives the registry listener only the keys its mode needs', () => {
    const resolved = resolveDockerWorkloadEgressListenerOptions(registryOnly());
    expect(Object.keys(resolved?.registry ?? {}).sort()).toEqual([
      'ca',
      'outboundTransport',
      'providers',
      'registryEgress',
      'socketPath',
    ]);
  });

  it.each(SECURITY_SENSITIVE_OPTIONS)('never sets %s on the registry listener', (key) => {
    const resolved = resolveDockerWorkloadEgressListenerOptions(registryOnly());
    expect(resolved?.registry[key]).toBeUndefined();
  });

  it('gives the registry listener no providers and exactly one egress mode', () => {
    const resolved = resolveDockerWorkloadEgressListenerOptions(registryOnly());
    expect(resolved?.registry.providers).toEqual([]);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

function workload(networkAccess: 'offline' | 'images' | 'packages'): ResolvedDockerWorkloadConfig {
  return {
    enabled: true,
    networkAccess,
    acceptObservedDiskRisk: true,
    resources: {
      memoryMb: 4096,
      cpus: 2,
      pids: { desired: 512, required: false },
      diskMb: null,
    },
  };
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'workload-egress-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** UDS paths are length-limited (~104 bytes), so keep the basename short. */
function socketPathIn(directory: string): string {
  return join(directory, 'e.sock');
}

function trackProxies(
  listeners:
    | DockerWorkloadEgressSet<{ readonly listener: MitmProxy }, { readonly listener: PackageEgressProxy }>
    | undefined,
): void {
  if (listeners === undefined) return;
  proxies.push(listeners.registry.listener);
  if (listeners.networkAccess === 'packages') packageProxies.push(listeners.packages.listener);
}

function registryOnly(): CreateDockerWorkloadEgressListenersOptions {
  return {
    workload: workload('images'),
    ca,
    outboundTransport: unreachableTransport(),
    registryListen: { socketPath: socketPathIn(tempDirectory()) },
  };
}

interface RecordedTransport {
  readonly transport: OutboundTransport;
  readonly requests: DestinationBoundRequest[];
}

/**
 * Stub destination-bound transport with the capabilities registry egress
 * requires, routing each frozen hostname at a loopback upstream and recording
 * exactly what it was asked to fetch.
 */
function recordingTransport(routes: Record<string, number | undefined>): RecordedTransport {
  const requests: DestinationBoundRequest[] = [];
  return {
    requests,
    transport: {
      kind: 'fixed-parent-proxy',
      addressGuard: 'local-resolver',
      request(request, onResponse) {
        requests.push(request);
        const port = routes[request.destination.hostname];
        if (port === undefined) throw new Error(`no test route for ${request.destination.hostname}`);
        return http.request(
          { host: '127.0.0.1', port, method: request.method, path: request.path, headers: request.headers },
          onResponse,
        );
      },
    },
  };
}

/** A transport that proves a rejection never reached the network. */
function unreachableTransport(
  overrides: Partial<Pick<OutboundTransport, 'kind' | 'addressGuard'>> = {},
): OutboundTransport {
  return {
    kind: overrides.kind ?? 'fixed-parent-proxy',
    addressGuard: overrides.addressGuard ?? 'local-resolver',
    request() {
      throw new Error('this fixture must never reach upstream');
    },
  };
}

interface UpstreamServer {
  readonly port: number;
}

function startUpstream(handler: http.RequestListener): Promise<UpstreamServer> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
      done({ port: address.port });
    });
  });
}

async function startRegistryListener(transport: OutboundTransport): Promise<string> {
  const socketPath = socketPathIn(tempDirectory());
  const listeners = createDockerWorkloadEgressListeners({
    workload: workload('images'),
    ca,
    outboundTransport: transport,
    registryListen: { socketPath },
  });
  return startListener(listeners?.registry.listener, socketPath);
}

async function startListener(proxy: MitmProxy | undefined, socketPath: string): Promise<string> {
  if (proxy === undefined) throw new Error('expected the listener to be constructed');
  proxies.push(proxy);
  await proxy.start();
  return socketPath;
}

interface RawResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Opens a CONNECT tunnel on the proxy's UDS and returns the tunneled socket. */
function sendConnect(socketPath: string, host: string, port: number): Promise<net.Socket> {
  return new Promise((done, fail) => {
    const request = http.request({ socketPath, method: 'CONNECT', path: `${host}:${port}` });
    request.on('connect', (response, socket: net.Socket) => {
      if (response.statusCode !== 200) {
        fail(new Error(`CONNECT ${host}:${port} returned ${String(response.statusCode)}`));
        return;
      }
      done(socket);
    });
    request.on('response', (response) => fail(new Error(`CONNECT refused with ${String(response.statusCode)}`)));
    request.on('error', fail);
    request.end();
  });
}

function connectStatus(socketPath: string, host: string, port: number): Promise<number> {
  return new Promise((done, fail) => {
    const request = http.request({ socketPath, method: 'CONNECT', path: `${host}:${port}` });
    request.on('connect', (response, socket: net.Socket) => {
      socket.destroy();
      done(response.statusCode ?? 0);
    });
    request.on('response', (response) => done(response.statusCode ?? 0));
    request.on('error', fail);
    request.end();
  });
}

/** Sends an exact CONNECT request-target without Node's client normalization. */
function rawConnectStatus(socketPath: string, authority: string): Promise<number> {
  return new Promise((done, fail) => {
    const socket = net.connect({ path: socketPath });
    let response = '';
    socket.on('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
      if (!response.includes('\r\n')) return;
      const status = Number.parseInt(response.split(' ')[1] ?? '0', 10);
      socket.destroy();
      done(status);
    });
    socket.on('error', fail);
    socket.on('close', () => {
      if (response === '') fail(new Error(`CONNECT ${authority} closed without a response`));
    });
  });
}

/** Writes a verbatim request onto a stream and parses the raw response. */
function exchangeRaw(stream: Duplex, request: string): Promise<RawResponse> {
  return new Promise((done, fail) => {
    let data = '';
    stream.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    stream.on('error', fail);
    stream.on('close', () => done(parseRawResponse(data)));
    stream.write(request);
  });
}

function parseRawResponse(data: string): RawResponse {
  const separator = data.indexOf('\r\n\r\n');
  const headSection = separator === -1 ? data : data.slice(0, separator);
  const rawBody = separator === -1 ? '' : data.slice(separator + 4);
  const lines = headSection.split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase().trim()] = line.slice(colon + 1).trim();
  }
  const body = headers['transfer-encoding'] === 'chunked' ? decodeChunkedBody(rawBody) : rawBody;
  return { statusCode: Number.parseInt(lines[0].split(' ')[1] ?? '0', 10), headers, body };
}

/** The mediated forwarder streams, so a length-less response arrives chunked. */
function decodeChunkedBody(raw: string): string {
  let offset = 0;
  let body = '';
  for (;;) {
    const lineEnd = raw.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const size = Number.parseInt(raw.slice(offset, lineEnd).split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    body += raw.slice(lineEnd + 2, lineEnd + 2 + size);
    offset = lineEnd + 2 + size + 2;
  }
  return body;
}

/** A realistic HTTPS client through the proxy: CONNECT, TLS, HTTP/1.1 request. */
async function httpsThroughProxy(
  socketPath: string,
  host: string,
  options: { method?: string; path: string; headers?: Record<string, string> },
): Promise<RawResponse> {
  const headerLines = Object.entries({ host, connection: 'close', ...options.headers })
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n');
  return rawHttpsThroughProxy(
    socketPath,
    host,
    `${options.method ?? 'GET'} ${options.path} HTTP/1.1\r\n${headerLines}\r\n\r\n`,
  );
}

/** CONNECT + TLS, then a verbatim request (so a test can omit `Host`). */
async function rawHttpsThroughProxy(socketPath: string, host: string, request: string): Promise<RawResponse> {
  const tunnel = await sendConnect(socketPath, host, 443);
  const secure = await new Promise<tls.TLSSocket>((done, fail) => {
    const socket = tls.connect({ socket: tunnel, servername: host, ca: ca.certPem }, () => done(socket));
    socket.on('error', fail);
  });
  return exchangeRaw(secure, request);
}
