<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  let {
    clickable = false,
    muted = false,
    class: className,
    children,
    onclick,
    onkeydown,
    ...restProps
  }: HTMLAttributes<HTMLTableRowElement> & {
    clickable?: boolean;
    muted?: boolean;
    children?: Snippet;
  } = $props();

  // When the row is `clickable`, mirror Enter / Space to the same `onclick`
  // handler so keyboard users can activate it like a button. Space is
  // intercepted with preventDefault() to suppress the browser's default
  // page-scroll behavior.
  function handleKeydown(event: KeyboardEvent): void {
    if (clickable && onclick && (event.key === 'Enter' || event.key === ' ')) {
      if (event.key === ' ') event.preventDefault();
      onclick(event as unknown as MouseEvent & { currentTarget: EventTarget & HTMLTableRowElement });
    }
    onkeydown?.(event as KeyboardEvent & { currentTarget: EventTarget & HTMLTableRowElement });
  }
</script>

<tr
  class={cn(
    'border-t border-border/50 transition-colors',
    clickable && 'hover:bg-accent/40 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
    !clickable && !muted && 'hover:bg-accent/30',
    muted && 'opacity-50',
    className,
  )}
  tabindex={clickable ? 0 : undefined}
  role={clickable ? 'button' : undefined}
  {onclick}
  onkeydown={handleKeydown}
  {...restProps}
>
  {#if children}
    {@render children()}
  {/if}
</tr>
