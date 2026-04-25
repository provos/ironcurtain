<script lang="ts">
  // Test-only stub component used by route-level tests to replace heavy
  // children (e.g. WorkflowDetail) without dragging in workspace-browser
  // and friends. Renders nothing. Accepts (and ignores) any props by
  // forwarding them to a hidden data attribute.
  import type { Snippet } from 'svelte';
  const props: Record<string, unknown> & { children?: Snippet } = $props();
</script>

<div data-testid="test-stub" data-prop-count={Object.keys(props).length}></div>
