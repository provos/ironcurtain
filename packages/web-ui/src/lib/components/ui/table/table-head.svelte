<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { Snippet } from 'svelte';

  let {
    align = 'left',
    class: className,
    children,
  }: {
    align?: 'left' | 'right' | 'center';
    class?: string;
    children?: Snippet;
  } = $props();
</script>

<th
  class={cn(
    'px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider',
    align === 'right' && 'text-right',
    align === 'center' && 'text-center',
    align === 'left' && 'text-left',
    className,
  )}
>
  {#if children}
    {@render children()}
  {/if}
</th>
