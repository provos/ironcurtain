<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { AlertVariant } from './index.js';
  import type { Snippet } from 'svelte';

  const variantStyles: Record<AlertVariant, string> = {
    default: 'bg-muted/40 border-border text-foreground',
    destructive: 'bg-destructive/10 border-destructive/20 text-destructive',
  };

  let {
    variant = 'default',
    class: className,
    dismissible = false,
    ondismiss,
    children,
  }: {
    variant?: AlertVariant;
    class?: string;
    dismissible?: boolean;
    ondismiss?: () => void;
    children?: Snippet;
  } = $props();
</script>

<div
  class={cn(
    'rounded-xl border px-4 py-3 text-sm flex items-center justify-between animate-fade-in',
    variantStyles[variant],
    className,
  )}
  role="alert"
>
  <span class="min-w-0">
    {#if children}
      {@render children()}
    {/if}
  </span>
  {#if dismissible && ondismiss}
    <button
      onclick={ondismiss}
      class={cn(
        'ml-4 text-xs font-medium shrink-0',
        variant === 'destructive' ? 'text-destructive/60 hover:text-destructive' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      Dismiss
    </button>
  {/if}
</div>
