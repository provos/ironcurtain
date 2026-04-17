/**
 * Typed WebSocket client with JSON-RPC framing and auto-reconnect.
 */

import type { ResponseFrame, EventFrame } from './types.js';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventHandler = (event: string, payload: unknown) => void;
type ConnectionHandler = (connected: boolean) => void;
type AuthErrorHandler = () => void;

/**
 * Result of the HTTP auth preflight.
 * - 'ok': token verified, proceed with WS upgrade
 * - 'invalid': server rejected the token (401); stop retrying
 * - 'offline': network/CORS error; daemon may be down; keep retrying
 */
export type PreflightResult = 'ok' | 'invalid' | 'offline';

export type PreflightFn = (token: string) => Promise<PreflightResult>;

export interface WsClient {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onEvent(handler: EventHandler): () => void;
  onConnectionChange(handler: ConnectionHandler): () => void;
  /** Fires once when the preflight returns 'invalid'. Reconnects stop. */
  onAuthError(handler: AuthErrorHandler): () => void;
  readonly isConnected: boolean;
  connect(url: string, token: string): void;
  disconnect(): void;
}

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

export function createWsClient(preflight?: PreflightFn): WsClient {
  let ws: WebSocket | null = null;
  let connected = false;
  let closed = false;
  let reconnectAttempts = 0;
  let wsUrl = '';
  let authToken = '';

  const pending = new Map<string, PendingRequest>();
  const eventHandlers = new Set<EventHandler>();
  const connectionHandlers = new Set<ConnectionHandler>();
  const authErrorHandlers = new Set<AuthErrorHandler>();
  let idCounter = 0;

  function setConnected(value: boolean): void {
    connected = value;
    for (const handler of connectionHandlers) {
      handler(value);
    }
  }

  function fireAuthError(): void {
    for (const handler of authErrorHandlers) {
      handler();
    }
  }

  async function doConnect(): Promise<void> {
    if (closed) return;

    // Preflight before opening the WebSocket. The browser WebSocket API
    // hides HTTP 401s (they surface as a generic close 1006), so we use
    // an HTTP probe to distinguish "bad token" from "daemon unreachable".
    if (preflight) {
      const result = await preflight(authToken);
      if (closed) return;
      if (result === 'invalid') {
        closed = true;
        fireAuthError();
        return;
      }
      if (result === 'offline') {
        scheduleReconnect();
        return;
      }
    }

    const separator = wsUrl.includes('?') ? '&' : '?';
    const fullUrl = `${wsUrl}${separator}token=${authToken}`;
    const socket = new WebSocket(fullUrl);

    socket.onopen = () => {
      reconnectAttempts = 0;
      setConnected(true);
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as Record<string, unknown>;

        // Event frame (has 'event' field)
        if ('event' in data) {
          const frame = data as unknown as EventFrame;
          for (const handler of eventHandlers) {
            handler(frame.event, frame.payload);
          }
          return;
        }

        // Response frame (has 'id' field)
        if ('id' in data) {
          const frame = data as unknown as ResponseFrame;
          const req = pending.get(frame.id);
          if (!req) return;
          pending.delete(frame.id);
          clearTimeout(req.timer);

          if (frame.ok) {
            req.resolve(frame.payload);
          } else {
            req.reject(new Error(frame.error.message));
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };

    socket.onclose = () => {
      ws = null;
      setConnected(false);

      // Reject all pending requests
      for (const [id, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Connection closed'));
        pending.delete(id);
      }

      if (!closed) {
        scheduleReconnect();
      }
    };

    socket.onerror = () => {
      // onclose will fire next
    };

    ws = socket;
  }

  function scheduleReconnect(): void {
    if (closed) return;
    reconnectAttempts++;
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
    setTimeout(() => {
      if (!closed) {
        void doConnect();
      }
    }, delay);
  }

  return {
    get isConnected() {
      return connected;
    },

    connect(url: string, token: string) {
      wsUrl = url;
      authToken = token;
      closed = false;
      reconnectAttempts = 0;
      void doConnect();
    },

    disconnect() {
      closed = true;
      if (ws) {
        ws.close();
        ws = null;
      }
      setConnected(false);
    },

    request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error('Not connected'));
          return;
        }

        const id = `req-${++idCounter}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Request timed out'));
        }, REQUEST_TIMEOUT_MS);

        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });

        const frame = { id, method, params: params ?? {} };
        ws.send(JSON.stringify(frame));
      });
    },

    onEvent(handler: EventHandler): () => void {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },

    onConnectionChange(handler: ConnectionHandler): () => void {
      connectionHandlers.add(handler);
      return () => connectionHandlers.delete(handler);
    },

    onAuthError(handler: AuthErrorHandler): () => void {
      authErrorHandlers.add(handler);
      return () => authErrorHandlers.delete(handler);
    },
  };
}
