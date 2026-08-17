<script lang="ts">
  // Vitest mock target for routes and features in App.test.ts. The optional
  // input hook lets Sessions.test exercise the TerminalConsole callback while
  // keeping this stub inert for every other consumer.
  let { oninput }: { oninput?: (dataB64: string) => void } = $props();
</script>

<span data-testid="test-stub"></span>
{#if oninput}
  <button data-testid="test-stub-input" type="button" onclick={() => oninput?.('AQ==')}>Simulate input</button>
{/if}
