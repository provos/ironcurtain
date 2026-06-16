/**
 * Unit tests for the daemon JSON-RPC-over-WebSocket client.
 *
 * Drives a real (minimal) WebSocket server with OS-assigned ports so the client
 * exercises its actual transport, id-correlation, and demux logic. Covers:
 *  - id-correlation under concurrent calls
 *  - RPC `{ok:false}` errors resolve (not reject)
 *  - transport close rejects in-flight calls
 *  - onEvent delivery + Unsubscribe
 *  - connect() timeout
 *  - discoverDaemon() over a temp web-ui.json (good / missing / garbage)
 *  - createDaemonClient() throws DaemonNotRunningError when discovery fails
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import {
  createDaemonClient,
  discoverDaemon,
  DaemonNotRunningError,
  type DaemonClient,
  type DaemonEndpoint,
} from '../src/daemon-client/daemon-client.js';
import { wsDataToString } from '../src/web-ui/ws-utils.js';

// ---------------------------------------------------------------------------
// Stub daemon WS server
// ---------------------------------------------------------------------------

interface ParsedRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** Raw frame as it arrives off the wire (params may be absent). */
interface RawRequestFrame {
  readonly id: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

type RequestHandler = (req: ParsedRequest, ws: WebSocket) => void;

/**
 * A minimal stand-in for the daemon's WS surface. The default handler echoes a
 * success frame; individual tests install a custom handler to model errors,
 * delays, or to capture concurrency. Push events are sent via `pushEvent`.
 */
class StubDaemonServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private handler: RequestHandler = defaultHandler;
  readonly token = 'test-token';

  constructor() {
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http, path: '/ws' });
    this.wss.on('connection', (ws, req) => {
      // Mirror the daemon's `?token=` auth: close non-matching tokens.
      const url = new URL(req.url ?? '', 'http://localhost');
      if (url.searchParams.get('token') !== this.token) {
        ws.close();
        return;
      }
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        const frame = JSON.parse(wsDataToString(data)) as RawRequestFrame;
        this.handler({ id: frame.id, method: frame.method, params: frame.params ?? {} }, ws);
      });
    });
  }

  async listen(): Promise<DaemonEndpoint> {
    await new Promise<void>((res) => this.http.listen(0, '127.0.0.1', res));
    const addr = this.http.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return { host: '127.0.0.1', port, token: this.token };
  }

  setHandler(handler: RequestHandler): void {
    this.handler = handler;
  }

  pushEvent(event: string, payload: unknown, seq: number): void {
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event, payload, seq }));
      }
    }
  }

  /** Abruptly drops every connected socket (transport failure simulation). */
  dropConnections(): void {
    for (const ws of this.wss.clients) {
      ws.terminate();
    }
  }

  /** Cleanly closes every connected socket with a code (graceful remote close). */
  closeConnections(code: number, reason = ''): void {
    for (const ws of this.wss.clients) {
      ws.close(code, reason);
    }
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((res) => this.wss.close(() => res()));
    await new Promise<void>((res) => this.http.close(() => res()));
  }
}

function defaultHandler(req: ParsedRequest, ws: WebSocket): void {
  ws.send(JSON.stringify({ id: req.id, ok: true, payload: { echo: req.params } }));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let server: StubDaemonServer | null = null;
let endpoint: DaemonEndpoint;
const clients: DaemonClient[] = [];

beforeEach(async () => {
  server = new StubDaemonServer();
  endpoint = await server.listen();
});

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => {});
  clients.length = 0;
  if (server) {
    await server.close();
    server = null;
  }
});

function makeClient(opts: Partial<Parameters<typeof createDaemonClient>[0]> = {}): DaemonClient {
  const client = createDaemonClient({ endpoint, ...opts });
  clients.push(client);
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DaemonClient', () => {
  describe('call() id-correlation', () => {
    it('resolves concurrent calls with their matching responses', async () => {
      // Echo the method back so we can verify each promise got the right frame,
      // even when responses are returned out of order.
      server?.setHandler((req, ws) => {
        const delayMs = req.method === 'slow' ? 40 : 0;
        setTimeout(() => {
          ws.send(JSON.stringify({ id: req.id, ok: true, payload: { method: req.method } }));
        }, delayMs);
      });

      const client = makeClient();
      await client.connect();

      const [slow, fast] = await Promise.all([
        client.call<{ method: string }>('slow' as never),
        client.call<{ method: string }>('fast' as never),
      ]);

      expect(slow.ok && slow.payload.method).toBe('slow');
      expect(fast.ok && fast.payload.method).toBe('fast');
    });
  });

  describe('RPC errors resolve as {ok:false}', () => {
    it('does not reject on an error frame', async () => {
      server?.setHandler((req, ws) => {
        ws.send(
          JSON.stringify({
            id: req.id,
            ok: false,
            error: { code: 'WORKFLOW_NOT_AT_GATE', message: 'not at a gate', data: { extra: 1 } },
          }),
        );
      });

      const client = makeClient();
      await client.connect();

      const result = await client.call('workflows.resolveGate' as never);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('WORKFLOW_NOT_AT_GATE');
        expect(result.message).toBe('not at a gate');
        expect(result.data).toEqual({ extra: 1 });
      }
    });
  });

  describe('transport close rejects in-flight calls', () => {
    it('rejects a pending call when the socket drops', async () => {
      // Handler never responds; the server then drops the connection.
      server?.setHandler(() => {
        /* swallow — never reply */
      });

      const client = makeClient();
      await client.connect();

      const pending = client.call('status');
      const assertion = expect(pending).rejects.toThrow();
      // Give the request a tick to be sent, then drop the socket.
      await new Promise((r) => setTimeout(r, 10));
      server?.dropConnections();
      await assertion;
    });

    it('rejects in-flight calls when close() is invoked', async () => {
      server?.setHandler(() => {
        /* never reply */
      });
      const client = makeClient();
      await client.connect();

      const pending = client.call('status');
      // Register the rejection assertion BEFORE close() settles it, so the
      // rejection is never momentarily unhandled.
      const assertion = expect(pending).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 10));
      await client.close();
      await assertion;
    });
  });

  describe('onEvent / Unsubscribe', () => {
    it('delivers push frames and stops after unsubscribe', async () => {
      const client = makeClient();
      await client.connect();

      const received: string[] = [];
      const unsubscribe = client.onEvent((e) => received.push(`${e.event}:${e.seq}`));

      server?.pushEvent('workflow.gate_raised', { workflowId: 'wf-1' }, 1);
      await waitFor(() => received.length === 1);
      expect(received).toEqual(['workflow.gate_raised:1']);

      unsubscribe();
      server?.pushEvent('workflow.completed', { workflowId: 'wf-1' }, 2);
      await new Promise((r) => setTimeout(r, 30));
      expect(received).toEqual(['workflow.gate_raised:1']);
    });

    it('does not deliver response frames to event listeners', async () => {
      const client = makeClient();
      await client.connect();

      const events: unknown[] = [];
      client.onEvent((e) => events.push(e));

      const result = await client.call('status');
      expect(result.ok).toBe(true);
      expect(events).toEqual([]);
    });
  });

  describe('onClose', () => {
    it('fires with a reason and code when the server closes the socket involuntarily', async () => {
      const client = makeClient();
      await client.connect();

      const closes: Array<{ reason: string; code: number | undefined }> = [];
      client.onClose((info) => closes.push({ reason: info.reason, code: info.code }));

      server?.closeConnections(4002, 'gone');
      await waitFor(() => closes.length === 1);

      expect(closes[0].code).toBe(4002);
      expect(closes[0].reason).toContain('4002');
    });

    it('does NOT fire when the caller invokes close()', async () => {
      const client = makeClient();
      await client.connect();

      let fired = false;
      client.onClose(() => {
        fired = true;
      });

      await client.close();
      // Give any stray 'close' event a chance to land before asserting.
      await new Promise((r) => setTimeout(r, 30));
      expect(fired).toBe(false);
    });

    it('fires AT MOST ONCE', async () => {
      const client = makeClient();
      await client.connect();

      let count = 0;
      client.onClose(() => {
        count += 1;
      });

      // A graceful close followed by an abrupt drop must still notify only once.
      server?.closeConnections(4003, 'first');
      await waitFor(() => count === 1);
      server?.dropConnections();
      await new Promise((r) => setTimeout(r, 30));
      expect(count).toBe(1);
    });

    it('stops delivery after the Unsubscribe returned by onClose', async () => {
      const client = makeClient();
      await client.connect();

      let fired = false;
      const unsubscribe = client.onClose(() => {
        fired = true;
      });
      unsubscribe();

      server?.closeConnections(4004, 'gone');
      await new Promise((r) => setTimeout(r, 30));
      expect(fired).toBe(false);
    });

    it('flows a captured transport error message into the reason', async () => {
      const client = makeClient();
      await client.connect();

      const reasons: string[] = [];
      client.onClose((info) => reasons.push(info.reason));

      // Inject an 'error' on the live socket, then drop it. The client's
      // steady-state handler captures the error message for the close info.
      const internal = client as unknown as { ws?: { emit(event: string, err: Error): void } };
      internal.ws?.emit('error', new Error('boom-transport'));
      server?.dropConnections();

      await waitFor(() => reasons.length === 1);
      expect(reasons[0]).toBe('boom-transport');
    });
  });

  describe('connect() timeout', () => {
    it('rejects when the server never accepts the connection', async () => {
      // Point at a closed port so the connect never opens. Use a tiny timeout.
      const badEndpoint: DaemonEndpoint = { host: '127.0.0.1', port: 9, token: 't' };
      const client = createDaemonClient({ endpoint: badEndpoint, connectTimeoutMs: 50 });
      clients.push(client);
      await expect(client.connect()).rejects.toThrow();
    });
  });

  describe('call() before connect', () => {
    it('rejects when not connected', async () => {
      const client = makeClient();
      await expect(client.call('status')).rejects.toThrow(/not connected/i);
    });
  });
});

// ---------------------------------------------------------------------------
// discoverDaemon() + createDaemonClient() discovery
// ---------------------------------------------------------------------------

describe('discoverDaemon', () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    homeDir = mkdtempSync(resolve(tmpdir(), 'ic-discover-'));
    process.env.IRONCURTAIN_HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('returns the parsed endpoint from a good web-ui.json', () => {
    writeFileSync(resolve(homeDir, 'web-ui.json'), JSON.stringify({ host: '127.0.0.1', port: 7400, token: 'abc' }));
    expect(discoverDaemon()).toEqual({ host: '127.0.0.1', port: 7400, token: 'abc' });
  });

  it('returns undefined when the file is missing', () => {
    expect(discoverDaemon()).toBeUndefined();
  });

  it('returns undefined for a garbage / malformed file', () => {
    writeFileSync(resolve(homeDir, 'web-ui.json'), 'not json {');
    expect(discoverDaemon()).toBeUndefined();
  });

  it('returns undefined for a JSON object missing required fields', () => {
    writeFileSync(resolve(homeDir, 'web-ui.json'), JSON.stringify({ host: '127.0.0.1' }));
    expect(discoverDaemon()).toBeUndefined();
  });

  it('createDaemonClient throws DaemonNotRunningError when discovery fails and no endpoint supplied', () => {
    expect(() => createDaemonClient()).toThrow(DaemonNotRunningError);
    try {
      createDaemonClient();
    } catch (err) {
      expect((err as DaemonNotRunningError).code).toBe('DAEMON_NOT_RUNNING');
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
