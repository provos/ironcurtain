import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWsClient } from '../ws-client.js';

// ---------------------------------------------------------------------------
// MockWebSocket — minimal stand-in for the browser WebSocket API
// ---------------------------------------------------------------------------

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  // --- test helpers ---

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }
}

// ---------------------------------------------------------------------------
// Global WebSocket stub — captures the most recent instance
// ---------------------------------------------------------------------------

let mockWs: MockWebSocket;

vi.stubGlobal(
  'WebSocket',
  class extends MockWebSocket {
    constructor(_url: string) {
      super();
      mockWs = this;
      // Simulate async open (mirrors real browser behavior)
      setTimeout(() => this.simulateOpen(), 0);
    }
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Connect a client and wait for the mock socket to open. */
async function connectClient() {
  const client = createWsClient();
  client.connect('ws://localhost:7400/ws', 'mock-token');
  await vi.waitFor(() => expect(client.isConnected).toBe(true));
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WsClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Request/response correlation
  it('correlates request and response by id', async () => {
    const client = await connectClient();

    const promise = client.request<{ ok: boolean }>('status');

    const frame = JSON.parse(mockWs.sent[0]);
    expect(frame.method).toBe('status');

    // Respond with matching id
    mockWs.simulateMessage(JSON.stringify({ id: frame.id, ok: true, payload: { ok: true } }));

    const result = await promise;
    expect(result).toEqual({ ok: true });
  });

  // 2. Event dispatch
  it('dispatches events to registered handlers', async () => {
    const client = createWsClient();
    const handler = vi.fn();
    client.onEvent(handler);
    client.connect('ws://localhost:7400/ws', 'mock-token');
    await vi.waitFor(() => expect(client.isConnected).toBe(true));

    mockWs.simulateMessage(JSON.stringify({ event: 'session.created', payload: { label: 1 }, seq: 1 }));

    expect(handler).toHaveBeenCalledWith('session.created', { label: 1 });
  });

  // 3. Rejection on close
  it('rejects pending requests when connection closes', async () => {
    const client = await connectClient();

    const promise = client.request('status');
    mockWs.simulateClose();

    await expect(promise).rejects.toThrow('Connection closed');
  });

  // 4. Request timeout
  it('rejects request after timeout when no response arrives', async () => {
    const client = await connectClient();

    const promise = client.request('slow-method');

    // Advance past the 120s request timeout.
    // Catch the rejection first to avoid unhandled rejection warnings,
    // then advance timers so the timeout fires.
    const rejection = expect(promise).rejects.toThrow('Request timed out');
    await vi.advanceTimersByTimeAsync(120_001);
    await rejection;
  });

  // 5. Auto-reconnect
  it('reconnects after connection loss', async () => {
    const client = createWsClient();
    const connectionHandler = vi.fn();
    client.onConnectionChange(connectionHandler);
    client.connect('ws://localhost:7400/ws', 'mock-token');

    // Initial open
    await vi.advanceTimersByTimeAsync(0);
    expect(connectionHandler).toHaveBeenCalledWith(true);

    // Disconnect
    mockWs.simulateClose();
    expect(connectionHandler).toHaveBeenCalledWith(false);

    // Advance past reconnect delay (base 1s * 1.5^1 = 1.5s).
    // The new MockWebSocket constructor auto-opens via setTimeout(0),
    // which also fires within this advance.
    await vi.advanceTimersByTimeAsync(2000);

    expect(connectionHandler).toHaveBeenCalledTimes(3); // true, false, true
    expect(connectionHandler).toHaveBeenLastCalledWith(true);
  });

  // ---------------------------------------------------------------------
  // Preflight — gate the WS upgrade on an HTTP probe so a bad token is
  // detectable (the browser WebSocket API hides 401s from JS).
  // ---------------------------------------------------------------------

  // 6. Preflight "invalid" stops reconnects and fires onAuthError
  it('fires onAuthError and does not open a WS when preflight returns "invalid"', async () => {
    const preflight = vi.fn().mockResolvedValue('invalid' as const);
    const client = createWsClient(preflight);
    const authErrorHandler = vi.fn();
    const connectionHandler = vi.fn();
    client.onAuthError(authErrorHandler);
    client.onConnectionChange(connectionHandler);

    client.connect('ws://localhost:7400/ws', 'bad-token');

    // Flush the preflight microtask and any scheduled timers.
    await vi.runAllTimersAsync();

    expect(preflight).toHaveBeenCalledWith('bad-token');
    expect(authErrorHandler).toHaveBeenCalledOnce();
    expect(connectionHandler).not.toHaveBeenCalledWith(true);
    // No WS should have been constructed; mockWs from earlier tests
    // leaks across describe blocks, but re-opening here would have
    // reset it — we assert on the absence of a "true" connection event.
  });

  // 7. Preflight "ok" proceeds with the WS upgrade
  it('opens the WS when preflight returns "ok"', async () => {
    const preflight = vi.fn().mockResolvedValue('ok' as const);
    const client = createWsClient(preflight);
    const connectionHandler = vi.fn();
    client.onConnectionChange(connectionHandler);

    client.connect('ws://localhost:7400/ws', 'good-token');

    await vi.runAllTimersAsync();

    expect(preflight).toHaveBeenCalledWith('good-token');
    expect(connectionHandler).toHaveBeenCalledWith(true);
  });

  // 8. Preflight "offline" reschedules without firing authError
  it('schedules a reconnect (but does not flip authError) when preflight returns "offline"', async () => {
    // First call: offline (daemon down). Second call: ok (daemon came back).
    const preflight = vi
      .fn<(token: string) => Promise<'ok' | 'invalid' | 'offline'>>()
      .mockResolvedValueOnce('offline')
      .mockResolvedValueOnce('ok');
    const client = createWsClient(preflight);
    const authErrorHandler = vi.fn();
    const connectionHandler = vi.fn();
    client.onAuthError(authErrorHandler);
    client.onConnectionChange(connectionHandler);

    client.connect('ws://localhost:7400/ws', 'some-token');

    // Let the first preflight resolve and the reconnect timer schedule.
    await vi.runAllTimersAsync();

    expect(preflight).toHaveBeenCalledTimes(2);
    expect(authErrorHandler).not.toHaveBeenCalled();
    expect(connectionHandler).toHaveBeenCalledWith(true);
  });

  // 9. A rejected preflight must not kill the reconnect loop: treat as 'offline'.
  it('treats a rejected preflight as "offline" and keeps retrying', async () => {
    const preflight = vi
      .fn<(token: string) => Promise<'ok' | 'invalid' | 'offline'>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');
    const client = createWsClient(preflight);
    const authErrorHandler = vi.fn();
    const connectionHandler = vi.fn();
    client.onAuthError(authErrorHandler);
    client.onConnectionChange(connectionHandler);

    client.connect('ws://localhost:7400/ws', 'some-token');

    await vi.runAllTimersAsync();

    expect(preflight).toHaveBeenCalledTimes(2);
    expect(authErrorHandler).not.toHaveBeenCalled();
    expect(connectionHandler).toHaveBeenCalledWith(true);
  });
});
