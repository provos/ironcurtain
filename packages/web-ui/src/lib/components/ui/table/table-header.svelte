<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children?: Snippet } = $props();
</script>

<thead>
  <tr class="border-b border-border bg-muted/30">
    {#if children}
      {@render children()}
    {/if}
  </tr>
</thead>
