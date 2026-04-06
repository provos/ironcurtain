<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { BadgeVariant } from './index.js';
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  const variantStyles: Record<BadgeVariant, string> = {
    default: 'bg-primary/15 text-primary',
    secondary: 'bg-secondary text-secondary-foreground',
    destructive: 'bg-destructive/15 text-destructive',
    outline: 'border border-border text-foreground',
    success: 'bg-success/15 text-success',
    warning: 'bg-warning/15 text-warning',
  };

  let {
    variant = 'default',
    class: className,
    children,
    ...restProps
  }: HTMLAttributes<HTMLSpanElement> & {
    variant?: BadgeVariant;
    children?: Snippet;
  } = $props();
</script>

<span
  class={cn(
    'inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded-full',
    variantStyles[variant],
    className,
  )}
  {...restProps}
>
  {#if children}
    {@render children()}
  {/if}
</span>
