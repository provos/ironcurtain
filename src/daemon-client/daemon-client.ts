/**
 * A thin, generic JSON-RPC-over-WebSocket client for the IronCurtain daemon.
 *
 * This is the single reusable transport for talking to the daemon's web-UI
 * WebSocket surface (`ws://{host}:{port}/ws?token=`). It is workflow-agnostic:
 * it sends arbitrary `MethodName` requests and optionally subscribes to push
 * event frames. Workflow-specific knowledge lives in the calling CLI command.
 *
 * Layering: this module is a LEAF. Its only runtime dependencies are `ws`,
 * node builtins, `src/config/paths.ts` (for discovery), and
 * `src/web-ui/ws-utils.ts`. It imports the wire-contract types from
 * `web-ui-types.ts` as **type-only** imports, which creates no runtime edge.
 *
 * Contract recap (see the {@link DaemonClient} interface for the full list):
 *  - RPC-level errors resolve as `{ ok:false, ... }` — callers branch on the
 *    discriminant rather than try/catch.
 *  - Transport failures (socket closed, connect/request timeout) reject.
 */

import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';

import { getWebUiStatePath } from '../config/paths.js';
import { wsDataToString } from '../web-ui/ws-utils.js';
import type { MethodName, ErrorCode } from '../web-ui/web-ui-types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Connection coordinates discovered from `~/.ironcurtain/web-ui.json`. */
export interface DaemonEndpoint {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

/** Discriminated result of a single JSON-RPC call. */
export type RpcResult<T> =
  | { readonly ok: true; readonly payload: T }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly data?: unknown };

/** A push event frame delivered to subscribers. */
export interface DaemonEvent {
  readonly event: string;
  readonly payload: unknown;
  readonly seq: number;
}

/** Unsubscribe handle returned by {@link DaemonClient.onEvent}. */
export type Unsubscribe = () => void;

export interface DaemonClientOptions {
  /** Override discovery (tests, alternate endpoints). */
  readonly endpoint?: DaemonEndpoint;
  /** Per-request timeout in ms. Default 30_000. */
  readonly requestTimeoutMs?: number;
  /** Connect timeout in ms. Default 10_000. */
  readonly connectTimeoutMs?: number;
}

/**
 * A thin, generic JSON-RPC-over-WebSocket client for the IronCurtain daemon.
 *
 * Contract / invariants:
 *  - `connect()` must resolve before `call`/`onEvent` are used; calling them
 *    earlier rejects/throws with a clear error.
 *  - `call()` is id-correlated: concurrent calls are safe; each resolves with
 *    the response frame whose `id` matches. RPC-level errors do NOT reject the
 *    promise — they resolve as `{ ok:false, ... }`. Transport failures (socket
 *    closed, timeout) DO reject.
 *  - `onEvent()` delivers every push frame (`{event,payload,seq}`) to the
 *    listener until unsubscribed. Listeners never see response frames.
 *  - `close()` is idempotent and unblocks any in-flight `call()` with a
 *    rejection. Safe to call from a `finally`.
 *  - The client never writes to stdout/stderr; all presentation is the caller's.
 */
export interface DaemonClient {
  connect(): Promise<void>;
  call<T = unknown>(method: MethodName, params?: Record<string, unknown>): Promise<RpcResult<T>>;
  onEvent(listener: (e: DaemonEvent) => void): Unsubscribe;
  close(): Promise<void>;
}

/**
 * Signals that no daemon is running with `--web-ui` (no discoverable endpoint).
 * Carries a `code` discriminant so cross-module catchers branch on a string
 * rather than `instanceof` (per CLAUDE.md module-layering guidance).
 */
export class DaemonNotRunningError extends Error {
  readonly code = 'DAEMON_NOT_RUNNING' as const;

  constructor(message = 'No IronCurtain daemon with web UI is running') {
    super(message);
    this.name = 'DaemonNotRunningError';
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Reads daemon connection info from the well-known state file
 * (`getWebUiStatePath()` → `~/.ironcurtain/web-ui.json`).
 *
 * Returns `undefined` when the file is absent or unparseable — i.e. when no
 * daemon is running with `--web-ui`. Callers distinguish "no daemon" from other
 * failures by this `undefined` return, never by catching.
 */
export function discoverDaemon(): DaemonEndpoint | undefined {
  let raw: string;
  try {
    raw = readFileSync(getWebUiStatePath(), 'utf-8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isDaemonEndpoint(parsed)) return undefined;
  return { host: parsed.host, port: parsed.port, token: parsed.token };
}

/** Structural guard for a discovered endpoint (rejects garbage state files). */
function isDaemonEndpoint(value: unknown): value is DaemonEndpoint {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.host === 'string' &&
    v.host.length > 0 &&
    typeof v.port === 'number' &&
    Number.isFinite(v.port) &&
    typeof v.token === 'string' &&
    v.token.length > 0
  );
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Constructs (but does not connect) a {@link DaemonClient}.
 *
 * Throws {@link DaemonNotRunningError} when no `endpoint` is supplied and
 * discovery fails — the single typed signal an agent uses to decide whether to
 * start a daemon.
 */
export function createDaemonClient(options: DaemonClientOptions = {}): DaemonClient {
  const endpoint = options.endpoint ?? discoverDaemon();
  if (!endpoint) {
    throw new DaemonNotRunningError();
  }
  return new WebSocketDaemonClient(endpoint, {
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  });
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface ResolvedTimeouts {
  readonly requestTimeoutMs: number;
  readonly connectTimeoutMs: number;
}

/** A single in-flight request awaiting its id-correlated response frame. */
interface PendingCall {
  readonly resolve: (result: RpcResult<unknown>) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class WebSocketDaemonClient implements DaemonClient {
  private ws: WebSocket | undefined;
  private readonly pending = new Map<string, PendingCall>();
  private readonly listeners = new Set<(e: DaemonEvent) => void>();
  private idCounter = 0;
  private closed = false;

  constructor(
    private readonly endpoint: DaemonEndpoint,
    private readonly timeouts: ResolvedTimeouts,
  ) {}

  connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('DaemonClient is closed'));
    }
    if (this.ws) {
      return Promise.reject(new Error('DaemonClient is already connected'));
    }

    const url = `ws://${this.endpoint.host}:${this.endpoint.port}/ws?token=${this.endpoint.token}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
        ws.close();
        reject(new Error(`Timed out connecting to daemon after ${this.timeouts.connectTimeoutMs}ms`));
      }, this.timeouts.connectTimeoutMs);

      const onOpen = (): void => {
        clearTimeout(timer);
        ws.removeListener('error', onError);
        this.attachSteadyStateHandlers(ws);
        resolve();
      };

      const onError = (err: Error): void => {
        clearTimeout(timer);
        ws.removeListener('open', onOpen);
        reject(err);
      };

      ws.once('open', onOpen);
      ws.once('error', onError);
    });
  }

  call<T = unknown>(method: MethodName, params: Record<string, unknown> = {}): Promise<RpcResult<T>> {
    if (this.closed) {
      return Promise.reject(new Error('DaemonClient is closed'));
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('DaemonClient is not connected'));
    }

    const id = `rpc-${++this.idCounter}`;
    return new Promise<RpcResult<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request "${method}" (${id}) timed out after ${this.timeouts.requestTimeoutMs}ms`));
      }, this.timeouts.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (result: RpcResult<unknown>) => void,
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  onEvent(listener: (e: DaemonEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.rejectAllPending(new Error('DaemonClient closed'));
    this.listeners.clear();

    const ws = this.ws;
    if (!ws) return;

    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
    });
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private attachSteadyStateHandlers(ws: WebSocket): void {
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => this.handleMessage(data));
    ws.on('close', () => this.handleClose());
    // Post-handshake errors surface via the 'close' that follows; rejecting
    // pending calls there keeps a single drain path. The no-op listener
    // prevents an unhandled 'error' from crashing the process.
    ws.on('error', () => {});
  }

  private handleMessage(data: Buffer | ArrayBuffer | Buffer[]): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(wsDataToString(data)) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof frame.id === 'string') {
      this.settleResponse(frame.id, frame);
      return;
    }

    if (typeof frame.event === 'string') {
      this.fanOutEvent({
        event: frame.event,
        payload: frame.payload,
        seq: typeof frame.seq === 'number' ? frame.seq : 0,
      });
    }
  }

  private settleResponse(id: string, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(toRpcResult(frame));
  }

  private fanOutEvent(event: DaemonEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving listener must not break delivery to the others.
      }
    }
  }

  private handleClose(): void {
    this.rejectAllPending(new Error('Daemon connection closed'));
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

/** Maps a raw `{id,ok,...}` response frame to the {@link RpcResult} discriminant. */
function toRpcResult(frame: Record<string, unknown>): RpcResult<unknown> {
  if (frame.ok === true) {
    return { ok: true, payload: frame.payload };
  }
  const error = frame.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
  return {
    ok: false,
    code: (typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR') as ErrorCode,
    message: typeof error?.message === 'string' ? error.message : 'Unknown RPC error',
    data: error?.data,
  };
}
