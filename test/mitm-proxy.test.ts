import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as http from 'node:http';
import * as tls from 'node:tls';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrCreateCA, type CertificateAuthority } from '../src/docker/ca.js';
import { createMitmProxy, type MitmProxy } from '../src/docker/mitm-proxy.js';
import { isEndpointAllowed, type ProviderConfig } from '../src/docker/provider-config.js';
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

  it('rejects requests with missing API key', async () => {
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

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('does not match expected sentinel');
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
});
