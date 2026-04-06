<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { HTMLInputAttributes } from 'svelte/elements';

  let {
    class: className,
    value = $bindable(''),
    ...restProps
  }: HTMLInputAttributes & {
    value?: string;
  } = $props();
</script>

<input
  bind:value
  class={cn(
    'w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm',
    'focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring',
    'placeholder:text-muted-foreground/50 transition-all disabled:opacity-50',
    className,
  )}
  {...restProps}
/>
