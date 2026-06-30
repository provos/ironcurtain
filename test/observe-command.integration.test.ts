/**
 * Integration tests for `runObserveCommand` over the real DaemonClient.
 *
 * These cover the *plain-mode* (non-TUI) lifecycle paths that resolve the
 * command's promise WITHOUT calling `process.exit`, so they are safe to drive
 * in-process against a stub daemon WS server:
 *
 *  - subscribe failure → plain-mode error on stderr, clean teardown.
 *  - involuntary disconnect → `connectionLost` on stderr via onClose, resolve.
 *  - single-session `session.ended` → renders end + tears down.
 *
 * The no-daemon and connect-failure paths call `process.exit(1)` and are
 * verified by manual trace in the PR rather than here (exiting the test runner
 * is not safe to exercise in-process). `--no-tui` forces the plain renderer so
 * no terminal state is touched.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import { runObserveCommand } from '../src/observe/observe-command.js';
import { getWebUiStatePath } from '../src/config/paths.js';
import { wsDataToString } from '../src/web-ui/ws-utils.js';

// ---------------------------------------------------------------------------
// Stub daemon WS server (mirrors test/daemon-client.test.ts harness)
// ---------------------------------------------------------------------------

interface ParsedRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

type RequestHandler = (req: ParsedRequest, ws: WebSocket) => void;

class StubDaemonServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private handler: RequestHandler = okHandler;
  readonly token = 'test-token';

  constructor() {
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http, path: '/ws' });
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      if (url.searchParams.get('token') !== this.token) {
        ws.close();
        return;
      }
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        const frame = JSON.parse(wsDataToString(data)) as {
          id: string;
          method: string;
          params?: Record<string, unknown>;
        };
        this.handler({ id: frame.id, method: frame.method, params: frame.params ?? {} }, ws);
      });
    });
  }

  async listen(): Promise<{ host: string; port: number }> {
    await new Promise<void>((res) => this.http.listen(0, '127.0.0.1', res));
    const addr = this.http.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return { host: '127.0.0.1', port };
  }

  setHandler(handler: RequestHandler): void {
    this.handler = handler;
  }

  pushEvent(event: string, payload: unknown, seq: number): void {
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, payload, seq }));
    }
  }

  dropConnections(): void {
    for (const ws of this.wss.clients) ws.terminate();
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((res) => this.wss.close(() => res()));
    await new Promise<void>((res) => this.http.close(() => res()));
  }
}

function okHandler(req: ParsedRequest, ws: WebSocket): void {
  ws.send(JSON.stringify({ id: req.id, ok: true, payload: {} }));
}

// ---------------------------------------------------------------------------
// stderr capture (avoids the any-typed process.stdout.write overload pitfall)
// ---------------------------------------------------------------------------

function captureStderr(): { text(): string; restore(): void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let server: StubDaemonServer | null = null;
let homeDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  server = new StubDaemonServer();
  const { host, port } = await server.listen();

  originalHome = process.env.IRONCURTAIN_HOME;
  homeDir = mkdtempSync(resolve(tmpdir(), 'ic-observe-'));
  process.env.IRONCURTAIN_HOME = homeDir;
  writeFileSync(getWebUiStatePath(), JSON.stringify({ host, port, token: server.token }));
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
  else process.env.IRONCURTAIN_HOME = originalHome;
  rmSync(homeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runObserveCommand (plain mode, real DaemonClient)', () => {
  it('prints the subscribe error and resolves when subscription fails', async () => {
    server?.setHandler((req, ws) => {
      ws.send(
        JSON.stringify({
          id: req.id,
          ok: false,
          error: { code: 'INVALID_PARAMS', message: 'no such session' },
        }),
      );
    });

    const captured = captureStderr();
    try {
      // Resolves (does not hang / exit) because the subscribe-failure path
      // routes through cleanup().
      await runObserveCommand(['7', '--no-tui']);
    } finally {
      captured.restore();
    }

    expect(captured.text()).toContain('no such session');
  });

  it('reports connection lost and resolves on an involuntary disconnect', async () => {
    // Default handler ACKs the subscribe; then we drop the socket from the server.
    server?.setHandler((req, ws) => {
      ws.send(JSON.stringify({ id: req.id, ok: true, payload: {} }));
      setTimeout(() => server?.dropConnections(), 10);
    });

    const captured = captureStderr();
    try {
      await runObserveCommand(['7', '--no-tui']);
    } finally {
      captured.restore();
    }

    expect(captured.text()).toContain('Connection lost');
  });

  it('renders session end and resolves when the watched session ends', async () => {
    server?.setHandler((req, ws) => {
      ws.send(JSON.stringify({ id: req.id, ok: true, payload: {} }));
      // After the subscribe ACK, emit the watched session's end.
      setTimeout(() => server?.pushEvent('session.ended', { label: 7, reason: 'completed' }, 1), 10);
    });

    const captured = captureStderr();
    try {
      await runObserveCommand(['7', '--no-tui']);
    } finally {
      captured.restore();
    }

    const text = captured.text();
    // renderConnected + renderSessionEnded both write to stderr in plain mode.
    expect(text).toContain('7');
  });
});
