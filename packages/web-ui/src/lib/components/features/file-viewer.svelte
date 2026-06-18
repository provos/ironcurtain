<script lang="ts">
  import type { FileContentResponseDto } from '$lib/types.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';

  let {
    workflowId,
    path,
    refreshKey = '',
    fetchFileContent,
  }: {
    workflowId: string;
    path: string;
    // Bumps whenever an external signal (workflow lifecycle event or a manual
    // Refresh click) wants the open file re-read. A change to refreshKey alone
    // triggers a *silent* refresh: the current content stays on screen and is
    // swapped in place when the new fetch resolves, so there's no spinner flash.
    refreshKey?: string | number;
    fetchFileContent: (workflowId: string, path: string) => Promise<FileContentResponseDto>;
  } = $props();

  let content = $state<FileContentResponseDto | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');
  let fetchVersion = 0;
  let lastId: string | undefined;
  let lastPath: string | undefined;
  let lastKey: string | number | undefined;

  $effect(() => {
    const id = workflowId;
    const filePath = path;
    // refreshKey is read to register it as a reactive dependency so a bump
    // re-reads the *same* file.
    const key = refreshKey;
    // A changed workflow/file is a hard reload (blank + spinner). Re-reading
    // the same file (refreshKey bumped) is a silent refresh that keeps the old
    // content visible until the new content arrives.
    const isReload = id !== lastId || filePath !== lastPath;
    const keyChanged = key !== lastKey;
    // Guard against effect re-runs that change nothing relevant (e.g. an
    // unrelated parent re-render): only fetch when the file or the refresh
    // signal actually changed.
    if (!isReload && !keyChanged) return;
    lastId = id;
    lastPath = filePath;
    lastKey = key;
    const version = ++fetchVersion;
    if (isReload) {
      loading = true;
      error = '';
      content = null;
    } else {
      refreshing = true;
    }

    fetchFileContent(id, filePath)
      .then((res) => {
        if (version !== fetchVersion) return;
        content = res;
        error = '';
        loading = false;
        refreshing = false;
      })
      .catch((err) => {
        if (version !== fetchVersion) return;
        // Only surface errors on a hard reload. A transient silent-refresh
        // failure keeps the last good content on screen rather than replacing
        // it with an error banner.
        if (isReload) {
          error = err instanceof Error ? err.message : String(err);
          content = null;
        }
        loading = false;
        refreshing = false;
      });
  });
</script>

<div class="flex flex-col h-full">
  <!-- File path header -->
  <div class="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30 shrink-0">
    <span class="text-xs text-muted-foreground font-mono truncate" title={path}>{path}</span>
    {#if refreshing}
      <span class="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground shrink-0" title="Reloading file">
        <Spinner size="xs" /> refreshing
      </span>
    {/if}
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
