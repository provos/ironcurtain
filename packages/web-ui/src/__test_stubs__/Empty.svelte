<script lang="ts">
  // Stand-in for feature components in tests. `$props()` must be the
  // initializer of a top-level `const`, but we destructure to nothing so the
  // binding is never read at module scope (which would otherwise trigger the
  // Svelte 5 `state_referenced_locally` reactivity warning).
  const {}: Record<string, unknown> = $props();
</script>

<!-- no markup -->
