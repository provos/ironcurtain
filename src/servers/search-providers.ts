/**
 * Web search provider abstraction.
 *
 * Supports Brave, Tavily, and SerpAPI.
 * Each provider is configured via environment variables injected through
 * the serverCredentials flow (never hardcoded or read from the config directly).
 */

const SEARCH_TIMEOUT_MS = 15_000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, maxResults: number): Promise<SearchResult[]>;
}

// ─── Brave ───────────────────────────────────────────────────

class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? 'https://api.search.brave.com';
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL('/res/v1/web/search', this.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));

    const response = await fetchWithTimeout(url.toString(), {
      headers: { 'X-Subscription-Token': this.apiKey, Accept: 'application/json' },
    });
    const data = (await response.json()) as { web?: { results?: BraveResult[] } };
    return (data.web?.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
    }));
  }
}

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

// ─── Tavily ──────────────────────────────────────────────────

class TavilySearchProvider implements SearchProvider {
  readonly name = 'tavily';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? 'https://api.tavily.com';
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL('/search', this.baseUrl);

    const response = await fetchWithTimeout(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: maxResults,
      }),
    });
    const data = (await response.json()) as { results?: TavilyResult[] };
    return (data.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
    }));
  }
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

// ─── SerpAPI ─────────────────────────────────────────────────

class SerpApiSearchProvider implements SearchProvider {
  readonly name = 'serpapi';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? 'https://serpapi.com';
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL('/search.json', this.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('num', String(maxResults));

    const response = await fetchWithTimeout(url.toString(), {
      headers: { Accept: 'application/json' },
    });
    const data = (await response.json()) as { organic_results?: SerpApiResult[] };
    return (data.organic_results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? '',
      url: r.link ?? '',
      snippet: r.snippet ?? '',
    }));
  }
}

interface SerpApiResult {
  title?: string;
  link?: string;
  snippet?: string;
}

// ─── Factory ─────────────────────────────────────────────────

/**
 * Creates a search provider from environment variables.
 * Returns null if no provider is configured or credentials are missing.
 *
 * Base URL overrides (e.g. BRAVE_API_BASE_URL) are used for testing against
 * local mock servers. These env vars are injected by the trusted process via
 * serverCredentials — if that layer is compromised, all bets are off regardless.
 */
export function createSearchProvider(env: Record<string, string | undefined>): SearchProvider | null {
  const provider = env.WEB_SEARCH_PROVIDER;
  if (!provider) return null;

  switch (provider) {
    case 'brave': {
      const apiKey = env.BRAVE_API_KEY;
      if (!apiKey) return null;
      return new BraveSearchProvider(apiKey, env.BRAVE_API_BASE_URL);
    }
    case 'tavily': {
      const apiKey = env.TAVILY_API_KEY;
      if (!apiKey) return null;
      return new TavilySearchProvider(apiKey, env.TAVILY_API_BASE_URL);
    }
    case 'serpapi': {
      const apiKey = env.SERPAPI_API_KEY;
      if (!apiKey) return null;
      return new SerpApiSearchProvider(apiKey, env.SERPAPI_API_BASE_URL);
    }
    default:
      return null;
  }
}

// ─── Format helper ───────────────────────────────────────────

/**
 * Formats search results into numbered text output suitable for LLM consumption.
 */
export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No results found for: ${query}`;
  }

  const lines = [`Search results for: ${query}`, ''];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   URL: ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// ─── Internal helpers ────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Search API returned ${response.status}: ${response.statusText}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
