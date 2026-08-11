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

  it('admits a trusted host-configured private provider gateway without relaxing ordinary requests', async () => {
    const observed = new Promise<string | undefined>((resolve) => {
      const server = http.createServer((request, response) => {
        resolve(request.headers.host);
        response.end('gateway-ok');
      });
      servers.push(server);
    });
    const port = await listenTcp(servers[0]);
    const transport = createDirectOutboundTransport({
      lookup: stubLookup({ 'litellm.internal': '127.0.0.1' }),
    });

    await expect(
      requestBody(transport, {
        destination: { protocol: 'http:', hostname: 'litellm.internal', port },
        addressPolicy: 'trusted-provider-override',
        method: 'POST',
        path: '/v1/messages',
      }),
    ).resolves.toBe('gateway-ok');
    await expect(observed).resolves.toBe(`litellm.internal:${port}`);

    expect(() =>
      transport.request({
        destination: { protocol: 'http:', hostname: 'litellm.internal', port },
        method: 'POST',
        path: '/v1/messages',
      }),
    ).toThrow(/local|metadata/u);
  });

  it('keeps metadata destinations forbidden for trusted provider overrides', () => {
    const transport = createDirectOutboundTransport();
    for (const hostname of ['metadata.google.internal', '169.254.169.254']) {
      expect(() =>
        transport.request({
          destination: { protocol: 'http:', hostname, port: 80 },
          addressPolicy: 'trusted-provider-override',
          method: 'GET',
          path: '/',
        }),
      ).toThrow(/metadata|not allowed/u);
    }
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
    const transport = createParentProxyOutboundTransport({
      proxy: { socketPath },
      lookup: stubLookup({ 'packages.example.com': PUBLIC_ADDRESS }),
    });

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

  it('admits a trusted private provider gateway through a fixed parent without making it the default', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'outbound-private-parent-'));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, 'parent.sock');
    const observed = new Promise<string>((resolve) => {
      const server = http.createServer((request, response) => {
        resolve(request.url ?? '');
        response.end('parent-private-ok');
      });
      servers.push(server);
    });
    await listenUds(servers[0], socketPath);
    const transport = createParentProxyOutboundTransport({
      proxy: { socketPath },
      lookup: stubLookup({ 'litellm.internal': '10.20.30.40' }),
    });

    await expect(
      requestBody(transport, {
        destination: { protocol: 'http:', hostname: 'litellm.internal', port: 4000 },
        addressPolicy: 'trusted-provider-override',
        method: 'POST',
        path: '/v1/messages',
      }),
    ).resolves.toBe('parent-private-ok');
    await expect(observed).resolves.toBe('http://litellm.internal:4000/v1/messages');
  });

  it('reaches a TCP parent endpoint the same way as a UDS one', async () => {
    const observed = new Promise<string>((resolve) => {
      const server = http.createServer((request, response) => {
        resolve(request.url ?? '');
        response.end('tcp-parent-ok');
      });
      servers.push(server);
    });
    const port = await listenTcp(servers[0]);
    const transport = createParentProxyOutboundTransport({
      proxy: { hostname: '127.0.0.1', port },
      lookup: stubLookup({ 'packages.example.com': PUBLIC_ADDRESS }),
    });

    await expect(
      requestBody(transport, {
        destination: { protocol: 'http:', hostname: 'packages.example.com', port: 8080 },
        method: 'GET',
        path: '/artifact',
      }),
    ).resolves.toBe('tcp-parent-ok');
    await expect(observed).resolves.toBe('http://packages.example.com:8080/artifact');
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
    const transport = createParentProxyOutboundTransport({
      proxy: { socketPath },
      lookup: stubLookup({ 'api.example.com': PUBLIC_ADDRESS }),
    });
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
    const transport = createParentProxyOutboundTransport({
      proxy: { socketPath: join(directory, 'absent.sock') },
      lookup: stubLookup({ 'example.com': PUBLIC_ADDRESS }),
    });
    const request = transport.request({
      destination: { protocol: 'http:', hostname: 'example.com', port: 80 },
      method: 'GET',
      path: '/',
    });
    const error = new Promise<Error>((resolve) => request.once('error', resolve));
    request.end();
    await expect(error).resolves.toBeInstanceOf(Error);
  });

  it('rejects local, metadata, and private literal destinations before I/O', () => {
    const transport = createParentProxyOutboundTransport({ proxy: { socketPath: '/tmp/not-contacted.sock' } });
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

  it('refuses a name resolving to a non-public address before writing a CONNECT authority to the parent', async () => {
    const parent = await startCountingParent('outbound-connect-ssrf-');
    const transport = createParentProxyOutboundTransport({
      proxy: { socketPath: parent.socketPath },
      lookup: stubLookup({ 'cdn.evil.test': METADATA_ADDRESS }),
    });

    const request = transport.request({
      destination: { protocol: 'https:', hostname: 'cdn.evil.test', port: 443 },
      method: 'GET',
      path: '/',
    });
    const error = new Promise<Error>((resolve) => request.once('error', resolve));
    request.end();

    await expect(error).resolves.toMatchObject({ message: expect.stringContaining('non-public address') });
    // The refusal happens in the child, so the parent is never even dialed —
    // the destination never becomes a CONNECT authority it could act on.
    expect(parent.connections()).toBe(0);
  });

  it('applies the same guarded resolution to the plain-HTTP branch', async () => {
    const parent = await startCountingParent('outbound-http-ssrf-');
    const transport = createParentProxyOutboundTransport({
      proxy: { socketPath: parent.socketPath },
      lookup: stubLookup({ 'cdn.evil.test': METADATA_ADDRESS }),
    });

    const request = transport.request({
      destination: { protocol: 'http:', hostname: 'cdn.evil.test', port: 80 },
      method: 'GET',
      path: '/layer',
    });
    const error = new Promise<Error>((resolve) => request.once('error', resolve));
    request.end();

    await expect(error).resolves.toMatchObject({ message: expect.stringContaining('non-public address') });
    expect(parent.connections()).toBe(0);
  });
});

/**
 * Regression guard for the property the registry-egress redirect follower
 * depends on: an attacker-chosen `Location` is refused identically no matter
 * which transport carries the exchange, so nested mode cannot become the weaker
 * of the two.
 */
describe('derived-redirect refusal symmetry', () => {
  const location = 'https://cdn.evil.test/layer';

  it.each(['direct', 'fixed-parent-proxy'] as const)(
    'refuses the redirect target on the %s transport',
    async (kind) => {
      const directory = mkdtempSync(join(tmpdir(), 'outbound-symmetry-'));
      temporaryDirectories.push(directory);
      const lookup = stubLookup({ 'cdn.evil.test': METADATA_ADDRESS });
      const transport: OutboundTransport =
        kind === 'direct'
          ? createDirectOutboundTransport({ lookup })
          : createParentProxyOutboundTransport({ proxy: { socketPath: join(directory, 'absent.sock') }, lookup });
      expect(transport.addressGuard).toBe('local-resolver');

      const target = new URL(location);
      const request = transport.request({
        destination: { protocol: 'https:', hostname: target.hostname, port: 443 },
        method: 'GET',
        path: target.pathname,
      });
      const error = new Promise<Error>((resolve) => request.once('error', resolve));
      request.end();
      await expect(error).resolves.toMatchObject({ message: expect.stringContaining('non-public address') });
    },
  );
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

/** A routable documentation address; passes the address policy. */
const PUBLIC_ADDRESS = '93.184.216.34';
/** The cloud metadata service — the canonical SSRF rebinding target. */
const METADATA_ADDRESS = '169.254.169.254';

/** Resolver stub so a fixture screens a real name without touching real DNS. */
function stubLookup(answers: Readonly<Record<string, string | undefined>>): typeof dns.lookup {
  return ((
    hostname: string,
    options: dns.LookupOptions,
    callback: (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
  ): void => {
    const address = answers[hostname];
    if (address === undefined) {
      const error: NodeJS.ErrnoException = new Error(`no stub DNS answer for ${hostname}`);
      error.code = 'ENOTFOUND';
      callback(error, []);
      return;
    }
    const family = address.includes(':') ? 6 : 4;
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as typeof dns.lookup;
}

interface CountingParent {
  readonly socketPath: string;
  /** How many times the parent was dialed at all (0 proves a pre-I/O refusal). */
  connections(): number;
}

/** A parent proxy that only counts connections; it must never be reached. */
async function startCountingParent(prefix: string): Promise<CountingParent> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, 'parent.sock');
  let connections = 0;
  const server = http.createServer();
  server.on('connection', () => {
    connections += 1;
  });
  servers.push(server);
  await listenUds(server, socketPath);
  return { socketPath, connections: () => connections };
}

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
