import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import NewSessionDialog from './new-session-dialog.svelte';
import type { CreateSessionOptions, PersonaListItem } from '$lib/types.js';

function makePersona(overrides: Partial<PersonaListItem> = {}): PersonaListItem {
  return { name: 'coder', description: 'Code-focused persona', compiled: true, ...overrides };
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    onclose: vi.fn(),
    oncreate: vi.fn<(opts: CreateSessionOptions) => void>(),
    creating: false,
    createError: '',
    loadPersonasFn: vi.fn<() => Promise<PersonaListItem[]>>().mockResolvedValue([]),
    loadProviderProfilesFn: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
    ...overrides,
  };
}

describe('NewSessionDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing while closed', () => {
    render(NewSessionDialog, { props: makeProps({ open: false }) });
    expect(screen.queryByTestId('session-launch-form')).toBeNull();
  });

  it('loads personas and provider profiles into the launch options', async () => {
    const loadPersonasFn = vi
      .fn<() => Promise<PersonaListItem[]>>()
      .mockResolvedValue([makePersona({ name: 'coder' }), makePersona({ name: 'draft', compiled: false })]);
    const loadProviderProfilesFn = vi.fn<() => Promise<string[]>>().mockResolvedValue(['work']);
    render(NewSessionDialog, { props: makeProps({ loadPersonasFn, loadProviderProfilesFn }) });

    expect(screen.getByRole('dialog', { name: 'New session' })).toBeTruthy();
    const personaSelect = screen.getByTestId('launch-persona') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(personaSelect.options).some((o) => o.value === 'coder')).toBe(true);
    });
    expect(Array.from(personaSelect.options).find((o) => o.value === 'draft')?.disabled).toBe(true);
    const providerSelect = screen.getByTestId('launch-provider') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(providerSelect.options).some((o) => o.value === 'work')).toBe(true);
    });
  });

  it('submits the chosen launch options, trimmed', async () => {
    const oncreate = vi.fn<(opts: CreateSessionOptions) => void>();
    render(NewSessionDialog, {
      props: makeProps({
        oncreate,
        loadPersonasFn: vi.fn<() => Promise<PersonaListItem[]>>().mockResolvedValue([makePersona()]),
        loadProviderProfilesFn: vi.fn<() => Promise<string[]>>().mockResolvedValue(['ops']),
      }),
    });
    const personaSelect = screen.getByTestId('launch-persona') as HTMLSelectElement;
    await waitFor(() => expect(Array.from(personaSelect.options).some((o) => o.value === 'coder')).toBe(true));
    const providerSelect = screen.getByTestId('launch-provider') as HTMLSelectElement;
    await waitFor(() => expect(Array.from(providerSelect.options).some((o) => o.value === 'ops')).toBe(true));

    await fireEvent.change(personaSelect, { target: { value: 'coder' } });
    await fireEvent.input(screen.getByTestId('launch-workspace'), { target: { value: '  /tmp/workspace  ' } });
    await fireEvent.change(providerSelect, { target: { value: 'ops' } });
    await fireEvent.input(screen.getByTestId('launch-model'), { target: { value: '  gpt-5  ' } });
    await fireEvent.click(screen.getByTestId('launch-start'));

    expect(oncreate).toHaveBeenCalledWith({
      persona: 'coder',
      workspacePath: '/tmp/workspace',
      providerProfileName: 'ops',
      model: 'gpt-5',
    });
  });

  it('omits empty launch fields', async () => {
    const oncreate = vi.fn<(opts: CreateSessionOptions) => void>();
    render(NewSessionDialog, { props: makeProps({ oncreate }) });

    await fireEvent.click(screen.getByTestId('launch-start'));

    expect(oncreate).toHaveBeenCalledWith({});
  });

  it('turns read-only folders into chips with a compact warning', async () => {
    const oncreate = vi.fn<(opts: CreateSessionOptions) => void>();
    render(NewSessionDialog, { props: makeProps({ oncreate }) });

    expect(screen.queryByTestId('launch-readonly-warning')).toBeNull();
    const input = screen.getByTestId('launch-readonly-input');
    await fireEvent.input(input, { target: { value: '/mnt/d/Training' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.input(input, { target: { value: 'D:\\Datasets\\imagenet' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.input(input, { target: { value: '/mnt/d/Training' } });
    await fireEvent.keyDown(input, { key: 'Enter' }); // duplicate ignored

    const chips = screen.getAllByTestId('launch-readonly-chip');
    expect(chips.map((chip) => chip.textContent?.trim())).toEqual(['Training', 'imagenet']);
    expect(chips[1].getAttribute('title')).toBe('D:\\Datasets\\imagenet');
    expect(screen.getByTestId('launch-readonly-warning').textContent).toContain('model provider');

    await fireEvent.click(screen.getByLabelText('Remove D:\\Datasets\\imagenet'));
    await fireEvent.input(input, { target: { value: '  /data/ref  ' } });
    await fireEvent.click(screen.getByTestId('launch-start'));

    expect(oncreate).toHaveBeenCalledWith({ readonlyMounts: ['/mnt/d/Training', '/data/ref'] });
  });

  it('removes the last chip with Backspace on an empty input', async () => {
    render(NewSessionDialog, { props: makeProps() });
    const input = screen.getByTestId('launch-readonly-input');
    await fireEvent.input(input, { target: { value: '/a' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.input(input, { target: { value: '/b' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    await fireEvent.keyDown(input, { key: 'Backspace' });

    expect(screen.getAllByTestId('launch-readonly-chip').map((c) => c.getAttribute('title'))).toEqual(['/a']);
  });

  it('ignores submit while a session is being created and shows create errors', async () => {
    const oncreate = vi.fn<(opts: CreateSessionOptions) => void>();
    render(NewSessionDialog, { props: makeProps({ oncreate, creating: true, createError: 'Folder not allowed' }) });

    await fireEvent.submit(screen.getByTestId('session-launch-form'));

    expect(oncreate).not.toHaveBeenCalled();
    expect(screen.getByTestId('launch-error').textContent).toContain('Folder not allowed');
  });

  it('closes on Cancel', async () => {
    const onclose = vi.fn();
    render(NewSessionDialog, { props: makeProps({ onclose }) });

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
