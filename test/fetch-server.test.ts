import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TEST_HTML = `<!DOCTYPE html>
<html><head><title>Test Page</title></head>
<body>
<script>var x = 1;</script>
<style>.hidden { display: none; }</style>
<nav><a href="/">Home</a></nav>
<main>
<h1>Hello World</h1>
<p>This is a <strong>test</strong> page with &amp; entities.</p>
</main>
<footer>Copyright 2026</footer>
<aside>Sidebar content</aside>
</body></html>`;

// A realistic article page with enough content for Readability's charThreshold (~500 chars).
// Includes boilerplate (nav, sidebar, cookie banner, ads) that Readability should strip.
const ARTICLE_HTML = `<!DOCTYPE html>
<html><head><title>Breaking Discovery in Solar Energy</title></head>
<body>
<nav class="site-nav"><a href="/">Home</a> | <a href="/news">News</a> | <a href="/about">About</a></nav>
<div class="cookie-banner">We use cookies to improve your experience. <button>Accept</button></div>
<div class="ad-placeholder">ADVERTISEMENT: Buy our product today!</div>
<div class="sidebar">
  <h3>Related Articles</h3>
  <ul>
    <li><a href="/article/1">First related article link</a></li>
    <li><a href="/article/2">Second related article link</a></li>
    <li><a href="/article/3">Third related article link</a></li>
  </ul>
  <h3>Newsletter</h3>
  <p>Subscribe to our newsletter for daily updates.</p>
</div>
<article>
  <h1>Breaking Discovery in Solar Energy</h1>
  <p class="byline">By Jane Smith, Science Correspondent</p>
  <p>Scientists at the National Renewable Energy Laboratory have announced a groundbreaking
  advancement in solar cell technology that could dramatically reduce the cost of solar energy
  production worldwide. The new perovskite-silicon tandem cells achieved a record efficiency
  of 33.7 percent in laboratory conditions, surpassing all previous records.</p>
  <p>The research team, led by Dr. Maria Chen, spent three years developing the novel tandem
  architecture that combines perovskite with traditional silicon cells. "This is a watershed
  moment for renewable energy," Dr. Chen said in a press conference. "We've shown that it's
  possible to break through the theoretical efficiency limits of single-junction cells."</p>
  <p>Industry analysts predict that this breakthrough could reduce the cost of solar panels
  by up to 40 percent within the next five years. Major manufacturers including SunPower,
  First Solar, and JinkoSolar have already expressed interest in licensing the technology
  for commercial production.</p>
  <p>The implications extend beyond just electricity generation. The improved efficiency means
  that solar installations can produce more power per square meter, making rooftop solar
  viable in regions that were previously considered too cloudy or too far north for effective
  solar energy harvesting. This could accelerate the global transition away from fossil fuels.</p>
  <p>Environmental groups have praised the development. "Every percentage point of efficiency
  gain translates to millions of tons of carbon emissions avoided," said Michael Torres,
  director of the Clean Energy Alliance. "This kind of innovation is exactly what we need
  to meet our climate goals."</p>
</article>
<footer class="site-footer">
  <p>Copyright 2026 Science Daily News. All rights reserved.</p>
  <nav><a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms of Service</a></nav>
</footer>
</body></html>`;

let httpServer: HttpServer;
let baseUrl: string;
let client: Client;

beforeAll(async () => {
  // Start a local HTTP server with controlled responses
  httpServer = createServer((req, res) => {
    if (req.url === '/html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(TEST_HTML);
    } else if (req.url === '/article') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ARTICLE_HTML);
    } else if (req.url === '/plain') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Plain text response');
    } else if (req.url === '/slow') {
      // Never respond — used to test timeout
      // (request will hang until timeout fires)
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const addr = httpServer.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Spawn fetch server via MCP SDK
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/servers/fetch-server.ts'],
  });
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  httpServer?.close();
});

/** Extracts the text content from an MCP tool call result. */
function resultText(result: Awaited<ReturnType<typeof client.callTool>>): string {
  return (result.content as { text: string }[])[0].text;
}

describe('fetch-server', () => {
  describe('tool schema', () => {
    it('exposes format enum and timeout parameter', async () => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(1);
      const schema = tools[0].inputSchema as { properties: Record<string, unknown> };

      expect(schema.properties).toHaveProperty('format');
      const format = schema.properties.format as Record<string, unknown>;
      expect(format.enum).toEqual(['markdown', 'text', 'html']);
      expect(format.default).toBe('markdown');

      expect(schema.properties).toHaveProperty('timeout');
      const timeout = schema.properties.timeout as Record<string, unknown>;
      expect(timeout.type).toBe('number');
      expect(timeout.default).toBe(30);

      // raw_html should be gone
      expect(schema.properties).not.toHaveProperty('raw_html');
    });
  });

  describe('format parameter', () => {
    it('converts HTML to markdown by default', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html` },
      });
      const text = resultText(result);
      expect(text).toContain('# Hello World');
      expect(text).toContain('**test**');
      // Boilerplate should be stripped by turndown.remove()
      expect(text).not.toContain('var x = 1');
      expect(text).not.toContain('Copyright 2026');
      expect(text).not.toContain('Sidebar content');
    });

    it('returns raw HTML with format=html', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html`, format: 'html' },
      });
      const text = resultText(result);
      expect(text).toContain('<!DOCTYPE html>');
      expect(text).toContain('<h1>Hello World</h1>');
      expect(text).toContain('<script>var x = 1;</script>');
    });

    it('returns plain text with format=text, stripping tags and boilerplate', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html`, format: 'text' },
      });
      const text = resultText(result);
      // Should contain visible text
      expect(text).toContain('Hello World');
      expect(text).toContain('test');
      // Script/style/nav/footer/aside content should be stripped
      expect(text).not.toContain('var x = 1');
      expect(text).not.toContain('.hidden');
      expect(text).not.toContain('Copyright 2026');
      expect(text).not.toContain('Sidebar content');
      // Should not contain HTML tags
      expect(text).not.toContain('<h1>');
      expect(text).not.toContain('<p>');
    });

    it('decodes HTML entities in text mode', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html`, format: 'text' },
      });
      const text = resultText(result);
      expect(text).toContain('&');
      expect(text).not.toContain('&amp;');
    });

    it('passes non-HTML through unchanged in markdown mode', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/plain` },
      });
      const text = resultText(result);
      expect(text).toContain('Plain text response');
    });
  });

  describe('timeout parameter', () => {
    it('times out with short timeout on slow endpoint', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/slow`, timeout: 5 },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/Fetch error:.*abort/i);
    }, 15_000);
  });

  describe('boilerplate stripping', () => {
    it('removes nav, footer, aside, script, style in markdown mode', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html` },
      });
      const text = resultText(result);
      // nav link should be gone
      expect(text).not.toContain('Home');
      // script content should be gone
      expect(text).not.toContain('var x');
      // style content should be gone
      expect(text).not.toContain('.hidden');
    });
  });

  describe('max_length truncation', () => {
    it('truncates output and appends marker', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html`, max_length: 50 },
      });
      const text = resultText(result);
      expect(text).toContain('[Truncated]');
    });
  });

  describe('readability extraction', () => {
    it('extracts article content and strips boilerplate in markdown mode', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/article`, max_length: 50000 },
      });
      const text = resultText(result);
      // Article content should be present
      expect(text).toContain('perovskite-silicon tandem cells');
      expect(text).toContain('Dr. Maria Chen');
      // Boilerplate should be stripped
      expect(text).not.toContain('ADVERTISEMENT');
      expect(text).not.toContain('cookie');
      expect(text).not.toContain('Related Articles');
      expect(text).not.toContain('Privacy Policy');
    });

    it('includes metadata header when readability succeeds', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/article`, max_length: 50000 },
      });
      const text = resultText(result);
      expect(text).toContain('Title: Breaking Discovery in Solar Energy');
    });

    it('uses readability textContent for text format', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/article`, format: 'text', max_length: 50000 },
      });
      const text = resultText(result);
      // Should have article content as plain text
      expect(text).toContain('perovskite-silicon tandem cells');
      expect(text).toContain('Title: Breaking Discovery in Solar Energy');
      // Should not have HTML tags
      expect(text).not.toContain('<p>');
      expect(text).not.toContain('<h1>');
      // Boilerplate should be stripped
      expect(text).not.toContain('ADVERTISEMENT');
      expect(text).not.toContain('cookie');
    });

    it('falls back to turndown for non-article pages', async () => {
      const result = await client.callTool({
        name: 'http_fetch',
        arguments: { url: `${baseUrl}/html` },
      });
      const text = resultText(result);
      // Should still work via turndown fallback
      expect(text).toContain('Hello World');
    });
  });
});
