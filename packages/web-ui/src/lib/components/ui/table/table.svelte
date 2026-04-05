<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { Snippet } from 'svelte';

  let {
    class: className,
    children,
  }: {
    class?: string;
    children?: Snippet;
  } = $props();
</script>

<div class={cn('bg-card border border-border rounded-xl overflow-hidden', className)}>
  <table class="w-full text-sm">
    {#if children}
      {@render children()}
    {/if}
  </table>
</div>
