/**
 * HTTP fetch and web search MCP server.
 *
 * Exposes two tools:
 * - `http_fetch` (GET-only) retrieves web content, converting HTML to markdown by default.
 * - `web_search` queries a configured search provider (Brave, Tavily, or SerpAPI).
 *
 * Security:
 * - SSRF protection is handled by the policy engine (IP addresses blocked structurally)
 * - User-Agent header is always injected and cannot be overridden by the agent
 * - Redirects are followed (up to 5 hops) without per-hop policy re-evaluation
 * - Responses are capped at 10 MB; requests time out after 30 seconds
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { VERSION } from '../version.js';
import { createSearchProvider, formatSearchResults } from './search-providers.js';

const USER_AGENT = `IronCurtain/${VERSION} (AI Agent Runtime)`;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const REQUEST_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_LENGTH = 5000;
const MAX_READABILITY_BYTES = 1_000_000; // 1 MB — skip DOM parsing above this
const MAX_READABILITY_ELEMS = 10_000; // bail if document has too many elements

type OutputFormat = 'markdown' | 'text' | 'html';
const VALID_FORMATS: readonly OutputFormat[] = ['markdown', 'text', 'html'];

function isValidFormat(value: unknown): value is OutputFormat {
  return typeof value === 'string' && VALID_FORMATS.includes(value as OutputFormat);
}

/** Tags that carry boilerplate or non-visible content, stripped before conversion. */
const BOILERPLATE_TAGS = ['script', 'style', 'nav', 'footer', 'aside', 'noscript', 'iframe'] as const;

/** Regex for stripping boilerplate tags and their content (used in regex fallback path). */
const BOILERPLATE_TAG_RE = new RegExp(`<(${BOILERPLATE_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi');

const turndown = new TurndownService({ headingStyle: 'atx' });
turndown.remove([...BOILERPLATE_TAGS]);

const searchProvider = createSearchProvider(process.env);

/**
 * Performs the actual HTTP GET request with redirect following,
 * timeout, and response size limits.
 */
async function doFetch(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...headers,
        'User-Agent': USER_AGENT, // Injected last — agent cannot override
      },
      signal: controller.signal,
      redirect: 'follow',
      // @ts-expect-error -- undici-specific option for redirect limit
      maxRedirections: MAX_REDIRECTS,
    });

    // Read response body with size limit
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();

    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          void reader.cancel();
          throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} byte limit`);
        }
        chunks.push(value);
      }
    }

    const body = new TextDecoder().decode(chunks.length === 1 ? chunks[0] : concatUint8Arrays(chunks));

    // Extract selected response headers
    const responseHeaders: Record<string, string> = {};
    for (const key of ['content-type', 'content-length', 'last-modified', 'etag']) {
      const value = response.headers.get(key);
      if (value) responseHeaders[key] = value;
    }

    return { status: response.status, headers: responseHeaders, body };
  } finally {
    clearTimeout(timeout);
  }
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.byteLength;
  }
  return result;
}

/**
 * Converts HTML to markdown using turndown.
 * Falls back to raw HTML if turndown throws.
 */
function htmlToMarkdown(html: string): string {
  try {
    return turndown.turndown(html);
  } catch {
    return html;
  }
}

/**
 * Regex-based HTML-to-text fallback. Loops boilerplate tag removal until
 * stable to prevent nested-tag bypasses (e.g. "<scri<script>...</script>pt>"
 * reconstructing after a single pass), then strips all remaining tags.
 */
export function stripHtmlFallback(html: string): string {
  let stripped = html;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(BOILERPLATE_TAG_RE, '');
  } while (stripped !== prev);
  return stripped
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strips boilerplate elements and returns plain text using JSDOM for
 * reliable entity decoding and element removal.
 */
function htmlToText(html: string): string {
  let dom: JSDOM | undefined;
  try {
    dom = new JSDOM(html);
    const doc = dom.window.document;
    for (const el of doc.querySelectorAll(BOILERPLATE_TAGS.join(','))) {
      el.remove();
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: DOM body may be null at runtime
    return (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    return stripHtmlFallback(html);
  } finally {
    dom?.window.close();
  }
}

interface ReadabilityArticle {
  title: string;
  byline: string | null;
  content: string;
  textContent: string;
}

/**
 * Extracts main article content using Mozilla Readability.
 * Returns null if the page is not article-like or extraction fails.
 *
 * Guards against DoS: skips documents over MAX_READABILITY_BYTES and
 * uses Readability's maxElemsToParse to bail on high-element-count pages.
 */
function extractWithReadability(html: string, url: string): ReadabilityArticle | null {
  let dom: JSDOM | undefined;
  try {
    if (html.length > MAX_READABILITY_BYTES) return null;

    dom = new JSDOM(html, { url });

    const doc = dom.window.document;
    if (!isProbablyReaderable(doc)) return null;

    const result = new Readability(doc, { maxElemsToParse: MAX_READABILITY_ELEMS }).parse();
    if (!result) return null;

    return {
      title: result.title ?? '',
      byline: result.byline ?? null,
      content: result.content ?? '',
      textContent: result.textContent ?? '',
    };
  } catch {
    return null;
  } finally {
    dom?.window.close();
  }
}

/**
 * Builds a metadata header from Readability results.
 * Only includes non-empty fields.
 */
function readabilityMetadataHeader(article: ReadabilityArticle): string {
  const lines: string[] = [];
  if (article.title) lines.push(`Title: ${article.title}`);
  if (article.byline) lines.push(`Byline: ${article.byline}`);
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n\n';
}

/**
 * Converts a response body to the requested output format.
 * For HTML responses, attempts Readability extraction first, falling back
 * to turndown (markdown) or regex-based tag stripping (text).
 */
function formatResponseBody(body: string, isHtml: boolean, format: OutputFormat, url: string): string {
  if (format === 'html' || !isHtml) return body;

  const article = extractWithReadability(body, url);
  const header = article ? readabilityMetadataHeader(article) : '';

  if (format === 'text') {
    const content = article ? article.textContent : htmlToText(body);
    return header + content;
  }

  // markdown (default)
  const content = article ? htmlToMarkdown(article.content) : htmlToMarkdown(body);
  return header + content;
}

// eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional use of low-level Server for raw JSON schema passthrough
const server = new Server({ name: 'ironcurtain-fetch', version: VERSION }, { capabilities: { tools: {} } });

// eslint-disable-next-line @typescript-eslint/require-await -- handler interface requires async
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'http_fetch',
      description: 'Fetch content from a URL via HTTP GET',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          headers: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'HTTP headers',
          },
          max_length: {
            type: 'number',
            default: DEFAULT_MAX_LENGTH,
            description: 'Maximum response body length in characters',
          },
          format: {
            type: 'string',
            enum: ['markdown', 'text', 'html'],
            default: 'markdown',
            description: 'Output format: markdown (default), text (stripped tags), or html (raw)',
          },
          timeout: {
            type: 'number',
            default: 30,
            description: 'Request timeout in seconds (5–60)',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'web_search',
      description: 'Search the web for information using a configured search provider',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'The search query' },
          max_results: {
            type: 'number',
            default: 5,
            description: 'Maximum number of results to return (1–20)',
          },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  switch (req.params.name) {
    case 'http_fetch':
      return handleHttpFetch(req.params.arguments);
    case 'web_search':
      return handleWebSearch(req.params.arguments);
    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
  }
});

async function handleHttpFetch(
  args: Record<string, unknown> | undefined,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const url = args?.url as string | undefined;
  if (!url || typeof url !== 'string') {
    return {
      content: [{ type: 'text', text: 'Missing required parameter: url' }],
      isError: true,
    };
  }

  const requestHeaders = (args?.headers ?? {}) as Record<string, string>;
  const rawMaxLength = args?.max_length;
  const maxLength =
    typeof rawMaxLength === 'number' && Number.isFinite(rawMaxLength)
      ? Math.max(0, Math.trunc(rawMaxLength))
      : DEFAULT_MAX_LENGTH;
  const rawFormat = args?.format;
  if (rawFormat !== undefined && !isValidFormat(rawFormat)) {
    return {
      content: [
        {
          type: 'text',
          text: `Invalid format: ${typeof rawFormat === 'string' ? rawFormat : JSON.stringify(rawFormat)}. Supported formats are: ${VALID_FORMATS.join(', ')}.`,
        },
      ],
      isError: true,
    };
  }
  const format: OutputFormat = rawFormat ?? 'markdown';
  const timeoutSec =
    typeof args?.timeout === 'number' && Number.isFinite(args.timeout) ? Math.min(60, Math.max(5, args.timeout)) : 30;

  try {
    const { status, headers, body } = await doFetch(url, requestHeaders, timeoutSec * 1000);

    const contentType = headers['content-type'] ?? '';
    const isHtml = contentType.includes('text/html');

    const processedBody = formatResponseBody(body, isHtml, format, url);

    // Truncate to max_length
    const truncated = processedBody.length > maxLength;
    const finalBody = truncated ? processedBody.slice(0, maxLength) + '\n\n[Truncated]' : processedBody;

    const result = [`Status: ${status}`, `Headers: ${JSON.stringify(headers)}`, '', finalBody].join('\n');

    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Fetch error: ${message}` }],
      isError: true,
    };
  }
}

async function handleWebSearch(
  args: Record<string, unknown> | undefined,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const query = args?.query as string | undefined;
  if (!query || typeof query !== 'string') {
    return {
      content: [{ type: 'text', text: 'Missing required parameter: query' }],
      isError: true,
    };
  }

  if (!searchProvider) {
    return {
      content: [
        {
          type: 'text',
          text:
            'Web search is not configured. Set a search provider in ~/.ironcurtain/config.json ' +
            'using "ironcurtain config" or by adding a webSearch section with provider and API key.',
        },
      ],
      isError: true,
    };
  }

  const rawMaxResults = args?.max_results;
  const maxResults =
    typeof rawMaxResults === 'number' && Number.isFinite(rawMaxResults)
      ? Math.min(20, Math.max(1, Math.trunc(rawMaxResults)))
      : 5;

  try {
    const results = await searchProvider.search(query, maxResults);
    const formatted = formatSearchResults(query, results);
    return { content: [{ type: 'text', text: formatted }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Search error: ${message}` }],
      isError: true,
    };
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
