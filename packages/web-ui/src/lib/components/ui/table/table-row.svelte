<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  let {
    clickable = false,
    muted = false,
    class: className,
    children,
    ...restProps
  }: HTMLAttributes<HTMLTableRowElement> & {
    clickable?: boolean;
    muted?: boolean;
    children?: Snippet;
  } = $props();
</script>

<tr
  class={cn(
    'border-t border-border/50 transition-colors',
    clickable && 'hover:bg-accent/40 cursor-pointer',
    !clickable && !muted && 'hover:bg-accent/30',
    muted && 'opacity-50',
    className,
  )}
  {...restProps}
>
  {#if children}
    {@render children()}
  {/if}
</tr>
