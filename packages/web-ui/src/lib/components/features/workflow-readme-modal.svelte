<script lang="ts">
  import { untrack } from 'svelte';
  import { Modal } from '$lib/components/ui/modal/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import { renderMarkdown } from '$lib/markdown.js';
  import BookOpen from 'phosphor-svelte/lib/BookOpen';

  let {
    open,
    onclose,
    title,
    fetchReadme,
  }: {
    /** Whether the modal is visible. */
    open: boolean;
    /** Called when the user dismisses (backdrop, Escape, or close button). */
    onclose: () => void;
    /** Workflow name shown in the modal header. */
    title: string;
    /** Lazily resolves the raw README markdown. Invoked once per open. */
    fetchReadme: () => Promise<string>;
  } = $props();

  let loading = $state(false);
  let error = $state<string | null>(null);
  let content = $state<string | null>(null);
  // Monotonic token guards against out-of-order responses when the modal is
  // re-opened (or re-targeted) before an in-flight fetch resolves.
  let loadToken = 0;

  $effect(() => {
    // Re-fetch each time the modal opens (or its target changes). We read
    // `open` and `title` for reactivity, then run the fetch untracked so the
    // `fetchReadme` prop identity never becomes a dependency — otherwise an
    // unrelated parent re-render while the modal is open would refetch.
    const isOpen = open;
    void title;
    if (!isOpen) return;
    untrack(() => {
      void load();
    });
  });

  async function load(): Promise<void> {
    const token = ++loadToken;
    loading = true;
    error = null;
    content = null;
    try {
      const md = await fetchReadme();
      if (token === loadToken) content = md;
    } catch (e) {
      if (token === loadToken) error = e instanceof Error ? e.message : String(e);
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  const hasContent = $derived(content !== null && content.trim().length > 0);
</script>

<Modal {open} {onclose} class="max-w-3xl">
  <!-- Custom header: icon + title + close, so the README gets a book affordance. -->
  <div class="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
    <div class="flex items-center gap-2 min-w-0">
      <BookOpen size={18} weight="duotone" class="text-primary shrink-0" />
      <h2 class="text-sm font-semibold truncate">
        {title}
        <span class="text-muted-foreground font-normal">· README</span>
      </h2>
    </div>
    <button
      type="button"
      onclick={onclose}
      aria-label="Close README"
      class="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </button>
  </div>

  <div class="max-h-[68vh] overflow-y-auto px-5 py-4" data-testid="workflow-readme-body">
    {#if loading}
      <div class="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Spinner size="sm" /> Loading README…
      </div>
    {:else if error}
      <div class="py-6 text-sm text-destructive" data-testid="workflow-readme-error">
        Could not load README: {error}
      </div>
    {:else if hasContent && content !== null}
      <article class="prose-markdown text-sm" data-testid="workflow-readme-content">
        {@html renderMarkdown(content)}
      </article>
    {:else}
      <div class="py-6 text-sm text-muted-foreground">This workflow has no README content.</div>
    {/if}
  </div>
</Modal>
