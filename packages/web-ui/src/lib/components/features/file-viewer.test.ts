import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import FileViewer from './file-viewer.svelte';
import type { FileContentResponseDto } from '$lib/types.js';

// Stable prop refs across rerenders: a changing function prop would itself be a
// reactive dependency of the fetch effect and re-trigger it, masking what we're
// actually testing (refreshKey / path driven re-fetches).
function textContent(body: string): FileContentResponseDto {
  return { content: body, language: 'text' };
}

describe('FileViewer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches and renders the file content for the given path', async () => {
    const fetchFileContent = vi.fn(async () => textContent('hello world'));
    render(FileViewer, { props: { workflowId: 'wf-1', path: 'a.txt', fetchFileContent } });

    expect(await screen.findByText('hello world')).toBeTruthy();
    expect(fetchFileContent).toHaveBeenCalledWith('wf-1', 'a.txt');
    expect(fetchFileContent).toHaveBeenCalledTimes(1);
  });

  it('re-reads the same file and swaps in new content when refreshKey changes', async () => {
    let body = 'v1';
    const fetchFileContent = vi.fn(async () => textContent(body));
    const base = { workflowId: 'wf-1', path: 'a.txt', fetchFileContent };
    const { rerender } = render(FileViewer, { props: { ...base, refreshKey: 'k0' } });

    expect(await screen.findByText('v1')).toBeTruthy();
    expect(fetchFileContent).toHaveBeenCalledTimes(1);

    body = 'v2';
    await rerender({ ...base, refreshKey: 'k1' });

    expect(await screen.findByText('v2')).toBeTruthy();
    expect(fetchFileContent).toHaveBeenCalledTimes(2);
  });

  it('does not re-fetch when refreshKey is unchanged across a rerender', async () => {
    const fetchFileContent = vi.fn(async () => textContent('stable'));
    const base = { workflowId: 'wf-1', path: 'a.txt', fetchFileContent, refreshKey: 'k0' };
    const { rerender } = render(FileViewer, { props: { ...base } });

    expect(await screen.findByText('stable')).toBeTruthy();
    await rerender({ ...base });

    // Give any stray effect a chance to fire before asserting it did not.
    await waitFor(() => expect(fetchFileContent).toHaveBeenCalledTimes(1));
  });

  it('keeps the previous content on screen during an in-flight silent refresh', async () => {
    let resolveSecond: ((v: FileContentResponseDto) => void) | undefined;
    let call = 0;
    const fetchFileContent = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(textContent('old'));
      return new Promise<FileContentResponseDto>((res) => {
        resolveSecond = res;
      });
    });
    const base = { workflowId: 'wf-1', path: 'a.txt', fetchFileContent };
    const { rerender } = render(FileViewer, { props: { ...base, refreshKey: 'k0' } });

    expect(await screen.findByText('old')).toBeTruthy();

    // Trigger a silent refresh whose fetch is still pending.
    await rerender({ ...base, refreshKey: 'k1' });
    // The old content must remain visible — no blank / spinner flash.
    expect(screen.getByText('old')).toBeTruthy();

    resolveSecond?.(textContent('new'));
    expect(await screen.findByText('new')).toBeTruthy();
  });

  it('re-fetches when the path changes', async () => {
    const fetchFileContent = vi.fn(async (_id: string, p: string) => textContent(`body:${p}`));
    const base = { workflowId: 'wf-1', fetchFileContent };
    const { rerender } = render(FileViewer, { props: { ...base, path: 'a.txt' } });

    expect(await screen.findByText('body:a.txt')).toBeTruthy();

    await rerender({ ...base, path: 'b.txt' });

    expect(await screen.findByText('body:b.txt')).toBeTruthy();
    expect(fetchFileContent).toHaveBeenCalledTimes(2);
  });
});
