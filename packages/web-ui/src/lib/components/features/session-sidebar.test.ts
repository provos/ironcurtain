import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import SessionSidebar from './session-sidebar.svelte';
import { mockSession } from '../../__tests__/fixtures.js';
import type { SessionDto } from '$lib/types.js';

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    sessions: new Map<number, SessionDto>(),
    selectedLabel: null,
    onselect: vi.fn(),
    onnew: vi.fn(),
    creating: false,
    ...overrides,
  };
}

describe('SessionSidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('is a session list with a New action instead of an inline launch form', async () => {
    const onnew = vi.fn();
    render(SessionSidebar, { props: makeProps({ onnew }) });

    expect(screen.queryByTestId('session-launch-form')).toBeNull();
    expect(screen.queryByTestId('launch-start')).toBeNull();
    expect(screen.getByText('No active sessions')).toBeTruthy();

    await fireEvent.click(screen.getByTestId('session-new'));
    expect(onnew).toHaveBeenCalledTimes(1);
  });

  it('selects existing sessions from the list', async () => {
    const onselect = vi.fn();
    render(SessionSidebar, {
      props: makeProps({
        sessions: new Map([[3, mockSession(3, { source: { kind: 'web-pty' }, persona: 'reviewer' })]]),
        onselect,
      }),
    });

    const item = screen.getByTestId('session-item-3');
    expect(item.textContent).toContain('reviewer');
    await fireEvent.click(item);

    expect(onselect).toHaveBeenCalledWith(3);
  });

  it('shows a live stopping state for sessions awaiting process exit', () => {
    render(SessionSidebar, {
      props: makeProps({
        selectedLabel: 4,
        sessions: new Map([[4, mockSession(4, { source: { kind: 'web-pty' }, status: 'stopping' })]]),
      }),
    });

    const stoppingStatus = screen.getByTestId('session-stopping-status');
    expect(stoppingStatus.textContent).toContain('Stopping…');
    expect(stoppingStatus.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers collapse when a toggle handler is provided', async () => {
    const ontogglecollapse = vi.fn();
    render(SessionSidebar, { props: makeProps({ ontogglecollapse }) });

    await fireEvent.click(screen.getByTestId('sidebar-collapse'));
    expect(ontogglecollapse).toHaveBeenCalledTimes(1);
  });

  it('renders a rail with session numbers, New, expand, and resume when collapsed', async () => {
    const onselect = vi.fn();
    const onnew = vi.fn();
    const ontogglecollapse = vi.fn();
    const onresumeopen = vi.fn();
    render(SessionSidebar, {
      props: makeProps({
        collapsed: true,
        selectedLabel: 2,
        sessions: new Map([
          [2, mockSession(2, { source: { kind: 'web-pty' } })],
          [5, mockSession(5, { source: { kind: 'web-pty' } })],
        ]),
        onselect,
        onnew,
        ontogglecollapse,
        onresumeopen,
      }),
    });

    expect(screen.queryByTestId('session-sidebar')).toBeNull();
    expect(screen.getByTestId('session-rail-item-2').getAttribute('aria-current')).toBe('true');

    await fireEvent.click(screen.getByTestId('session-rail-item-5'));
    await fireEvent.click(screen.getByTestId('session-new'));
    await fireEvent.click(screen.getByTestId('resume-open'));
    await fireEvent.click(screen.getByTestId('sidebar-expand'));

    expect(onselect).toHaveBeenCalledWith(5);
    expect(onnew).toHaveBeenCalledTimes(1);
    expect(onresumeopen).toHaveBeenCalledTimes(1);
    expect(ontogglecollapse).toHaveBeenCalledTimes(1);
  });

  it('disables resume with the reason shown', () => {
    render(SessionSidebar, {
      props: makeProps({ onresumeopen: vi.fn(), resumeDisabledReason: 'Connect to the daemon to resume a session.' }),
    });

    expect(screen.getByTestId('resume-open')).toHaveProperty('disabled', true);
    expect(screen.getByText('Connect to the daemon to resume a session.')).toBeTruthy();
  });
});
