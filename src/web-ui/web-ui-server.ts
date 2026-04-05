/**
 * WebUiServer -- HTTP + WebSocket server for the daemon web UI.
 *
 * Serves the compiled Svelte SPA as static files and handles
 * WebSocket upgrades for the JSON-RPC frame protocol. Bearer token
 * authentication is required for WebSocket connections.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';

import type { SessionManager } from '../session/session-manager.js';
import type { ControlRequestHandler } from '../daemon/control-socket.js';
import type { SessionMode } from '../session/types.js';
import { WebEventBus } from './web-event-bus.js';
import { type RequestFrame, type ResponseFrame, type EventFrame, RpcError } from './web-ui-types.js';
import { dispatch, buildStatusDto, type DispatchContext } from './json-rpc-dispatch.js';
import * as logger from '../logger.js';

// ---------------------------------------------------------------------------
// MIME types for static file serving
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// WebUiServer
// ---------------------------------------------------------------------------

export interface WebUiServerOptions {
  readonly port: number;
  readonly host: string;
  readonly handler: ControlRequestHandler;
  readonly sessionManager: SessionManager;
  readonly mode: SessionMode;
  readonly maxConcurrentWebSessions: number;
  /** When true, skip Origin validation (for Vite dev server). */
  readonly devMode?: boolean;
}

export class WebUiServer {
  private httpServer: Server | null = null;
  private wss: InstanceType<typeof WebSocketServer> | null = null;
  private readonly clients = new Set<WsWebSocket>();
  private readonly authToken: string;
  private readonly options: WebUiServerOptions;
  private readonly eventBus = new WebEventBus();
  private readonly dispatchCtx: DispatchContext;
  private eventSeq = 0;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private readonly staticRoot: string;
  private readonly staticCache = new Map<string, { content: Buffer; mime: string }>();

  constructor(options: WebUiServerOptions) {
    this.options = options;
    this.authToken = randomBytes(32).toString('base64url');
    this.staticRoot = resolveStaticAssetPath();

    this.dispatchCtx = {
      handler: options.handler,
      sessionManager: options.sessionManager,
      mode: options.mode,
      eventBus: this.eventBus,
      maxConcurrentWebSessions: options.maxConcurrentWebSessions,
      sessionQueues: new Map(),
    };

    // Subscribe to own event bus and broadcast to WS clients
    this.eventBus.subscribe((event, payload) => {
      this.broadcast(event, payload);
    });
  }

  /** Returns the event bus for external producers. */
  getEventBus(): WebEventBus {
    return this.eventBus;
  }

  async start(): Promise<string> {
    const httpServer = createServer((req, res) => this.handleHttpRequest(req, res));
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      this.handleUpgrade(req, socket, head, wss);
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.on('error', reject);
      httpServer.listen(this.options.port, this.options.host, () => resolve());
    });

    this.httpServer = httpServer;
    this.wss = wss;

    this.statusInterval = setInterval(() => {
      if (this.clients.size > 0) {
        this.broadcast('daemon.status', buildStatusDto(this.dispatchCtx));
      }
    }, 10_000);

    return `http://${this.options.host}:${this.options.port}?token=${this.authToken}`;
  }

  async stop(): Promise<void> {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    for (const client of this.clients) {
      client.close(1001, 'Server shutting down');
    }
    this.clients.clear();

    const webSessions = this.options.sessionManager.byKind('web');
    for (const managed of webSessions) {
      await this.options.sessionManager.end(managed.label).catch((err: unknown) => {
        logger.warn(`[WebUI] Error ending web session #${managed.label}: ${String(err)}`);
      });
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      const server = this.httpServer;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  private broadcast(event: string, payload: unknown): void {
    const frame: EventFrame = { event, payload, seq: ++this.eventSeq };
    const data = JSON.stringify(frame);
    for (const client of this.clients) {
      if (client.readyState === WsWebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  // --- HTTP ---

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
    );

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.includes('..')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const filePath =
      pathname === '/' ? resolve(this.staticRoot, 'index.html') : resolve(this.staticRoot, pathname.slice(1));

    // Path containment check
    if (!filePath.startsWith(this.staticRoot)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const cached = this.serveFromCache(filePath, res);
    if (cached) return;

    // SPA fallback — serve index.html for client-side routing
    const indexPath = resolve(this.staticRoot, 'index.html');
    if (this.serveFromCache(indexPath, res)) return;

    res.writeHead(404);
    res.end('Web UI not built. Run: npm run build:web-ui');
  }

  private serveFromCache(filePath: string, res: ServerResponse): boolean {
    const cached = this.staticCache.get(filePath);
    if (cached) {
      res.writeHead(200, { 'Content-Type': cached.mime });
      res.end(cached.content);
      return true;
    }
    try {
      const content = readFileSync(filePath);
      const mime = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
      this.staticCache.set(filePath, { content, mime });
      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }

  // --- WebSocket ---

  private handleUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    wss: InstanceType<typeof WebSocketServer>,
  ): void {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);

    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    if (!token || !this.verifyToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!this.options.devMode) {
      const origin = req.headers.origin;
      if (origin && !this.isValidOrigin(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    if (this.clients.size >= 10) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      this.clients.add(ws);
      logger.info(`[WebUI] Client connected (${this.clients.size} active)`);

      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        const text = Buffer.isBuffer(data)
          ? data.toString()
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString()
            : Buffer.concat(data).toString();
        this.handleMessage(ws, text).catch((err: unknown) => {
          logger.error(`[WebUI] Error handling message: ${String(err)}`);
        });
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info(`[WebUI] Client disconnected (${this.clients.size} active)`);
      });

      ws.on('error', (err) => {
        logger.warn(`[WebUI] WebSocket error: ${err.message}`);
        this.clients.delete(ws);
      });
    });
  }

  private verifyToken(provided: string): boolean {
    const expected = Buffer.from(this.authToken, 'utf8');
    const actual = Buffer.from(provided, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  private isValidOrigin(origin: string): boolean {
    const { host, port } = this.options;
    return [`http://${host}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(origin);
  }

  // --- JSON-RPC ---

  private async handleMessage(client: WsWebSocket, data: string): Promise<void> {
    let frame: RequestFrame;
    try {
      const parsed: unknown = JSON.parse(data);
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.id !== 'string' || typeof obj.method !== 'string') {
        throw new Error('Missing id or method');
      }
      frame = parsed as RequestFrame;
    } catch {
      client.send(
        JSON.stringify({
          id: '',
          ok: false,
          error: { code: 'INVALID_PARAMS', message: 'Invalid JSON-RPC frame' },
        } satisfies ResponseFrame),
      );
      return;
    }

    try {
      const payload = await dispatch(this.dispatchCtx, frame.method, frame.params ?? {});
      client.send(JSON.stringify({ id: frame.id, ok: true, payload } satisfies ResponseFrame));
    } catch (err: unknown) {
      const response: ResponseFrame =
        err instanceof RpcError
          ? { id: frame.id, ok: false, error: { code: err.code, message: err.message } }
          : {
              id: frame.id,
              ok: false,
              error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) },
            };
      client.send(JSON.stringify(response));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveStaticAssetPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const candidates = [
    resolve(__dirname, '..', 'web-ui-static'),
    resolve(__dirname, '..', '..', 'dist', 'web-ui-static'),
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'index.html'))) {
      return candidate;
    }
  }
  return candidates[0];
}
