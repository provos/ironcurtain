import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import TableRowHarness from './__test_harness__.svelte';

// ---------------------------------------------------------------------------
// Tests for B1: keyboard a11y on `clickable` rows.
//
// The harness component wraps a `TableRow` in a real `<table><tbody>` so
// jsdom's HTML parser keeps the row in the tree. Tests assert ARIA/tabindex
// when `clickable` is true and verify Enter / Space activate the same
// `onclick` handler as a mouse click would.
// ---------------------------------------------------------------------------

function getRow(container: HTMLElement): HTMLTableRowElement {
  const row = container.querySelector('tr[data-testid="row"]') as HTMLTableRowElement | null;
  if (!row) throw new Error('TableRow not found in DOM');
  return row;
}

describe('TableRow', () => {
  describe('clickable', () => {
    it('exposes role="button" and tabindex=0 when clickable', () => {
      const { container } = render(TableRowHarness, { props: { clickable: true, onclick: vi.fn() } });
      const row = getRow(container);
      expect(row.getAttribute('role')).toBe('button');
      expect(row.getAttribute('tabindex')).toBe('0');
    });

    it('Enter activates the same onclick handler', async () => {
      const onclick = vi.fn();
      const { container } = render(TableRowHarness, { props: { clickable: true, onclick } });
      const row = getRow(container);
      await fireEvent.keyDown(row, { key: 'Enter' });
      expect(onclick).toHaveBeenCalledTimes(1);
    });

    it('Space activates the handler and prevents page scroll', async () => {
      const onclick = vi.fn();
      const { container } = render(TableRowHarness, { props: { clickable: true, onclick } });
      const row = getRow(container);
      const event = new KeyboardEvent('keydown', { key: ' ', cancelable: true, bubbles: true });
      row.dispatchEvent(event);
      expect(onclick).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('mouse click still fires onclick', async () => {
      const onclick = vi.fn();
      const { container } = render(TableRowHarness, { props: { clickable: true, onclick } });
      const row = getRow(container);
      await fireEvent.click(row);
      expect(onclick).toHaveBeenCalledTimes(1);
    });

    it('ignores other keys (e.g. ArrowDown)', async () => {
      const onclick = vi.fn();
      const { container } = render(TableRowHarness, { props: { clickable: true, onclick } });
      const row = getRow(container);
      await fireEvent.keyDown(row, { key: 'ArrowDown' });
      expect(onclick).not.toHaveBeenCalled();
    });
  });

  describe('non-clickable', () => {
    it('omits role and tabindex when not clickable', () => {
      const { container } = render(TableRowHarness, { props: { clickable: false } });
      const row = getRow(container);
      expect(row.getAttribute('role')).toBeNull();
      expect(row.getAttribute('tabindex')).toBeNull();
    });

    it('does not invoke onclick on Enter when clickable is false', async () => {
      const onclick = vi.fn();
      const { container } = render(TableRowHarness, { props: { clickable: false, onclick } });
      const row = getRow(container);
      await fireEvent.keyDown(row, { key: 'Enter' });
      expect(onclick).not.toHaveBeenCalled();
    });
  });
});
