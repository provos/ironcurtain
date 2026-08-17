import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobListDto, PtySink, SessionDto } from '../types.js';

// ---------------------------------------------------------------------------
// Mock the WS client dependency so getWsClient() returns a spyable client.
// stores.svelte.ts lazily builds its singleton via createWsClient(); replacing
// that lets us assert the exact RPC method + params each action sends, and
// capture the wired onEvent handler to exercise the sink registry seam.
// ---------------------------------------------------------------------------

const mockRequest = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>();
let capturedOnEvent: ((event: string, payload: unknown) => void) | undefined;
let capturedOnConnectionChange: ((connected: boolean) => void) | undefined;

const mockClient = {
  request: mockRequest,
  onEvent: vi.fn((handler: (event: string, payload: unknown) => void) => {
    capturedOnEvent = handler;
    return () => {};
  }),
  onConnectionChange: vi.fn((handler: (connected: boolean) => void) => {
    capturedOnConnectionChange = handler;
    return () => {};
  }),
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
  appState,
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mockSession(label: number, overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    label,
    source: { kind: 'web' },
    status: 'ready',
    turnCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    hasPendingEscalation: false,
    messageInFlight: false,
    budget: {
      totalTokens: 0,
      stepCount: 0,
      elapsedSeconds: 0,
      estimatedCostUsd: 0,
      tokenTrackingAvailable: true,
      limits: {
        maxTotalTokens: null,
        maxSteps: null,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
      },
    },
    ...overrides,
  };
}

describe('connection refresh ordering', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    appState.sessions = new Map();
    appState.jobs = [];
    appState.sessionOutputs = new Map();
    appState.selectedSessionLabel = null;
  });

  function configureRefresh(
    sessionLists: Array<{ promise: Promise<SessionDto[]> }>,
    jobsList: Promise<JobListDto[]> = Promise.resolve([{} as JobListDto]),
  ): { sessionRequestCount: () => number } {
    let sessionRequestCount = 0;
    mockRequest.mockImplementation((method) => {
      if (method === 'sessions.list') {
        sessionRequestCount++;
        return sessionLists.shift()?.promise ?? Promise.resolve([]);
      }
      if (method === 'jobs.list') return jobsList;
      if (method === 'status') return Promise.resolve({});
      if (method === 'escalations.list') return Promise.resolve([]);
      if (method === 'workflows.list') return Promise.resolve([]);
      if (method === 'personas.listCompiles') {
        return Promise.resolve({ active: [], recent: [], queueDepth: 0 });
      }
      return Promise.resolve(undefined);
    });
    return { sessionRequestCount: () => sessionRequestCount };
  }

  it('replays a session event received before a stale sessions.list response', async () => {
    const sessionsList = deferred<SessionDto[]>();
    const existingSession = mockSession(1);
    appState.sessions = new Map([[existingSession.label, existingSession]]);
    configureRefresh([sessionsList]);

    getWsClient();
    capturedOnConnectionChange?.(true);

    capturedOnEvent?.('session.ended', { label: existingSession.label, reason: 'budget_exhausted' });
    expect(appState.sessions.has(existingSession.label)).toBe(false);

    // The response was generated before the ended event and is stale.
    sessionsList.resolve([existingSession]);
    await vi.waitFor(() => expect(appState.jobs).toHaveLength(1));
    expect(appState.sessions.has(existingSession.label)).toBe(false);
  });

  it('keeps a session event received after the snapshot while another refresh RPC is pending', async () => {
    const sessionsList = deferred<SessionDto[]>();
    const jobsList = deferred<JobListDto[]>();
    const snapshotSession = mockSession(1);
    const eventSession = mockSession(2);
    configureRefresh([sessionsList], jobsList.promise);

    getWsClient();
    capturedOnConnectionChange?.(true);

    sessionsList.resolve([snapshotSession]);
    await vi.waitFor(() => expect(appState.sessions.has(snapshotSession.label)).toBe(true));

    // The snapshot has arrived, but jobs.list is still pending. This event is
    // later on the same socket and must remain authoritative after refreshAll.
    capturedOnEvent?.('session.created', eventSession);
    expect(appState.sessions.has(eventSession.label)).toBe(true);

    jobsList.resolve([{} as JobListDto]);
    await vi.waitFor(() => expect(appState.jobs).toHaveLength(1));
    expect(appState.sessions.has(eventSession.label)).toBe(true);
  });

  it('applies the session snapshot when an unrelated refresh RPC rejects first', async () => {
    const sessionsList = deferred<SessionDto[]>();
    const jobsList = deferred<JobListDto[]>();
    const snapshotSession = mockSession(1);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    configureRefresh([sessionsList], jobsList.promise);

    getWsClient();
    capturedOnConnectionChange?.(true);
    jobsList.reject(new Error('jobs unavailable'));
    sessionsList.resolve([snapshotSession]);

    await vi.waitFor(() => expect(appState.sessions.get(snapshotSession.label)).toEqual(snapshotSession));
    errorSpy.mockRestore();
  });

  it('queues a second session refresh behind a failing first request', async () => {
    const firstSessionsList = deferred<SessionDto[]>();
    const secondSessionsList = deferred<SessionDto[]>();
    const newerSession = mockSession(1, { status: 'completed', turnCount: 2 });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refreshes = configureRefresh([firstSessionsList, secondSessionsList]);

    getWsClient();
    capturedOnConnectionChange?.(true);
    capturedOnConnectionChange?.(true);
    await vi.waitFor(() => expect(refreshes.sessionRequestCount()).toBe(1));

    firstSessionsList.reject(new Error('stale connection'));
    await vi.waitFor(() => expect(refreshes.sessionRequestCount()).toBe(2));
    secondSessionsList.resolve([newerSession]);

    await vi.waitFor(() => expect(appState.sessions.get(newerSession.label)).toEqual(newerSession));
    errorSpy.mockRestore();
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

  it('caps the pre-connect buffer so a terminal that never connects cannot grow it without bound', () => {
    getWsClient();
    registerPtySink(46);
    const big = 'x'.repeat(200_000); // ~200KB per frame
    const total = 15; // ~3MB total, over the 2MB cap
    for (let i = 0; i < total; i++) {
      capturedOnEvent?.('session.pty_output', { label: 46, data: `${i}:${big}` });
    }
    const handle = makeSink();
    connectPtyTerminal(46, handle);
    // Oldest frames were dropped to stay under the cap; the newest is retained.
    expect(handle.writes.length).toBeGreaterThan(0);
    expect(handle.writes.length).toBeLessThan(total);
    expect(handle.writes[handle.writes.length - 1].startsWith(`${total - 1}:`)).toBe(true);
    unregisterPtySink(46);
  });
});
