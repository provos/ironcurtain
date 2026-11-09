import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { mockSession } from '../lib/__tests__/fixtures.js';

const { mockRequest } = vi.hoisted(() => ({
  mockRequest: vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('../lib/ws-client.js', () => ({
  createWsClient: () => ({
    request: mockRequest,
    onEvent: () => () => {},
    onConnectionChange: () => () => {},
    onAuthError: () => () => {},
  }),
}));
vi.mock('$lib/components/features/terminal-console.svelte', async () => await import('../__test_stubs__/Stub.svelte'));

import { appState } from '../lib/stores.svelte.js';
import Sessions from './Sessions.svelte';

describe('Sessions terminal viewing lifecycle', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockRequest.mockImplementation(async (method) => {
      if (method === 'config.getModelProviders') return { profiles: {} };
      return [];
    });
    appState.connected = true;
    appState.sessions = new Map([
      [1, mockSession(1, { source: { kind: 'web-pty' } })],
      [2, mockSession(2, { source: { kind: 'web-pty' } })],
    ]);
    appState.selectedSessionLabel = 1;
  });

  afterEach(() => cleanup());

  function subscriptionCalls(): unknown[][] {
    return mockRequest.mock.calls.filter(([method]) => method.startsWith('sessions.pty'));
  }

  it('switches terminal subscriptions without ending either session', async () => {
    render(Sessions);
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('sessions.ptyAttach', { label: 1 }));

    await fireEvent.click(screen.getByTestId('session-item-2'));

    await waitFor(() =>
      expect(subscriptionCalls()).toEqual([
        ['sessions.ptyAttach', { label: 1 }],
        ['sessions.ptyDetach', { label: 1 }],
        ['sessions.ptyAttach', { label: 2 }],
      ]),
    );
    expect(appState.sessions.size).toBe(2);
    expect(mockRequest.mock.calls.some(([method]) => method === 'sessions.end')).toBe(false);
  });

  it('detaches when the route unmounts and reattaches the existing session on return', async () => {
    const view = render(Sessions);
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('sessions.ptyAttach', { label: 1 }));

    view.unmount();
    expect(mockRequest).toHaveBeenCalledWith('sessions.ptyDetach', { label: 1 });
    render(Sessions);

    await waitFor(() =>
      expect(subscriptionCalls()).toEqual([
        ['sessions.ptyAttach', { label: 1 }],
        ['sessions.ptyDetach', { label: 1 }],
        ['sessions.ptyAttach', { label: 1 }],
      ]),
    );
    expect(appState.selectedSessionLabel).toBe(1);
    expect(appState.sessions.size).toBe(2);
    expect(mockRequest.mock.calls.some(([method]) => method === 'sessions.end')).toBe(false);
  });
});
