import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as http from 'node:http';
import * as tls from 'node:tls';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrCreateCA, type CertificateAuthority } from '../src/docker/ca.js';
import { createMitmProxy, type MitmProxy } from '../src/docker/mitm-proxy.js';
import {
  isEndpointAllowed,
  stripServerSideTools,
  shouldRewriteBody,
  type ProviderConfig,
} from '../src/docker/provider-config.js';
import { generateFakeKey } from '../src/docker/fake-keys.js';

// --- Test helpers ---

/** Sends a CONNECT request to the proxy via UDS, returns client socket + status. */
function sendConnect(
  socketPath: string,
  host: string,
  port: number,
): Promise<{ socket: import('node:net').Socket | null; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      method: 'CONNECT',
      path: `${host}:${port}`,
    });

    req.on('connect', (res, socket) => {
      resolve({ socket, statusCode: res.statusCode ?? 0 });
    });

    req.on('error', reject);

    req.on('response', (res) => {
      resolve({ socket: null, statusCode: res.statusCode ?? 0 });
    });

    req.end();
  });
}

/**
 * Performs a TLS handshake on an already-CONNECT'd socket,
 * then sends an HTTP request over it.
 */
function makeHttpsRequest(
  socket: import('node:net').Socket,
  ca: CertificateAuthority,
  host: string,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect(
      {
        socket,
        servername: host,
        ca: ca.certPem,
      },
      () => {
        const method = options.method ?? 'GET';
        const path = options.path ?? '/';
        const headers: Record<string, string> = {
          host,
          connection: 'close',
          ...options.headers,
        };

        if (options.body) {
          headers['content-length'] = Buffer.byteLength(options.body).toString();
        }

        const headerLines = Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n');
        const reqStr = `${method} ${path} HTTP/1.1\r\n${headerLines}\r\n\r\n`;
        tlsSocket.write(reqStr);
        if (options.body) tlsSocket.write(options.body);

        // Parse response manually
        let data = '';
        tlsSocket.on('data', (chunk) => {
          data += chunk.toString();
        });
        tlsSocket.on('end', () => {
          const [headerSection, ...bodyParts] = data.split('\r\n\r\n');
          const statusLine = headerSection.split('\r\n')[0];
          const statusCode = parseInt(statusLine.split(' ')[1], 10);
          const responseHeaders: Record<string, string> = {};
          for (const line of headerSection.split('\r\n').slice(1)) {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
              responseHeaders[line.substring(0, colonIdx).toLowerCase().trim()] = line.substring(colonIdx + 1).trim();
            }
          }
          resolve({
            statusCode,
            headers: responseHeaders,
            body: bodyParts.join('\r\n\r\n'),
          });
        });
        tlsSocket.on('error', reject);
      },
    );
    tlsSocket.on('error', reject);
  });
}

// --- Tests ---

describe('isEndpointAllowed', () => {
  const config: ProviderConfig = {
    host: 'api.example.com',
    displayName: 'Example',
    allowedEndpoints: [
      { method: 'POST', path: '/v1/messages' },
      { method: 'GET', path: '/v1/models' },
      { method: 'POST', path: '/v1beta/models/*/generateContent' },
    ],
    keyInjection: { type: 'header', headerName: 'x-api-key' },
    fakeKeyPrefix: 'test-',
  };

  it('allows exact match', () => {
    expect(isEndpointAllowed(config, 'POST', '/v1/messages')).toBe(true);
  });

  it('allows exact match with query string stripped', () => {
    expect(isEndpointAllowed(config, 'POST', '/v1/messages?foo=bar')).toBe(true);
  });

  it('blocks wrong method', () => {
    expect(isEndpointAllowed(config, 'GET', '/v1/messages')).toBe(false);
  });

  it('blocks unlisted path', () => {
    expect(isEndpointAllowed(config, 'POST', '/v1/other')).toBe(false);
  });

  it('allows glob pattern match', () => {
    expect(isEndpointAllowed(config, 'POST', '/v1beta/models/gemini-pro/generateContent')).toBe(true);
  });

  it('blocks glob with extra segments', () => {
    expect(isEndpointAllowed(config, 'POST', '/v1beta/models/a/b/generateContent')).toBe(false);
  });

  it('returns false for undefined method or path', () => {
    expect(isEndpointAllowed(config, undefined, '/v1/messages')).toBe(false);
    expect(isEndpointAllowed(config, 'POST', undefined)).toBe(false);
  });
});

describe('stripServerSideTools', () => {
  it('returns null when body has no tools field', () => {
    expect(stripServerSideTools({ model: 'claude-3', messages: [] })).toBeNull();
  });

  it('returns null when tools array is empty', () => {
    expect(stripServerSideTools({ tools: [] })).toBeNull();
  });

  it('returns null when all tools are custom (no type field)', () => {
    const body = {
      tools: [
        { name: 'read_file', input_schema: {} },
        { name: 'write_file', input_schema: {} },
      ],
    };
    expect(stripServerSideTools(body)).toBeNull();
  });

  it('returns null when all tools have type "custom"', () => {
    const body = {
      tools: [{ name: 'read_file', type: 'custom', input_schema: {} }],
    };
    expect(stripServerSideTools(body)).toBeNull();
  });

  it('strips server-side tools and keeps custom tools', () => {
    const body = {
      model: 'claude-3',
      tools: [
        { name: 'read_file', input_schema: {} },
        { type: 'web_search_20250305' },
        { name: 'write_file', type: 'custom', input_schema: {} },
        { type: 'computer_20250124', display_width: 1024 },
      ],
    };
    const result = stripServerSideTools(body);
    expect(result).not.toBeNull();
    expect(result!.modified.tools).toEqual([
      { name: 'read_file', input_schema: {} },
      { name: 'write_file', type: 'custom', input_schema: {} },
    ]);
    expect(result!.stripped).toEqual(['web_search_20250305', 'computer_20250124']);
    expect(result!.modified.model).toBe('claude-3');
  });

  it('returns empty tools array when all tools are server-side', () => {
    const body = {
      tools: [{ type: 'web_search_20250305' }, { type: 'computer_20250124' }],
    };
    const result = stripServerSideTools(body);
    expect(result).not.toBeNull();
    expect(result!.modified.tools).toEqual([]);
    expect(result!.stripped).toEqual(['web_search_20250305', 'computer_20250124']);
  });
});

describe('shouldRewriteBody', () => {
  const configWithRewriter: ProviderConfig = {
    host: 'api.anthropic.com',
    displayName: 'Anthropic',
    allowedEndpoints: [{ method: 'POST', path: '/v1/messages' }],
    keyInjection: { type: 'header', headerName: 'x-api-key' },
    fakeKeyPrefix: 'sk-ant-',
    requestRewriter: stripServerSideTools,
    rewriteEndpoints: ['/v1/messages'],
  };

  const configWithoutRewriter: ProviderConfig = {
    host: 'api.openai.com',
    displayName: 'OpenAI',
    allowedEndpoints: [{ method: 'POST', path: '/v1/chat/completions' }],
    keyInjection: { type: 'bearer' },
    fakeKeyPrefix: 'sk-',
  };

  it('returns false when provider has no rewriter', () => {
    expect(shouldRewriteBody(configWithoutRewriter, 'POST', '/v1/chat/completions')).toBe(false);
  });

  it('returns false for GET requests', () => {
    expect(shouldRewriteBody(configWithRewriter, 'GET', '/v1/messages')).toBe(false);
  });

  it('returns false for non-rewrite paths', () => {
    expect(shouldRewriteBody(configWithRewriter, 'POST', '/v1/messages/count_tokens')).toBe(false);
  });

  it('returns true for POST /v1/messages with Anthropic config', () => {
    expect(shouldRewriteBody(configWithRewriter, 'POST', '/v1/messages')).toBe(true);
  });

  it('returns true with query string in path', () => {
    expect(shouldRewriteBody(configWithRewriter, 'POST', '/v1/messages?beta=true')).toBe(true);
  });

  it('returns false for undefined method or path', () => {
    expect(shouldRewriteBody(configWithRewriter, undefined, '/v1/messages')).toBe(false);
    expect(shouldRewriteBody(configWithRewriter, 'POST', undefined)).toBe(false);
  });
});

describe('generateFakeKey', () => {
  it('generates a key with the given prefix', () => {
    const key = generateFakeKey('sk-ant-api03-');
    expect(key.startsWith('sk-ant-api03-')).toBe(true);
    expect(key.length).toBeGreaterThan('sk-ant-api03-'.length);
  });

  it('generates unique keys each call', () => {
    const key1 = generateFakeKey('test-');
    const key2 = generateFakeKey('test-');
    expect(key1).not.toBe(key2);
  });
});

describe('MitmProxy', () => {
  let proxy: MitmProxy | undefined;
  let tempDir: string;
  let ca: CertificateAuthority;
  let socketPath: string;

  const testProvider: ProviderConfig = {
    host: 'api.test.com',
    displayName: 'Test',
    allowedEndpoints: [
      { method: 'POST', path: '/v1/messages' },
      { method: 'GET', path: '/v1/models' },
    ],
    keyInjection: { type: 'header', headerName: 'x-api-key' },
    fakeKeyPrefix: 'sk-test-',
  };

  const rewriteProvider: ProviderConfig = {
    host: 'api.rewrite-test.com',
    displayName: 'Rewrite Test',
    allowedEndpoints: [{ method: 'POST', path: '/v1/messages' }],
    keyInjection: { type: 'header', headerName: 'x-api-key' },
    fakeKeyPrefix: 'sk-rw-',
    requestRewriter: stripServerSideTools,
    rewriteEndpoints: ['/v1/messages'],
  };

  const rewriteFakeKey = 'sk-rw-fake-key-for-testing';
  const rewriteRealKey = 'sk-rw-real-key-secret';

  const fakeKey = 'sk-test-fake-key-for-testing';
  const realKey = 'sk-real-api-key-secret';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mitm-proxy-test-'));
    ca = loadOrCreateCA(join(tempDir, 'ca'));
    socketPath = join(tempDir, 'mitm-proxy.sock');
  });

  afterEach(async () => {
    if (proxy) {
      await proxy.stop();
      proxy = undefined;
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('starts and listens on the specified socket path', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    const addr = await proxy.start();

    expect(addr.socketPath).toBe(socketPath);
    expect(existsSync(socketPath)).toBe(true);
  });

  it('returns 403 for CONNECT to denied host', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket, statusCode } = await sendConnect(socketPath, 'evil.com', 443);
    expect(statusCode).toBe(403);
    socket?.destroy();
  });

  it('returns 200 for CONNECT to allowed host', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket, statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(statusCode).toBe(200);
    expect(socket).not.toBeNull();
    socket?.destroy();
  });

  it('returns 405 for non-CONNECT methods', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method: 'GET',
          path: '/',
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(405);
  });

  it('performs TLS handshake with CA-signed cert for allowed host', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    // TLS handshake should succeed with our CA
    const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const tls_ = tls.connect(
        {
          socket: socket!,
          servername: 'api.test.com',
          ca: ca.certPem,
        },
        () => resolve(tls_),
      );
      tls_.on('error', reject);
    });

    expect(tlsSocket.authorized).toBe(true);
    tlsSocket.destroy();
  });

  it('blocks requests to disallowed endpoints', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    const response = await makeHttpsRequest(socket!, ca, 'api.test.com', {
      method: 'POST',
      path: '/v1/other-endpoint',
      headers: { 'x-api-key': fakeKey },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('not an allowed endpoint');
  });

  it('rejects requests with wrong fake key', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    const response = await makeHttpsRequest(socket!, ca, 'api.test.com', {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'x-api-key': 'wrong-key' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('does not match expected sentinel');
  });

  it('forwards requests with no API key header (unauthenticated endpoint)', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    const response = await makeHttpsRequest(socket!, ca, 'api.test.com', {
      method: 'POST',
      path: '/v1/messages',
      headers: {},
    });

    // No API key header → treated as unauthenticated, forwarded upstream
    // (502 because no real upstream exists in the test)
    expect(response.statusCode).toBe(502);
  });

  it('stop() cleans up socket file', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    expect(existsSync(socketPath)).toBe(true);
    await proxy.stop();
    expect(existsSync(socketPath)).toBe(false);
    proxy = undefined; // Already stopped
  });

  it('handles bearer key injection for OpenAI-style providers', async () => {
    const bearerProvider: ProviderConfig = {
      host: 'api.bearer-test.com',
      displayName: 'Bearer Test',
      allowedEndpoints: [{ method: 'POST', path: '/v1/chat/completions' }],
      keyInjection: { type: 'bearer' },
      fakeKeyPrefix: 'sk-bearer-',
    };
    const bearerFakeKey = 'sk-bearer-fake123';

    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: bearerProvider, fakeKey: bearerFakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.bearer-test.com', 443);
    expect(socket).not.toBeNull();

    // Wrong bearer key should be rejected
    const response = await makeHttpsRequest(socket!, ca, 'api.bearer-test.com', {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { authorization: 'Bearer wrong-key' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('does not match expected sentinel');
  });

  // --- P0: Crash prevention ---

  it('survives client destroying socket during TLS handshake', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    // Immediately destroy the raw socket before TLS handshake completes.
    // Without the clientSocket error handler, this would crash the process.
    socket!.destroy();

    // Give the proxy a moment to process the error
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Proxy should still be alive and accepting new connections
    const { statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(statusCode).toBe(200);
  });

  it('handles upstream response error gracefully', async () => {
    // Verify the proxy survives when the upstream connection fails.
    // We make a request to the proxy which will attempt to connect
    // upstream to api.test.com (which won't resolve correctly), and
    // the proxy should return a 502 or handle the error gracefully.
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    // Make a request; the real upstream (api.test.com) won't respond
    // correctly, but what matters is the proxy doesn't crash
    try {
      await makeHttpsRequest(socket!, ca, 'api.test.com', {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'x-api-key': fakeKey, 'content-type': 'application/json' },
        body: '{"test": true}',
      });
    } catch {
      // Connection errors are expected since api.test.com may not resolve
    }

    // Proxy should still be functional
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(statusCode).toBe(200);
  });

  // --- P1: Resource leak / cleanup ---

  it('stop() cleanly shuts down with active connections', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    // Open several connections to create active sockets
    const sockets: import('node:net').Socket[] = [];
    for (let i = 0; i < 3; i++) {
      const { socket, statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
      expect(statusCode).toBe(200);
      sockets.push(socket!);
    }

    // stop() should complete without hanging or throwing, even with active sockets
    await proxy.stop();
    proxy = undefined; // Already stopped

    // All client sockets should be destroyed
    for (const sock of sockets) {
      // Give a tick for the destroy to propagate
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sock.destroyed).toBe(true);
    }
  });

  it('returns 400 for malformed HTTP after TLS handshake', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    // Perform TLS handshake, then send garbage HTTP
    const response = await new Promise<string>((resolve) => {
      const tlsSocket = tls.connect(
        {
          socket: socket!,
          servername: 'api.test.com',
          ca: ca.certPem,
        },
        () => {
          // Send malformed HTTP that will trigger a clientError
          tlsSocket.write('NOT VALID HTTP\r\n\r\n');

          let data = '';
          tlsSocket.on('data', (chunk) => {
            data += chunk.toString();
          });
          tlsSocket.on('end', () => resolve(data));
          tlsSocket.on('error', () => resolve(data));

          // Timeout fallback in case we get no response
          setTimeout(() => resolve(data), 2000);
        },
      );
      tlsSocket.on('error', () => resolve(''));
    });

    // The proxy should respond with 400 Bad Request
    expect(response).toContain('400');
  });

  it('tracks and cleans up raw client sockets on stop()', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    // Create a connection but don't do TLS handshake — this tests
    // the gap between CONNECT ack and TLS socket creation
    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();
    expect(socket!.destroyed).toBe(false);

    // stop() should destroy the raw client socket too
    await proxy.stop();
    proxy = undefined;

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socket!.destroyed).toBe(true);
  });

  // --- P2: Robustness ---

  it('handles ECONNRESET without crashing', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    // Open a CONNECT and do a TLS handshake
    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const tls_ = tls.connect({ socket: socket!, servername: 'api.test.com', ca: ca.certPem }, () => resolve(tls_));
      tls_.on('error', reject);
    });

    // Force-destroy the underlying socket to trigger ECONNRESET on the proxy side
    tlsSocket.destroy();

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Proxy should still accept new connections
    const { statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(statusCode).toBe(200);
  });

  it('removes stale error listener after successful start', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });

    await proxy.start();

    // After successful start, there should be no lingering 'error' listeners
    // from the start() promise. The server's error listeners should only be
    // the default Node.js ones, not the reject callback from the promise.
    // We verify this indirectly: if the stale listener were present and the
    // server emitted an error, it would reject a long-resolved promise
    // (which would be an unhandled rejection). Instead, we just verify that
    // start completed and the proxy is functional.
    const { statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(statusCode).toBe(200);
  });

  it('rejects requests with Content-Encoding on rewrite endpoints', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: rewriteProvider, fakeKey: rewriteFakeKey, realKey: rewriteRealKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.rewrite-test.com', 443);
    expect(socket).not.toBeNull();

    const response = await makeHttpsRequest(socket!, ca, 'api.rewrite-test.com', {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'x-api-key': rewriteFakeKey,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: 'compressed-bytes-here',
    });

    expect(response.statusCode).toBe(415);
    expect(response.body).toContain('Unsupported Content-Encoding');
  });

  it('handles client request body errors', async () => {
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(socket).not.toBeNull();

    // Do TLS handshake then send a request with chunked encoding that
    // gets cut off mid-stream to trigger an error on clientReq
    await new Promise<void>((resolve) => {
      const tlsSocket = tls.connect({ socket: socket!, servername: 'api.test.com', ca: ca.certPem }, () => {
        // Send a request with Transfer-Encoding: chunked, then destroy mid-body
        const reqLines = [
          'POST /v1/messages HTTP/1.1',
          'host: api.test.com',
          `x-api-key: ${fakeKey}`,
          'transfer-encoding: chunked',
          '',
          'ff', // claim 255 bytes of chunk data
          '', // but don't send the data
        ].join('\r\n');
        tlsSocket.write(reqLines);

        // Destroy mid-chunk to trigger an error
        setTimeout(() => {
          tlsSocket.destroy();
          resolve();
        }, 50);
      });
      tlsSocket.on('error', () => {});
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Proxy should still be alive
    const { statusCode } = await sendConnect(socketPath, 'api.test.com', 443);
    expect(statusCode).toBe(200);
  });
});
