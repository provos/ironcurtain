import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';

const { mockAppState, mockCreateSession, mockListPersonas, mockGetModelProviders } = vi.hoisted(() => ({
  mockAppState: {
    daemonStatus: null as Record<string, unknown> | null,
    sessions: new Map(),
    selectedSessionLabel: null as number | null,
    selectedSession: null,
    escalationDismissedAt: 0,
  },
  mockCreateSession: vi.fn<(opts?: unknown) => Promise<{ label: number }>>(),
  mockListPersonas: vi.fn<() => Promise<unknown[]>>(),
  mockGetModelProviders: vi.fn<() => Promise<{ profiles: Record<string, unknown> }>>(),
}));

vi.mock('../lib/stores.svelte.js', () => ({
  appState: mockAppState,
  createSession: mockCreateSession,
  endSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  listPersonas: mockListPersonas,
  attachPty: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  detachPty: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  sendPtyInput: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  sendPtyResize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  sendPtyPrompt: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  registerPtySink: vi.fn(),
  unregisterPtySink: vi.fn(),
  connectPtyTerminal: vi.fn(),
  disconnectPtyTerminal: vi.fn(),
  getModelProviders: mockGetModelProviders,
}));

vi.mock('$lib/components/features/terminal-console.svelte', async () => await import('../__test_stubs__/Stub.svelte'));

import Sessions from './Sessions.svelte';

function makeStatus(sessionMode?: 'builtin' | 'container'): Record<string, unknown> {
  return {
    uptimeSeconds: 1,
    jobs: { total: 0, enabled: 0, running: 0 },
    signalConnected: false,
    webUiListening: true,
    activeSessions: 0,
    nextFireTime: null,
    ...(sessionMode ? { sessionMode } : {}),
  };
}

describe('Sessions create flow guards', () => {
  beforeEach(() => {
    mockAppState.daemonStatus = makeStatus('container');
    mockAppState.sessions = new Map();
    mockAppState.selectedSessionLabel = null;
    mockAppState.selectedSession = null;
    mockAppState.escalationDismissedAt = 0;
    mockCreateSession.mockReset();
    mockCreateSession.mockResolvedValue({ label: 7 });
    mockListPersonas.mockReset();
    mockListPersonas.mockResolvedValue([]);
    mockGetModelProviders.mockReset();
    mockGetModelProviders.mockResolvedValue({ profiles: { native: { type: 'native' } } });
  });

  it('does not create duplicate sessions from repeated native form submits while create is in flight', async () => {
    let resolveCreate: ((value: { label: number }) => void) | undefined;
    mockCreateSession.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    render(Sessions);

    const form = screen.getByTestId('session-launch-form');
    await fireEvent.submit(form);
    await fireEvent.submit(form);

    expect(mockCreateSession).toHaveBeenCalledTimes(1);

    resolveCreate?.({ label: 7 });
    await waitFor(() => expect(mockAppState.selectedSessionLabel).toBe(7));
  });

  it('shows an upgrade/restart message when daemon status omits sessionMode', async () => {
    mockAppState.daemonStatus = makeStatus();
    render(Sessions);

    await fireEvent.click(screen.getByTestId('launch-start'));

    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(screen.getByText(/daemon session-mode support/i)).toBeTruthy();
    expect(screen.queryByText(/container mode enabled/i)).toBeNull();
  });

  it('shows a container-mode message when the daemon explicitly reports builtin mode', async () => {
    mockAppState.daemonStatus = makeStatus('builtin');
    render(Sessions);

    await fireEvent.click(screen.getByTestId('launch-start'));

    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(screen.getByText(/container mode enabled/i)).toBeTruthy();
  });
});
