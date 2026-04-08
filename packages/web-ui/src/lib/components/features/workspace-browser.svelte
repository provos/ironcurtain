<script lang="ts">
  import type { FileTreeResponseDto, FileContentResponseDto } from '$lib/types.js';
  import FileTree from './file-tree.svelte';
  import FileViewer from './file-viewer.svelte';

  let {
    workflowId,
    fetchFileTree,
    fetchFileContent,
  }: {
    workflowId: string;
    fetchFileTree: (workflowId: string, path?: string) => Promise<FileTreeResponseDto>;
    fetchFileContent: (workflowId: string, path: string) => Promise<FileContentResponseDto>;
  } = $props();

  let selectedPath = $state<string | null>(null);

  function handleFileSelect(path: string): void {
    selectedPath = path;
  }
</script>

<div class="flex h-full min-h-[300px] border border-border rounded-lg overflow-hidden">
  <!-- File tree panel -->
  <div class="w-64 shrink-0 border-r border-border overflow-y-auto bg-muted/10">
    <div class="px-3 py-2 border-b border-border">
      <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Files</span>
    </div>
    <FileTree {workflowId} onFileSelect={handleFileSelect} {fetchFileTree} />
  </div>

  <!-- File viewer panel -->
  <div class="flex-1 min-w-0 overflow-hidden">
    {#if selectedPath}
      <FileViewer {workflowId} path={selectedPath} {fetchFileContent} />
    {:else}
      <div class="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a file to view its contents
      </div>
    {/if}
  </div>
</div>
