import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadOrCreateCA } from '../../src/docker/ca.js';
import {
  createPackageEgressProxy,
  PACKAGE_EGRESS_HEALTH_BODY,
  PACKAGE_EGRESS_HEALTH_REQUEST,
} from '../../src/docker/package-egress-proxy.js';

interface RelayTransportLimits {
  readonly maxBytesEachDirection: number;
  readonly idleTimeoutMs: number;
  readonly absoluteTimeoutMs: number | null;
  readonly dialTimeoutMs: number;
}

interface RelayEndpoint {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly socketPath: string;
  readonly healthRequest: string;
  readonly healthBody: string;
  readonly transportLimits: RelayTransportLimits;
}

interface RelayController {
  readonly done: Promise<void>;
  readonly activeConnections: number;
  close(): Promise<void>;
}

interface RelayModule {
  readonly APPLE_VM_EGRESS_RELAY_VERSION: string;
  readonly DEFAULT_RELAY_LIMITS: {
    readonly maxConnections: number;
    readonly registry: RelayTransportLimits;
    readonly package: RelayTransportLimits;
  };
  startRelayProfileForTest(
    endpoints: readonly RelayEndpoint[],
    options?: {
      readonly maxConnections?: number;
      readonly testHooks?: { readonly onAccepted?: (socket: Socket, endpoint: RelayEndpoint) => void };
    },
  ): Promise<RelayController>;
  parseHealthResponseForTest(response: Buffer, expectedBody: string): void;
  probeEndpointForTest(endpoint: RelayEndpoint): Promise<void>;
}

const RELAY_PATH = resolve('docker/apple-vm-egress-relay.mjs');
const LOOPBACK = '127.0.0.1';
const HEALTH_REQUEST =
  'GET http://ironcurtain.invalid/__ironcurtain/health HTTP/1.1\r\n' +
  'Host: ironcurtain.invalid\r\nConnection: close\r\n\r\n';
const HEALTH_BODY = 'IRONCURTAIN_OK/1\n';
let relayModule: RelayModule;
const cleanup: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  relayModule = (await import(pathToFileURL(RELAY_PATH).href)) as RelayModule;
});

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function listen(server: Server, target: string | number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      resolveListen();
    });
    if (typeof target === 'number') server.listen(target, LOOPBACK);
    else server.listen(target);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(resolveClose));
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test listener has no TCP port');
  await closeServer(server);
  return address.port;
}

function endpoint(
  port: number,
  socketPath: string,
  transportLimits: RelayTransportLimits = relayModule.DEFAULT_RELAY_LIMITS.package,
): RelayEndpoint {
  return {
    name: 'test',
    host: LOOPBACK,
    port,
    socketPath,
    healthRequest: HEALTH_REQUEST,
    healthBody: HEALTH_BODY,
    transportLimits,
  };
}

async function fixture(handler: (socket: Socket) => void): Promise<{
  readonly directory: string;
  readonly socketPath: string;
  readonly server: Server;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'ironcurtain-node-relay-'));
  const socketPath = join(directory, 'relay.sock');
  const server = createServer({ allowHalfOpen: true }, handler);
  await listen(server, socketPath);
  cleanup.push(async () => {
    await closeServer(server);
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, socketPath, server };
}

function exchange(
  port: number,
  request: Buffer | string,
  options: {
    readonly halfClose?: boolean;
    readonly maxBytes?: number;
    readonly pauseMs?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<Buffer> {
  return new Promise((resolveExchange, reject) => {
    const socket = createConnection({ host: LOOPBACK, port, allowHalfOpen: true });
    const chunks: Buffer[] = [];
    let ended = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('test exchange timed out'));
    }, options.timeoutMs ?? 5_000);
    socket.once('connect', () => {
      if (options.halfClose === true) socket.end(request);
      else socket.write(request);
      if ((options.pauseMs ?? 0) > 0) {
        socket.pause();
        setTimeout(() => socket.resume(), options.pauseMs);
      }
    });
    let size = 0;
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? Number.POSITIVE_INFINITY)) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error('test exchange exceeded its byte bound'));
        return;
      }
      chunks.push(chunk);
    });
    socket.once('end', () => {
      ended = true;
      clearTimeout(timer);
      const response = Buffer.concat(chunks);
      socket.destroy();
      resolveExchange(response);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      if (!ended) reject(error);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      if (!ended) reject(new Error('test exchange closed without clean EOF'));
    });
  });
}

async function sendFragmented(socket: Socket, bytes: Buffer, delayMs = 0): Promise<void> {
  if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  const fragmentSizes = [1, 137, 4093, 17, 65_521];
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const end = Math.min(bytes.length, offset + fragmentSizes[index % fragmentSizes.length]);
    if (!socket.write(bytes.subarray(offset, end))) await once(socket, 'drain');
    offset = end;
    index += 1;
  }
  socket.end();
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error('condition did not become true within the test bound');
}

function waitForClose(socket: Socket): Promise<void> {
  return new Promise((resolveClose) => socket.once('close', () => resolveClose()));
}

describe('purpose-built Apple VM egress relay', () => {
  it('has an exact non-configurable CLI and fixed version output', () => {
    const version = spawnSync(process.execPath, [RELAY_PATH, '--version'], { encoding: 'utf8' });
    expect(version).toMatchObject({
      status: 0,
      stdout: 'ironcurtain-apple-vm-egress-relay/1\n',
      stderr: '',
    });
    expect(relayModule.APPLE_VM_EGRESS_RELAY_VERSION).toBe('ironcurtain-apple-vm-egress-relay/1');
    expect(relayModule.DEFAULT_RELAY_LIMITS).toEqual({
      maxConnections: 32,
      registry: {
        maxBytesEachDirection: 20 * 1024 * 1024 * 1024,
        idleTimeoutMs: 11 * 60_000,
        absoluteTimeoutMs: null,
        dialTimeoutMs: 15_000,
      },
      package: {
        maxBytesEachDirection: 4 * 1024 * 1024 * 1024,
        idleTimeoutMs: 11 * 60_000,
        absoluteTimeoutMs: 11 * 60_000,
        dialTimeoutMs: 15_000,
      },
    });

    for (const argv of [[], ['serve'], ['serve', 'registry'], ['serve', 'images', '18090'], ['probe', 'public']]) {
      const invalid = spawnSync(process.execPath, [RELAY_PATH, ...argv], { encoding: 'utf8' });
      expect(invalid).toMatchObject({
        status: 64,
        stdout: '',
        stderr: 'IRONCURTAIN_APPLE_VM_EGRESS_RELAY_USAGE/1\n',
      });
    }

    const source = readFileSync(RELAY_PATH, 'utf8');
    expect(source).toContain("port: 18081,\n    socketPath: '/tmp/ironcurtain-registry-egress.sock'");
    expect(source).toContain("port: 18082,\n    socketPath: '/tmp/ironcurtain-package-egress.sock'");
    expect(source).toContain('images: Object.freeze([ENDPOINTS.registry])');
    expect(source).toContain('packages: Object.freeze([ENDPOINTS.registry, ENDPOINTS.package])');
    expect(source).toContain("if (profile === 'images') await requireRefused(ENDPOINTS.package)");
    expect(source).not.toMatch(/process\.env|--host|--port|--socket/u);
  });

  it('uses the production held-open probe and requires a clean chunked health EOF', async () => {
    const body = Buffer.from(HEALTH_BODY);
    const response = Buffer.from(
      `HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${HEALTH_BODY}\r\n0\r\n\r\n`,
    );
    const { socketPath } = await fixture((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).toString('utf8') === HEALTH_REQUEST) socket.end(response);
      });
    });
    const port = await reservePort();
    const relayEndpoint = endpoint(port, socketPath);
    const relay = await relayModule.startRelayProfileForTest([relayEndpoint]);
    cleanup.push(() => relay.close());

    await expect(relayModule.probeEndpointForTest(relayEndpoint)).resolves.toBeUndefined();
    await waitUntil(() => relay.activeConnections === 0);
  });

  it('forwards held-open requests and delayed half-closed responses with backpressure', async () => {
    const heldResponse = Buffer.concat([Buffer.from('held:'), Buffer.alloc(2 * 1024 * 1024, 0x68)]);
    const halfResponse = Buffer.concat([Buffer.from('half:'), Buffer.alloc(512 * 1024, 0x66)]);
    const { socketPath } = await fixture((socket) => {
      const chunks: Buffer[] = [];
      let dispatched = false;
      let waitForEnd = false;
      const dispatch = (): void => {
        if (dispatched) return;
        const request = Buffer.concat(chunks).toString('utf8');
        if (request === 'HELD\n') {
          dispatched = true;
          void sendFragmented(socket, heldResponse);
        } else if (request === 'HALF\n') {
          dispatched = true;
          waitForEnd = true;
        }
      };
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        dispatch();
      });
      socket.on('end', () => {
        dispatch();
        if (waitForEnd) void sendFragmented(socket, halfResponse, 75);
      });
    });
    const port = await reservePort();
    const relay = await relayModule.startRelayProfileForTest([endpoint(port, socketPath)]);
    cleanup.push(() => relay.close());

    await expect(exchange(port, 'HELD\n', { pauseMs: 100 })).resolves.toEqual(heldResponse);
    await expect(exchange(port, 'HALF\n', { halfClose: true })).resolves.toEqual(halfResponse);
    await waitUntil(() => relay.activeConnections === 0);
  });

  it('composes the real package proxy and relay for an exact held-open CONNECT denial', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ironcurtain-package-relay-composed-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    let authorizationAttempts = 0;
    let dialAttempts = 0;
    const proxy = createPackageEgressProxy({
      ca: loadOrCreateCA(join(directory, 'ca')),
      auditLogPath: join(directory, 'audit.jsonl'),
      resolver: async () => [],
      hostIdentityProvider: async () => [],
      nat64PrefixProvider: async () => [],
      testHooks: {
        dialSelectedAddress: async () => {
          dialAttempts += 1;
          throw new Error('forbidden CONNECT must not dial');
        },
        authorize: () => {
          authorizationAttempts += 1;
          throw new Error('forbidden CONNECT must not authorize');
        },
      },
    });
    const socketPath = join(directory, 'package.sock');
    await proxy.start(socketPath);
    cleanup.push(() => proxy.stop());
    const port = await reservePort();
    const relayEndpoint = {
      ...endpoint(port, socketPath),
      healthRequest: PACKAGE_EGRESS_HEALTH_REQUEST,
      healthBody: PACKAGE_EGRESS_HEALTH_BODY,
    };
    const relay = await relayModule.startRelayProfileForTest([relayEndpoint]);
    cleanup.push(() => relay.close());

    const response = await exchange(port, 'CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n', {
      maxBytes: 64 * 1024,
      pauseMs: 75,
    });
    expect(response.toString('ascii')).toBe(
      'HTTP/1.1 403 package egress CONNECT authority is not a fixed package host on port 443\r\n' +
        'Connection: close\r\nContent-Length: 0\r\n\r\n',
    );
    await waitUntil(
      () =>
        relay.activeConnections === 0 &&
        proxy.snapshot.activeClients === 0 &&
        proxy.snapshot.activeDirect === 0 &&
        proxy.snapshot.activeDerived === 0 &&
        proxy.snapshot.activeUpstreams === 0,
    );
    await expect(relayModule.probeEndpointForTest(relayEndpoint)).resolves.toBeUndefined();
    await waitUntil(
      () =>
        relay.activeConnections === 0 &&
        proxy.snapshot.activeClients === 0 &&
        proxy.snapshot.activeDirect === 0 &&
        proxy.snapshot.activeDerived === 0 &&
        proxy.snapshot.activeUpstreams === 0,
    );
    expect(proxy.snapshot).toMatchObject({
      attempts: 2,
      clientAttempts: 2,
      derivedAttempts: 0,
      activeClients: 0,
      activeDirect: 0,
      activeDerived: 0,
      activeUpstreams: 0,
    });
    expect({ authorizationAttempts, dialAttempts }).toEqual({ authorizationAttempts: 0, dialAttempts: 0 });
  });

  it('keeps a cleanly ended upstream accounted until the downstream flush closes', async () => {
    const bufferedResponse = Buffer.alloc(48 * 1024, 0x72);
    const { socketPath } = await fixture((socket) => {
      socket.once('data', () => socket.end(bufferedResponse, () => socket.destroy()));
    });
    const port = await reservePort();
    let downstreamEndRequested = false;
    const relay = await relayModule.startRelayProfileForTest([endpoint(port, socketPath)], {
      testHooks: {
        onAccepted(socket) {
          socket.end = () => {
            downstreamEndRequested = true;
            return socket;
          };
        },
      },
    });
    cleanup.push(() => relay.close());
    const client = createConnection({ host: LOOPBACK, port, allowHalfOpen: true });
    client.on('error', () => undefined);
    await once(client, 'connect');
    client.write('BUFFERED\n');
    client.pause();

    await waitUntil(() => downstreamEndRequested);
    expect(relay.activeConnections).toBe(1);

    const clientClosed = waitForClose(client);
    await relay.close();
    await clientClosed;
    expect(relay.activeConnections).toBe(0);
  });

  it('isolates concurrent connections and leaves the listener and UDS inode intact', async () => {
    const { socketPath } = await fixture((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        const request = Buffer.concat(chunks).toString('utf8');
        if (/^request:[0-9]+\n$/u.test(request)) socket.end(`response:${request.slice('request:'.length)}`);
      });
    });
    const originalSocket = lstatSync(socketPath);
    const port = await reservePort();
    const relay = await relayModule.startRelayProfileForTest([endpoint(port, socketPath)]);
    cleanup.push(() => relay.close());

    const responses = await Promise.all(
      Array.from({ length: 16 }, async (_unused, index) =>
        exchange(port, `request:${index}\n`, { halfClose: index % 2 === 0 }),
      ),
    );
    expect(responses.map((response) => response.toString('utf8'))).toEqual(
      Array.from({ length: 16 }, (_unused, index) => `response:${index}\n`),
    );
    await waitUntil(() => relay.activeConnections === 0);
    const currentSocket = lstatSync(socketPath);
    expect({ dev: currentSocket.dev, ino: currentSocket.ino, mode: currentSocket.mode }).toEqual({
      dev: originalSocket.dev,
      ino: originalSocket.ino,
      mode: originalSocket.mode,
    });
    await expect(exchange(port, 'request:99\n')).resolves.toEqual(Buffer.from('response:99\n'));
  });

  it('binds all listeners or rolls every listener back on a collision', async () => {
    const first = await fixture((socket) => socket.end());
    const second = await fixture((socket) => socket.end());
    const port = await reservePort();
    const collision = createServer();
    const collisionPort = await reservePort();
    await listen(collision, collisionPort);
    cleanup.push(() => closeServer(collision));

    await expect(
      relayModule.startRelayProfileForTest([
        endpoint(port, first.socketPath),
        endpoint(collisionPort, second.socketPath),
      ]),
    ).rejects.toBeDefined();

    const rebound = createServer();
    await expect(listen(rebound, port)).resolves.toBeUndefined();
    await closeServer(rebound);
  });

  it('rejects missing, symlinked, and replaced UDS identities without mutating them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ironcurtain-relay-invalid-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const port = await reservePort();
    await expect(
      relayModule.startRelayProfileForTest([endpoint(port, join(directory, 'missing.sock'))]),
    ).rejects.toThrow(/ENOENT/u);

    const real = await fixture((socket) => socket.end('old'));
    const symlinkPath = join(directory, 'linked.sock');
    symlinkSync(real.socketPath, symlinkPath);
    await expect(relayModule.startRelayProfileForTest([endpoint(port, symlinkPath)])).rejects.toThrow(
      'ironcurtain Apple VM egress relay socket-identity',
    );
    const parentSymlink = join(directory, 'linked-parent');
    symlinkSync(real.directory, parentSymlink, 'dir');
    await expect(
      relayModule.startRelayProfileForTest([endpoint(port, join(parentSymlink, 'relay.sock'))]),
    ).rejects.toThrow('ironcurtain Apple VM egress relay directory-identity');

    const replacementPort = await reservePort();
    const relay = await relayModule.startRelayProfileForTest([endpoint(replacementPort, real.socketPath)]);
    cleanup.push(() => relay.close());
    const movedPath = `${real.socketPath}.old`;
    renameSync(real.socketPath, movedPath);
    let replacementConnections = 0;
    const replacement = createServer((socket) => {
      replacementConnections += 1;
      socket.end('replacement');
    });
    await listen(replacement, real.socketPath);
    cleanup.push(() => closeServer(replacement));
    await expect(exchange(replacementPort, 'request', { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: 'ECONNRESET',
    });
    expect(replacementConnections).toBe(0);
  });

  it('enforces shared connection, byte, idle, and absolute bounds and drains on close', async () => {
    const { socketPath } = await fixture((socket) => {
      socket.on('error', () => undefined);
      socket.on('end', () => socket.end());
    });
    const port = await reservePort();
    const boundedEndpoint = endpoint(port, socketPath, {
      maxBytesEachDirection: 16,
      idleTimeoutMs: 50,
      absoluteTimeoutMs: 100,
      dialTimeoutMs: 50,
    });
    const relay = await relayModule.startRelayProfileForTest([boundedEndpoint], { maxConnections: 1 });
    cleanup.push(() => relay.close());

    const held = createConnection({ host: LOOPBACK, port });
    held.on('error', () => undefined);
    await once(held, 'connect');
    await waitUntil(() => relay.activeConnections === 1);
    const excess = createConnection({ host: LOOPBACK, port });
    excess.on('error', () => undefined);
    await waitForClose(excess);
    expect(relay.activeConnections).toBe(1);

    held.write(Buffer.alloc(17));
    await waitForClose(held);
    await waitUntil(() => relay.activeConnections === 0);

    const idle = createConnection({ host: LOOPBACK, port });
    idle.on('error', () => undefined);
    await once(idle, 'connect');
    await waitForClose(idle);
    await waitUntil(() => relay.activeConnections === 0);

    const draining = createConnection({ host: LOOPBACK, port });
    draining.on('error', () => undefined);
    await once(draining, 'connect');
    await waitUntil(() => relay.activeConnections === 1);
    const drainingClosed = waitForClose(draining);
    await relay.close();
    await drainingClosed;
    expect(relay.activeConnections).toBe(0);
    const refused = createConnection({ host: LOOPBACK, port });
    const refusal = once(refused, 'error');
    await expect(refusal).resolves.toMatchObject([{ code: 'ECONNREFUSED' }]);
  });

  it('bounds package lifetime without preempting a reused registry connection in one profile', async () => {
    const streamingFixture = async (): Promise<Awaited<ReturnType<typeof fixture>>> =>
      fixture((socket) => {
        const interval = setInterval(() => socket.write('.'), 20);
        socket.on('end', () => socket.end());
        socket.on('close', () => clearInterval(interval));
        socket.on('error', () => undefined);
      });
    const registry = await streamingFixture();
    const packageEgress = await streamingFixture();
    const registryPort = await reservePort();
    const packagePort = await reservePort();
    const registryEndpoint = endpoint(registryPort, registry.socketPath, {
      maxBytesEachDirection: 1024,
      idleTimeoutMs: 500,
      absoluteTimeoutMs: null,
      dialTimeoutMs: 50,
    });
    const packageEndpoint = endpoint(packagePort, packageEgress.socketPath, {
      maxBytesEachDirection: 1024,
      idleTimeoutMs: 500,
      absoluteTimeoutMs: 90,
      dialTimeoutMs: 50,
    });
    const relay = await relayModule.startRelayProfileForTest([registryEndpoint, packageEndpoint]);
    cleanup.push(() => relay.close());
    const registryClient = createConnection({ host: LOOPBACK, port: registryPort });
    const packageClient = createConnection({ host: LOOPBACK, port: packagePort });
    registryClient.on('error', () => undefined);
    packageClient.on('error', () => undefined);
    await Promise.all([once(registryClient, 'connect'), once(packageClient, 'connect')]);
    await waitUntil(() => relay.activeConnections === 2);

    await waitForClose(packageClient);
    expect(registryClient.destroyed).toBe(false);
    await waitUntil(() => relay.activeConnections === 1);
    const registryClosed = waitForClose(registryClient);
    await relay.close();
    await registryClosed;
    expect(relay.activeConnections).toBe(0);
  });

  it('strictly parses exact content-length or canonical chunked health responses', () => {
    const body = Buffer.from(HEALTH_BODY);
    const contentLength = Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n`),
      body,
    ]);
    const chunked = Buffer.from(
      `HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${HEALTH_BODY}\r\n0\r\n\r\n`,
    );
    expect(() => relayModule.parseHealthResponseForTest(contentLength, HEALTH_BODY)).not.toThrow();
    expect(() => relayModule.parseHealthResponseForTest(chunked, HEALTH_BODY)).not.toThrow();

    const highBitStatus = Buffer.from(contentLength);
    highBitStatus[0] |= 0x80;
    const highBitHeader = Buffer.from(contentLength);
    highBitHeader[highBitHeader.indexOf('Connection')] |= 0x80;
    const chunkSizeOffset = chunked.indexOf('\r\n\r\n') + 4;
    const highBitChunkSize = Buffer.from(chunked);
    highBitChunkSize[chunkSizeOffset] |= 0x80;
    const highBitChunkCrlf = Buffer.from(chunked);
    const chunkSizeLineEnd = chunked.indexOf('\r\n', chunkSizeOffset);
    const chunkDataCrlfOffset = chunkSizeLineEnd + 2 + body.length;
    highBitChunkCrlf[chunkDataCrlfOffset] |= 0x80;
    highBitChunkCrlf[chunkDataCrlfOffset + 1] |= 0x80;

    for (const malformed of [
      highBitStatus,
      highBitHeader,
      highBitChunkSize,
      highBitChunkCrlf,
      Buffer.from(`HTTP/1.1 500 Error\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n${HEALTH_BODY}`),
      Buffer.from(`HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n${HEALTH_BODY}`),
      Buffer.from(
        `HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ${body.length}\r\nTransfer-Encoding: chunked\r\n\r\n${HEALTH_BODY}`,
      ),
      Buffer.from(`HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ${body.length + 1}\r\n\r\n${HEALTH_BODY}`),
      Buffer.from(`HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: ${body.length}\r\n\r\n${HEALTH_BODY}`),
      Buffer.from(
        `HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)};x=1\r\n${HEALTH_BODY}\r\n0\r\n\r\n`,
      ),
    ]) {
      expect(() => relayModule.parseHealthResponseForTest(malformed, HEALTH_BODY)).toThrow();
    }
  });
});
