<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  let {
    class: className,
    children,
    ...restProps
  }: HTMLAttributes<HTMLDivElement> & {
    children?: Snippet;
  } = $props();
</script>

<div
  class={cn('bg-card border border-border rounded-xl', className)}
  {...restProps}
>
  {#if children}
    {@render children()}
  {/if}
</div>
