import * as http from 'node:http';
import * as tls from 'node:tls';
import * as zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateCA, type CertificateAuthority } from '../../src/docker/ca.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import type { OAuthTokenManager } from '../../src/docker/oauth-token-manager.js';
import { anthropicProvider, googleProvider, type ProviderConfig } from '../../src/docker/provider-config.js';
import { createTrajectoryCaptureWriter, type TrajectoryCaptureWriter } from '../../src/docker/trajectory-capture.js';
import { getLlmMetricsEventBus, resetLlmMetricsEventBus } from '../../src/llm-metrics/event-bus.js';
import type { MetricsInvocationLease } from '../../src/llm-metrics/attribution-registry.js';
import type { LlmExchangeCompleted } from '../../src/llm-metrics/types.js';
import type { SessionId } from '../../src/session/types.js';
import { sendConnect } from '../helpers/mitm-tls-harness.js';

const CLIENT_HOST = 'api.anthropic.com';
const GOOGLE_HOST = 'generativelanguage.googleapis.com';
const FAKE_KEY = 'sk-ant-api03-ironcurtain-test';
const REAL_KEY = 'sk-ant-api03-real-test';
const GOOGLE_FAKE_KEY = 'AIzaSy-ironcurtain-test';
const GOOGLE_REAL_KEY = 'AIzaSy-real-test';

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_test","model":"claude-served","service_tier":"priority","usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":10,"output_tokens":1}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hidden"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50,"output_tokens_details":{"thinking_tokens":30}}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const CAPTURE_COMPATIBLE_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_capture","type":"message","role":"assistant","model":"claude-served","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

function makeLargeCaptureCompatibleSse(): string {
  const text = randomBytes(7 * 1024 * 1024).toString('base64');
  const events = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_large","type":"message","role":"assistant","model":"claude-served","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":8,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
  ];
  for (let offset = 0; offset < text.length; offset += 4096) {
    events.push(
      'event: content_block_delta',
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: text.slice(offset, offset + 4096) },
      })}`,
      '',
    );
  }
  events.push(
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4242}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  );
  return events.join('\n');
}

interface CapturedRequest {
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

interface TestUpstream {
  readonly server: http.Server;
  readonly port: number;
  readonly requests: CapturedRequest[];
}

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function sendFixedResponse(
  response: http.ServerResponse,
  body: Buffer,
  headers: Readonly<Record<string, string>>,
): void {
  response.writeHead(200, {
    ...headers,
    'Content-Length': body.length,
    Connection: 'close',
  });
  response.end(body);
}

async function createUpstream(
  onRequest: (request: CapturedRequest, response: http.ServerResponse) => void,
): Promise<TestUpstream> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const captured = { headers: request.headers, body: Buffer.concat(chunks) };
      requests.push(captured);
      onRequest(captured, response);
    });
  });
  return { server, port: await listen(server), requests };
}

function metricsProvider(upstreamPort: number): ProviderConfig {
  return {
    ...anthropicProvider,
    requestRewriter: (body) => ({ modified: { ...body, model: 'claude-forwarded' }, stripped: ['model'] }),
    upstreamTarget: {
      hostname: '127.0.0.1',
      port: upstreamPort,
      pathPrefix: '',
      useTls: false,
    },
  };
}

function googleMetricsProvider(upstreamPort: number): ProviderConfig {
  return {
    ...googleProvider,
    upstreamTarget: {
      hostname: '127.0.0.1',
      port: upstreamPort,
      pathPrefix: '',
      useTls: false,
    },
  };
}

function proxyAuthorization(lease: MetricsInvocationLease): string {
  const proxyUrl = new URL(lease.proxyUrl);
  const credentials = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

interface BufferResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

function makeHttpsBufferRequest(
  socket: Socket,
  ca: CertificateAuthority,
  body: Buffer,
  options: {
    readonly host?: string;
    readonly path?: string;
    readonly apiKeyHeader?: string;
    readonly apiKey?: string;
  } = {},
): Promise<BufferResponse> {
  const host = options.host ?? CLIENT_HOST;
  const path = options.path ?? '/v1/messages';
  const apiKeyHeader = options.apiKeyHeader ?? 'x-api-key';
  const apiKey = options.apiKey ?? FAKE_KEY;
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: host, ca: ca.certPem }, () => {
      const requestHeaders = [
        `POST ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Connection: close',
        'Content-Type: application/json',
        `Content-Length: ${body.length}`,
        `${apiKeyHeader}: ${apiKey}`,
        '',
        '',
      ].join('\r\n');
      tlsSocket.write(requestHeaders);
      tlsSocket.write(body);
    });
    const chunks: Buffer[] = [];
    tlsSocket.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    tlsSocket.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const boundary = bytes.indexOf('\r\n\r\n');
      if (boundary < 0) {
        reject(new Error('missing HTTP response header boundary'));
        return;
      }
      const headerLines = bytes.subarray(0, boundary).toString('latin1').split('\r\n');
      const statusCode = Number.parseInt(headerLines[0]?.split(' ')[1] ?? '', 10);
      const headers: Record<string, string> = {};
      for (const line of headerLines.slice(1)) {
        const separator = line.indexOf(':');
        if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
      }
      resolve({ statusCode, headers, body: bytes.subarray(boundary + 4) });
    });
    tlsSocket.on('error', reject);
  });
}

function abortHttpsRequestOnFirstResponse(socket: Socket, ca: CertificateAuthority, body: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: CLIENT_HOST, ca: ca.certPem }, () => {
      tlsSocket.write(
        [
          'POST /v1/messages HTTP/1.1',
          `Host: ${CLIENT_HOST}`,
          'Connection: close',
          'Content-Type: application/json',
          `Content-Length: ${body.length}`,
          `x-api-key: ${FAKE_KEY}`,
          '',
          '',
        ].join('\r\n'),
      );
      tlsSocket.write(body);
    });
    tlsSocket.once('data', () => {
      tlsSocket.destroy();
      resolve();
    });
    tlsSocket.once('error', reject);
  });
}

describe('MITM LLM metrics integration', () => {
  let proxy: MitmProxy | undefined;
  let upstream: TestUpstream | undefined;
  let tempDir: string;
  let socketPath: string;
  let ca: CertificateAuthority;
  let unsubscribe: (() => void) | undefined;
  let exchanges: LlmExchangeCompleted[];
  let captureWriter: TrajectoryCaptureWriter | undefined;

  beforeEach(() => {
    resetLlmMetricsEventBus();
    exchanges = [];
    unsubscribe = getLlmMetricsEventBus().subscribe((exchange) => exchanges.push(exchange));
    tempDir = mkdtempSync(join(tmpdir(), 'mitm-llm-metrics-'));
    socketPath = join(tempDir, 'proxy.sock');
    ca = loadOrCreateCA(join(tempDir, 'ca'));
  });

  afterEach(async () => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (proxy) {
      await proxy.stop();
      proxy = undefined;
    }
    if (upstream) {
      await closeServer(upstream.server);
      upstream = undefined;
    }
    if (captureWriter) {
      await captureWriter.close();
      captureWriter = undefined;
    }
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  it('captures rewritten Anthropic SSE exactly once and releases attribution only after finalization', async () => {
    let releaseFirstResponse: (() => void) | undefined;
    let notifyFirstRequest: (() => void) | undefined;
    const firstRequestSeen = new Promise<void>((resolve) => {
      notifyFirstRequest = resolve;
    });
    upstream = await createUpstream((_request, response) => {
      if (releaseFirstResponse === undefined) {
        notifyFirstRequest?.();
        releaseFirstResponse = () =>
          sendFixedResponse(response, Buffer.from(ANTHROPIC_SSE), {
            'Content-Type': 'text/event-stream',
            'request-id': 'request_test',
          });
        return;
      }
      sendFixedResponse(response, Buffer.from(ANTHROPIC_SSE), {
        'Content-Type': 'text/event-stream',
        'request-id': 'request_test',
      });
    });
    proxy = createMitmProxy({
      socketPath,
      ca,
      statisticsEnabled: true,
      providerProfileId: 'native-test',
      providers: [{ config: metricsProvider(upstream.port), fakeKey: FAKE_KEY, realKey: REAL_KEY }],
    });
    await proxy.start();

    const lease = proxy.beginMetricsInvocation('http://127.0.0.1:9999', {
      sessionId: 'session-exact',
      turnId: 'turn-exact',
      agentId: 'claude-code',
    });
    const firstConnect = await sendConnect(socketPath, CLIENT_HOST, 443, {
      'Proxy-Authorization': proxyAuthorization(lease),
    });
    expect(firstConnect.statusCode).toBe(200);
    expect(firstConnect.socket).not.toBeNull();
    const requestBody = Buffer.from(JSON.stringify({ model: 'claude-requested', stream: true, messages: [] }));
    const firstResponse = makeHttpsBufferRequest(firstConnect.socket as Socket, ca, requestBody);
    await firstRequestSeen;

    let leaseDrained = false;
    const leaseDrain = lease.end().then(() => {
      leaseDrained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(leaseDrained).toBe(false);
    releaseFirstResponse?.();
    expect((await firstResponse).body.toString()).toBe(ANTHROPIC_SSE);
    await leaseDrain;

    await expect.poll(() => exchanges.length).toBe(1);
    const exact = exchanges[0];
    expect(exact.attribution).toMatchObject({ quality: 'exact', sessionId: 'session-exact', turnId: 'turn-exact' });
    expect(exact.identity.requestedModel).toEqual({ value: 'claude-requested', source: 'request' });
    expect(exact.identity.forwardedModel).toEqual({ value: 'claude-forwarded', source: 'forwarded_request' });
    expect(exact.identity.responseModel).toEqual({ value: 'claude-served', source: 'protocol_response' });
    expect(exact.identity.servedModel).toEqual({ value: null, source: 'not_exposed' });
    expect(exact.responseMetadata).toMatchObject({
      providerRequestId: 'request_test',
      providerResponseId: 'msg_test',
      gatewayGenerationId: null,
      actualServiceTier: 'priority',
    });
    expect(exact.usage).toMatchObject({
      inputTokensReported: 100,
      inputTokensTotal: 130,
      outputTokensTotal: 50,
      thinkingTokens: 30,
      nonThinkingOutputTokens: 20,
      canonicalTotalTokens: 180,
      usageCompleteness: 'complete',
    });
    expect(exact.outcome).toMatchObject({ responseStatus: 200, termination: 'stop', refusal: false });
    expect(exact.transportAttempts).toHaveLength(1);
    expect(exact.transportAttempts[0]).toMatchObject({ ordinal: 1, responseStatus: 200, outcome: 'response' });
    expect(exact.transportAttempts[0]?.endedOffsetMs).toBeGreaterThanOrEqual(
      exact.transportAttempts[0]?.startedOffsetMs ?? Number.POSITIVE_INFINITY,
    );
    expect(exact.timing.firstUpstreamBodyByteOffsetMs).not.toBeNull();
    expect(exact.timing.firstReasoningEventOffsetMs).not.toBeNull();
    expect(exact.timing.firstOutputEventOffsetMs).toBeGreaterThanOrEqual(
      exact.timing.firstReasoningEventOffsetMs ?? Number.POSITIVE_INFINITY,
    );
    expect(exact.timing.lastOutputEventOffsetMs).not.toBeNull();
    expect(exact.route).toEqual({
      logicalProvider: 'anthropic',
      providerProfileId: 'native-test',
      protocol: 'anthropic-messages',
      gatewayKind: 'opaque',
      clientRouteId: CLIENT_HOST,
      upstreamRouteId: 'anthropic:override',
    });
    expect(JSON.stringify(exact)).not.toContain('127.0.0.1');
    expect(JSON.parse(upstream.requests[0]?.body.toString() ?? '{}')).toMatchObject({ model: 'claude-forwarded' });
    expect(upstream.requests[0]?.headers['x-api-key']).toBe(REAL_KEY);

    const secondConnect = await sendConnect(socketPath, CLIENT_HOST, 443, {
      'Proxy-Authorization': proxyAuthorization(lease),
    });
    expect(secondConnect.socket).not.toBeNull();
    await makeHttpsBufferRequest(secondConnect.socket as Socket, ca, requestBody);
    await expect.poll(() => exchanges.length).toBe(2);
    expect(exchanges[1]?.attribution).toMatchObject({ quality: 'unattributed', sessionId: null, bundleId: null });
  });

  it('decodes gzip for observation while forwarding the original compressed bytes unchanged', async () => {
    const compressed = zlib.gzipSync(Buffer.from(ANTHROPIC_SSE));
    upstream = await createUpstream((_request, response) => {
      sendFixedResponse(response, compressed, {
        'Content-Type': 'text/event-stream',
        'Content-Encoding': 'gzip',
      });
    });
    proxy = createMitmProxy({
      socketPath,
      ca,
      statisticsEnabled: true,
      bundleId: 'bundle-fallback',
      providers: [{ config: metricsProvider(upstream.port), fakeKey: FAKE_KEY, realKey: REAL_KEY }],
    });
    await proxy.start();

    const { socket, statusCode } = await sendConnect(socketPath, CLIENT_HOST, 443);
    expect(statusCode).toBe(200);
    const requestBody = Buffer.from(JSON.stringify({ model: 'claude-requested', stream: true, messages: [] }));
    const response = await makeHttpsBufferRequest(socket as Socket, ca, requestBody);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.body).toEqual(compressed);
    await expect.poll(() => exchanges.length).toBe(1);
    expect(exchanges[0]?.attribution).toMatchObject({ quality: 'bundle_only', bundleId: 'bundle-fallback' });
    expect(exchanges[0]?.usage).toMatchObject({ inputTokensTotal: 130, outputTokensTotal: 50, thinkingTokens: 30 });
  });

  it('captures a built-in Google generateContent JSON response with minimal valid usage', async () => {
    const responseBody = Buffer.from(
      JSON.stringify({
        modelVersion: 'gemini-2.5-flash-001',
        responseId: 'google-json-response',
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hello' }] } }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
      }),
    );
    upstream = await createUpstream((_request, response) => {
      sendFixedResponse(response, responseBody, { 'Content-Type': 'application/json' });
    });
    proxy = createMitmProxy({
      socketPath,
      ca,
      statisticsEnabled: true,
      providers: [{ config: googleMetricsProvider(upstream.port), fakeKey: GOOGLE_FAKE_KEY, realKey: GOOGLE_REAL_KEY }],
    });
    await proxy.start();

    const { socket, statusCode } = await sendConnect(socketPath, GOOGLE_HOST, 443);
    expect(statusCode).toBe(200);
    const response = await makeHttpsBufferRequest(socket as Socket, ca, Buffer.from(JSON.stringify({ contents: [] })), {
      host: GOOGLE_HOST,
      path: '/v1beta/models/gemini-2.5-flash:generateContent',
      apiKeyHeader: 'x-goog-api-key',
      apiKey: GOOGLE_FAKE_KEY,
    });

    expect(response.body).toEqual(responseBody);
    await expect.poll(() => exchanges.length).toBe(1);
    expect(exchanges[0]?.route).toMatchObject({ logicalProvider: 'google', protocol: 'google-generate-content' });
    expect(exchanges[0]?.identity.requestedModel).toEqual({ value: 'gemini-2.5-flash', source: 'request' });
    expect(exchanges[0]?.usage).toMatchObject({
      inputTokensTotal: 4,
      toolUseInputTokens: 0,
      outputTokensTotal: 3,
      thinkingTokens: 0,
      providerTotalTokens: 7,
      canonicalTotalTokens: 7,
      usageCompleteness: 'complete',
    });
    expect(upstream.requests[0]?.headers['x-goog-api-key']).toBe(GOOGLE_REAL_KEY);
  });

  it('captures a built-in Google streamGenerateContent SSE response with minimal valid usage', async () => {
    const googleSse = [
      'data: {"modelVersion":"gemini-2.5-flash-001","responseId":"google-stream-response","candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}',
      '',
      '',
    ].join('\n');
    upstream = await createUpstream((_request, response) => {
      sendFixedResponse(response, Buffer.from(googleSse), { 'Content-Type': 'text/event-stream' });
    });
    proxy = createMitmProxy({
      socketPath,
      ca,
      statisticsEnabled: true,
      providers: [{ config: googleMetricsProvider(upstream.port), fakeKey: GOOGLE_FAKE_KEY, realKey: GOOGLE_REAL_KEY }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, GOOGLE_HOST, 443);
    const response = await makeHttpsBufferRequest(socket as Socket, ca, Buffer.from(JSON.stringify({ contents: [] })), {
      host: GOOGLE_HOST,
      path: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      apiKeyHeader: 'x-goog-api-key',
      apiKey: GOOGLE_FAKE_KEY,
    });

    expect(response.body.toString()).toBe(googleSse);
    await expect.poll(() => exchanges.length).toBe(1);
    expect(exchanges[0]?.identity.requestedModel).toEqual({ value: 'gemini-2.5-flash', source: 'request' });
    expect(exchanges[0]?.request.streaming).toBe(true);
    expect(exchanges[0]?.usage).toMatchObject({
      inputTokensTotal: 5,
      toolUseInputTokens: 0,
      outputTokensTotal: 2,
      thinkingTokens: 0,
      canonicalTotalTokens: 7,
      usageCompleteness: 'complete',
    });
  });

  it('keeps large compressed SSE observable and byte-identical with trajectory capture on and off', async () => {
    const largeSse = makeLargeCaptureCompatibleSse();
    const compressed = zlib.gzipSync(Buffer.from(largeSse));
    expect(Buffer.byteLength(largeSse)).toBeGreaterThan(8 * 1024 * 1024);
    expect(compressed.length).toBeGreaterThan(64 * 1024);
    upstream = await createUpstream((_request, response) => {
      sendFixedResponse(response, compressed, {
        'Content-Type': 'text/event-stream',
        'Content-Encoding': 'gzip',
      });
    });
    const captureSessionId = 'large-capture-and-metrics' as SessionId;
    captureWriter = createTrajectoryCaptureWriter({ capturesDir: join(tempDir, 'large-captures') });
    captureWriter.beginSession({ sessionId: captureSessionId });
    proxy = createMitmProxy({
      socketPath,
      ca,
      statisticsEnabled: true,
      capture: captureWriter,
      providers: [{ config: metricsProvider(upstream.port), fakeKey: FAKE_KEY, realKey: REAL_KEY }],
    });
    proxy.setCaptureSessionId(captureSessionId);
    await proxy.start();

    const requestBody = Buffer.from(JSON.stringify({ model: 'claude-requested', stream: true, messages: [] }));
    const capturedConnect = await sendConnect(socketPath, CLIENT_HOST, 443);
    const capturedResponse = await makeHttpsBufferRequest(capturedConnect.socket as Socket, ca, requestBody);
    expect(capturedResponse.body).toEqual(compressed);
    await expect.poll(() => exchanges.length, { timeout: 10_000 }).toBe(1);
    expect(exchanges[0]?.usage).toMatchObject({ inputTokensTotal: 8, outputTokensTotal: 4242 });
    expect(exchanges[0]?.qualityFlags).not.toContain('consumer-decoded-byte-limit');
    await captureWriter.endSession(captureSessionId);
    expect(captureWriter.stats()).toMatchObject({ written: 1, dropped: 0, openSessions: 0 });

    proxy.setCaptureSessionId(undefined);
    const uncapturedConnect = await sendConnect(socketPath, CLIENT_HOST, 443);
    const uncapturedResponse = await makeHttpsBufferRequest(uncapturedConnect.socket as Socket, ca, requestBody);
    expect(uncapturedResponse.body).toEqual(compressed);
    await expect.poll(() => exchanges.length, { timeout: 10_000 }).toBe(2);
    expect(exchanges[1]?.usage).toMatchObject({ inputTokensTotal: 8, outputTokensTotal: 4242 });
  });

  it('finalizes once when the client aborts a live upstream stream', async () => {
    upstream = await createUpstream((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: message_start\ndata: {"type":"message_start","message":{"model":"claude"}}\n\n');
      // Intentionally leave the response open. Client close must tear down
      // the upstream request and settle the passive observation branch.
    });
    proxy = createMitmProxy({
      socketPath,
      ca,
      statisticsEnabled: true,
      providers: [{ config: metricsProvider(upstream.port), fakeKey: FAKE_KEY, realKey: REAL_KEY }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, CLIENT_HOST, 443);
    const requestBody = Buffer.from(JSON.stringify({ model: 'claude-requested', stream: true, messages: [] }));
    await abortHttpsRequestOnFirstResponse(socket as Socket, ca, requestBody);

    await expect.poll(() => exchanges.length).toBe(1);
    expect(exchanges[0]?.timing.clientAborted).toBe(true);
    expect(exchanges[0]?.outcome.termination).toBe('aborted');
    expect(exchanges[0]?.transportAttempts).toEqual([
      expect.objectContaining({ ordinal: 1, responseStatus: null, outcome: 'aborted' }),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(exchanges).toHaveLength(1);
  });

  it('finalizes once on an upstream transport error', async () => {
    const resetServer = http.createServer((request) => {
      request.resume();
      request.once('end', () => request.socket.destroy());
    });
    upstream = { server: resetServer, port: await listen(resetServer), requests: [] };
    proxy = createMitmProxy({
      socketPath,
      ca,
      statisticsEnabled: true,
      providers: [{ config: metricsProvider(upstream.port), fakeKey: FAKE_KEY, realKey: REAL_KEY }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, CLIENT_HOST, 443);
    const requestBody = Buffer.from(JSON.stringify({ model: 'claude-requested', stream: true, messages: [] }));
    const response = await makeHttpsBufferRequest(socket as Socket, ca, requestBody);

    expect(response.statusCode).toBe(502);
    await expect.poll(() => exchanges.length).toBe(1);
    expect(exchanges[0]?.transportAttempts).toEqual([
      expect.objectContaining({ ordinal: 1, responseStatus: null, outcome: 'error' }),
    ]);
    expect(exchanges[0]?.outcome).toMatchObject({ responseStatus: 502, termination: 'error' });
  });

  it('finalizes once when an auth retry cannot refresh its token', async () => {
    upstream = await createUpstream((_request, response) => {
      const body = Buffer.from('unauthorized');
      response.writeHead(401, { 'Content-Length': body.length, Connection: 'close' });
      response.end(body);
    });
    const tokenManager = {
      getValidAccessToken: async () => REAL_KEY,
      handleAuthFailure: async () => null,
    } as unknown as OAuthTokenManager;
    proxy = createMitmProxy({
      socketPath,
      ca,
      statisticsEnabled: true,
      providers: [{ config: metricsProvider(upstream.port), fakeKey: FAKE_KEY, realKey: REAL_KEY, tokenManager }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, CLIENT_HOST, 443);
    const requestBody = Buffer.from(JSON.stringify({ model: 'claude-requested', stream: true, messages: [] }));
    const response = await makeHttpsBufferRequest(socket as Socket, ca, requestBody);

    expect(response.statusCode).toBe(401);
    await expect.poll(() => exchanges.length).toBe(1);
    expect(exchanges[0]?.transportAttempts).toEqual([
      expect.objectContaining({ ordinal: 1, responseStatus: 401, outcome: 'auth_retry' }),
    ]);
    expect(exchanges[0]?.outcome).toMatchObject({ responseStatus: 401, termination: 'error' });
    expect(exchanges[0]?.qualityFlags).toContain('response_body_not_observed');
  });

  it('aborts and drains an active exact observation during proxy stop', async () => {
    let notifyRequest: (() => void) | undefined;
    const requestSeen = new Promise<void>((resolve) => {
      notifyRequest = resolve;
    });
    upstream = await createUpstream(() => {
      notifyRequest?.();
      // Hold the request without response headers until proxy.stop().
    });
    proxy = createMitmProxy({
      socketPath,
      ca,
      statisticsEnabled: true,
      providers: [{ config: metricsProvider(upstream.port), fakeKey: FAKE_KEY, realKey: REAL_KEY }],
    });
    await proxy.start();
    const lease = proxy.beginMetricsInvocation('http://127.0.0.1:9999', { sessionId: 'session-stop' });
    const { socket } = await sendConnect(socketPath, CLIENT_HOST, 443, {
      'Proxy-Authorization': proxyAuthorization(lease),
    });
    const requestBody = Buffer.from(JSON.stringify({ model: 'claude-requested', stream: true, messages: [] }));
    const pendingResponse = makeHttpsBufferRequest(socket as Socket, ca, requestBody).catch(() => undefined);
    await requestSeen;

    await proxy.stop();
    proxy = undefined;
    await lease.end();
    await pendingResponse;

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.attribution).toMatchObject({ quality: 'exact', sessionId: 'session-stop' });
    expect(exchanges[0]?.qualityFlags).toContain('proxy_stopped');
    expect(exchanges[0]?.outcome.termination).toBe('aborted');
    expect(exchanges[0]?.transportAttempts).toEqual([
      expect.objectContaining({ ordinal: 1, responseStatus: null, outcome: 'aborted' }),
    ]);
  });

  it('captures trajectory and metrics from the same response without semantic coupling', async () => {
    upstream = await createUpstream((_request, response) => {
      sendFixedResponse(response, Buffer.from(CAPTURE_COMPATIBLE_SSE), { 'Content-Type': 'text/event-stream' });
    });
    const captureSessionId = 'capture-and-metrics' as SessionId;
    captureWriter = createTrajectoryCaptureWriter({ capturesDir: join(tempDir, 'captures') });
    captureWriter.beginSession({ sessionId: captureSessionId });
    proxy = createMitmProxy({
      socketPath,
      ca,
      statisticsEnabled: true,
      capture: captureWriter,
      providers: [{ config: metricsProvider(upstream.port), fakeKey: FAKE_KEY, realKey: REAL_KEY }],
    });
    proxy.setCaptureSessionId(captureSessionId);
    await proxy.start();

    const { socket } = await sendConnect(socketPath, CLIENT_HOST, 443);
    const requestBody = Buffer.from(JSON.stringify({ model: 'claude-requested', stream: true, messages: [] }));
    const response = await makeHttpsBufferRequest(socket as Socket, ca, requestBody);
    expect(response.body.toString()).toBe(CAPTURE_COMPATIBLE_SSE);
    await expect.poll(() => exchanges.length).toBe(1);
    await captureWriter.endSession(captureSessionId);

    expect(captureWriter.stats()).toMatchObject({ written: 1, dropped: 0, queued: 0, openSessions: 0 });
    expect(exchanges[0]?.usage).toMatchObject({ inputTokensReported: 4, outputTokensTotal: 2 });
  });

  it('does not observe when statistics are disabled', async () => {
    upstream = await createUpstream((_request, response) => {
      sendFixedResponse(response, Buffer.from(ANTHROPIC_SSE), { 'Content-Type': 'text/event-stream' });
    });
    proxy = createMitmProxy({
      socketPath,
      ca,
      statisticsEnabled: false,
      providers: [{ config: metricsProvider(upstream.port), fakeKey: FAKE_KEY, realKey: REAL_KEY }],
    });
    await proxy.start();

    const { socket } = await sendConnect(socketPath, CLIENT_HOST, 443);
    const requestBody = Buffer.from(JSON.stringify({ model: 'claude-requested', stream: true, messages: [] }));
    const response = await makeHttpsBufferRequest(socket as Socket, ca, requestBody);

    expect(response.body.toString()).toBe(ANTHROPIC_SSE);
    expect(exchanges).toEqual([]);
  });

  it('rejects completion descriptors that are not an authorization subset at proxy construction', () => {
    const invalid: ProviderConfig = {
      ...anthropicProvider,
      allowedEndpoints: [],
    };
    expect(() =>
      createMitmProxy({
        socketPath,
        ca,
        statisticsEnabled: false,
        providers: [{ config: invalid, fakeKey: FAKE_KEY, realKey: REAL_KEY }],
      }),
    ).toThrow(/not a proven subset of authorization/);
  });
});
