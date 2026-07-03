/**
 * Shared TLS-CONNECT harness for MITM-proxy end-to-end tests.
 *
 * Extracts the CONNECT + TLS-handshake + manual HTTP request/response helpers
 * used by the token-stream and OpenRouter macro suites so they share one
 * implementation. All servers bind to 127.0.0.1 on an ephemeral port; the
 * proxy's `dnsLookup` is overridden to resolve every hostname to loopback so a
 * canonical host (`openrouter.ai`) reaches a local fake upstream.
 */

import * as http from 'node:http';
import * as tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import type { CertificateAuthority } from '../../src/docker/ca.js';
import type { MitmProxyOptions } from '../../src/docker/mitm-proxy.js';

/** DNS lookup that resolves all hostnames to 127.0.0.1 for testing. */
export const localhostDnsLookup: MitmProxyOptions['dnsLookup'] = (_hostname, opts, cb) => {
  if ((opts as { all?: boolean }).all) {
    cb(null, [{ address: '127.0.0.1', family: 4 }] as never);
  } else {
    cb(null, '127.0.0.1', 4);
  }
};

/** Sends a CONNECT request to the proxy via UDS, returns client socket + status. */
export function sendConnect(
  socketPath: string,
  host: string,
  port: number,
): Promise<{ socket: import('node:net').Socket | null; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'CONNECT', path: `${host}:${port}` });
    req.on('connect', (res, socket) => resolve({ socket, statusCode: res.statusCode ?? 0 }));
    req.on('error', reject);
    req.on('response', (res) => resolve({ socket: null, statusCode: res.statusCode ?? 0 }));
    req.end();
  });
}

export interface HttpsResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Performs a TLS handshake on an already-CONNECT'd socket, then sends an HTTP
 * request over it and collects the full response body (the fake upstream ends
 * the connection, so `end` fires once the body is complete).
 */
export function makeHttpsRequest(
  socket: import('node:net').Socket,
  ca: CertificateAuthority,
  host: string,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: host, ca: ca.certPem }, () => {
      const method = options.method ?? 'GET';
      const path = options.path ?? '/';
      const headers: Record<string, string> = { host, connection: 'close', ...options.headers };
      if (options.body) headers['content-length'] = Buffer.byteLength(options.body).toString();

      const headerLines = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      tlsSocket.write(`${method} ${path} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
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
        resolve({ statusCode, headers: responseHeaders, body: bodyParts.join('\r\n\r\n') });
      });
      tlsSocket.on('error', reject);
    });
    tlsSocket.on('error', reject);
  });
}

/** Starts a local HTTP server that returns a fixed SSE (or other) response. */
export async function createSseUpstream(
  ssePayload: string,
  contentType = 'text/event-stream',
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(ssePayload);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  return { server, port };
}

/** A single captured upstream request (method, path, headers, parsed JSON body). */
export interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
  rawBody: string;
}

/**
 * A configurable fake OpenRouter upstream. Captures every request it receives
 * and lets the test decide the response per request (status + body/SSE),
 * defaulting to echoing the received body as JSON. Used to assert the
 * post-rewrite body, the swapped auth header, allowlist behavior, and
 * count_tokens passthrough.
 */
export interface FakeUpstream {
  server: http.Server;
  port: number;
  requests: () => CapturedRequest[];
}

export type UpstreamResponder = (req: CapturedRequest) => {
  status?: number;
  contentType?: string;
  body: string;
};

/** Parses a request body as JSON, returning `{}` for empty or invalid input. */
function parseJsonBody(rawBody: string): Record<string, unknown> {
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function createFakeUpstream(responder?: UpstreamResponder): Promise<FakeUpstream> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString();
      const body = parseJsonBody(rawBody);
      const record: CapturedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body,
        rawBody,
      };
      captured.push(record);
      const reply = responder
        ? responder(record)
        : { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, echo: body }) };
      res.writeHead(reply.status ?? 200, { 'Content-Type': reply.contentType ?? 'application/json' });
      res.end(reply.body);
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  return { server, port, requests: () => captured };
}
