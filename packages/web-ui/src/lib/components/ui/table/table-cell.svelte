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

<td class={cn('px-4 py-2.5', className)}>
  {#if children}
    {@render children()}
  {/if}
</td>
