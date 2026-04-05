<script lang="ts">
  import { cn } from '$lib/utils.js';

  let {
    size = 'sm',
    class: className,
  }: {
    size?: 'xs' | 'sm' | 'md';
    class?: string;
  } = $props();

  const sizeStyles = {
    xs: 'w-2 h-2 border-[1.5px]',
    sm: 'w-3 h-3 border-2',
    md: 'w-4 h-4 border-2',
  };
</script>

<span
  class={cn('inline-block rounded-full border-current/30 border-t-current animate-spin', sizeStyles[size], className)}
  aria-label="Loading"
></span>
