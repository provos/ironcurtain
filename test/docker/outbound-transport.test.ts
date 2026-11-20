import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDirectOutboundTransport,
  createParentProxyOutboundTransport,
  createGuardedLookup,
  assertHostnameIsEligible,
  isPublicAddress,
  type OutboundTransport,
} from '../../src/docker/outbound-transport.js';
import {
  createTlsIdentity,
  startFakeParentProxy,
  type ParentRoute,
  type TlsIdentity,
} from '../helpers/fake-parent-proxy.js';

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
  it('destroys idle pooled upstream sockets without waiting for their timeout', async () => {
    const connections = new Set<Socket>();
    const server = http.createServer((_req, res) => res.end('pooled-ok'));
    server.keepAliveTimeout = 60_000;
    server.on('connection', (socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    });
    servers.push(server);
    const port = await listenTcp(server);
    const transport = createDirectOutboundTransport({ lookup: stubLookup({ 'linux.localdomain': '127.0.0.1' }) });
    try {
      await expect(
        requestBody(transport, {
          destination: { protocol: 'http:', hostname: 'linux.localdomain', port },
          addressPolicy: 'approved-private-network',
          method: 'GET',
          path: '/',
        }),
      ).resolves.toBe('pooled-ok');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(connections.size).toBe(1);
      transport.destroy?.();
      await vi.waitFor(() => expect(connections.size).toBe(0), { timeout: 1_000 });
      transport.destroy?.(); // Destruction is safe to repeat during cleanup.
    } finally {
      transport.destroy?.();
    }
  });

  it('allows an explicitly authorized private passthrough without relaxing other requests', async () => {
    const server = http.createServer((_req, res) => res.end('private-ok'));
    servers.push(server);
    const port = await listenTcp(server);
    const transport = createDirectOutboundTransport({ lookup: stubLookup({ 'linux.localdomain': '127.0.0.1' }) });
    await expect(
      requestBody(transport, {
        destination: { protocol: 'http:', hostname: 'linux.localdomain', port },
        addressPolicy: 'approved-private-network',
        method: 'GET',
        path: '/',
      }),
    ).resolves.toBe('private-ok');
    await expect(
      requestBody(transport, {
        destination: { protocol: 'http:', hostname: 'linux.localdomain', port },
        method: 'GET',
        path: '/',
      }),
    ).rejects.toThrow(/non-public/u);
  });

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

describe('destination policy model', () => {
  const hostname = 'outbound-model.test';
  const protocols = ['http:', 'https:'] as const;
  const privatePolicies = ['approved-private-network', 'trusted-provider-override'] as const;
  let identity: TlsIdentity;

  beforeAll(() => {
    identity = createTlsIdentity([hostname]);
  });

  const deniedDns = [
    { state: 'private answer', records: '127.0.0.1', error: /non-public/u },
    {
      state: 'dual-stack private answers',
      records: [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ],
      error: /non-public/u,
    },
    { state: 'missing answer', records: undefined, error: /no stub DNS answer/u },
  ];
  const directTraces = protocols.flatMap((protocol) =>
    privatePolicies.flatMap((policy) => deniedDns.map((dnsState) => ({ protocol, policy, dnsState }))),
  );

  it.each(directTraces)(
    'keeps the direct $protocol pool isolated after $policy with $dnsState.state',
    async ({ protocol, policy, dnsState }) => {
      const received: Socket[] = [];
      const serve: http.RequestListener = (request, response) => {
        received.push(request.socket);
        response.end('direct-ok');
      };
      const server =
        protocol === 'https:'
          ? https.createServer({ key: identity.keyPem, cert: identity.certPem }, serve)
          : http.createServer(serve);
      let connections = 0;
      server.on('connection', () => {
        connections += 1;
      });
      servers.push(server);
      const port = await listenTcp(server);
      const answers: Record<string, string | dns.LookupAddress[] | undefined> = { [hostname]: '127.0.0.1' };
      const transport = createDirectOutboundTransport({ lookup: stubLookup(answers) });
      const connect = https.Agent.prototype.createConnection;
      // Trust only the fixture certificate while keeping the real TLS agent and pool.
      const trustFixture =
        protocol === 'https:'
          ? vi.spyOn(https.Agent.prototype, 'createConnection').mockImplementation(function (
              this: https.Agent,
              options,
              callback,
            ) {
              const tlsOptions = { ...options, ca: identity.certPem };
              return connect.call(this, tlsOptions, callback);
            })
          : undefined;
      const destination = { protocol, hostname, port };

      try {
        const privateRequest = { destination, addressPolicy: policy, method: 'GET', path: '/private' } as const;
        await expect(requestBody(transport, privateRequest)).resolves.toBe('direct-ok');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(received).toHaveLength(1);
        expect(connections).toBe(1);

        answers[hostname] = dnsState.records;
        await expect(
          requestBody(transport, { destination, addressPolicy: 'public-only', method: 'GET', path: '/public' }),
        ).rejects.toThrow(dnsState.error);
        expect(received).toHaveLength(1);
        expect(connections).toBe(1);

        answers[hostname] = '127.0.0.1';
        await expect(requestBody(transport, privateRequest)).resolves.toBe('direct-ok');
        expect(received).toHaveLength(2);
        expect(received[1]).toBe(received[0]);
        expect(connections).toBe(1);
      } finally {
        transport.destroy?.();
        trustFixture?.mockRestore();
      }
    },
  );

  const parentTraces = protocols.flatMap((protocol) =>
    privatePolicies.flatMap((policy) => ['refuses', 'disappears'].map((fault) => ({ protocol, policy, fault }))),
  );

  it.each(parentTraces)(
    'keeps $protocol through the fixed parent under $policy when the parent $fault',
    async ({ protocol, policy, fault }) => {
      const directory = mkdtempSync(join(tmpdir(), 'outbound-model-'));
      temporaryDirectories.push(directory);
      const socketPath = join(directory, 'parent.sock');
      const destination = { protocol, hostname, port: protocol === 'https:' ? 443 : 80 };
      const paths: string[] = [];
      const serve: ParentRoute = (request, response) => {
        paths.push(request.url ?? '');
        response.end('parent-ok');
      };
      const routes: Record<string, ParentRoute | undefined> = { [hostname]: serve };
      const startParent = () =>
        startFakeParentProxy({
          socketPath,
          identity,
          routes,
          httpRoute(request, response) {
            if (routes[hostname] === undefined) {
              response.writeHead(403).end('parent-refused');
              return;
            }
            serve(request, response);
          },
        });
      let parent: Awaited<ReturnType<typeof startParent>> | undefined = await startParent();
      const answers: Record<string, string | dns.LookupAddress[]> = { [hostname]: '127.0.0.1' };
      const transport = createParentProxyOutboundTransport({
        proxy: { socketPath },
        ca: identity.certPem,
        lookup: stubLookup(answers),
      });
      const dials: string[] = [];
      const connect = Socket.prototype.connect;
      const connectSpy = vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (
        this: Socket,
        ...args: unknown[]
      ) {
        // net.connect can hand Socket.connect an already-normalized argument tuple.
        const endpoint: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
        if (
          typeof endpoint !== 'object' ||
          endpoint === null ||
          !('path' in endpoint) ||
          endpoint.path !== socketPath
        ) {
          dials.push('direct');
          throw new Error('unexpected direct connection in the fixed-parent model');
        }
        dials.push('parent');
        return Reflect.apply(connect, this, args) as Socket;
      });

      try {
        const request = (addressPolicy: typeof policy | 'public-only') =>
          requestResponse(transport, { destination, addressPolicy, method: 'GET', path: '/probe' });
        const expectedPath = protocol === 'http:' ? `http://${hostname}/probe` : '/probe';
        const success = { status: 200, body: 'parent-ok' };
        await expect(request(policy)).resolves.toEqual(success);
        expect(dials).toEqual(['parent']);
        expect(paths).toEqual([expectedPath]);
        expect(parent.connectAuthorities).toEqual(protocol === 'https:' ? [`${hostname}:443`] : []);

        // A plausible public answer does not authorize the accompanying private answer.
        answers[hostname] = [
          { address: PUBLIC_ADDRESS, family: 4 },
          { address: '127.0.0.1', family: 4 },
        ];
        await expect(request('public-only')).rejects.toThrow(/non-public/u);
        expect(dials).toEqual(['parent']);
        expect(parent.connections).toBe(1);
        expect(paths).toEqual([expectedPath]);

        answers[hostname] = PUBLIC_ADDRESS;
        await expect(request('public-only')).resolves.toEqual(success);
        expect(dials).toEqual(['parent', 'parent']);
        expect(paths).toEqual([expectedPath, expectedPath]);

        if (fault === 'refuses') {
          delete routes[hostname];
          if (protocol === 'https:') await expect(request(policy)).rejects.toThrow(/fixed parent proxy refused/u);
          else await expect(request(policy)).resolves.toEqual({ status: 403, body: 'parent-refused' });
        } else {
          await parent.close();
          parent = undefined;
          await expect(request(policy)).rejects.toThrow(/ENOENT|ECONNREFUSED/u);
        }
        expect(dials).toEqual(['parent', 'parent', 'parent']);
        expect(paths).toEqual([expectedPath, expectedPath]);

        routes[hostname] = serve;
        parent ??= await startParent();
        await expect(request(policy)).resolves.toEqual(success);
        expect(dials).toEqual(['parent', 'parent', 'parent', 'parent']);
        expect(paths).toEqual([expectedPath, expectedPath, expectedPath]);
      } finally {
        connectSpy.mockRestore();
        await parent?.close();
      }
    },
  );
});

describe('address classification', () => {
  it.each([false, true])('screens trailing-dot literals consistently with private access=%s', async (allowPrivate) => {
    for (const hostname of ['169.254.169.254.', '169.254.1.2.', '100.100.100.200.', 'fd00:ec2::254.', 'fe80::1.']) {
      expect(() => assertHostnameIsEligible(hostname, allowPrivate)).toThrow(/not public|not allowed/u);
      // No DNS answer can turn a denied literal into an allowed destination.
      const dnsFixture = { lookup: stubLookup({ [hostname]: '8.8.8.8' }) };
      const resolver = vi.spyOn(dnsFixture, 'lookup');
      const result = new Promise((resolve, reject) => {
        createGuardedLookup(dnsFixture.lookup, allowPrivate)(hostname, { all: true }, (err, answers) => {
          if (err) reject(err);
          else resolve(answers);
        });
      });
      await expect(result).rejects.toThrow(/not public|not allowed/u);
      expect(resolver).not.toHaveBeenCalled();
    }
    expect(() => assertHostnameIsEligible('8.8.8.8.', allowPrivate)).not.toThrow();
    for (const hostname of ['192.168.1.10.', '127.0.0.1.', '::1.', '100.64.0.1.', 'fd12::1.']) {
      if (allowPrivate) expect(() => assertHostnameIsEligible(hostname, allowPrivate)).not.toThrow();
      else expect(() => assertHostnameIsEligible(hostname, allowPrivate)).toThrow(/not public/u);
    }
  });

  it.each(['0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:c0a8:101', '::ffff:192.168.1.1', 'fe80:0:0:0::1', '2001:0db8::1'])(
    'rejects equivalent non-public IPv6 address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );

  it.each([
    '192.168.1.10',
    '10.1.2.3',
    '172.16.0.1',
    '100.64.0.1',
    'fd12::1',
    '::ffff:192.168.1.10',
    '0:0:0:0:0:ffff:c0a8:10a',
  ])('permits private answer %s only when enabled', async (address) => {
    const resolver = stubLookup({ 'linux.localdomain': address });
    const lookup = (enabled: boolean) =>
      new Promise((resolve, reject) => {
        createGuardedLookup(resolver, enabled)('linux.localdomain', { all: true }, (err, answers) => {
          if (err) reject(err);
          else resolve(answers);
        });
      });
    await expect(lookup(false)).rejects.toThrow(/non-public/u);
    await expect(lookup(true)).resolves.toEqual([{ address, family: address.includes(':') ? 6 : 4 }]);
  });

  it.each([
    '169.254.169.254',
    '169.254.1.2',
    'fe80::1',
    'fe80:0:0:0:0:0:0:1',
    '100.100.100.200',
    'fd00:ec2::254',
    'fd00:0ec2:0:0:0:0:0:0254',
    '::ffff:169.254.169.254',
    '::ffff:6464:64c8',
    '0.0.0.0',
    '224.0.0.1',
    '2001:db8::1',
  ])('keeps metadata/link-local/reserved address %s blocked when private access is enabled', async (address) => {
    expect(() => assertHostnameIsEligible(address, true)).toThrow(/not allowed/u);
    const resolver = stubLookup({ 'linux.localdomain': address });
    const result = new Promise((resolve, reject) => {
      createGuardedLookup(resolver, true)('linux.localdomain', { all: true }, (err, answers) => {
        if (err) reject(err);
        else resolve(answers);
      });
    });
    await expect(result).rejects.toThrow(/non-public/u);
  });

  it('rejects mixed allowed/private and metadata answers', async () => {
    const resolver = stubLookup({
      'linux.localdomain': [
        { address: '192.168.1.10', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    });
    const result = new Promise((resolve, reject) => {
      createGuardedLookup(resolver, true)('linux.localdomain', { all: true }, (err, answers) => {
        if (err) reject(err);
        else resolve(answers);
      });
    });
    await expect(result).rejects.toThrow(/non-public/u);
  });

  it.each(['metadata.google.internal', 'METADATA.GOOGLE.INTERNAL.'])(
    'rejects metadata hostname %s even if its DNS would return an allowed address',
    async (hostname) => {
      const result = new Promise((resolve, reject) => {
        createGuardedLookup(stubLookup({ [hostname]: '127.0.0.1' }), true)(hostname, { all: true }, (err, answers) => {
          if (err) reject(err);
          else resolve(answers);
        });
      });
      await expect(result).rejects.toThrow(/metadata/u);
    },
  );

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

/** A public DNS fixture answer. The tests use it for screening only. */
const PUBLIC_ADDRESS = '93.184.216.34';
/** The cloud metadata service — the canonical SSRF rebinding target. */
const METADATA_ADDRESS = '169.254.169.254';

/** Resolver stub so a fixture screens a real name without touching real DNS. */
function stubLookup(
  answers: Readonly<Record<string, string | readonly dns.LookupAddress[] | undefined>>,
): typeof dns.lookup {
  return ((
    hostname: string,
    options: dns.LookupOptions,
    callback: (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
  ): void => {
    const answer = answers[hostname];
    if (answer === undefined) {
      const error: NodeJS.ErrnoException = new Error(`no stub DNS answer for ${hostname}`);
      error.code = 'ENOTFOUND';
      callback(error, []);
      return;
    }
    const records = typeof answer === 'string' ? [{ address: answer, family: answer.includes(':') ? 6 : 4 }] : answer;
    if (options.all) callback(null, [...records]);
    else callback(null, records[0]?.address ?? '', records[0]?.family);
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

async function requestBody(
  transport: OutboundTransport,
  request: Parameters<OutboundTransport['request']>[0],
): Promise<string> {
  return (await requestResponse(transport, request)).body;
}

function requestResponse(
  transport: OutboundTransport,
  request: Parameters<OutboundTransport['request']>[0],
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = transport.request(request, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
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
