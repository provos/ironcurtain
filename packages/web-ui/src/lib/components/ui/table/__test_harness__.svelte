<script lang="ts">
  // Minimal wrapper that mounts a TableRow inside a real <table>/<tbody> so
  // jsdom keeps the row in the parsed tree. Used exclusively by
  // table-row.test.ts.
  import TableRow from './table-row.svelte';

  let {
    clickable = false,
    onclick,
  }: {
    clickable?: boolean;
    onclick?: (e: MouseEvent) => void;
  } = $props();
</script>

<table>
  <tbody>
    <TableRow {clickable} {onclick} data-testid="row">
      <td>cell</td>
    </TableRow>
  </tbody>
</table>
