<script lang="ts">
  import type { FileTreeEntryDto, FileTreeResponseDto } from '$lib/types.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';

  let {
    workflowId,
    refreshKey = '',
    refreshing = $bindable(false),
    onFileSelect,
    fetchFileTree,
  }: {
    workflowId: string;
    // Bumps on a workflow lifecycle event or a manual Refresh click. A change
    // triggers a *silent* reconcile that re-reads the root and every currently
    // expanded directory, surfacing new/removed files while preserving each
    // node's expansion state, identity (keyed DOM), and scroll position.
    refreshKey?: string | number;
    // Bound up to the parent so a shared Refresh control can reflect an
    // in-flight reconcile.
    refreshing?: boolean;
    onFileSelect: (path: string) => void;
    fetchFileTree: (workflowId: string, path?: string) => Promise<FileTreeResponseDto>;
  } = $props();

  interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    expanded: boolean;
    children: TreeNode[] | null;
    loading: boolean;
  }

  let roots = $state<TreeNode[]>([]);
  let rootLoading = $state(true);
  let error = $state('');
  // Bumped by every load/reconcile; an in-flight async pass that finds its
  // version stale abandons its writes so a newer pass always wins.
  let loadVersion = 0;
  let lastId: string | undefined;
  let lastRefreshKey: string | number | undefined;

  $effect(() => {
    const id = workflowId;
    const key = refreshKey;
    if (id !== lastId) {
      // First mount or a workflow switch: full load with a spinner.
      lastId = id;
      lastRefreshKey = key;
      void fullLoad(id);
      return;
    }
    if (key !== lastRefreshKey) {
      // Same workflow, external refresh signal: reconcile silently.
      lastRefreshKey = key;
      void reconcile(id);
    }
  });

  async function fullLoad(id: string): Promise<void> {
    const version = ++loadVersion;
    rootLoading = true;
    error = '';
    try {
      const res = await fetchFileTree(id);
      if (version !== loadVersion) return;
      roots = res.entries.map((e) => entryToNode(e, ''));
    } catch (err) {
      if (version !== loadVersion) return;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (version === loadVersion) rootLoading = false;
    }
  }

  async function reconcile(id: string): Promise<void> {
    const version = ++loadVersion;
    refreshing = true;
    try {
      const res = await fetchFileTree(id);
      if (version !== loadVersion) return;
      const merged = await mergeLevel(id, roots, res.entries, '', version);
      // A newer pass may have started while we were merging; don't clobber it.
      if (version !== loadVersion) return;
      roots = merged;
    } catch {
      // Keep the existing tree on a transient refresh failure.
    } finally {
      if (version === loadVersion) refreshing = false;
    }
  }

  // Reconcile a fresh directory listing against existing nodes. Unchanged
  // entries keep their node object (preserving expansion + already-loaded
  // children and keeping the keyed DOM stable); expanded directories are
  // re-fetched recursively so newly created files appear; entries absent from
  // the new listing fall away because the result is rebuilt from `entries`.
  // Sibling directories are re-fetched concurrently rather than one at a time.
  async function mergeLevel(
    id: string,
    existing: TreeNode[],
    entries: readonly FileTreeEntryDto[],
    parentPath: string,
    version: number,
  ): Promise<TreeNode[]> {
    const byPath = new Map(existing.map((n) => [n.path, n]));
    const result: TreeNode[] = [];
    const childFetches: Promise<void>[] = [];
    for (const entry of entries) {
      const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const prev = byPath.get(path);
      if (prev && prev.type === entry.type) {
        prev.size = entry.size;
        if (prev.type === 'directory' && prev.expanded && prev.children !== null) {
          const node = prev;
          childFetches.push(
            (async () => {
              try {
                const sub = await fetchFileTree(id, node.path);
                if (version !== loadVersion) return;
                node.children = await mergeLevel(id, node.children ?? [], sub.entries, node.path, version);
              } catch {
                // Keep previously loaded children if this sub-fetch fails.
              }
            })(),
          );
        }
        result.push(prev);
      } else {
        result.push(entryToNode(entry, parentPath));
      }
    }
    await Promise.all(childFetches);
    return result;
  }

  function entryToNode(entry: FileTreeEntryDto, parentPath: string): TreeNode {
    const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    return {
      name: entry.name,
      path,
      type: entry.type,
      size: entry.size,
      expanded: false,
      children: null,
      loading: false,
    };
  }

  async function toggleDir(node: TreeNode): Promise<void> {
    if (node.type !== 'directory') return;

    if (node.expanded) {
      node.expanded = false;
      return;
    }

    if (node.children === null) {
      node.loading = true;
      try {
        const res = await fetchFileTree(workflowId, node.path);
        node.children = res.entries.map((e) => entryToNode(e, node.path));
      } catch {
        node.children = [];
      }
      node.loading = false;
    }
    node.expanded = true;
  }

  function handleClick(node: TreeNode): void {
    if (node.type === 'directory') {
      toggleDir(node);
    } else {
      onFileSelect(node.path);
    }
  }

  function isWorkflowDir(name: string): boolean {
    return name === '.workflow';
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}K`;
    return `${(bytes / 1048576).toFixed(1)}M`;
  }
</script>

<div class="text-sm font-mono">
  {#if rootLoading}
    <div class="flex items-center justify-center py-4">
      <Spinner size="sm" />
    </div>
  {:else if error}
    <p class="text-destructive text-xs px-2 py-1">{error}</p>
  {:else if roots.length === 0}
    <p class="text-muted-foreground text-xs px-2 py-1">Empty workspace</p>
  {:else}
    <ul class="space-y-0">
      {#each roots as node (node.path)}
        {@render treeItem(node, 0)}
      {/each}
    </ul>
  {/if}
</div>

{#snippet treeItem(node: TreeNode, depth: number)}
  <li>
    <button
      onclick={() => handleClick(node)}
      class="w-full text-left flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-accent/50 transition-colors"
      style="padding-left: {depth * 16 + 8}px"
    >
      {#if node.type === 'directory'}
        <span class="shrink-0 w-4 text-center text-muted-foreground">
          {node.expanded ? '\u25BE' : '\u25B8'}
        </span>
        <span class={isWorkflowDir(node.name) ? 'text-primary' : 'text-foreground'}>
          {node.name}/
        </span>
        {#if node.loading}
          <Spinner size="xs" />
        {/if}
      {:else}
        <span class="shrink-0 w-4 text-center text-muted-foreground/50">&middot;</span>
        <span class="text-foreground/80">{node.name}</span>
        {#if node.size != null}
          <span class="text-muted-foreground text-[10px] ml-auto">{formatSize(node.size)}</span>
        {/if}
      {/if}
    </button>
    {#if node.type === 'directory' && node.expanded && node.children}
      <ul>
        {#each node.children as child (child.path)}
          {@render treeItem(child, depth + 1)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}
