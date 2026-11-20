import type * as dns from 'node:dns';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadOrCreateCA, type CertificateAuthority } from '../../src/docker/ca.js';
import { createMitmProxy, type MitmProxy, type ProviderKeyMapping } from '../../src/docker/mitm-proxy.js';
import {
  createDirectOutboundTransport,
  type DestinationBoundRequest,
  type OutboundTransport,
} from '../../src/docker/outbound-transport.js';
import type { KeyInjection } from '../../src/docker/provider-config.js';
import {
  createFakeUpstream,
  localhostDnsLookup,
  makeHttpsRequest,
  sendConnect,
  type CapturedRequest,
} from '../helpers/mitm-tls-harness.js';

const providers = [
  { host: 'header.provider.test', path: '/v1/messages', keyInjection: { type: 'header', headerName: 'x-api-key' } },
  { host: 'bearer.provider.test', path: '/v1/responses', keyInjection: { type: 'bearer' } },
] as const;
type Provider = (typeof providers)[number];
const credentials = ['sentinel', 'agent key', 'other sentinel', 'absent'] as const;
const challenges = ['none', 'first attempt', 'every attempt'] as const;
const traces = providers.flatMap((provider) =>
  credentials.flatMap((credential) =>
    [false, true].flatMap((rotate) => challenges.map((challenge) => ({ provider, credential, rotate, challenge }))),
  ),
);
const body = '{"probe":"café"}';
const prefix = '/gateway';

function authHeader(injection: KeyInjection): string {
  return injection.type === 'header' ? injection.headerName : 'authorization';
}

function authValue(injection: KeyInjection, token?: string): string | undefined {
  return injection.type === 'bearer' && token !== undefined ? `Bearer ${token}` : token;
}

async function createRoute(provider: Provider) {
  const state = { token: `${provider.host}-initial`, responses: [] as number[] };
  const getValidAccessToken = vi.fn(() => Promise.resolve(state.token));
  const handleAuthFailure = vi.fn(() => {
    state.token = `${provider.host}-reactive`;
    return Promise.resolve(state.token);
  });
  const upstream = await createFakeUpstream(() => ({ status: state.responses.shift() ?? 200, body: '{}' }));
  const mapping: ProviderKeyMapping = {
    config: {
      ...provider,
      displayName: provider.host,
      allowedEndpoints: [{ method: 'POST', path: provider.path }],
      fakeKeyPrefix: 'model-',
      upstreamTarget: { hostname: '127.0.0.1', port: upstream.port, pathPrefix: prefix, useTls: false },
    },
    fakeKey: `model-${provider.host}`,
    realKey: state.token,
    tokenManager: { getValidAccessToken, handleAuthFailure },
  };
  return { provider, state, upstream, mapping, getValidAccessToken, handleAuthFailure };
}

type Route = Awaited<ReturnType<typeof createRoute>>;

describe('MITM provider routing and credential model', () => {
  const routes: Route[] = [];
  const outboundAttempts: DestinationBoundRequest[] = [];
  let tempDir: string;
  let socketPath: string;
  let ca: CertificateAuthority;
  let proxy: MitmProxy | undefined;
  let transport: OutboundTransport | undefined;

  beforeAll(async () => {
    vi.stubEnv('IRONCURTAIN_MITM_ALLOW_ALL_HOSTS', '');
    tempDir = mkdtempSync(join(tmpdir(), 'mitm-provider-model-'));
    socketPath = join(tempDir, 'mitm.sock');
    ca = loadOrCreateCA(join(tempDir, 'ca'));
    for (const provider of providers) routes.push(await createRoute(provider));
    const direct = createDirectOutboundTransport({ lookup: localhostDnsLookup as typeof dns.lookup });
    transport = direct;
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: routes.map(({ mapping }) => mapping),
      outboundTransport: {
        ...direct,
        request(request, onResponse) {
          outboundAttempts.push(request);
          return direct.request(request, onResponse);
        },
      },
    });
    await proxy.start();
  });

  afterAll(async () => {
    try {
      await proxy?.stop();
    } finally {
      transport?.destroy?.();
      await Promise.all(
        routes.map(({ upstream }) => new Promise<void>((resolve) => upstream.server.close(() => resolve()))),
      );
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  async function request(route: Route, token?: string, method = 'POST', path = `${route.provider.path}?probe=1`) {
    const host = route.provider.host;
    const { socket, statusCode } = await sendConnect(socketPath, host, 443);
    try {
      if (!socket || statusCode !== 200) throw new Error(`CONNECT to ${host} failed with status ${statusCode}`);
      const value = authValue(route.provider.keyInjection, token);
      const other = routes.find((candidate) => candidate !== route)!;
      return await makeHttpsRequest(socket, ca, host, {
        method,
        path,
        headers: {
          host: other.provider.host,
          'content-type': 'application/json',
          ...(value === undefined ? {} : { [authHeader(route.provider.keyInjection)]: value }),
        },
        ...(method === 'POST' ? { body } : {}),
      });
    } finally {
      socket?.destroy();
    }
  }

  function assertUpstream(route: Route, received: readonly CapturedRequest[], expectedTokens: (string | undefined)[]) {
    expect(received.map(({ headers }) => headers[authHeader(route.provider.keyInjection)])).toEqual(
      expectedTokens.map((token) => authValue(route.provider.keyInjection, token)),
    );
    for (const record of received) {
      expect(record).toMatchObject({
        method: 'POST',
        path: `${prefix}${route.provider.path}?probe=1`,
        headers: { host: `127.0.0.1:${route.upstream.port}` },
        rawBody: body,
      });
    }
  }

  it.each(traces)(
    'routes $provider.host with $credential, rotate=$rotate, challenge=$challenge',
    async ({ provider, credential, rotate, challenge }) => {
      const route = routes.find((candidate) => candidate.provider === provider)!;
      const other = routes.find((candidate) => candidate !== route)!;
      // Establish a known managed token, then optionally rotate it before the next request.
      const baseline = `${provider.host}-baseline`;
      route.state.token = baseline;
      route.state.responses = [];
      expect((await request(route, route.mapping.fakeKey)).statusCode).toBe(200);
      const currentToken = rotate ? `${provider.host}-proactive` : baseline;
      route.state.token = currentToken;
      route.state.responses = challenge === 'none' ? [] : challenge === 'first attempt' ? [401] : [401, 401];

      const suppliedTokens = {
        sentinel: route.mapping.fakeKey,
        'agent key': 'agent-owned-key',
        'other sentinel': other.mapping.fakeKey,
        absent: undefined,
      };
      const supplied = suppliedTokens[credential];
      const expectedTokens = [credential === 'sentinel' ? currentToken : supplied];
      const expectRetry = credential === 'sentinel' && challenge !== 'none';
      if (expectRetry) expectedTokens.push(`${provider.host}-reactive`);
      const start = route.upstream.requests().length;
      const otherStart = other.upstream.requests().length;
      const outboundStart = outboundAttempts.length;
      const retryStart = route.handleAuthFailure.mock.calls.length;
      const refreshStart = route.getValidAccessToken.mock.calls.length;

      const response = await request(route, supplied);

      assertUpstream(route, route.upstream.requests().slice(start), expectedTokens);
      expect(other.upstream.requests()).toHaveLength(otherStart);
      expect(outboundAttempts.slice(outboundStart).map(({ destination }) => destination.port)).toEqual(
        expectedTokens.map(() => route.upstream.port),
      );
      expect(route.getValidAccessToken.mock.calls.length - refreshStart).toBe(credential === 'sentinel' ? 1 : 0);
      expect(route.handleAuthFailure.mock.calls.length - retryStart).toBe(expectRetry ? 1 : 0);
      expect(response.statusCode).toBe(
        challenge === 'none' || (expectRetry && challenge === 'first attempt') ? 200 : 401,
      );
    },
  );

  it.each(providers)('applies a shared refresh to both in-flight requests for $host', async (provider) => {
    const route = routes.find((candidate) => candidate.provider === provider)!;
    route.state.token = `${provider.host}-before-shared-refresh`;
    route.state.responses = [];
    expect((await request(route, route.mapping.fakeKey)).statusCode).toBe(200);

    route.state.token = `${provider.host}-after-shared-refresh`;
    let completeRefresh!: (token: string) => void;
    const sharedRefresh = new Promise<string>((resolve) => {
      completeRefresh = resolve;
    });
    route.getValidAccessToken
      .mockImplementationOnce(() => sharedRefresh)
      .mockImplementationOnce(() => {
        // Both requests have matched their sentinel before either one forwards upstream.
        completeRefresh(route.state.token);
        return sharedRefresh;
      });

    const start = route.upstream.requests().length;
    const responses = await Promise.all([request(route, route.mapping.fakeKey), request(route, route.mapping.fakeKey)]);

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    assertUpstream(route, route.upstream.requests().slice(start), [route.state.token, route.state.token]);
  });

  it('rejects routes outside the CONNECT authority policy before making any outbound request', async () => {
    const start = outboundAttempts.length;
    for (const [index, route] of routes.entries()) {
      const other = routes[(index + 1) % routes.length];
      const refreshStart = route.getValidAccessToken.mock.calls.length;
      expect((await request(route, route.mapping.fakeKey, 'POST', other.provider.path)).statusCode).toBe(403);
      expect((await request(route, route.mapping.fakeKey, 'GET')).statusCode).toBe(403);
      expect(route.getValidAccessToken.mock.calls).toHaveLength(refreshStart);
    }
    const denied = await sendConnect(socketPath, 'unlisted.provider.test', 443);
    denied.socket?.destroy();
    expect(denied.statusCode).toBe(403);
    expect(outboundAttempts).toHaveLength(start);
  });
});
