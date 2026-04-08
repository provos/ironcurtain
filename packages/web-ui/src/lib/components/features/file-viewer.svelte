<script lang="ts">
  import type { FileContentResponseDto } from '$lib/types.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';

  let {
    workflowId,
    path,
    fetchFileContent,
  }: {
    workflowId: string;
    path: string;
    fetchFileContent: (workflowId: string, path: string) => Promise<FileContentResponseDto>;
  } = $props();

  let content = $state<FileContentResponseDto | null>(null);
  let loading = $state(true);
  let error = $state('');
  let fetchVersion = 0;

  $effect(() => {
    const id = workflowId;
    const filePath = path;
    const version = ++fetchVersion;
    loading = true;
    error = '';
    content = null;

    fetchFileContent(id, filePath)
      .then((res) => {
        if (version === fetchVersion) {
          content = res;
          loading = false;
        }
      })
      .catch((err) => {
        if (version === fetchVersion) {
          error = err instanceof Error ? err.message : String(err);
          loading = false;
        }
      });
  });
</script>

<div class="flex flex-col h-full">
  <!-- File path header -->
  <div class="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30 shrink-0">
    <span class="text-xs text-muted-foreground font-mono truncate" title={path}>{path}</span>
  </div>

  <!-- Content area -->
  <div class="flex-1 overflow-auto">
    {#if loading}
      <div class="flex items-center justify-center py-8">
        <Spinner size="sm" />
      </div>
    {:else if error}
      <div class="p-4 text-sm text-destructive">{error}</div>
    {:else if content}
      {#if content.error}
        <div class="p-4 text-sm text-muted-foreground">{content.error}</div>
      {:else if content.binary}
        <div class="p-4 text-sm text-muted-foreground italic">Binary file -- cannot display</div>
      {:else if content.content != null}
        <pre class="p-3 text-xs leading-relaxed overflow-x-auto"><code class="language-{content.language ?? 'text'}"
            >{content.content}</code
          ></pre>
      {/if}
    {/if}
  </div>
</div>
