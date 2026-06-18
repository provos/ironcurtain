import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import FileTree from './file-tree.svelte';
import type { FileTreeEntryDto, FileTreeResponseDto } from '$lib/types.js';

type DirMap = Record<string, FileTreeEntryDto[]>;

/**
 * Build a fetchFileTree mock backed by a mutable directory map keyed by path
 * (root is the empty string). Mutating the map between renders simulates files
 * being created/removed in the workspace while a workflow runs.
 */
function makeFetch(map: DirMap) {
  return vi.fn(async (_workflowId: string, path?: string): Promise<FileTreeResponseDto> => {
    return { entries: map[path ?? ''] ?? [] };
  });
}

async function expandDir(label: string): Promise<void> {
  const span = await screen.findByText(label);
  const button = span.closest('button');
  expect(button, `expected a clickable row for ${label}`).toBeTruthy();
  await fireEvent.click(button!);
}

describe('FileTree', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists root entries', async () => {
    const fetchFileTree = makeFetch({
      '': [
        { name: 'src', type: 'directory' },
        { name: 'README.md', type: 'file', size: 10 },
      ],
    });
    render(FileTree, { props: { workflowId: 'wf-1', onFileSelect: vi.fn(), fetchFileTree } });

    expect(await screen.findByText('src/')).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
  });

  it('surfaces a newly created top-level file on a refreshKey change', async () => {
    const map: DirMap = { '': [{ name: 'src', type: 'directory' }] };
    const fetchFileTree = makeFetch(map);
    const base = { workflowId: 'wf-1', onFileSelect: vi.fn(), fetchFileTree };
    const { rerender } = render(FileTree, { props: { ...base, refreshKey: 'k0' } });

    expect(await screen.findByText('src/')).toBeTruthy();
    expect(screen.queryByText('NEW.md')).toBeNull();

    map[''] = [
      { name: 'src', type: 'directory' },
      { name: 'NEW.md', type: 'file', size: 3 },
    ];
    await rerender({ ...base, refreshKey: 'k1' });

    expect(await screen.findByText('NEW.md')).toBeTruthy();
  });

  it('reconciles new files into an expanded directory while keeping it expanded', async () => {
    const map: DirMap = {
      '': [{ name: 'src', type: 'directory' }],
      src: [{ name: 'a.ts', type: 'file', size: 1 }],
    };
    const fetchFileTree = makeFetch(map);
    const base = { workflowId: 'wf-1', onFileSelect: vi.fn(), fetchFileTree };
    const { rerender } = render(FileTree, { props: { ...base, refreshKey: 'k0' } });

    await expandDir('src/');
    expect(await screen.findByText('a.ts')).toBeTruthy();

    // A new file lands in src/ while it is expanded.
    map.src = [
      { name: 'a.ts', type: 'file', size: 1 },
      { name: 'b.ts', type: 'file', size: 2 },
    ];
    await rerender({ ...base, refreshKey: 'k1' });

    // The new file appears and the directory stays expanded (a.ts still shown).
    expect(await screen.findByText('b.ts')).toBeTruthy();
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByText('src/')).toBeTruthy();
  });

  it('reconciles removed files out of an expanded directory', async () => {
    const map: DirMap = {
      '': [{ name: 'src', type: 'directory' }],
      src: [
        { name: 'a.ts', type: 'file', size: 1 },
        { name: 'gone.ts', type: 'file', size: 2 },
      ],
    };
    const fetchFileTree = makeFetch(map);
    const base = { workflowId: 'wf-1', onFileSelect: vi.fn(), fetchFileTree };
    const { rerender } = render(FileTree, { props: { ...base, refreshKey: 'k0' } });

    await expandDir('src/');
    expect(await screen.findByText('gone.ts')).toBeTruthy();

    map.src = [{ name: 'a.ts', type: 'file', size: 1 }];
    await rerender({ ...base, refreshKey: 'k1' });

    await waitFor(() => expect(screen.queryByText('gone.ts')).toBeNull());
    expect(screen.getByText('a.ts')).toBeTruthy();
  });

  it('does not re-fetch when refreshKey is unchanged across a rerender', async () => {
    const fetchFileTree = makeFetch({ '': [{ name: 'src', type: 'directory' }] });
    const base = { workflowId: 'wf-1', onFileSelect: vi.fn(), fetchFileTree, refreshKey: 'k0' };
    const { rerender } = render(FileTree, { props: { ...base } });

    expect(await screen.findByText('src/')).toBeTruthy();
    expect(fetchFileTree).toHaveBeenCalledTimes(1);

    await rerender({ ...base });

    await waitFor(() => expect(fetchFileTree).toHaveBeenCalledTimes(1));
  });

  it('renders the tree when a reconcile pre-empts an in-flight initial load', async () => {
    let call = 0;
    const fetchFileTree = vi.fn((_workflowId: string, _path?: string): Promise<FileTreeResponseDto> => {
      call += 1;
      // The initial full load never resolves; the reconcile that pre-empts it
      // must still surface its tree (and clear the initial-load spinner).
      if (call === 1) return new Promise<FileTreeResponseDto>(() => {});
      return Promise.resolve({ entries: [{ name: 'src', type: 'directory' }] });
    });
    const base = { workflowId: 'wf-1', onFileSelect: vi.fn(), fetchFileTree };
    const { rerender } = render(FileTree, { props: { ...base, refreshKey: 'k0' } });

    // Initial fetch is pending — bump refreshKey to start the pre-empting reconcile.
    await rerender({ ...base, refreshKey: 'k1' });

    // Without rootLoading being cleared, this stays stuck on the spinner forever.
    expect(await screen.findByText('src/')).toBeTruthy();
  });
});
