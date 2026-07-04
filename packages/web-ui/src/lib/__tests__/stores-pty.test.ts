import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PtySink } from '../types.js';

// ---------------------------------------------------------------------------
// Mock the WS client dependency so getWsClient() returns a spyable client.
// stores.svelte.ts lazily builds its singleton via createWsClient(); replacing
// that lets us assert the exact RPC method + params each action sends, and
// capture the wired onEvent handler to exercise the sink registry seam.
// ---------------------------------------------------------------------------

const mockRequest = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>();
let capturedOnEvent: ((event: string, payload: unknown) => void) | undefined;

const mockClient = {
  request: mockRequest,
  onEvent: vi.fn((handler: (event: string, payload: unknown) => void) => {
    capturedOnEvent = handler;
    return () => {};
  }),
  onConnectionChange: vi.fn(() => () => {}),
  onAuthError: vi.fn(() => () => {}),
  get isConnected() {
    return false;
  },
  connect: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock('../ws-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ws-client.js')>();
  return { ...actual, createWsClient: () => mockClient };
});

import {
  attachPty,
  detachPty,
  sendPtyInput,
  sendPtyResize,
  registerPtySink,
  unregisterPtySink,
  getWsClient,
} from '../stores.svelte.js';

describe('PTY store actions', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockRequest.mockResolvedValue(undefined);
  });

  it('attachPty sends sessions.ptyAttach with the label', async () => {
    await attachPty(5);
    expect(mockRequest).toHaveBeenCalledWith('sessions.ptyAttach', { label: 5 });
  });

  it('detachPty sends sessions.ptyDetach with the label', async () => {
    await detachPty(5);
    expect(mockRequest).toHaveBeenCalledWith('sessions.ptyDetach', { label: 5 });
  });

  it('sendPtyInput sends sessions.ptyInput with { label, data }', async () => {
    await sendPtyInput(5, 'aGk=');
    expect(mockRequest).toHaveBeenCalledWith('sessions.ptyInput', { label: 5, data: 'aGk=' });
  });

  it('sendPtyResize sends sessions.ptyResize with { label, cols, rows }', async () => {
    await sendPtyResize(5, 120, 40);
    expect(mockRequest).toHaveBeenCalledWith('sessions.ptyResize', { label: 5, cols: 120, rows: 40 });
  });
});

describe('PTY sink registry seam', () => {
  // NOTE: the WS client is a module singleton wired exactly once, so the
  // event handler is captured on the first getWsClient() call in this file.
  // We must not clear `capturedOnEvent` between tests.

  function makeSink(): PtySink & { writes: string[]; resets: string[] } {
    const writes: string[] = [];
    const resets: string[] = [];
    return { writes, resets, write: (d) => writes.push(d), reset: (s) => resets.push(s) };
  }

  it('routes a session.pty_output event through the wired handler to a registered sink', () => {
    // Force the client to be built + event handlers wired.
    getWsClient();
    expect(capturedOnEvent).toBeDefined();

    const sink = makeSink();
    registerPtySink(42, sink);
    capturedOnEvent?.('session.pty_output', { label: 42, data: 'ZnJhbWU=' });
    expect(sink.writes).toEqual(['ZnJhbWU=']);

    // After unregister the event is a no-op (no throw, no delivery).
    unregisterPtySink(42);
    capturedOnEvent?.('session.pty_output', { label: 42, data: 'YWZ0ZXI=' });
    expect(sink.writes).toEqual(['ZnJhbWU=']);
  });

  it('routes session.pty_replay to the registered sink.reset', () => {
    getWsClient();
    const sink = makeSink();
    registerPtySink(99, sink);
    capturedOnEvent?.('session.pty_replay', { label: 99, snapshot: 'c25hcHNob3Q=' });
    expect(sink.resets).toEqual(['c25hcHNob3Q=']);
    unregisterPtySink(99);
  });
});
