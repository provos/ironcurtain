<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { Snippet } from 'svelte';

  let {
    class: className,
    children,
  }: {
    class?: string;
    children?: Snippet;
  } = $props();
</script>

<span class={cn('text-xs font-medium text-muted-foreground uppercase tracking-wider', className)}>
  {#if children}
    {@render children()}
  {/if}
</span>
