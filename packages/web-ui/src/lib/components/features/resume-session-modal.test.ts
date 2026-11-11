import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ResumeSessionModal from './resume-session-modal.svelte';
import type { ResumableSessionDto } from '$lib/types.js';

const saved: ResumableSessionDto[] = [
  {
    sessionId: 'saved-session-1234',
    displayName: 'Claude Code session',
    agent: 'claude-code',
    status: 'user-exit',
    lastActivity: '2026-08-24T12:00:00.000Z',
    workspaceLabel: '~/src/ironcurtain',
    persona: 'reviewer',
    providerProfileName: 'work',
  },
  {
    sessionId: 'another-session',
    displayName: 'Goose session',
    agent: 'goose',
    status: 'crashed',
    lastActivity: '2026-08-23T12:00:00.000Z',
  },
];

function props(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    sessions: saved,
    loading: false,
    loadError: '',
    actionError: '',
    resumingId: null,
    onclose: vi.fn(),
    onretry: vi.fn(),
    onresume: vi.fn(),
    ...overrides,
  };
}

describe('ResumeSessionModal', () => {
  it('shows saved read-only folders and adds new ones when resuming', async () => {
    const onresume = vi.fn();
    const withFolders: ResumableSessionDto[] = [{ ...saved[0], readonlyMounts: ['/mnt/d/Training', 'D:\\Data'] }];
    render(ResumeSessionModal, { props: props({ onresume, sessions: withFolders }) });

    expect(screen.getByTestId('resume-saved-folders').textContent).toContain('Read-only: Training, Data');
    expect(screen.queryByTestId('resume-readonly-warning')).toBeNull();

    const input = screen.getByTestId('resume-readonly-input');
    await fireEvent.input(input, { target: { value: '/mnt/d/Reference' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.input(input, { target: { value: '/data/typed-not-added' } });
    expect(screen.getAllByTestId('resume-readonly-chip').map((chip) => chip.textContent?.trim())).toEqual([
      'Reference',
    ]);
    expect(screen.getByTestId('resume-readonly-warning')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Resume Claude Code session' }));
    expect(onresume).toHaveBeenCalledWith('saved-session-1234', ['/mnt/d/Reference', '/data/typed-not-added']);
  });

  it('clears added folders when the dialog is closed and reopened', async () => {
    const onresume = vi.fn();
    const rendered = render(ResumeSessionModal, { props: props({ onresume }) });
    const input = screen.getByTestId('resume-readonly-input');
    await fireEvent.input(input, { target: { value: '/mnt/d/Reference' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.input(input, { target: { value: '/data/draft' } });
    expect(screen.getAllByTestId('resume-readonly-chip')).toHaveLength(1);

    await rendered.rerender(props({ onresume, open: false }));
    await rendered.rerender(props({ onresume, open: true }));

    expect(screen.queryAllByTestId('resume-readonly-chip')).toHaveLength(0);
    expect((screen.getByTestId('resume-readonly-input') as HTMLInputElement).value).toBe('');
    await fireEvent.click(screen.getByRole('button', { name: 'Resume Claude Code session' }));
    expect(onresume).toHaveBeenCalledWith('saved-session-1234', undefined);
  });

  it('hides the folder field when there is nothing to resume', () => {
    render(ResumeSessionModal, { props: props({ sessions: [] }) });
    expect(screen.queryByTestId('resume-readonly-input')).toBeNull();
  });

  it('presents persisted metadata and resumes the selected row', async () => {
    const onresume = vi.fn();
    render(ResumeSessionModal, { props: props({ onresume }) });

    expect(screen.getByRole('dialog', { name: 'Resume a session' })).toBeTruthy();
    expect(screen.getByText('~/src/ironcurtain')).toBeTruthy();
    expect(screen.getByText('Persona: reviewer')).toBeTruthy();
    expect(screen.getByText('Profile: work')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Resume Goose session' }));
    expect(onresume).toHaveBeenCalledWith('another-session', undefined);
  });

  it('uses an announced loading state and a clear empty state', async () => {
    const rendered = render(ResumeSessionModal, { props: props({ sessions: [], loading: true }) });
    expect(screen.getByRole('status').textContent).toContain('Loading resumable sessions');

    await rendered.rerender(props({ sessions: [], loading: false }));
    expect(screen.getByText('No resumable sessions')).toBeTruthy();
  });

  it('locks modal actions while a resume is in flight', () => {
    render(ResumeSessionModal, { props: props({ resumingId: 'saved-session-1234' }) });

    expect(screen.getByRole('button', { name: 'Resume Claude Code session' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Resume Goose session' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveProperty('disabled', true);
  });

  it('keeps valid rows visible and offers a refresh when a resume action fails', async () => {
    const onretry = vi.fn();
    render(ResumeSessionModal, { props: props({ actionError: 'That session is already active', onretry }) });

    expect(screen.getByRole('alert').textContent).toContain('already active');
    expect(screen.getByText('Claude Code session')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }));
    expect(onretry).toHaveBeenCalledOnce();
  });
});
