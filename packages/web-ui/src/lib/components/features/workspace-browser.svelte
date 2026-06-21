<script lang="ts">
  import type { FileTreeResponseDto, FileContentResponseDto } from '$lib/types.js';
  import FileTree from './file-tree.svelte';
  import FileViewer from './file-viewer.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import ArrowsClockwise from 'phosphor-svelte/lib/ArrowsClockwise';

  let {
    workflowId,
    refreshSignal = '',
    fetchFileTree,
    fetchFileContent,
  }: {
    workflowId: string;
    // External auto-refresh trigger (e.g. a workflow lifecycle key from the
    // detail view). Folded together with the manual refresh counter into the
    // key handed to the tree and viewer.
    refreshSignal?: string | number;
    fetchFileTree: (workflowId: string, path?: string) => Promise<FileTreeResponseDto>;
    fetchFileContent: (workflowId: string, path: string) => Promise<FileContentResponseDto>;
  } = $props();

  let selectedPath = $state<string | null>(null);
  let manualRefreshCount = $state(0);
  let treeRefreshing = $state(false);

  // Any change here re-reads the tree and the open file. Auto-refreshes ride on
  // refreshSignal; the Refresh button bumps manualRefreshCount.
  const refreshKey = $derived(`${refreshSignal}#${manualRefreshCount}`);

  function handleFileSelect(path: string): void {
    selectedPath = path;
  }

  function refreshNow(): void {
    manualRefreshCount += 1;
  }
</script>

<div class="flex h-full min-h-[300px] border border-border rounded-lg overflow-hidden">
  <!-- File tree panel -->
  <div class="w-64 shrink-0 border-r border-border overflow-y-auto bg-muted/10">
    <div class="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
      <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Files</span>
      <Button
        variant="ghost"
        size="icon"
        type="button"
        class="shrink-0 h-6 w-6 text-muted-foreground"
        loading={treeRefreshing}
        title="Reload files and the open file"
        aria-label="Refresh files"
        onclick={refreshNow}
      >
        {#if !treeRefreshing}
          <ArrowsClockwise size={14} weight="bold" />
        {/if}
      </Button>
    </div>
    <FileTree
      {workflowId}
      {refreshKey}
      bind:refreshing={treeRefreshing}
      onFileSelect={handleFileSelect}
      {fetchFileTree}
    />
  </div>

  <!-- File viewer panel -->
  <div class="flex-1 min-w-0 overflow-hidden">
    {#if selectedPath}
      <FileViewer {workflowId} path={selectedPath} {refreshKey} {fetchFileContent} />
    {:else}
      <div class="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a file to view its contents
      </div>
    {/if}
  </div>
</div>
