import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSearchProvider } from '../src/servers/search-providers.js';
import { VERSION } from '../src/version.js';

type Observed = { url: string | undefined; headers: IncomingMessage['headers']; body: unknown };
type Reply = (response: ServerResponse) => void;

const payload = {
  results: [
    { title: 'API docs', url: 'https://example.com/docs', snippet: 'First passage.', description: '' },
    { title: '', url: 'https://example.com/reference', description: 'Reference page.' },
  ],
};

describe('Keenable search provider', () => {
  let server: ReturnType<typeof createServer>;
  let otherOrigin: ReturnType<typeof createServer>;
  let baseUrl: string;
  let otherUrl: string;
  let observed: Observed[];
  let otherOriginHits: number;
  let reply: Reply;

  beforeEach(async () => {
    observed = [];
    otherOriginHits = 0;
    reply = (response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    otherOrigin = createServer((_request, response) => {
      otherOriginHits++;
      response.writeHead(200).end('{"results":[]}');
    }).listen(0, '127.0.0.1');
    server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
      request.on('end', () => {
        observed.push({ url: request.url, headers: request.headers, body: body ? JSON.parse(body) : undefined });
        reply(response);
      });
    }).listen(0, '127.0.0.1');
    await Promise.all([once(server, 'listening'), once(otherOrigin, 'listening')]);
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    otherUrl = `http://127.0.0.1:${(otherOrigin.address() as { port: number }).port}`;
  });

  afterEach(() => {
    server.close();
    otherOrigin.close();
  });

  it('is available without a key and uses the keyless endpoint with an app title', async () => {
    const provider = createSearchProvider({ WEB_SEARCH_PROVIDER: 'keenable', KEENABLE_API_BASE_URL: baseUrl });
    if (!provider) throw new Error('Keenable provider should be available without a key');

    const results = await provider.search('node fs readFileSync', 5);

    expect(provider.name).toBe('keenable');
    expect(observed).toHaveLength(1);
    expect(observed[0].url).toBe('/v1/search/public');
    expect(observed[0].headers['x-keenable-title']).toBe('IronCurtain');
    expect(observed[0].headers['x-api-key']).toBeUndefined();
    expect(observed[0].headers['user-agent']).toBe(`IronCurtain/${VERSION}`);
    expect(observed[0].body).toEqual({ query: 'node fs readFileSync', max_results: 5 });
    expect(results).toEqual([
      { title: 'API docs', url: 'https://example.com/docs', snippet: 'First passage.' },
      { title: 'https://example.com/reference', url: 'https://example.com/reference', snippet: 'Reference page.' },
    ]);
  });

  it('uses the keyed endpoint when KEENABLE_API_KEY is set', async () => {
    const provider = createSearchProvider({
      WEB_SEARCH_PROVIDER: 'keenable',
      KEENABLE_API_KEY: 'test-key',
      KEENABLE_API_BASE_URL: baseUrl,
    });

    const results = await provider?.search('query', 1);

    expect(observed[0].url).toBe('/v1/search');
    expect(observed[0].headers['x-api-key']).toBe('test-key');
    expect(observed[0].headers['x-keenable-title']).toBeUndefined();
    expect(results).toHaveLength(1);
  });

  it('reports rate limits and HTTP errors', async () => {
    const provider = createSearchProvider({ WEB_SEARCH_PROVIDER: 'keenable', KEENABLE_API_BASE_URL: baseUrl });
    reply = (response) => response.writeHead(429).end('slow down');
    await expect(provider?.search('q', 5)).rejects.toThrow('Keenable rate limit reached (HTTP 429)');

    reply = (response) => response.writeHead(500).end('boom');
    await expect(provider?.search('q', 5)).rejects.toThrow('Search API returned 500');
  });

  it('does not follow redirects to another origin', async () => {
    const provider = createSearchProvider({
      WEB_SEARCH_PROVIDER: 'keenable',
      KEENABLE_API_KEY: 'test-key',
      KEENABLE_API_BASE_URL: baseUrl,
    });
    reply = (response) => response.writeHead(307, { Location: `${otherUrl}/v1/search` }).end();

    await expect(provider?.search('q', 5)).rejects.toThrow();
    expect(otherOriginHits).toBe(0);
  });

  it('rejects malformed responses and honors the abort signal', async () => {
    const provider = createSearchProvider({ WEB_SEARCH_PROVIDER: 'keenable', KEENABLE_API_BASE_URL: baseUrl });
    reply = (response) => response.writeHead(200).end(JSON.stringify({ results: [{ url: 'not a url' }] }));
    await expect(provider?.search('q', 5)).rejects.toThrow();

    const controller = new AbortController();
    controller.abort();
    await expect(provider?.search('q', 5, controller.signal)).rejects.toThrow();
  });
});
