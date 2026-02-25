import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { createSearchProvider, formatSearchResults, type SearchResult } from '../src/servers/search-providers.js';

let mockServer: HttpServer;
let baseUrl: string;

beforeAll(async () => {
  mockServer = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.url?.startsWith('/res/v1/web/search')) {
      // Brave mock
      res.end(
        JSON.stringify({
          web: {
            results: [
              { title: 'Brave Result 1', url: 'https://example.com/1', description: 'Brave snippet 1' },
              { title: 'Brave Result 2', url: 'https://example.com/2', description: 'Brave snippet 2' },
            ],
          },
        }),
      );
    } else if (req.url === '/search' && req.method === 'POST') {
      // Tavily mock
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        res.end(
          JSON.stringify({
            results: [{ title: 'Tavily Result 1', url: 'https://example.com/t1', content: 'Tavily content 1' }],
          }),
        );
      });
    } else if (req.url?.startsWith('/search.json')) {
      // SerpAPI mock
      res.end(
        JSON.stringify({
          organic_results: [{ title: 'Serp Result 1', link: 'https://example.com/s1', snippet: 'Serp snippet 1' }],
        }),
      );
    } else if (req.url?.startsWith('/error')) {
      res.writeHead(500);
      res.end('Internal Server Error');
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', resolve);
  });
  const addr = mockServer.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  mockServer.close();
});

describe('createSearchProvider', () => {
  it('returns null when no provider configured', () => {
    expect(createSearchProvider({})).toBeNull();
  });

  it('returns null for unknown provider', () => {
    expect(createSearchProvider({ WEB_SEARCH_PROVIDER: 'bing' })).toBeNull();
  });

  it('returns null when provider set but credentials missing', () => {
    expect(createSearchProvider({ WEB_SEARCH_PROVIDER: 'brave' })).toBeNull();
    expect(createSearchProvider({ WEB_SEARCH_PROVIDER: 'tavily' })).toBeNull();
    expect(createSearchProvider({ WEB_SEARCH_PROVIDER: 'serpapi' })).toBeNull();
  });

  it('creates brave provider when configured', () => {
    const provider = createSearchProvider({
      WEB_SEARCH_PROVIDER: 'brave',
      BRAVE_API_KEY: 'test-key',
    });
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('brave');
  });

  it('creates tavily provider when configured', () => {
    const provider = createSearchProvider({
      WEB_SEARCH_PROVIDER: 'tavily',
      TAVILY_API_KEY: 'test-key',
    });
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('tavily');
  });

  it('creates serpapi provider when configured', () => {
    const provider = createSearchProvider({
      WEB_SEARCH_PROVIDER: 'serpapi',
      SERPAPI_API_KEY: 'test-key',
    });
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('serpapi');
  });
});

describe('brave search', () => {
  it('returns formatted results', async () => {
    const provider = createSearchProvider({
      WEB_SEARCH_PROVIDER: 'brave',
      BRAVE_API_KEY: 'test-key',
      BRAVE_API_BASE_URL: baseUrl,
    })!;

    const results = await provider.search('test query', 5);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Brave Result 1');
    expect(results[0].url).toBe('https://example.com/1');
    expect(results[0].snippet).toBe('Brave snippet 1');
  });
});

describe('tavily search', () => {
  it('returns formatted results', async () => {
    const provider = createSearchProvider({
      WEB_SEARCH_PROVIDER: 'tavily',
      TAVILY_API_KEY: 'test-key',
      TAVILY_API_BASE_URL: baseUrl,
    })!;

    const results = await provider.search('test query', 5);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Tavily Result 1');
    expect(results[0].snippet).toBe('Tavily content 1');
  });
});

describe('serpapi search', () => {
  it('returns formatted results', async () => {
    const provider = createSearchProvider({
      WEB_SEARCH_PROVIDER: 'serpapi',
      SERPAPI_API_KEY: 'test-key',
      SERPAPI_API_BASE_URL: baseUrl,
    })!;

    const results = await provider.search('test query', 5);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Serp Result 1');
    expect(results[0].url).toBe('https://example.com/s1');
  });
});

describe('formatSearchResults', () => {
  it('formats results as numbered text', () => {
    const results: SearchResult[] = [
      { title: 'Result One', url: 'https://example.com/1', snippet: 'First snippet' },
      { title: 'Result Two', url: 'https://example.com/2', snippet: 'Second snippet' },
    ];

    const formatted = formatSearchResults('test query', results);
    expect(formatted).toContain('Search results for: test query');
    expect(formatted).toContain('1. Result One');
    expect(formatted).toContain('URL: https://example.com/1');
    expect(formatted).toContain('First snippet');
    expect(formatted).toContain('2. Result Two');
  });

  it('returns "no results" message for empty results', () => {
    const formatted = formatSearchResults('test query', []);
    expect(formatted).toContain('No results found for: test query');
  });

  it('omits empty snippets', () => {
    const results: SearchResult[] = [{ title: 'No Snippet', url: 'https://example.com/1', snippet: '' }];
    const formatted = formatSearchResults('test query', results);
    expect(formatted).toContain('1. No Snippet');
    expect(formatted).toContain('URL: https://example.com/1');
    // Should not contain any indented text after the URL (empty snippet should not generate a line)
    expect(formatted).not.toMatch(/URL: https:\/\/example\.com\/1\n {3}\S/);
  });
});
