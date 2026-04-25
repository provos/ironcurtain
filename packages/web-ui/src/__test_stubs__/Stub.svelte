<script lang="ts">
  // Vitest mock target for routes and features in App.test.ts. Empty
  // destructure avoids the Svelte 5 `state_referenced_locally` warning.
  const {}: Record<string, unknown> = $props();
</script>

<span data-testid="test-stub"></span>
