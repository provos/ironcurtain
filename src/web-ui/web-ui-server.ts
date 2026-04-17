/**
 * WebUiServer -- HTTP + WebSocket server for the daemon web UI.
 *
 * Serves the compiled Svelte SPA as static files and handles
 * WebSocket upgrades for the JSON-RPC frame protocol. Bearer token
 * authentication is required for WebSocket connections.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import type { Socket } from 'node:net';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';

import type { SessionManager } from '../session/session-manager.js';
import type { ControlRequestHandler } from '../daemon/control-socket.js';
import type { SessionMode } from '../session/types.js';
import type { TokenStreamBus } from '../docker/token-stream-bus.js';
import type { TokenStreamBridge } from './token-stream-bridge.js';
import { WebEventBus } from './web-event-bus.js';
import { type RequestFrame, type ResponseFrame, type EventFrame, RpcError } from './web-ui-types.js';
import { dispatch, buildStatusDto, type WorkflowDispatchContext } from './json-rpc-dispatch.js';
import type { WorkflowManager } from './workflow-manager.js';
import { wsDataToString } from './ws-utils.js';
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
  /** Optional WorkflowManager for workflow RPC methods. */
  readonly workflowManager?: WorkflowManager;
  /** Shared token stream bus for real-time LLM output observation. */
  readonly tokenStreamBus?: TokenStreamBus;
}

export class WebUiServer {
  private httpServer: Server | null = null;
  private wss: InstanceType<typeof WebSocketServer> | null = null;
  private readonly clients = new Set<WsWebSocket>();
  private readonly authToken: string;
  private readonly options: WebUiServerOptions;
  private readonly eventBus = new WebEventBus();
  private readonly dispatchCtx: WorkflowDispatchContext;
  private tokenStreamBridge: TokenStreamBridge | null = null;
  private eventSeq = 0;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private orphanTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly aliveClients = new Set<WsWebSocket>();
  private readonly missedPings = new Map<WsWebSocket, number>();
  private readonly staticRoot: string;
  private readonly staticCache = new Map<string, { content: Buffer; mime: string }>();

  constructor(options: WebUiServerOptions) {
    this.options = options;
    this.authToken = randomBytes(32).toString('base64url');
    const rawStaticRoot = resolveStaticAssetPath();
    try {
      this.staticRoot = realpathSync(rawStaticRoot);
    } catch {
      // Static root may not exist yet (web UI not built); keep the raw path
      this.staticRoot = rawStaticRoot;
    }

    this.dispatchCtx = {
      handler: options.handler,
      sessionManager: options.sessionManager,
      mode: options.mode,
      eventBus: this.eventBus,
      maxConcurrentWebSessions: options.maxConcurrentWebSessions,
      sessionQueues: new Map(),
      workflowManager: options.workflowManager,
      tokenStreamBus: options.tokenStreamBus,
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

  /** Set the WorkflowManager after construction (avoids circular dependency). */
  setWorkflowManager(manager: WorkflowManager): void {
    this.dispatchCtx.workflowManager = manager;
  }

  /** Returns the bearer auth token for external consumers (e.g., CLI observe). */
  getAuthToken(): string {
    return this.authToken;
  }

  /** Returns the actual port the server is listening on. */
  getPort(): number {
    const addr = this.httpServer?.address();
    return typeof addr === 'object' && addr ? addr.port : this.options.port;
  }

  /** Set the TokenStreamBridge after construction. */
  setTokenStreamBridge(bridge: TokenStreamBridge): void {
    this.tokenStreamBridge = bridge;
    this.dispatchCtx.tokenStreamBridge = bridge;
  }

  async start(): Promise<string> {
    const httpServer = createServer((req, res) => this.handleHttpRequest(req, res));
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });

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

    this.pingInterval = setInterval(() => {
      this.pingClients();
    }, 30_000);

    const addr = httpServer.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : this.options.port;
    return `http://${this.options.host}:${actualPort}?token=${this.authToken}`;
  }

  async stop(): Promise<void> {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    this.cancelOrphanTimer();

    for (const client of this.clients) {
      client.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.aliveClients.clear();
    this.missedPings.clear();

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
    this.sendToSubscribers(this.clients, event, payload);
  }

  /**
   * Send an event frame to a specific set of clients (targeted delivery).
   * Used by TokenStreamBridge for per-subscription delivery without
   * modifying the generic broadcast() path.
   */
  sendToSubscribers(clients: ReadonlySet<WsWebSocket>, event: string, payload: unknown): void {
    const frame: EventFrame = { event, payload, seq: ++this.eventSeq };
    const data = JSON.stringify(frame);
    for (const client of clients) {
      if (client.readyState === WsWebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  // --- Ping/pong heartbeat ---

  private pingClients(): void {
    for (const client of this.clients) {
      if (!this.aliveClients.has(client)) {
        const missed = (this.missedPings.get(client) ?? 0) + 1;
        if (missed >= 2) {
          logger.info('[WebUI] Terminating stale client (missed 2 pings)');
          this.removeClient(client);
          client.terminate();
          continue;
        }
        this.missedPings.set(client, missed);
      }
      this.aliveClients.delete(client);
      if (client.readyState === WsWebSocket.OPEN) {
        client.ping();
      }
    }
    this.startOrphanTimerIfNeeded();
  }

  private removeClient(ws: WsWebSocket): void {
    this.clients.delete(ws);
    this.aliveClients.delete(ws);
    this.missedPings.delete(ws);
  }

  // --- Orphan session cleanup ---

  private static readonly ORPHAN_GRACE_MS = 60_000;

  private startOrphanTimerIfNeeded(): void {
    if (this.orphanTimer) return;
    if (this.clients.size > 0) return;

    const webSessions = this.options.sessionManager.byKind('web');
    if (webSessions.length === 0) return;

    logger.info(`[WebUI] No connected clients with ${webSessions.length} web session(s). Starting 60s orphan timer.`);
    this.orphanTimer = setTimeout(() => {
      this.orphanTimer = null;
      this.cleanupOrphanedWebSessions();
    }, WebUiServer.ORPHAN_GRACE_MS);
  }

  private cancelOrphanTimer(): void {
    if (this.orphanTimer) {
      clearTimeout(this.orphanTimer);
      this.orphanTimer = null;
    }
  }

  private cleanupOrphanedWebSessions(): void {
    if (this.clients.size > 0) return;

    const webSessions = this.options.sessionManager.byKind('web');
    if (webSessions.length === 0) return;

    logger.info(`[WebUI] Ending ${webSessions.length} orphaned web session(s).`);
    for (const managed of webSessions) {
      this.options.sessionManager.end(managed.label).catch((err: unknown) => {
        logger.warn(`[WebUI] Error ending orphaned web session #${managed.label}: ${String(err)}`);
      });
    }
  }

  // --- HTTP ---

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    const connectSrc = this.options.devMode ? "'self' ws://127.0.0.1:* ws://localhost:*" : "'self'";
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ${connectSrc}`,
    );

    let url: URL;
    let pathname: string;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    if (pathname.includes('..')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Auth preflight endpoint -- lets the client distinguish a bad token
    // (stop retrying, show error) from a daemon-down condition (keep
    // retrying). Uses the same timing-safe verifier as the WS upgrade.
    // GET only; any other method hits the explicit 404 branch below.
    // `Cache-Control: no-store` keeps the browser and any intermediary
    // from caching a response keyed by the token-bearing URL.
    if (pathname === '/ws/auth' && req.method === 'GET') {
      const token = url.searchParams.get('token');
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (token && this.verifyToken(token)) {
        res.writeHead(200, headers);
        res.end('{"ok":true}');
      } else {
        res.writeHead(401, headers);
        res.end('{"ok":false,"error":"invalid_token"}');
      }
      return;
    }
    if (pathname === '/ws/auth') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const rawFilePath =
      pathname === '/' ? resolve(this.staticRoot, 'index.html') : resolve(this.staticRoot, pathname.slice(1));

    // Resolve symlinks before containment check to prevent symlink escape
    let filePath: string;
    try {
      filePath = realpathSync(rawFilePath);
    } catch {
      // File doesn't exist — fall through to SPA fallback below
      filePath = rawFilePath;
    }

    // Path containment check (both sides are canonical real paths)
    if (filePath !== this.staticRoot && !filePath.startsWith(this.staticRoot + sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const cached = this.serveFromCache(filePath, res);
    if (cached) return;

    // SPA fallback — only for paths without a file extension (client-side routes).
    // Requests for missing assets (e.g. /assets/app.js) get a proper 404.
    if (extname(pathname)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

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
    let url: URL;
    try {
      url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

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
      this.aliveClients.add(ws);
      this.missedPings.delete(ws);
      this.cancelOrphanTimer();
      logger.info(`[WebUI] Client connected (${this.clients.size} active)`);

      ws.on('pong', () => {
        this.aliveClients.add(ws);
        this.missedPings.delete(ws);
      });

      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        const text = wsDataToString(data);
        this.handleMessage(ws, text).catch((err: unknown) => {
          logger.error(`[WebUI] Error handling message: ${String(err)}`);
        });
      });

      ws.on('close', () => {
        this.removeClient(ws);
        this.tokenStreamBridge?.removeAllForClient(ws);
        logger.info(`[WebUI] Client disconnected (${this.clients.size} active)`);
        this.startOrphanTimerIfNeeded();
      });

      ws.on('error', (err) => {
        logger.warn(`[WebUI] WebSocket error: ${err.message}`);
        this.removeClient(ws);
        this.tokenStreamBridge?.removeAllForClient(ws);
        this.startOrphanTimerIfNeeded();
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
      const payload = await dispatch(this.dispatchCtx, frame.method, frame.params ?? {}, client);
      client.send(JSON.stringify({ id: frame.id, ok: true, payload } satisfies ResponseFrame));
    } catch (err: unknown) {
      const response: ResponseFrame =
        err instanceof RpcError
          ? {
              id: frame.id,
              ok: false,
              error: { code: err.code, message: err.message, data: err.data },
            }
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
