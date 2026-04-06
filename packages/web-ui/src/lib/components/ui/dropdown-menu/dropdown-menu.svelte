<script lang="ts">
  import { cn } from '$lib/utils.js';
  import { tick } from 'svelte';
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
    'aria-label': ariaLabel = 'Menu',
    class: className,
    contentClass,
    trigger,
    children,
  }: {
    open?: boolean;
    align?: MenuAlign;
    'aria-label'?: string;
    class?: string;
    contentClass?: string;
    trigger: Snippet;
    children?: Snippet;
  } = $props();

  let triggerEl: HTMLDivElement | undefined = $state(undefined);
  let menuEl: HTMLDivElement | undefined = $state(undefined);

  function handleBackdropClick(): void {
    open = false;
    triggerEl?.querySelector('button')?.focus();
  }

  function focusFirstItem(): void {
    tick().then(() => {
      const firstItem = menuEl?.querySelector('[role="menuitem"]') as HTMLElement | null;
      firstItem?.focus();
    });
  }

  $effect(() => {
    if (open) {
      focusFirstItem();
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          open = false;
          triggerEl?.querySelector('button')?.focus();
        }
      };
      document.addEventListener('keydown', handler);
      return () => document.removeEventListener('keydown', handler);
    }
  });
</script>

<div class={cn('relative', className)}>
  <div bind:this={triggerEl} aria-expanded={open} aria-haspopup="menu">
    {@render trigger()}
  </div>

  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-10" onclick={handleBackdropClick}></div>
    <div
      bind:this={menuEl}
      class={cn(
        'absolute z-20 min-w-[12rem] bg-card border border-border rounded-lg shadow-xl overflow-hidden animate-fade-in',
        alignStyles[align],
        contentClass,
      )}
      role="menu"
      aria-label={ariaLabel}
    >
      {#if children}
        {@render children()}
      {/if}
    </div>
  {/if}
</div>
