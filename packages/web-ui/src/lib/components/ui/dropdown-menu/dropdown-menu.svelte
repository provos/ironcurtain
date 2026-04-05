<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { Snippet } from 'svelte';

  type MenuAlign = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';

  const alignStyles: Record<MenuAlign, string> = {
    'bottom-left': 'left-0 top-full mt-1',
    'bottom-right': 'right-0 top-full mt-1',
    'top-left': 'left-0 bottom-full mb-1',
    'top-right': 'right-0 bottom-full mb-1',
  };

  let {
    open = $bindable(false),
    align = 'bottom-left',
    class: className,
    contentClass,
    trigger,
    children,
  }: {
    open?: boolean;
    align?: MenuAlign;
    class?: string;
    contentClass?: string;
    trigger: Snippet;
    children?: Snippet;
  } = $props();

  function handleBackdropClick(): void {
    open = false;
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      open = false;
    }
  }
</script>

<div class={cn('relative', className)}>
  {@render trigger()}

  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="fixed inset-0 z-10"
      onclick={handleBackdropClick}
      onkeydown={handleKeydown}
    ></div>
    <div
      class={cn(
        'absolute z-20 min-w-[12rem] bg-card border border-border rounded-lg shadow-xl overflow-hidden animate-fade-in',
        alignStyles[align],
        contentClass,
      )}
      role="menu"
    >
      {#if children}
        {@render children()}
      {/if}
    </div>
  {/if}
</div>
