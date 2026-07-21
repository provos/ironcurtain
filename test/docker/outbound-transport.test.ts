import { afterEach, describe, expect, it } from 'vitest';
import * as dns from 'node:dns';
import * as http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDirectOutboundTransport,
  createParentProxyOutboundTransport,
  isPublicAddress,
  type OutboundTransport,
} from '../../src/docker/outbound-transport.js';

const servers: http.Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('direct destination-bound transport', () => {
  it('owns Host and strips proxy credentials while preserving the origin-form path', async () => {
    const observed = new Promise<{ url: string; host?: string; proxyAuthorization?: string }>((resolve) => {
      const server = http.createServer((request, response) => {
        resolve({
          url: request.url ?? '',
          host: request.headers.host,
          proxyAuthorization: request.headers['proxy-authorization'],
        });
        response.end('ok');
      });
      servers.push(server);
    });
    const server = servers[0];
    const port = await listenTcp(server);
    const transport = createDirectOutboundTransport({ allowPrivateDestinationsForTests: true });

    const response = requestBody(transport, {
      destination: { protocol: 'http:', hostname: '127.0.0.1', port },
      method: 'GET',
      path: '/provider?x=1',
      headers: { host: 'attacker.invalid', 'proxy-authorization': 'secret', 'x-test': 'yes' },
    });

    await expect(response).resolves.toBe('ok');
    await expect(observed).resolves.toEqual({ url: '/provider?x=1', host: `127.0.0.1:${port}` });
  });

  it('rejects local, metadata, and private literal destinations before I/O', () => {
    const transport = createDirectOutboundTransport();
    for (const hostname of ['localhost', 'metadata.google.internal', '127.0.0.1', '169.254.169.254', '10.0.0.1']) {
      expect(() =>
        transport.request({
          destination: { protocol: 'https:', hostname, port: 443 },
          method: 'GET',
          path: '/',
        }),
      ).toThrow(/local|metadata|not public/u);
    }
  });

  it('rejects a DNS answer set containing any private rebinding address', async () => {
    const lookup = ((
      _hostname: string,
      _options: dns.LookupAllOptions,
      callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
    ) =>
      callback(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.4', family: 4 },
      ])) as typeof dns.lookup;
    const transport = createDirectOutboundTransport({ lookup });
    const request = transport.request({
      destination: { protocol: 'https:', hostname: 'example.com', port: 443 },
      method: 'GET',
      path: '/',
    });
    const error = new Promise<Error>((resolve) => request.once('error', resolve));
    request.end();
    await expect(error).resolves.toMatchObject({ message: expect.stringContaining('non-public address') });
  });

  it('rejects absolute-form paths and header injection', () => {
    const transport = createDirectOutboundTransport();
    expect(() =>
      transport.request({
        destination: { protocol: 'https:', hostname: 'example.com', port: 443 },
        method: 'GET',
        path: '//attacker.invalid/',
      }),
    ).toThrow(/origin-form/u);
    expect(() =>
      transport.request({
        destination: { protocol: 'https:', hostname: 'example.com', port: 443 },
        method: 'GET',
        path: '/',
        headers: { 'x-test': 'ok\r\ninjected: yes' },
      }),
    ).toThrow(/invalid outbound header/u);
    expect(() =>
      transport.request({
        destination: { protocol: 'https:', hostname: 'example.com', port: 443 },
        method: 'GET',
        path: '/',
        headers: { 'x-test': ['ok', 'bad\r\ninjected: yes'] },
      }),
    ).toThrow(/invalid outbound header/u);
  });

  it('does not expose CONNECT to callers', () => {
    const transport = createParentProxyOutboundTransport({ proxy: { socketPath: '/tmp/not-contacted.sock' } });
    expect(() =>
      transport.request({
        destination: { protocol: 'http:', hostname: 'example.com', port: 80 },
        method: 'CONNECT',
        path: '/',
      }),
    ).toThrow(/does not expose generic CONNECT/u);
  });
});

describe('fixed parent proxy transport', () => {
  it('sends HTTP in absolute form to one fixed UDS while preserving destination Host', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'outbound-parent-'));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, 'parent.sock');
    const observed = new Promise<{ url: string; host?: string }>((resolve) => {
      const server = http.createServer((request, response) => {
        resolve({ url: request.url ?? '', host: request.headers.host });
        response.end('parent-ok');
      });
      servers.push(server);
    });
    await listenUds(servers[0], socketPath);
    const transport = createParentProxyOutboundTransport({ proxy: { socketPath } });

    await expect(
      requestBody(transport, {
        destination: { protocol: 'http:', hostname: 'packages.example.com', port: 8080 },
        method: 'GET',
        path: '/artifact?id=1',
        headers: { host: 'attacker.invalid' },
      }),
    ).resolves.toBe('parent-ok');
    await expect(observed).resolves.toEqual({
      url: 'http://packages.example.com:8080/artifact?id=1',
      host: 'packages.example.com:8080',
    });
  });

  it('uses CONNECT for HTTPS and surfaces parent refusal without direct fallback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'outbound-connect-'));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, 'parent.sock');
    const authority = new Promise<string>((resolve) => {
      const server = http.createServer();
      server.on('connect', (request, socket) => {
        resolve(request.url ?? '');
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      });
      servers.push(server);
    });
    await listenUds(servers[0], socketPath);
    const transport = createParentProxyOutboundTransport({ proxy: { socketPath } });
    const request = transport.request({
      destination: { protocol: 'https:', hostname: 'api.example.com', port: 443 },
      method: 'POST',
      path: '/v1/messages',
    });
    const error = new Promise<Error>((resolve) => request.once('error', resolve));
    request.end();

    await expect(authority).resolves.toBe('api.example.com:443');
    await expect(error).resolves.toMatchObject({ message: expect.stringContaining('refused api.example.com:443') });
  });

  it('fails closed when its exact UDS relay is absent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'outbound-loss-'));
    temporaryDirectories.push(directory);
    const transport = createParentProxyOutboundTransport({ proxy: { socketPath: join(directory, 'absent.sock') } });
    const request = transport.request({
      destination: { protocol: 'http:', hostname: 'example.com', port: 80 },
      method: 'GET',
      path: '/',
    });
    const error = new Promise<Error>((resolve) => request.once('error', resolve));
    request.end();
    await expect(error).resolves.toBeInstanceOf(Error);
  });
});

describe('address classification', () => {
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('accepts public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(['0.0.0.0', '127.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fe80::1', 'fd00::1'])(
    'rejects non-public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );
});

function requestBody(
  transport: OutboundTransport,
  request: Parameters<OutboundTransport['request']>[0],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const outgoing = transport.request(request, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

function listenTcp(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('TCP server did not bind'));
      else resolve(address.port);
    });
  });
}

function listenUds(server: http.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}
