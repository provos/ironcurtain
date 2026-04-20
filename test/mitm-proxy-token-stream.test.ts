import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as http from 'node:http';
import * as tls from 'node:tls';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrCreateCA, type CertificateAuthority } from '../src/docker/ca.js';
import {
  createMitmProxy,
  resolveSseProvider,
  type MitmProxy,
  type MitmProxyOptions,
} from '../src/docker/mitm-proxy.js';
import type { ProviderConfig } from '../src/docker/provider-config.js';
import { getTokenStreamBus, resetTokenStreamBus } from '../src/docker/token-stream-bus.js';
import type { TokenStreamEvent } from '../src/docker/token-stream-types.js';
import type { SessionId } from '../src/session/types.js';

// --- Test helpers ---

/** Type-safe event filter that narrows the union. */
function eventsOfKind<K extends TokenStreamEvent['kind']>(
  events: TokenStreamEvent[],
  kind: K,
): Array<Extract<TokenStreamEvent, { kind: K }>> {
  return events.filter((e): e is Extract<TokenStreamEvent, { kind: K }> => e.kind === kind);
}

/** DNS lookup that resolves all hostnames to 127.0.0.1 for testing. */
const localhostDnsLookup: MitmProxyOptions['dnsLookup'] = (_hostname, opts, cb) => {
  if ((opts as { all?: boolean }).all) {
    cb(null, [{ address: '127.0.0.1', family: 4 }] as never);
  } else {
    cb(null, '127.0.0.1', 4);
  }
};

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
 * then sends an HTTP request and collects the full response body.
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

/** Starts a local HTTP server that returns an SSE response. */
async function createSseUpstream(
  ssePayload: string,
  contentType = 'text/event-stream',
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(ssePayload);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as import('node:net').AddressInfo).port);
    });
  });
  return { server, port };
}

// --- Tests ---

describe('resolveSseProvider', () => {
  it('resolves api.anthropic.com to anthropic', () => {
    expect(resolveSseProvider('api.anthropic.com')).toBe('anthropic');
  });

  it('resolves platform.claude.com to anthropic', () => {
    expect(resolveSseProvider('platform.claude.com')).toBe('anthropic');
  });

  it('resolves api.openai.com to openai', () => {
    expect(resolveSseProvider('api.openai.com')).toBe('openai');
  });

  it('resolves unknown hosts to unknown', () => {
    expect(resolveSseProvider('api.example.com')).toBe('unknown');
    expect(resolveSseProvider('generativelanguage.googleapis.com')).toBe('unknown');
  });
});

describe('MitmProxy token stream integration', () => {
  let proxy: MitmProxy | undefined;
  let tempDir: string;
  let ca: CertificateAuthority;
  let socketPath: string;

  beforeEach(() => {
    resetTokenStreamBus();
    tempDir = mkdtempSync(join(tmpdir(), 'mitm-token-stream-test-'));
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

  /** Creates an Anthropic-like provider config that routes upstream to a local HTTP server. */
  function makeTestProvider(upstreamPort: number): {
    config: ProviderConfig;
    fakeKey: string;
    realKey: string;
  } {
    return {
      config: {
        host: 'api.anthropic.com',
        displayName: 'Anthropic (test)',
        allowedEndpoints: [{ method: 'POST', path: '/v1/messages' }],
        keyInjection: { type: 'header', headerName: 'x-api-key' },
        fakeKeyPrefix: 'sk-ant-test-',
        upstreamTarget: {
          hostname: '127.0.0.1',
          port: upstreamPort,
          pathPrefix: '',
          useTls: false,
        },
      },
      fakeKey: 'sk-ant-test-fake-key',
      realKey: 'sk-ant-test-real-key',
    };
  }

  it('does not throw when sessionId is provided (bus is fetched from singleton)', () => {
    expect(() =>
      createMitmProxy({
        socketPath,
        ca,
        providers: [],
        sessionId: 'test-session',
      }),
    ).not.toThrow();
  });

  it('does not throw when sessionId is omitted (extractor is skipped)', () => {
    expect(() =>
      createMitmProxy({
        socketPath,
        ca,
        providers: [],
      }),
    ).not.toThrow();
  });

  it('publishes into the singleton bus when sessionId is provided', async () => {
    // End-to-end singleton-wiring check: proxy receives only sessionId
    // (no bus parameter exists), yet subscribers on getTokenStreamBus()
    // still observe events from the proxy's SSE tap.
    const ssePayload = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Singleton"}}',
      '',
    ].join('\n');

    const { server: upstream, port: upstreamPort } = await createSseUpstream(ssePayload);

    try {
      const sessionId = 'test-session-singleton' as SessionId;
      const events: TokenStreamEvent[] = [];
      getTokenStreamBus().subscribe(sessionId, (_sid, event) => {
        events.push(event);
      });

      const provider = makeTestProvider(upstreamPort);
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [provider],
        dnsLookup: localhostDnsLookup,
        sessionId: sessionId as string,
      });
      await proxy.start();

      const { socket } = await sendConnect(socketPath, 'api.anthropic.com', 443);
      expect(socket).not.toBeNull();

      await makeHttpsRequest(socket!, ca, 'api.anthropic.com', {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': provider.fakeKey,
          'content-type': 'application/json',
        },
        body: '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"hi"}]}',
      });

      const textDelta = events.find((e) => e.kind === 'text_delta');
      expect(textDelta).toBeDefined();
      if (textDelta?.kind === 'text_delta') {
        expect(textDelta.text).toBe('Singleton');
      }
    } finally {
      upstream.close();
    }
  });

  it('taps SSE responses and pushes events to the bus', async () => {
    const ssePayload = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_test","model":"claude-sonnet-4-20250514"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
      '',
    ].join('\n');

    const { server: upstream, port: upstreamPort } = await createSseUpstream(ssePayload);

    try {
      const sessionId = 'test-session-sse' as SessionId;
      const events: TokenStreamEvent[] = [];
      // Subscribe via the singleton bus — this is the same instance the
      // proxy will publish into.
      getTokenStreamBus().subscribe(sessionId, (_sid, event) => {
        events.push(event);
      });

      const provider = makeTestProvider(upstreamPort);
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [provider],
        dnsLookup: localhostDnsLookup,
        sessionId: sessionId as string,
      });
      await proxy.start();

      const { socket } = await sendConnect(socketPath, 'api.anthropic.com', 443);
      expect(socket).not.toBeNull();

      const response = await makeHttpsRequest(socket!, ca, 'api.anthropic.com', {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': provider.fakeKey,
          'content-type': 'application/json',
        },
        body: '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"hi"}]}',
      });

      expect(response.statusCode).toBe(200);
      expect(events.length).toBeGreaterThanOrEqual(3);

      // Verify structured events
      const messageStart = events.find((e) => e.kind === 'message_start');
      expect(messageStart).toBeDefined();
      if (messageStart?.kind === 'message_start') {
        expect(messageStart.model).toBe('claude-sonnet-4-20250514');
      }

      const textDelta = events.find((e) => e.kind === 'text_delta');
      expect(textDelta).toBeDefined();
      if (textDelta?.kind === 'text_delta') {
        expect(textDelta.text).toBe('Hello');
      }

      const messageEnd = events.find((e) => e.kind === 'message_end');
      expect(messageEnd).toBeDefined();
      if (messageEnd?.kind === 'message_end') {
        expect(messageEnd.stopReason).toBe('end_turn');
        expect(messageEnd.outputTokens).toBe(42);
      }
    } finally {
      upstream.close();
    }
  });

  it('does not tap when sessionId is not provided', async () => {
    const ssePayload = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '',
    ].join('\n');

    const { server: upstream, port: upstreamPort } = await createSseUpstream(ssePayload);

    try {
      const provider = makeTestProvider(upstreamPort);
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [provider],
        dnsLookup: localhostDnsLookup,
        // No sessionId (bus is always fetched from singleton when sessionId is set)
      });
      await proxy.start();

      const { socket } = await sendConnect(socketPath, 'api.anthropic.com', 443);
      expect(socket).not.toBeNull();

      // Request still succeeds without the extractor
      const response = await makeHttpsRequest(socket!, ca, 'api.anthropic.com', {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': provider.fakeKey,
          'content-type': 'application/json',
        },
        body: '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"hi"}]}',
      });

      expect(response.statusCode).toBe(200);
      // Response body should still contain the SSE data
      expect(response.body).toContain('text_delta');
    } finally {
      upstream.close();
    }
  });

  it('extracts events from non-streaming JSON responses on LLM endpoints', async () => {
    // Create a JSON upstream that returns a real-looking Anthropic response
    const jsonBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text: 'Hello from JSON' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const jsonServer = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(jsonBody).toString(),
      });
      res.end(jsonBody);
    });
    const jsonPort = await new Promise<number>((resolve) => {
      jsonServer.listen(0, '127.0.0.1', () => {
        resolve((jsonServer.address() as import('node:net').AddressInfo).port);
      });
    });

    try {
      const sessionId = 'test-session-json' as SessionId;
      const events: TokenStreamEvent[] = [];
      getTokenStreamBus().subscribe(sessionId, (_sid, event) => {
        events.push(event);
      });

      const provider = makeTestProvider(jsonPort);
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [provider],
        dnsLookup: localhostDnsLookup,
        sessionId: sessionId as string,
      });
      await proxy.start();

      const { socket } = await sendConnect(socketPath, 'api.anthropic.com', 443);
      expect(socket).not.toBeNull();

      const response = await makeHttpsRequest(socket!, ca, 'api.anthropic.com', {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': provider.fakeKey,
          'content-type': 'application/json',
        },
        body: '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"hi"}]}',
      });

      expect(response.statusCode).toBe(200);

      // Wait briefly for the async end handler to fire
      await new Promise((resolve) => setTimeout(resolve, 50));

      // JSON response extraction should produce message_start, text_delta, and message_end
      const starts = eventsOfKind(events, 'message_start');
      expect(starts).toHaveLength(1);
      expect(starts[0].model).toBe('claude-sonnet-4-20250514');

      const deltas = eventsOfKind(events, 'text_delta');
      expect(deltas).toHaveLength(1);
      expect(deltas[0].text).toBe('Hello from JSON');

      const ends = eventsOfKind(events, 'message_end');
      expect(ends).toHaveLength(1);
      expect(ends[0].inputTokens).toBe(100);
      expect(ends[0].outputTokens).toBe(50);
    } finally {
      jsonServer.close();
    }
  });

  it('delivers events to global bus subscribers', async () => {
    const ssePayload = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"World"}}',
      '',
    ].join('\n');

    const { server: upstream, port: upstreamPort } = await createSseUpstream(ssePayload);

    try {
      const sessionId = 'test-session-global' as SessionId;
      const globalEvents: Array<{ sessionId: SessionId; event: TokenStreamEvent }> = [];
      getTokenStreamBus().subscribeAll((sid, event) => {
        globalEvents.push({ sessionId: sid, event });
      });

      const provider = makeTestProvider(upstreamPort);
      proxy = createMitmProxy({
        socketPath,
        ca,
        providers: [provider],
        dnsLookup: localhostDnsLookup,
        sessionId: sessionId as string,
      });
      await proxy.start();

      const { socket } = await sendConnect(socketPath, 'api.anthropic.com', 443);
      expect(socket).not.toBeNull();

      await makeHttpsRequest(socket!, ca, 'api.anthropic.com', {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': provider.fakeKey,
          'content-type': 'application/json',
        },
        body: '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"hi"}]}',
      });

      expect(globalEvents.length).toBeGreaterThan(0);
      // All events should be tagged with the correct session ID
      for (const entry of globalEvents) {
        expect(entry.sessionId).toBe(sessionId);
      }
    } finally {
      upstream.close();
    }
  });
});
