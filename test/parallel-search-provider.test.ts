import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchProvider } from '../src/servers/search-providers.js';
import { VERSION } from '../src/version.js';

type Reply = (request: IncomingMessage, response: ServerResponse, id: number) => void;
type ObservedRequest = {
  method: string | undefined;
  rpc: string | undefined;
  userAgent: string | undefined;
  session: string | undefined;
};

const endpoint = 'https://mcp.parallel.ai/mcp';
const toolResult = {
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        results: [
          { url: 'https://example.com/docs', title: 'API docs', excerpts: ['First passage.', 'Second passage.'] },
          { url: 'https://example.com/reference', title: 'Reference', excerpts: [] },
        ],
      }),
    },
  ],
};

function sendResult(response: ServerResponse, id: number, result: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

describe('Parallel Search MCP provider', () => {
  const provider = createSearchProvider({ WEB_SEARCH_PROVIDER: 'parallel' });
  if (!provider) throw new Error('Parallel provider should be available without a key');
  let requests: ObservedRequest[];
  let args: unknown;
  let requestedUrls: string[];
  let otherOriginHits: number;
  let reply: Reply;
  let teardown: (response: ServerResponse) => void;
  let server: ReturnType<typeof createServer>;
  let otherOrigin: ReturnType<typeof createServer>;
  let redirectTo: string;

  beforeEach(async () => {
    requests = [];
    requestedUrls = [];
    otherOriginHits = 0;
    reply = (_request, response, id) => sendResult(response, id, toolResult);
    teardown = (response) => response.writeHead(204).end();
    otherOrigin = createServer((_request, response) => {
      otherOriginHits++;
      response.writeHead(400).end();
    }).listen(0, '127.0.0.1');
    server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8').on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        const rpc = body
          ? (JSON.parse(body) as { id: number; method: string; params?: { name: string; arguments: unknown } })
          : undefined;
        requests.push({
          method: request.method,
          rpc: rpc?.method,
          userAgent: request.headers['user-agent'],
          session: request.headers['mcp-session-id'] as string | undefined,
        });
        if (request.method === 'GET') {
          response.writeHead(405).end();
        } else if (request.method === 'DELETE') {
          teardown(response);
        } else if (rpc?.method === 'initialize') {
          response.setHeader('Mcp-Session-Id', 'test-session');
          sendResult(response, rpc.id, {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          });
        } else if (rpc?.method === 'notifications/initialized') {
          response.writeHead(202).end();
        } else if (rpc?.method === 'tools/call' && rpc.params?.name === 'web_search') {
          args = rpc.params.arguments;
          reply(request, response, rpc.id);
        } else {
          response.writeHead(400).end();
        }
      });
    }).listen(0, '127.0.0.1');
    await Promise.all([once(server, 'listening'), once(otherOrigin, 'listening')]);
    const localAddress = server.address();
    const otherAddress = otherOrigin.address();
    if (!localAddress || typeof localAddress === 'string' || !otherAddress || typeof otherAddress === 'string') {
      throw new Error('Expected HTTP fixture addresses');
    }
    const localEndpoint = `http://127.0.0.1:${localAddress.port}/mcp`;
    redirectTo = `http://127.0.0.1:${otherAddress.port}/mcp`;
    const fetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      requestedUrls.push(url);
      if (url !== endpoint) throw new Error('Unexpected MCP destination');
      return fetch(localEndpoint, init);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      [server, otherOrigin].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
            server.closeAllConnections();
          }),
      ),
    );
  });

  it('returns the requested number of links and excerpts, with the project User-Agent on every request', async () => {
    const query = 'What does readFileSync return when an encoding is specified?';
    await expect(provider.search(query, 1)).resolves.toEqual([
      { title: 'API docs', url: 'https://example.com/docs', snippet: 'First passage. Second passage.' },
    ]);
    expect(args).toEqual({ objective: query, search_queries: [query] });
    const methods = requests.map(({ method, rpc }) => rpc ?? method);
    expect(methods.sort()).toEqual(['DELETE', 'GET', 'initialize', 'notifications/initialized', 'tools/call']);
    expect(requests.map(({ userAgent }) => userAgent)).toEqual(requests.map(() => `IronCurtain/${VERSION}`));
    expect(requestedUrls.every((url) => url === endpoint)).toBe(true);
  });

  it('keeps a long query inside the provider limits', async () => {
    const query = 'Node.js documentation about filesystem APIs and their return values. '.repeat(100);
    await provider.search(query, 1);
    expect(args).toEqual({ objective: query.slice(0, 5000), search_queries: [query.slice(0, 200)] });
  });

  it('refuses redirects on the search itself and on teardown', async () => {
    reply = (_request, response) => response.writeHead(307, { Location: redirectTo }).end();
    teardown = (response) => response.writeHead(307, { Location: redirectTo }).end();

    await expect(provider.search('public docs', 1)).rejects.toThrow('fetch failed');

    expect(requests).toContainEqual(expect.objectContaining({ method: 'DELETE', session: 'test-session' }));
    expect(otherOriginHits).toBe(0);
  });

  it('caps decoded response bytes before handing a compressed body to the SDK', async () => {
    const body = gzipSync(' '.repeat(10 * 1024 * 1024 + 1));
    reply = (_request, response) =>
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }).end(body);

    await expect(provider.search('public docs', 1)).rejects.toThrow('Parallel Search response exceeds');
  });

  it.each([false, true])('closes a held-open SSE reply and bounds stalled teardown (RPC error=%s)', async (isError) => {
    let observeClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      observeClosed = resolve;
    });
    reply = (_request, response, id) => {
      response.on('close', observeClosed);
      response.writeHead(200, { 'Content-Type': 'Text/Event-Stream; charset=utf-8' });
      const result = isError
        ? { error: { code: -32000, message: 'Fixture search failed' } }
        : { result: { content: [], structuredContent: { results: [] } } };
      response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, ...result })}\n\n`);
    };
    teardown = () => undefined;

    const start = performance.now();
    const search = provider.search('public docs', 1);
    if (isError) {
      await expect(search).rejects.toThrow('Fixture search failed');
    } else {
      await expect(search).resolves.toEqual([]);
    }
    await closed;
    expect(performance.now() - start).toBeLessThan(4000);
  });

  it('aborts an in-flight search', async () => {
    let markReceived: () => void = () => undefined;
    const received = new Promise<void>((resolve) => {
      markReceived = resolve;
    });
    reply = () => markReceived();
    const controller = new AbortController();
    const search = provider.search('public docs', 1, controller.signal);
    await received;
    controller.abort();

    await expect(search).rejects.toMatchObject({ name: 'AbortError' });
  });
});
