/**
 * Minimal HTTP fetch MCP server.
 *
 * Exposes a single `http_fetch` tool (GET-only) that retrieves web content.
 * HTML responses are converted to markdown via turndown by default.
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

const USER_AGENT = 'IronCurtain/0.1 (AI Agent Runtime)';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const REQUEST_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_LENGTH = 5000;

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
          reader.cancel();
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
    return (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    // Fallback: regex-based stripping with limited entity decoding
    return html
      .replace(BOILERPLATE_TAG_RE, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
 * Note: Readability.parse() is synchronous and cannot be interrupted,
 * and no timeout is applied around this parsing step. Malicious or
 * pathological HTML could therefore cause slow or stalled parsing and
 * is a potential CPU DoS vector.
 */
function extractWithReadability(html: string, url: string): ReadabilityArticle | null {
  let dom: JSDOM | undefined;
  try {
    dom = new JSDOM(html, { url });

    const doc = dom.window.document;
    if (!isProbablyReaderable(doc)) return null;

    const result = new Readability(doc).parse();
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

const server = new Server({ name: 'ironcurtain-fetch', version: '0.1.0' }, { capabilities: { tools: {} } });

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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'http_fetch') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
      isError: true,
    };
  }

  const args = req.params.arguments as Record<string, unknown> | undefined;
  const url = args?.url as string | undefined;
  if (!url || typeof url !== 'string') {
    return {
      content: [{ type: 'text', text: 'Missing required parameter: url' }],
      isError: true,
    };
  }

  const requestHeaders = (args?.headers ?? {}) as Record<string, string>;
  const maxLength = typeof args?.max_length === 'number' ? args.max_length : DEFAULT_MAX_LENGTH;
  const rawFormat = args?.format;
  if (rawFormat !== undefined && !isValidFormat(rawFormat)) {
    return {
      content: [
        {
          type: 'text',
          text: `Invalid format: ${String(rawFormat)}. Supported formats are: ${VALID_FORMATS.join(', ')}.`,
        },
      ],
      isError: true,
    };
  }
  const format: OutputFormat = rawFormat ?? 'markdown';
  const timeoutSec = typeof args?.timeout === 'number' ? Math.min(60, Math.max(5, args.timeout)) : 30;

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
});

const transport = new StdioServerTransport();
await server.connect(transport);
