import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import SessionSidebar from './session-sidebar.svelte';
import type { CreateSessionOptions, PersonaListItem, SessionDto } from '$lib/types.js';

function makePersona(overrides: Partial<PersonaListItem> = {}): PersonaListItem {
  return {
    name: 'coder',
    description: 'Code-focused persona',
    compiled: true,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    label: 1,
    source: { kind: 'web-pty' },
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

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    sessions: new Map<number, SessionDto>(),
    selectedLabel: null,
    onselect: vi.fn(),
    oncreate: vi.fn<(opts: CreateSessionOptions) => void>(),
    creating: false,
    createError: '',
    loadPersonasFn: vi.fn<() => Promise<PersonaListItem[]>>().mockResolvedValue([]),
    loadProviderProfilesFn: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
    ...overrides,
  };
}

async function openNewDropdown(): Promise<void> {
  await fireEvent.click(screen.getByText('New'));
}

describe('SessionSidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('always opens the launch-options panel and loads personas/provider profiles', async () => {
    const loadPersonasFn = vi
      .fn<() => Promise<PersonaListItem[]>>()
      .mockResolvedValue([
        makePersona({ name: 'coder', compiled: true }),
        makePersona({ name: 'draft', compiled: false }),
      ]);
    const loadProviderProfilesFn = vi.fn<() => Promise<string[]>>().mockResolvedValue(['work']);

    render(SessionSidebar, { props: makeProps({ loadPersonasFn, loadProviderProfilesFn }) });

    await openNewDropdown();

    expect(screen.getByText('Launch options')).toBeTruthy();
    expect(screen.getByTestId('launch-persona')).toBeTruthy();
    expect(screen.getByTestId('launch-workspace')).toBeTruthy();
    expect(screen.getByTestId('launch-provider')).toBeTruthy();
    expect(screen.getByTestId('launch-model')).toBeTruthy();
    expect(screen.getByTestId('launch-start')).toBeTruthy();
    expect(screen.queryByTestId('persona-default')).toBeNull();
    expect(loadPersonasFn).toHaveBeenCalledTimes(1);
    expect(loadProviderProfilesFn).toHaveBeenCalledTimes(1);

    const personaSelect = screen.getByTestId('launch-persona') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(personaSelect.options).some((option) => option.value === 'coder')).toBe(true);
    });

    const draftOption = Array.from(personaSelect.options).find((option) => option.value === 'draft');
    expect(draftOption?.disabled).toBe(true);

    const providerSelect = screen.getByTestId('launch-provider') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(providerSelect.options).some((option) => option.value === 'work')).toBe(true);
    });
  });

  it('does not create when selecting a persona and submits only from launch start', async () => {
    const oncreate = vi.fn<(opts: CreateSessionOptions) => void>();
    render(SessionSidebar, {
      props: makeProps({
        oncreate,
        loadPersonasFn: vi
          .fn<() => Promise<PersonaListItem[]>>()
          .mockResolvedValue([makePersona({ name: 'coder', compiled: true })]),
        loadProviderProfilesFn: vi.fn<() => Promise<string[]>>().mockResolvedValue(['ops']),
      }),
    });

    await openNewDropdown();

    const personaSelect = screen.getByTestId('launch-persona') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(personaSelect.options).some((option) => option.value === 'coder')).toBe(true);
    });

    await fireEvent.change(personaSelect, { target: { value: 'coder' } });
    expect(oncreate).not.toHaveBeenCalled();

    await fireEvent.input(screen.getByTestId('launch-workspace'), { target: { value: '  /tmp/workspace  ' } });
    await fireEvent.change(screen.getByTestId('launch-provider'), { target: { value: 'ops' } });
    await fireEvent.input(screen.getByTestId('launch-model'), { target: { value: '  gpt-5  ' } });
    await fireEvent.click(screen.getByTestId('launch-start'));

    expect(oncreate).toHaveBeenCalledTimes(1);
    expect(oncreate).toHaveBeenCalledWith({
      persona: 'coder',
      workspacePath: '/tmp/workspace',
      providerProfileName: 'ops',
      model: 'gpt-5',
    });
  });

  it('uses the blank persona option as the default and omits empty launch fields', async () => {
    const oncreate = vi.fn<(opts: CreateSessionOptions) => void>();
    render(SessionSidebar, { props: makeProps({ oncreate }) });

    await openNewDropdown();
    await fireEvent.click(screen.getByTestId('launch-start'));

    expect(oncreate).toHaveBeenCalledTimes(1);
    expect(oncreate).toHaveBeenCalledWith({});
  });

  it('still selects existing sessions from the list', async () => {
    const onselect = vi.fn();
    render(SessionSidebar, {
      props: makeProps({
        sessions: new Map([[3, makeSession({ label: 3 })]]),
        onselect,
      }),
    });

    await fireEvent.click(screen.getByTestId('session-item-3'));

    expect(onselect).toHaveBeenCalledWith(3);
  });
});
