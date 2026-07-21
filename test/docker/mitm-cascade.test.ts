import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrCreateCA } from '../../src/docker/ca.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import { createParentProxyOutboundTransport } from '../../src/docker/outbound-transport.js';
import type { ProviderConfig } from '../../src/docker/provider-config.js';
import { makeHttpsRequest, sendConnect } from '../helpers/mitm-tls-harness.js';

describe('nested MITM credential and policy cascade', () => {
  let temporaryDirectory = '';
  let innerProxy: MitmProxy | undefined;
  let outerProxy: MitmProxy | undefined;
  let upstream: http.Server | undefined;

  afterEach(async () => {
    await innerProxy?.stop();
    await outerProxy?.stop();
    if (upstream) {
      await new Promise<void>((resolve) => upstream?.close(() => resolve()));
      upstream.closeAllConnections();
    }
    if (temporaryDirectory && existsSync(temporaryDirectory)) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('swaps inner sentinel to outer sentinel, then outer sentinel to the real credential', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'mitm-cascade-'));
    const outerCa = loadOrCreateCA(join(temporaryDirectory, 'outer-ca'));
    const innerCa = loadOrCreateCA(join(temporaryDirectory, 'inner-ca'));
    const outerSocketPath = join(temporaryDirectory, 'outer.sock');
    const innerSocketPath = join(temporaryDirectory, 'inner.sock');
    const innerSentinel = 'sk-inner-sentinel';
    const outerSentinel = 'sk-outer-sentinel';
    const realCredential = 'sk-real-host-only-secret';

    let credentialSeenByUpstream: string | undefined;
    upstream = http.createServer((request, response) => {
      credentialSeenByUpstream = request.headers['x-api-key'] as string | undefined;
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end(JSON.stringify({ cascade: 'ok' }));
    });
    const upstreamPort = await new Promise<number>((resolve) => {
      upstream?.listen(0, '127.0.0.1', () => {
        resolve((upstream?.address() as import('node:net').AddressInfo).port);
      });
    });

    const commonProvider: ProviderConfig = {
      host: 'api.cascade.example.com',
      displayName: 'Cascade Test',
      allowedEndpoints: [{ method: 'POST', path: '/v1/messages' }],
      keyInjection: { type: 'header', headerName: 'x-api-key' },
      fakeKeyPrefix: 'sk-cascade-',
    };
    const outerProvider: ProviderConfig = {
      ...commonProvider,
      upstreamTarget: { hostname: '127.0.0.1', port: upstreamPort, pathPrefix: '', useTls: false },
    };

    outerProxy = createMitmProxy({
      socketPath: outerSocketPath,
      ca: outerCa,
      providers: [{ config: outerProvider, fakeKey: outerSentinel, realKey: realCredential }],
      allowPrivateDestinationsForTests: true,
    });
    await outerProxy.start();

    // The inner proxy receives only the outer proxy's fake sentinel. The real
    // credential remains exclusively in the outer trusted process.
    innerProxy = createMitmProxy({
      socketPath: innerSocketPath,
      ca: innerCa,
      providers: [{ config: commonProvider, fakeKey: innerSentinel, realKey: outerSentinel }],
      outboundTransport: createParentProxyOutboundTransport({
        proxy: { socketPath: outerSocketPath },
        ca: outerCa.certPem,
      }),
    });
    await innerProxy.start();

    const { socket, statusCode } = await sendConnect(innerSocketPath, commonProvider.host, 443);
    expect(statusCode).toBe(200);
    expect(socket).not.toBeNull();
    const response = await makeHttpsRequest(socket!, innerCa, commonProvider.host, {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'x-api-key': innerSentinel, 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('cascade');
    expect(credentialSeenByUpstream).toBe(realCredential);

    // Parent loss is a hard failure: the inner transport has no direct route.
    await outerProxy.stop();
    outerProxy = undefined;
    const afterLoss = await sendConnect(innerSocketPath, commonProvider.host, 443);
    expect(afterLoss.statusCode).toBe(200);
    const failedResponse = await makeHttpsRequest(afterLoss.socket!, innerCa, commonProvider.host, {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'x-api-key': innerSentinel, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(failedResponse.statusCode).toBe(502);
    expect(credentialSeenByUpstream).toBe(realCredential);
  });
});
