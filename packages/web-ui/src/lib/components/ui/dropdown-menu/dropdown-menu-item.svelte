<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  let {
    active = false,
    class: className,
    children,
    ...restProps
  }: HTMLButtonAttributes & {
    active?: boolean;
    children?: Snippet;
  } = $props();
</script>

<button
  class={cn(
    'w-full text-left px-3 py-2 text-sm transition-colors',
    active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50 text-foreground',
    className,
  )}
  role="menuitem"
  {...restProps}
>
  {#if children}
    {@render children()}
  {/if}
</button>
