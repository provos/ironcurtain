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

<div class={cn('flex items-center justify-between p-4', className)}>
  {#if children}
    {@render children()}
  {/if}
</div>
