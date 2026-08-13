/**
 * Construction-seam tests for the nested Docker workload's egress listeners.
 *
 * Everything here is hermetic: no Docker, no nested daemon, no network. The
 * "upstream" is a loopback HTTP server reached through a stub destination-bound
 * transport, so the frozen manifests' real hostnames are exercised without ever
 * resolving or dialing them.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
} from '../../src/docker/docker-workload-egress.js';
import {
  getFrozenBuildEgressManifestPath,
  getFrozenRegistryEgressManifestPath,
  getIronCurtainPackageRoot,
} from '../../src/docker/docker-workload-paths.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import type { DestinationBoundRequest, OutboundTransport } from '../../src/docker/outbound-transport.js';
import { resolveDockerWorkloadConfig, type ResolvedDockerWorkloadConfig } from '../../src/docker-workload/config.js';
import { sha256Hex } from '../../src/hash.js';

/** node-forge RSA keygen is slow in pure JS; one CA and per-host leaf per file. */
let ca: CertificateAuthority;
let caDirectory: string;

const temporaryDirectories: string[] = [];
const servers: http.Server[] = [];
const proxies: MitmProxy[] = [];

beforeAll(() => {
  caDirectory = mkdtempSync(join(tmpdir(), 'workload-egress-ca-'));
  ca = loadOrCreateCA(caDirectory);
});

afterAll(() => {
  rmSync(caDirectory, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()));
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
    expect(listeners).toEqual({});
  });

  it('builds no listener when both egress modes are off', () => {
    // `preloaded-only` + `disabled` is "no route", not "a route that 403s": a
    // bound socket that TLS-terminates every host is more surface than none.
    const listeners = createDockerWorkloadEgressListeners({
      workload: workload({ imageIngress: 'preloaded-only', buildEgress: 'disabled' }),
      ca,
      outboundTransport: unreachableTransport(),
    });
    expect(listeners).toEqual({});
  });

  it('builds only the registry listener for public-registry image ingress', () => {
    const options = {
      workload: workload({ imageIngress: 'public-registry', buildEgress: 'disabled' }),
      ca,
      outboundTransport: unreachableTransport(),
      registryListen: { socketPath: socketPathIn(tempDirectory()) },
    } satisfies CreateDockerWorkloadEgressListenersOptions;

    const listeners = createDockerWorkloadEgressListeners(options);
    expect(listeners.registryEgress).toBeDefined();
    expect(listeners.buildEgress).toBeUndefined();
    trackProxies(listeners);

    const resolved = resolveDockerWorkloadEgressListenerOptions(options);
    const guard = resolved.registryEgress?.registryEgress?.guard;
    expect(guard?.mode).toBe('public-registry');
    expect(guard?.manifest?.policyId).toBe('workload-registry-egress-v1');
    expect(guard?.manifest?.status).toBe('frozen');
    expect(guard?.manifest?.origins.map((origin) => origin.hostname)).toEqual([
      'registry-1.docker.io',
      'auth.docker.io',
      'ghcr.io',
    ]);
  });

  it('builds only the build listener for ironcurtain-dockerfiles build egress', () => {
    const options = {
      workload: workload({ imageIngress: 'preloaded-only', buildEgress: 'ironcurtain-dockerfiles' }),
      ca,
      outboundTransport: unreachableTransport(),
      buildListen: { socketPath: socketPathIn(tempDirectory()) },
    } satisfies CreateDockerWorkloadEgressListenersOptions;

    const listeners = createDockerWorkloadEgressListeners(options);
    expect(listeners.buildEgress).toBeDefined();
    expect(listeners.registryEgress).toBeUndefined();
    trackProxies(listeners);

    const resolved = resolveDockerWorkloadEgressListenerOptions(options);
    const buildEgress = resolved.buildEgress?.buildEgress;
    expect(buildEgress?.guard.mode).toBe('ironcurtain-dockerfiles');
    expect(buildEgress?.seam).toBe('run');
    expect(buildEgress?.guard.manifest?.dockerfiles.map((source) => source.path)).toEqual([
      'docker/Dockerfile.base.arm64',
      'docker/Dockerfile.claude-code',
      'docker/Dockerfile.codex',
      'docker/Dockerfile.goose',
    ]);
    for (const source of buildEgress?.guard.manifest?.dockerfiles ?? []) {
      expect(source.sha256).toBe(sha256Hex(readFileSync(resolve(getIronCurtainPackageRoot(), source.path))));
    }
  });

  it('builds two distinct listeners when both modes are enabled', () => {
    const directory = tempDirectory();
    const listeners = createDockerWorkloadEgressListeners({
      workload: workload({ imageIngress: 'public-registry', buildEgress: 'ironcurtain-dockerfiles' }),
      ca,
      outboundTransport: unreachableTransport(),
      registryListen: { socketPath: join(directory, 'registry.sock') },
      buildListen: { socketPath: join(directory, 'build.sock') },
    });
    trackProxies(listeners);
    expect(listeners.registryEgress).toBeDefined();
    expect(listeners.buildEgress).toBeDefined();
    // Two listeners, never one proxy in two modes: the MITM rejects that pairing.
    expect(listeners.registryEgress).not.toBe(listeners.buildEgress);
  });

  it('refuses to build an enabled mode without a listen target', () => {
    expect(() =>
      createDockerWorkloadEgressListeners({
        workload: workload({ imageIngress: 'public-registry', buildEgress: 'disabled' }),
        ca,
        outboundTransport: unreachableTransport(),
      }),
    ).toThrow(/no listen target/u);
  });
});

// ── 2. Frozen-manifest binding ────────────────────────────────────────

describe('frozen-manifest binding', () => {
  it('binds each guard to the exact committed manifest bytes', () => {
    const resolved = resolveDockerWorkloadEgressListenerOptions(bothModes());
    const registryManifest = resolved.registryEgress?.registryEgress?.guard.manifest;
    expect(registryManifest?.path).toBe(getFrozenRegistryEgressManifestPath());
    expect(registryManifest?.sha256).toBe(sha256Hex(readFileSync(getFrozenRegistryEgressManifestPath())));

    const buildManifest = resolved.buildEgress?.buildEgress?.guard.manifest;
    expect(buildManifest?.path).toBe(getFrozenBuildEgressManifestPath());
    expect(buildManifest?.sha256).toBe(sha256Hex(readFileSync(getFrozenBuildEgressManifestPath())));
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

describe('build-egress listener (end-to-end through createMitmProxy)', () => {
  it('admits a listed TLS origin and forwards it destination-bound', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"name":"ironcurtain"}');
    });
    const transport = recordingTransport({ 'registry.npmjs.org': upstream.port });
    const socketPath = await startBuildListener(transport.transport);

    const response = await rawHttpsThroughProxy(
      socketPath,
      'registry.npmjs.org',
      'GET /ironcurtain HTTP/1.0\r\naccept: application/json\r\n\r\n',
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"name":"ironcurtain"}');
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0].destination).toEqual({
      protocol: 'https:',
      hostname: 'registry.npmjs.org',
      port: 443,
    });
  });

  it('refuses an unlisted TLS origin with no upstream contact', async () => {
    const transport = recordingTransport({});
    const socketPath = await startBuildListener(transport.transport);

    const response = await rawHttpsThroughProxy(socketPath, 'evil.example', 'GET /payload HTTP/1.0\r\n\r\n');

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatch(/build egress denied/u);
    expect(transport.requests).toHaveLength(0);
  });

  it('admits the plain-HTTP apt path, a dispatch separate from the TLS path', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Suite: bookworm');
    });
    const transport = recordingTransport({ 'deb.debian.org': upstream.port });
    const socketPath = await startBuildListener(transport.transport);

    const response = await rawPlainHttpThroughProxy(
      socketPath,
      'GET http://deb.debian.org/debian/dists/bookworm/InRelease HTTP/1.0\r\naccept: */*\r\n\r\n',
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('Suite: bookworm');
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0].destination).toEqual({ protocol: 'http:', hostname: 'deb.debian.org', port: 80 });
    expect(transport.requests[0].path).toBe('/debian/dists/bookworm/InRelease');
  });

  it('refuses an unlisted plain-HTTP host with no upstream contact', async () => {
    const transport = recordingTransport({});
    const socketPath = await startBuildListener(transport.transport);

    const response = await rawPlainHttpThroughProxy(
      socketPath,
      'GET http://evil.example/debian/dists/bookworm/InRelease HTTP/1.0\r\n\r\n',
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatch(/build egress denied/u);
    expect(transport.requests).toHaveLength(0);
  });

  it('admits a realistic HTTP/1.1 client that sends the mandatory Host header', async () => {
    // `Host` is mandatory in HTTP/1.1 and no frozen rule enumerates it, so build
    // egress used to refuse every real client (apt, curl, BuildKit).
    // `build-egress-policy.ts` now drops `host` and the hop-by-hop set before the
    // allow/strip lists are consulted, matching `registry-egress-policy.ts`:
    // the destination-bound transport owns Host/SNI, so relaying a client-supplied
    // `Host` would be a smuggling vector rather than a feature.
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Suite: bookworm');
    });
    const transport = recordingTransport({ 'deb.debian.org': upstream.port });
    const socketPath = await startBuildListener(transport.transport);

    const response = await rawPlainHttpThroughProxy(
      socketPath,
      'GET http://deb.debian.org/debian/dists/bookworm/InRelease HTTP/1.1\r\n' +
        'host: deb.debian.org\r\nconnection: close\r\nuser-agent: Debian APT-HTTP/1.3\r\n\r\n',
    );

    expect(response.statusCode).toBe(200);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.destination.hostname).toBe('deb.debian.org');
    // host/connection dropped, the declared user-agent preserved.
    expect(transport.requests[0]?.headers).toEqual({ 'user-agent': 'Debian APT-HTTP/1.3' });
  });
});

// ── 4. Fail-closed construction ───────────────────────────────────────

describe('fail-closed construction', () => {
  it('aborts before any listener exists when a hash-bound Dockerfile drifts', () => {
    const drifted = driftedRepositoryRoot();
    const options: CreateDockerWorkloadEgressListenersOptions = { ...bothModes(), repositoryRoot: drifted };

    // Both modes are enabled, and guard construction happens for every mode
    // before any proxy is constructed, so a drifted Dockerfile leaves no
    // half-built registry listener behind either.
    expect(() => resolveDockerWorkloadEgressListenerOptions(options)).toThrow(/hash mismatch/u);
    expect(() => createDockerWorkloadEgressListeners(options)).toThrow(/hash mismatch/u);
  });
});

// ── 5. Transport preconditions (checked at construction) ──────────────

describe('transport preconditions', () => {
  it('refuses build egress over a direct transport', () => {
    expect(() =>
      createDockerWorkloadEgressListeners({
        ...buildOnly(),
        outboundTransport: unreachableTransport({ kind: 'direct' }),
      }),
    ).toThrow(/fixed parent proxy transport/u);
  });

  it('refuses registry egress over a transport that delegates the address policy', () => {
    expect(() =>
      createDockerWorkloadEgressListeners({
        ...registryOnly(),
        outboundTransport: unreachableTransport({ addressGuard: 'delegated' }),
      }),
    ).toThrow(/resolves and screens destination addresses locally/u);
  });
});

// ── 6. Per-mode option discipline ─────────────────────────────────────

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

  it('gives each listener only the keys its mode needs', () => {
    const resolved = resolveDockerWorkloadEgressListenerOptions(bothModes());
    expect(Object.keys(resolved.registryEgress ?? {}).sort()).toEqual([
      'ca',
      'outboundTransport',
      'providers',
      'registryEgress',
      'socketPath',
    ]);
    expect(Object.keys(resolved.buildEgress ?? {}).sort()).toEqual([
      'buildEgress',
      'ca',
      'outboundTransport',
      'providers',
      'socketPath',
    ]);
  });

  it.each(SECURITY_SENSITIVE_OPTIONS)('never sets %s on either listener', (key) => {
    const resolved = resolveDockerWorkloadEgressListenerOptions(bothModes());
    expect(resolved.registryEgress?.[key]).toBeUndefined();
    expect(resolved.buildEgress?.[key]).toBeUndefined();
  });

  it('gives each listener no providers and exactly one egress mode', () => {
    const resolved = resolveDockerWorkloadEgressListenerOptions(bothModes());
    expect(resolved.registryEgress?.providers).toEqual([]);
    expect(resolved.buildEgress?.providers).toEqual([]);
    expect(resolved.registryEgress?.buildEgress).toBeUndefined();
    expect(resolved.buildEgress?.registryEgress).toBeUndefined();
  });

  it('would be rejected by the MITM if the two modes were ever merged onto one listener', () => {
    // Guards the invariant the seam relies on: one listener, one mode. Splicing
    // the two resolved option sets together must not produce a usable proxy.
    const resolved = resolveDockerWorkloadEgressListenerOptions(bothModes());
    const registryOptions = resolved.registryEgress;
    const buildMode = resolved.buildEgress?.buildEgress;
    if (registryOptions === undefined || buildMode === undefined) throw new Error('expected both modes resolved');
    expect(() => createMitmProxy({ ...registryOptions, buildEgress: buildMode })).toThrow(/mutually exclusive/u);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

function workload(overrides: {
  imageIngress: 'preloaded-only' | 'public-registry';
  buildEgress: 'disabled' | 'ironcurtain-dockerfiles';
}): ResolvedDockerWorkloadConfig {
  return resolveDockerWorkloadConfig({ enabled: true, ...overrides });
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

function trackProxies(listeners: { registryEgress?: MitmProxy; buildEgress?: MitmProxy }): void {
  if (listeners.registryEgress) proxies.push(listeners.registryEgress);
  if (listeners.buildEgress) proxies.push(listeners.buildEgress);
}

function registryOnly(): CreateDockerWorkloadEgressListenersOptions {
  return {
    workload: workload({ imageIngress: 'public-registry', buildEgress: 'disabled' }),
    ca,
    outboundTransport: unreachableTransport(),
    registryListen: { socketPath: socketPathIn(tempDirectory()) },
  };
}

function buildOnly(): CreateDockerWorkloadEgressListenersOptions {
  return {
    workload: workload({ imageIngress: 'preloaded-only', buildEgress: 'ironcurtain-dockerfiles' }),
    ca,
    outboundTransport: unreachableTransport(),
    buildListen: { socketPath: socketPathIn(tempDirectory()) },
  };
}

function bothModes(): CreateDockerWorkloadEgressListenersOptions {
  const directory = tempDirectory();
  return {
    workload: workload({ imageIngress: 'public-registry', buildEgress: 'ironcurtain-dockerfiles' }),
    ca,
    outboundTransport: unreachableTransport(),
    registryListen: { socketPath: join(directory, 'r.sock') },
    buildListen: { socketPath: join(directory, 'b.sock') },
  };
}

/** A checkout whose reviewed Dockerfiles no longer match the frozen hashes. */
function driftedRepositoryRoot(): string {
  const root = tempDirectory();
  mkdirSync(join(root, 'docker'));
  const manifest = JSON.parse(readFileSync(getFrozenBuildEgressManifestPath(), 'utf8')) as {
    sourceDockerfiles: readonly { readonly path: string }[];
  };
  for (const source of manifest.sourceDockerfiles) {
    copyFileSync(resolve(getIronCurtainPackageRoot(), source.path), join(root, source.path));
  }
  const drifted = join(root, 'docker', 'Dockerfile.base.arm64');
  writeFileSync(drifted, `${readFileSync(drifted, 'utf8')}\n`, { mode: 0o600 });
  return root;
}

interface RecordedTransport {
  readonly transport: OutboundTransport;
  readonly requests: DestinationBoundRequest[];
}

/**
 * Stub destination-bound transport with the capabilities both egress modes
 * require, routing each frozen hostname at a loopback upstream and recording
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
    workload: workload({ imageIngress: 'public-registry', buildEgress: 'disabled' }),
    ca,
    outboundTransport: transport,
    registryListen: { socketPath },
  });
  return startListener(listeners.registryEgress, socketPath);
}

async function startBuildListener(transport: OutboundTransport): Promise<string> {
  const socketPath = socketPathIn(tempDirectory());
  const listeners = createDockerWorkloadEgressListeners({
    workload: workload({ imageIngress: 'preloaded-only', buildEgress: 'ironcurtain-dockerfiles' }),
    ca,
    outboundTransport: transport,
    buildListen: { socketPath },
  });
  return startListener(listeners.buildEgress, socketPath);
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

/** A plain-HTTP proxy request (absolute-form), as apt speaks it. */
async function rawPlainHttpThroughProxy(socketPath: string, request: string): Promise<RawResponse> {
  const socket = await new Promise<net.Socket>((done, fail) => {
    const connection = net.connect({ path: socketPath }, () => done(connection));
    connection.on('error', fail);
  });
  return exchangeRaw(socket, request);
}
