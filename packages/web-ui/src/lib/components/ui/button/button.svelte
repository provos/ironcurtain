<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { ButtonVariant, ButtonSize } from './index.js';
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  const variantStyles: Record<ButtonVariant, string> = {
    default: 'bg-primary text-primary-foreground hover:brightness-110',
    destructive: 'bg-destructive text-destructive-foreground hover:brightness-110',
    outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
    ghost: 'hover:bg-accent/50 hover:text-foreground',
    secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
    success: 'bg-success text-success-foreground hover:brightness-110',
  };

  const sizeStyles: Record<ButtonSize, string> = {
    default: 'px-4 py-2 text-sm',
    sm: 'px-2.5 py-1 text-xs',
    lg: 'px-6 py-3 text-base',
    icon: 'h-8 w-8',
  };

  let {
    variant = 'default',
    size = 'default',
    loading = false,
    class: className,
    children,
    disabled,
    ...restProps
  }: HTMLButtonAttributes & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    loading?: boolean;
    children?: Snippet;
  } = $props();
</script>

<button
  class={cn(
    'inline-flex items-center justify-center gap-1.5 rounded-md font-medium',
    'transition-all active:scale-[0.97]',
    'disabled:opacity-50 disabled:pointer-events-none',
    variantStyles[variant],
    sizeStyles[size],
    className,
  )}
  disabled={disabled || loading}
  {...restProps}
>
  {#if loading}
    <span class="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin"></span>
  {/if}
  {#if children}
    {@render children()}
  {/if}
</button>
