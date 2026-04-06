<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { Snippet } from 'svelte';

  let {
    open,
    onclose,
    onkeydown: externalKeydown,
    title,
    class: className,
    children,
  }: {
    open: boolean;
    onclose: () => void;
    onkeydown?: (e: KeyboardEvent) => void;
    title?: string;
    class?: string;
    children?: Snippet;
  } = $props();

  let dialogEl: HTMLDivElement | undefined = $state(undefined);
  let previousActiveElement: Element | null = null;

  function getFocusableElements(): HTMLElement[] {
    if (!dialogEl) return [];
    return Array.from(
      dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])',
      ),
    );
  }

  function trapFocus(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    const focusable = getFocusableElements();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onclose();
      return;
    }
    trapFocus(e);
    externalKeydown?.(e);
  }

  function handleBackdropClick(): void {
    onclose();
  }

  $effect(() => {
    if (open) {
      previousActiveElement = document.activeElement;
      // Focus the dialog after it renders
      requestAnimationFrame(() => {
        const focusable = getFocusableElements();
        if (focusable.length > 0) {
          focusable[0].focus();
        } else {
          dialogEl?.focus();
        }
      });
    } else if (previousActiveElement && previousActiveElement instanceof HTMLElement) {
      previousActiveElement.focus();
      previousActiveElement = null;
    }
  });

  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onkeydown={handleKeydown}>
    <!-- Backdrop -->
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div class="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onclick={handleBackdropClick}></div>

    <!-- Dialog -->
    <div
      bind:this={dialogEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      tabindex="-1"
      class={cn(
        'relative z-10 w-full max-w-2xl mx-4 bg-card border border-border rounded-xl shadow-2xl animate-fade-in overflow-hidden',
        className,
      )}
    >
      {#if title}
        <div class="px-5 py-3 border-b border-border">
          <h2 id={titleId} class="text-sm font-semibold">{title}</h2>
        </div>
      {/if}
      {#if children}
        {@render children()}
      {/if}
    </div>
  </div>
{/if}
