import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';

// ---------------------------------------------------------------------------
// Stub matchMedia (read for reduced-motion in App.svelte's onMount path).
// ---------------------------------------------------------------------------

vi.stubGlobal(
  'matchMedia',
  vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
);

// ---------------------------------------------------------------------------
// Mock the store so the app renders the connected layout (sidebar + main).
// ---------------------------------------------------------------------------

const { mockAppState, mockInitConnection } = vi.hoisted(() => ({
  mockAppState: {
    connected: true,
    hasToken: true,
    authError: null as null | 'invalid_token',
    daemonStatus: null,
    sessions: new Map(),
    selectedSessionLabel: null as number | null,
    selectedSession: null,
    pendingEscalations: new Map(),
    escalationDisplayNumber: 0,
    escalationDismissedAt: 0,
    escalationCount: 0,
    activeSessionCount: 0,
    pendingGates: new Map(),
    currentView: 'dashboard' as 'dashboard' | 'sessions' | 'escalations' | 'jobs' | 'workflows' | 'personas',
    sessionOutputs: new Map(),
    getOutput: () => [],
  },
  mockInitConnection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./lib/stores.svelte.js', () => ({
  appState: mockAppState,
  initConnection: mockInitConnection,
  connectWithToken: vi.fn(),
  resolveEscalation: vi.fn(),
  getTheme: () => 'iron',
  setTheme: vi.fn(),
}));

// Stub routed views and feature components -- their internals pull in WS/store
// wiring we don't need for chrome-level assertions. Each one resolves to a
// trivial Svelte component.
vi.mock('./routes/Dashboard.svelte', async () => await import('./__test_stubs__/RouteStub.svelte'));
vi.mock('./routes/Sessions.svelte', async () => await import('./__test_stubs__/RouteStub.svelte'));
vi.mock('./routes/Escalations.svelte', async () => await import('./__test_stubs__/RouteStub.svelte'));
vi.mock('./routes/Jobs.svelte', async () => await import('./__test_stubs__/RouteStub.svelte'));
vi.mock('./routes/Workflows.svelte', async () => await import('./__test_stubs__/RouteStub.svelte'));
vi.mock('./routes/Personas.svelte', async () => await import('./__test_stubs__/RouteStub.svelte'));
vi.mock('$lib/components/features/escalation-modal.svelte', async () => await import('./__test_stubs__/Empty.svelte'));
vi.mock('$lib/components/features/matrix-rain.svelte', async () => await import('./__test_stubs__/Empty.svelte'));
vi.mock('$lib/flash-title.js', () => ({ startFlashTitle: () => () => undefined }));

import App from './App.svelte';

// ---------------------------------------------------------------------------
// Tests -- focus on the mobile drawer behaviour added in fix-pack A.
// ---------------------------------------------------------------------------

describe('App mobile drawer', () => {
  beforeEach(() => {
    mockAppState.connected = true;
    mockAppState.hasToken = true;
    mockAppState.currentView = 'dashboard';
  });

  it('renders the hamburger button for the mobile top bar', () => {
    render(App);
    expect(screen.getByLabelText('Open menu')).toBeTruthy();
  });

  it('opens the drawer when the hamburger is clicked', async () => {
    render(App);
    // The drawer carries aria-hidden="true" while closed, which excludes it
    // from the a11y tree, so we query by role with `hidden: true`.
    const dialog = screen.getByLabelText('Main navigation');

    // Drawer is rendered but offscreen by default.
    expect(dialog.className).toMatch(/-translate-x-full/);
    expect(dialog.getAttribute('aria-hidden')).toBe('true');

    await fireEvent.click(screen.getByLabelText('Open menu'));

    expect(dialog.className).toMatch(/translate-x-0/);
    expect(dialog.className).not.toMatch(/-translate-x-full/);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('closes the drawer when the backdrop is clicked', async () => {
    render(App);
    await fireEvent.click(screen.getByLabelText('Open menu'));

    // Backdrop is the role="button" overlay; multiple "Close menu" labels
    // exist (backdrop + X button), so query by data-testid to disambiguate.
    const backdrop = screen.getByTestId('drawer-backdrop');
    await fireEvent.click(backdrop);

    const dialog = screen.getByLabelText('Main navigation');
    expect(dialog.className).toMatch(/-translate-x-full/);
  });

  it('closes the drawer when Escape is pressed', async () => {
    render(App);
    await fireEvent.click(screen.getByLabelText('Open menu'));

    await fireEvent.keyDown(window, { key: 'Escape' });

    const dialog = screen.getByLabelText('Main navigation');
    expect(dialog.className).toMatch(/-translate-x-full/);
  });
});
