/**
 * Tests for WebUiServer -- focused on security-relevant behavior:
 * token verification, origin validation, path containment for static
 * files, and WebSocket message handling.
 *
 * Uses a real HTTP server with OS-assigned ports (port 0).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebUiServer, type WebUiServerOptions } from '../src/web-ui/web-ui-server.js';
import { SessionManager } from '../src/session/session-manager.js';
import type { ControlRequestHandler } from '../src/daemon/control-socket.js';
import type { RunRecord } from '../src/cron/types.js';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockHandler(): ControlRequestHandler {
  return {
    getStatus: vi.fn().mockReturnValue({
      uptimeSeconds: 100,
      jobs: { total: 0, enabled: 0, running: 0 },
      signalConnected: false,
      nextFireTime: undefined,
    }),
    addJob: vi.fn().mockResolvedValue(undefined),
    removeJob: vi.fn().mockResolvedValue(undefined),
    enableJob: vi.fn().mockResolvedValue(undefined),
    disableJob: vi.fn().mockResolvedValue(undefined),
    recompileJob: vi.fn().mockResolvedValue(undefined),
    reloadJob: vi.fn().mockResolvedValue(undefined),
    runJobNow: vi.fn().mockResolvedValue({} as RunRecord),
    listJobs: vi.fn().mockReturnValue([]),
  };
}

let server: WebUiServer | null = null;
const openSockets: WebSocket[] = [];

function createServer(): WebUiServer {
  const opts: WebUiServerOptions = {
    port: 0, // OS assigns a free port
    host: '127.0.0.1',
    handler: makeMockHandler(),
    sessionManager: new SessionManager(),
    mode: { kind: 'builtin' },
    maxConcurrentWebSessions: 3,
  };
  server = new WebUiServer(opts);
  return server;
}

/** Extracts the auth token from the URL returned by start(). */
function extractToken(url: string): string {
  return new URL(url).searchParams.get('token')!;
}

/** Extracts the port from the URL returned by start(). */
function extractPort(url: string): number {
  return parseInt(new URL(url).port, 10);
}

/** Create a WebSocket and track it for cleanup. */
function createWs(url: string): WebSocket {
  const ws = new WebSocket(url);
  openSockets.push(ws);
  return ws;
}

/** Wait for a WebSocket to fully close. */
function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => ws.on('close', resolve));
}

afterEach(async () => {
  // Close all tracked sockets first
  const closePromises = openSockets
    .filter((ws) => ws.readyState !== WebSocket.CLOSED)
    .map((ws) => {
      ws.close();
      return waitForClose(ws);
    });
  await Promise.all(closePromises);
  openSockets.length = 0;

  if (server) {
    await server.stop();
    server = null;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebUiServer', () => {
  describe('start and stop', () => {
    it('returns a URL with token on start', async () => {
      const srv = createServer();
      const url = await srv.start();

      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\?token=.+/);
      const token = extractToken(url);
      expect(token.length).toBeGreaterThan(20);
    });

    it('stop is idempotent', async () => {
      const srv = createServer();
      await srv.start();
      await srv.stop();
      await srv.stop(); // second call should not throw
      server = null; // already stopped
    });
  });

  describe('static file serving', () => {
    it('rejects path traversal with encoded ..', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);

      const http = await import('node:http');
      const status = await new Promise<number>((resolve) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/..%2F..%2Fetc/passwd', method: 'GET' }, (res) =>
          resolve(res.statusCode!),
        );
        req.end();
      });
      expect(status).toBe(403);
    });

    it('sets security headers on responses', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);

      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    });
  });

  describe('WebSocket authentication', () => {
    it('rejects connections without token', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws`);
      const error = await new Promise<Error>((resolve) => {
        ws.on('error', resolve);
      });
      expect(error).toBeDefined();
    });

    it('rejects connections with wrong token', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=wrong-token`);
      const error = await new Promise<Error>((resolve) => {
        ws.on('error', resolve);
      });
      expect(error).toBeDefined();
    });

    it('accepts connections with correct token', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
    });

    it('rejects connections to non-/ws paths', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/other?token=${token}`);
      const error = await new Promise<Error>((resolve) => {
        ws.on('error', resolve);
      });
      expect(error).toBeDefined();
    });
  });

  describe('WebSocket JSON-RPC', () => {
    it('handles valid status request', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const responsePromise = new Promise<string>((resolve) => {
        ws.on('message', (data: Buffer) => resolve(data.toString()));
      });

      ws.send(JSON.stringify({ id: 'req-1', method: 'status' }));
      const raw = await responsePromise;
      const response = JSON.parse(raw);

      expect(response.id).toBe('req-1');
      expect(response.ok).toBe(true);
      expect(response.payload).toMatchObject({ webUiListening: true });
    });

    it('returns error for invalid JSON', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const responsePromise = new Promise<string>((resolve) => {
        ws.on('message', (data: Buffer) => resolve(data.toString()));
      });

      ws.send('not valid json');
      const raw = await responsePromise;
      const response = JSON.parse(raw);

      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('INVALID_PARAMS');
    });

    it('returns error for missing id/method fields', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const responsePromise = new Promise<string>((resolve) => {
        ws.on('message', (data: Buffer) => resolve(data.toString()));
      });

      ws.send(JSON.stringify({ foo: 'bar' }));
      const raw = await responsePromise;
      const response = JSON.parse(raw);

      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('INVALID_PARAMS');
    });

    it('returns METHOD_NOT_FOUND for unknown methods', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const responsePromise = new Promise<string>((resolve) => {
        ws.on('message', (data: Buffer) => resolve(data.toString()));
      });

      ws.send(JSON.stringify({ id: 'req-2', method: 'nonexistent' }));
      const raw = await responsePromise;
      const response = JSON.parse(raw);

      expect(response.id).toBe('req-2');
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('METHOD_NOT_FOUND');
    });
  });

  describe('event broadcasting', () => {
    it('broadcasts events to connected clients', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const eventPromise = new Promise<string>((resolve) => {
        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.event) resolve(data.toString());
        });
      });

      srv.getEventBus().emit('session.ended', { label: 42, reason: 'test' });

      const raw = await eventPromise;
      const frame = JSON.parse(raw);

      expect(frame.event).toBe('session.ended');
      expect(frame.payload).toEqual({ label: 42, reason: 'test' });
      expect(frame.seq).toBe(1);
    });

    it('increments seq on each broadcast', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const events: unknown[] = [];
      const gotTwo = new Promise<void>((resolve) => {
        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.event) {
            events.push(msg);
            if (events.length === 2) resolve();
          }
        });
      });

      srv.getEventBus().emit('session.ended', { label: 1, reason: 'a' });
      srv.getEventBus().emit('session.ended', { label: 2, reason: 'b' });

      await gotTwo;
      expect((events[0] as { seq: number }).seq).toBe(1);
      expect((events[1] as { seq: number }).seq).toBe(2);
    });
  });
});
