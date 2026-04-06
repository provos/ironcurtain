<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children?: Snippet } = $props();
</script>

<tbody>
  {#if children}
    {@render children()}
  {/if}
</tbody>
