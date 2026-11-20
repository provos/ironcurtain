import * as http from 'node:http';
import * as net from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { loadOrCreateCA, type CertificateAuthority } from '../../src/docker/ca.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import { createDirectOutboundTransport, type OutboundTransport } from '../../src/docker/outbound-transport.js';
import { localhostDnsLookup, sendConnect } from '../helpers/mitm-tls-harness.js';

const domain = 'dynamic.test';
const staticDomain = 'provider.test';
const echo = 'tunnel data';
const proxyHeaders = { 'proxy-authorization': 'Basic fixture-proxy-credential' };
const upgradeHeaders = {
  upgrade: 'websocket',
  connection: 'Upgrade',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'sec-websocket-version': '13',
};

const protocols = ['HTTP', 'CONNECT', 'WebSocket'] as const;
type Protocol = (typeof protocols)[number];

function echoSocket(socket: Duplex): void {
  socket.on('error', () => {});
  socket.pipe(socket);
}

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

describe('MITM dynamic domain and tunnel model', () => {
  let dir: string;
  let ca: CertificateAuthority;
  let socketPath: string;
  let proxy: MitmProxy;
  let transport: OutboundTransport;
  let httpServer: http.Server;
  let tcpServer: net.Server;
  let ports: Record<Protocol, number>;
  let upgrades: 'accept' | 'hold' | 'decline';
  let declinedSocket: Duplex | undefined;
  const clients = new Set<net.Socket>();
  const upstreamSockets = new Set<net.Socket>();
  let hits: Record<Protocol, number>;

  function trackSocket(socket: net.Socket, sockets: Set<net.Socket>): void {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  }

  beforeAll(() => {
    vi.stubEnv('IRONCURTAIN_MITM_ALLOW_ALL_HOSTS', '');
    dir = mkdtempSync(join(tmpdir(), 'mitm-domain-model-'));
    socketPath = join(dir, 'mitm.sock');
    ca = loadOrCreateCA(join(dir, 'ca'));
  });

  beforeEach(async () => {
    hits = { HTTP: 0, CONNECT: 0, WebSocket: 0 };
    upgrades = 'accept';
    declinedSocket = undefined;
    httpServer = http.createServer((_req, res) => {
      hits.HTTP++;
      res.setHeader('Connection', 'close');
      res.end(echo);
    });
    httpServer.on('connection', (socket) => trackSocket(socket, upstreamSockets));
    httpServer.on('upgrade', (_req, socket) => {
      hits.WebSocket++;
      if (upgrades !== 'accept') {
        socket.on('end', () => socket.end());
        socket.resume();
        if (upgrades === 'decline') {
          // Hold the body open after declining the upgrade.
          declinedSocket = socket;
          socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 10\r\nConnection: close\r\n\r\nwait');
        }
        return;
      }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n',
      );
      echoSocket(socket);
    });
    tcpServer = net.createServer((socket) => {
      hits.CONNECT++;
      trackSocket(socket, upstreamSockets);
      echoSocket(socket);
    });
    const [httpPort, tcpPort] = await Promise.all([listen(httpServer), listen(tcpServer)]);
    ports = { HTTP: httpPort, CONNECT: tcpPort, WebSocket: httpPort };

    transport = createDirectOutboundTransport({
      lookup: localhostDnsLookup as typeof import('node:dns').lookup,
      allowPrivateDestinationsForTests: true,
    });
    proxy = createMitmProxy({
      socketPath,
      ca,
      dnsLookup: localhostDnsLookup,
      allowPrivateDestinationsForTests: true,
      requiredProxyAuthorization: proxyHeaders['proxy-authorization'],
      outboundTransport: transport,
      providers: [
        {
          config: {
            host: staticDomain,
            displayName: 'Static provider',
            allowedEndpoints: [],
            keyInjection: { type: 'bearer' },
            fakeKeyPrefix: 'sentinel-',
          },
          fakeKey: 'sentinel-model',
          realKey: 'model-key',
        },
      ],
    });
    await proxy.start();
  });

  afterEach(async () => {
    for (const socket of clients) socket.destroy();
    transport.destroy?.();
    await proxy.stop();
    for (const socket of upstreamSockets) socket.destroy();
    await Promise.all(
      [httpServer, tcpServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function open(protocol: Protocol, hostname: string): Promise<{ statusCode: number; socket?: net.Socket }> {
    const port = ports[protocol];
    if (protocol === 'CONNECT') {
      const { statusCode, socket } = await sendConnect(socketPath, hostname, port, proxyHeaders);
      if (socket) trackSocket(socket, clients);
      return { statusCode, socket: socket ?? undefined };
    }
    return await new Promise((resolve, reject) => {
      const req = http.get(
        {
          socketPath,
          agent: false,
          path: `http://${hostname}:${port}/echo`,
          headers: protocol === 'WebSocket' ? { ...proxyHeaders, ...upgradeHeaders } : proxyHeaders,
        },
        (res) => {
          res.setEncoding('utf8');
          let body = '';
          res.on('data', (chunk: string) => (body += chunk));
          res.on('error', reject);
          res.on('end', () => {
            if (res.statusCode === 200 && body !== echo) {
              reject(new Error(`Unexpected upstream response: ${body}`));
            } else {
              resolve({ statusCode: res.statusCode ?? 0 });
            }
          });
        },
      );
      req.on('upgrade', (res, socket) => {
        trackSocket(socket, clients);
        resolve({ socket, statusCode: res.statusCode ?? 0 });
      });
      req.on('error', reject);
    });
  }

  async function assertEcho(socket: net.Socket): Promise<void> {
    let reply = '';
    socket.write(echo);
    for await (const chunk of socket.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
      reply += chunk.toString();
      if (reply.length >= echo.length) break;
    }
    socket.resume();
    expect(reply).toBe(echo);
  }

  const traces = protocols.flatMap((protocol) => [false, true].map((uppercase) => ({ protocol, uppercase })));

  it.each(traces)(
    '$protocol authorization follows add/remove/re-add (uppercase=$uppercase)',
    async ({ protocol, uppercase }) => {
      const updateName = uppercase ? domain.toUpperCase() : domain;
      const otherCase = uppercase ? domain : domain.toUpperCase();
      let allowed = false;
      let expectedHits = 0;

      async function connect() {
        const { statusCode, socket } = await open(protocol, otherCase);
        expect(statusCode).toBe(allowed ? (protocol === 'WebSocket' ? 101 : 200) : 403);
        if (socket && allowed) await assertEcho(socket);
        if (socket && !allowed) socket.destroy();
        if (allowed) expectedHits++;
        expect(hits[protocol]).toBe(expectedHits);
        return allowed ? socket : undefined;
      }

      expect(proxy.hosts.addHost(staticDomain.toUpperCase())).toBe(false);
      expect(proxy.hosts.removeHost(staticDomain)).toBe(false);
      await connect();

      expect(proxy.hosts.addHost(updateName)).toBe(true);
      allowed = true;
      expect(proxy.hosts.addHost(otherCase)).toBe(false);
      expect(proxy.hosts.listHosts()).toMatchObject({ providers: [staticDomain], dynamic: [domain] });
      const established = await connect();

      expect(proxy.hosts.removeHost(updateName)).toBe(true);
      allowed = false;
      expect(proxy.hosts.removeHost(otherCase)).toBe(false);
      await connect();
      // Removal applies to new opens. A tunnel that was already admitted still carries bytes.
      if (established) await assertEcho(established);

      expect(proxy.hosts.addHost(otherCase)).toBe(true);
      allowed = true;
      await connect();

      await proxy.stop();
      await expect.poll(() => clients.size).toBe(0);
      await expect.poll(() => upstreamSockets.size).toBe(0);
    },
  );

  const incompleteUpgrades = [
    { phase: 'hold', action: 'disconnect' },
    { phase: 'hold', action: 'stop' },
    { phase: 'decline', action: 'stop' },
    { phase: 'denied', action: 'stop' },
    { phase: 'missing CONNECT auth', action: 'stop' },
  ] as const;

  function writeUpgradeRequest(client: net.Socket): void {
    const headers = Object.entries({ ...upgradeHeaders, ...proxyHeaders })
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join('');
    client.write(`GET http://${domain}:${ports.WebSocket}/echo HTTP/1.1\r\nHost: ${domain}\r\n${headers}\r\n`);
  }

  it('finishes a refused WebSocket response after the client half-closes', async () => {
    upgrades = 'decline';
    expect(proxy.hosts.addHost(domain)).toBe(true);
    const client = net.createConnection(socketPath);
    trackSocket(client, clients);
    await once(client, 'connect');
    const closed = once(client, 'close');
    let response = '';
    client.setEncoding('utf8').on('data', (chunk: string) => {
      response += chunk;
    });
    writeUpgradeRequest(client);
    await expect.poll(() => response).toContain('\r\n\r\nwait');
    await new Promise<void>((resolve) => client.end(resolve));
    // Let the proxy service another request while the refusal stays open.
    expect((await open('HTTP', domain)).statusCode).toBe(200);
    declinedSocket?.end(' more!');
    await closed;
    expect(response.split('\r\n\r\n')[1]).toBe('wait more!');
  });

  it.each(incompleteUpgrades)('closes an unfinished proxy request on $action ($phase)', async ({ phase, action }) => {
    const denied = phase === 'denied' || phase === 'missing CONNECT auth';
    if (!denied) {
      upgrades = phase;
      expect(proxy.hosts.addHost(domain)).toBe(true);
    }
    const client = net.createConnection({ path: socketPath, allowHalfOpen: denied });
    trackSocket(client, clients);
    await once(client, 'connect');
    let response = '';
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      response += chunk;
    });
    if (phase === 'missing CONNECT auth') {
      client.write(`CONNECT ${domain}:${ports.CONNECT} HTTP/1.1\r\nHost: ${domain}\r\n\r\n`);
    } else {
      writeUpgradeRequest(client);
    }
    if (denied) {
      await expect.poll(() => response).toContain(phase === 'denied' ? '403 Forbidden' : '407 Proxy Authentication');
      expect(hits).toEqual({ HTTP: 0, CONNECT: 0, WebSocket: 0 });
    } else {
      await expect.poll(() => hits.WebSocket).toBe(1);
      if (phase === 'decline') await expect.poll(() => response).toContain('\r\n\r\nwait');
    }

    if (action === 'disconnect') client.destroy();
    let finished = false;
    const stopped =
      action === 'stop'
        ? proxy.stop().then(() => {
            finished = true;
          })
        : undefined;
    try {
      if (stopped) await expect.poll(() => finished).toBe(true);
      if (!denied) await expect.poll(() => clients.size).toBe(0);
      await expect.poll(() => upstreamSockets.size).toBe(0);
    } finally {
      // Release the fixture even if stop missed one side of the request.
      client.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      await stopped;
    }
  });
});
