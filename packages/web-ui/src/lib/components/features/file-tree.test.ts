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

  it('does not let a superseded reconcile clobber a newer one’s nested children', async () => {
    // 'sub' fetches are resolved by hand so we can suspend one reconcile's deep
    // recursion while a newer reconcile overtakes it — the exact window where a
    // stale pass could otherwise write node.children after a newer pass won.
    const subResolvers: Array<(r: FileTreeResponseDto) => void> = [];
    // Keys are full node paths, matching what the component fetches.
    const data: DirMap = {
      '': [{ name: 'src', type: 'directory' }],
      src: [{ name: 'sub', type: 'directory' }],
      'src/sub': [{ name: 'a.ts', type: 'file', size: 1 }],
    };
    const fetchFileTree = vi.fn((_workflowId: string, path?: string): Promise<FileTreeResponseDto> => {
      const p = path ?? '';
      if (p === 'src/sub') return new Promise<FileTreeResponseDto>((resolve) => subResolvers.push(resolve));
      return Promise.resolve({ entries: data[p] ?? [] });
    });
    const base = { workflowId: 'wf-1', onFileSelect: vi.fn(), fetchFileTree };
    const { rerender } = render(FileTree, { props: { ...base, refreshKey: 'k0' } });

    // Open src, then sub (resolving sub's initial expansion fetch).
    await expandDir('src/');
    await expandDir('sub/');
    await waitFor(() => expect(subResolvers).toHaveLength(1));
    subResolvers[0]({ entries: data['src/sub'] });
    expect(await screen.findByText('a.ts')).toBeTruthy();

    // Reconcile v2: it reads src as [sub] then suspends on its sub fetch.
    await rerender({ ...base, refreshKey: 'k1' });
    await waitFor(() => expect(subResolvers).toHaveLength(2));

    // A new top-level file lands in src/ before the *next* reconcile reads it.
    data.src = [
      { name: 'sub', type: 'directory' },
      { name: 'b.ts', type: 'file', size: 2 },
    ];

    // Reconcile v3: reads the updated src (with b.ts) and its own sub fetch.
    await rerender({ ...base, refreshKey: 'k2' });
    await waitFor(() => expect(subResolvers).toHaveLength(3));

    // Let v3 finish first; b.ts is now in the tree.
    subResolvers[2]({ entries: data['src/sub'] });
    expect(await screen.findByText('b.ts')).toBeTruthy();

    // The stale v2 sub fetch now resolves. Its src listing predates b.ts, so an
    // unguarded write would drop b.ts; the post-merge version check must stop it.
    subResolvers[1]({ entries: data['src/sub'] });
    // Drain microtasks so any stale write (all promise continuations) lands.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText('b.ts')).toBeTruthy();
    expect(screen.getByText('a.ts')).toBeTruthy();
  });
});
