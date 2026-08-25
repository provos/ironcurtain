import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';

const {
  mockAppState,
  mockCreateSession,
  mockListPersonas,
  mockGetModelProviders,
  mockSendPtyInput,
  mockListResumableSessions,
  mockResumeSession,
} = vi.hoisted(() => ({
  mockAppState: {
    connected: true,
    daemonStatus: null as Record<string, unknown> | null,
    sessions: new Map(),
    selectedSessionLabel: null as number | null,
    selectedSession: null as {
      label: number;
      source: { kind: string };
      status: string;
      persona?: string;
      turnCount: number;
      budget: { estimatedCostUsd: number };
    } | null,
    escalationDismissedAt: 0,
  },
  mockCreateSession: vi.fn<(opts?: unknown) => Promise<{ label: number }>>(),
  mockListPersonas: vi.fn<() => Promise<unknown[]>>(),
  mockGetModelProviders: vi.fn<() => Promise<{ profiles: Record<string, unknown> }>>(),
  mockSendPtyInput: vi.fn<(label: number, dataB64: string) => Promise<void>>(),
  mockListResumableSessions: vi.fn<() => Promise<unknown[]>>(),
  mockResumeSession: vi.fn<(sessionId: string) => Promise<{ label: number }>>(),
}));

vi.mock('../lib/stores.svelte.js', () => ({
  appState: mockAppState,
  createSession: mockCreateSession,
  endSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  listPersonas: mockListPersonas,
  attachPty: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  detachPty: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  sendPtyInput: mockSendPtyInput,
  sendPtyResize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  sendPtyPrompt: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  registerPtySink: vi.fn(),
  unregisterPtySink: vi.fn(),
  connectPtyTerminal: vi.fn(),
  disconnectPtyTerminal: vi.fn(),
  getModelProviders: mockGetModelProviders,
  listResumableSessions: mockListResumableSessions,
  resumeSession: mockResumeSession,
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
    mockAppState.connected = true;
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
    mockSendPtyInput.mockReset();
    mockSendPtyInput.mockResolvedValue(undefined);
    mockListResumableSessions.mockReset();
    mockListResumableSessions.mockResolvedValue([]);
    mockResumeSession.mockReset();
    mockResumeSession.mockResolvedValue({ label: 12 });
  });

  it('explains PTY shutdown and disables ending it again while stopping', () => {
    const stoppingSession = {
      label: 4,
      source: { kind: 'web-pty' },
      status: 'stopping',
      persona: undefined,
      turnCount: 0,
      budget: { estimatedCostUsd: 0 },
    };
    mockAppState.sessions = new Map([[4, stoppingSession]]);
    mockAppState.selectedSessionLabel = 4;
    mockAppState.selectedSession = stoppingSession;

    render(Sessions);

    expect(
      screen.getByRole('status', { name: 'Stopping. Input is unavailable while shutdown completes.' }),
    ).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Stopping…' })).toHaveProperty('disabled', true);
    expect(screen.getByTestId('pty-prompt-input')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('pty-prompt-send')).toHaveProperty('disabled', true);
  });

  it('suppresses terminal input while stopping but forwards it when ready', async () => {
    const stoppingSession = {
      label: 4,
      source: { kind: 'web-pty' },
      status: 'stopping',
      persona: undefined,
      turnCount: 0,
      budget: { estimatedCostUsd: 0 },
    };
    mockAppState.sessions = new Map([[4, stoppingSession]]);
    mockAppState.selectedSessionLabel = 4;
    mockAppState.selectedSession = stoppingSession;

    const { unmount } = render(Sessions);
    await fireEvent.click(screen.getByTestId('test-stub-input'));
    expect(mockSendPtyInput).not.toHaveBeenCalled();
    unmount();

    mockAppState.sessions = new Map([[4, { ...stoppingSession, status: 'ready' }]]);
    mockAppState.selectedSession = { ...stoppingSession, status: 'ready' };
    render(Sessions);
    await fireEvent.click(screen.getByTestId('test-stub-input'));
    expect(mockSendPtyInput).toHaveBeenCalledWith(4, 'AQ==');
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

  it('loads resumable sessions on demand and selects the resumed terminal', async () => {
    mockListResumableSessions.mockResolvedValue([
      {
        sessionId: 'saved-session-1234',
        displayName: 'Claude Code session',
        agent: 'claude-code',
        status: 'user-exit',
        lastActivity: new Date().toISOString(),
        workspaceLabel: '~/src/project',
        persona: 'reviewer',
      },
    ]);
    render(Sessions);

    await fireEvent.click(screen.getByRole('button', { name: 'Resume previous…' }));
    expect(await screen.findByText('Claude Code session')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Resume Claude Code session' }));

    expect(mockResumeSession).toHaveBeenCalledWith('saved-session-1234');
    await waitFor(() => expect(mockAppState.selectedSessionLabel).toBe(12));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the resume dialog open with retry feedback after a failed request', async () => {
    mockListResumableSessions
      .mockRejectedValueOnce(new Error('Unable to read saved sessions'))
      .mockResolvedValueOnce([]);
    render(Sessions);

    await fireEvent.click(screen.getByRole('button', { name: 'Resume previous…' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to read saved sessions');
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(mockListResumableSessions).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('No resumable sessions')).toBeTruthy();
  });
});
