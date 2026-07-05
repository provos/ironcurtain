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
  sendPtyPrompt,
  createSession,
  registerPtySink,
  unregisterPtySink,
  connectPtyTerminal,
  disconnectPtyTerminal,
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

  it('sendPtyPrompt sends sessions.ptyPrompt with PLAIN text (not base64)', async () => {
    await sendPtyPrompt(5, 'approve the write');
    expect(mockRequest).toHaveBeenCalledWith('sessions.ptyPrompt', { label: 5, text: 'approve the write' });
  });
});

describe('createSession launch options', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockRequest.mockResolvedValue({ label: 1 });
  });

  it('sends an empty params object when no options are given', async () => {
    await createSession();
    expect(mockRequest).toHaveBeenCalledWith('sessions.create', {});
  });

  it('sends only persona when only persona is provided', async () => {
    await createSession({ persona: 'reviewer' });
    expect(mockRequest).toHaveBeenCalledWith('sessions.create', { persona: 'reviewer' });
  });

  it('sends only the provided launch-option keys (omits the rest)', async () => {
    await createSession({ workspacePath: '/repo', model: 'anthropic/claude-sonnet-4.5' });
    expect(mockRequest).toHaveBeenCalledWith('sessions.create', {
      workspacePath: '/repo',
      model: 'anthropic/claude-sonnet-4.5',
    });
  });

  it('sends all keys when all launch options are provided', async () => {
    await createSession({
      persona: 'reviewer',
      workspacePath: '/repo',
      providerProfileName: 'glm-5.2',
      model: 'z-ai/glm-5.2',
    });
    expect(mockRequest).toHaveBeenCalledWith('sessions.create', {
      persona: 'reviewer',
      workspacePath: '/repo',
      providerProfileName: 'glm-5.2',
      model: 'z-ai/glm-5.2',
    });
  });

  it('drops empty-string option values (does not send blank keys)', async () => {
    await createSession({ persona: '', workspacePath: '', providerProfileName: '', model: '' });
    expect(mockRequest).toHaveBeenCalledWith('sessions.create', {});
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

  it('routes pty_output/pty_replay to a connected terminal handle live', () => {
    // Force the client to be built + event handlers wired.
    getWsClient();
    expect(capturedOnEvent).toBeDefined();

    const handle = makeSink();
    registerPtySink(42);
    connectPtyTerminal(42, handle);

    capturedOnEvent?.('session.pty_replay', { label: 42, snapshot: 'c25hcA==' });
    capturedOnEvent?.('session.pty_output', { label: 42, data: 'ZnJhbWU=' });
    expect(handle.resets).toEqual(['c25hcA==']);
    expect(handle.writes).toEqual(['ZnJhbWU=']);

    // After unregister the event is a no-op (no throw, no delivery).
    unregisterPtySink(42);
    capturedOnEvent?.('session.pty_output', { label: 42, data: 'YWZ0ZXI=' });
    expect(handle.writes).toEqual(['ZnJhbWU=']);
  });

  it('buffers frames that arrive before connect and flushes them in order on connect', () => {
    // The drop-fix: a fast daemon sends the one-shot replay the instant it
    // receives ptyAttach, which can beat the terminal's mount. The buffering
    // sink must hold the replay (+ any following deltas) until connect.
    getWsClient();
    registerPtySink(43);

    capturedOnEvent?.('session.pty_replay', { label: 43, snapshot: 'c25hcA==' });
    capturedOnEvent?.('session.pty_output', { label: 43, data: 'ZGVsdGE=' });

    const handle = makeSink();
    // Nothing delivered yet — the terminal was not connected.
    expect(handle.resets).toEqual([]);
    expect(handle.writes).toEqual([]);

    connectPtyTerminal(43, handle);
    expect(handle.resets).toEqual(['c25hcA==']);
    expect(handle.writes).toEqual(['ZGVsdGE=']);
    unregisterPtySink(43);
  });

  it('a buffered replay supersedes earlier buffered deltas (snapshot is source of truth)', () => {
    getWsClient();
    registerPtySink(44);

    capturedOnEvent?.('session.pty_output', { label: 44, data: 'c3RhbGU=' });
    capturedOnEvent?.('session.pty_replay', { label: 44, snapshot: 'ZnJlc2g=' });

    const handle = makeSink();
    connectPtyTerminal(44, handle);
    // The stale pre-replay delta is dropped; only the snapshot replays.
    expect(handle.writes).toEqual([]);
    expect(handle.resets).toEqual(['ZnJlc2g=']);
    unregisterPtySink(44);
  });

  it('connectPtyTerminal is order-independent with registerPtySink', () => {
    getWsClient();
    const handle = makeSink();
    // Terminal mounts (connect) before the route registered the sink.
    connectPtyTerminal(45, handle);
    capturedOnEvent?.('session.pty_output', { label: 45, data: 'bGl2ZQ==' });
    expect(handle.writes).toEqual(['bGl2ZQ==']);

    // disconnect re-buffers until the next connect.
    disconnectPtyTerminal(45);
    capturedOnEvent?.('session.pty_output', { label: 45, data: 'YnVmZg==' });
    expect(handle.writes).toEqual(['bGl2ZQ==']);
    const handle2 = makeSink();
    connectPtyTerminal(45, handle2);
    expect(handle2.writes).toEqual(['YnVmZg==']);
    unregisterPtySink(45);
  });
});
