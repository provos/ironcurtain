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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import TurndownService from 'turndown';

const USER_AGENT = 'IronCurtain/0.1 (AI Agent Runtime)';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const REQUEST_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_LENGTH = 5000;

const turndown = new TurndownService();

/**
 * Performs the actual HTTP GET request with redirect following,
 * timeout, and response size limits.
 */
async function doFetch(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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

    const body = new TextDecoder().decode(
      chunks.length === 1 ? chunks[0] : concatUint8Arrays(chunks),
    );

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

const server = new Server(
  { name: 'ironcurtain-fetch', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
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
        raw_html: {
          type: 'boolean',
          default: false,
          description: 'When true, return raw HTML instead of converting to markdown',
        },
      },
      required: ['url'],
    },
  }],
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
  const rawHtml = args?.raw_html === true;

  try {
    const { status, headers, body } = await doFetch(url, requestHeaders);

    const contentType = headers['content-type'] ?? '';
    const isHtml = contentType.includes('text/html');

    // Convert HTML to markdown unless raw_html is requested
    let processedBody = body;
    if (isHtml && !rawHtml) {
      processedBody = htmlToMarkdown(body);
    }

    // Truncate to max_length
    const truncated = processedBody.length > maxLength;
    const finalBody = truncated
      ? processedBody.slice(0, maxLength) + '\n\n[Truncated]'
      : processedBody;

    const result = [
      `Status: ${status}`,
      `Headers: ${JSON.stringify(headers)}`,
      '',
      finalBody,
    ].join('\n');

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
