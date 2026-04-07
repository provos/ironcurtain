<script lang="ts">
  import type { FileTreeEntryDto, FileTreeResponseDto } from '$lib/types.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';

  let {
    workflowId,
    onFileSelect,
    fetchFileTree,
  }: {
    workflowId: string;
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

  $effect(() => {
    const id = workflowId;
    rootLoading = true;
    error = '';
    fetchFileTree(id)
      .then((res) => {
        roots = res.entries.map((e) => entryToNode(e, ''));
        rootLoading = false;
      })
      .catch((err) => {
        error = err instanceof Error ? err.message : String(err);
        rootLoading = false;
      });
  });

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
