import { describe, it, expect } from 'vitest';
import { calculateLayout } from '../src/mux/types.js';

describe('calculateLayout', () => {
  it('PTY mode: viewport = totalRows - 3 (tab bar + 2-row footer)', () => {
    const layout = calculateLayout(24, 'pty', 0);
    expect(layout.ptyViewportRows).toBe(21);
    expect(layout.overlayRows).toBe(0);
    expect(layout.tabBarY).toBe(0);
    expect(layout.ptyViewportY).toBe(1);
    expect(layout.footerY).toBe(22);
  });

  it('command mode, no escalations: overlay = 2 rows (hint + input)', () => {
    const layout = calculateLayout(24, 'command', 0);
    expect(layout.ptyViewportRows).toBe(21); // CONSTANT
    expect(layout.overlayRows).toBe(2); // hint bar + input line
    expect(layout.escalationPanelRows).toBe(0);
  });

  it('command mode, 2 escalations: escalation panel + hint + input', () => {
    const layout = calculateLayout(24, 'command', 2);
    expect(layout.ptyViewportRows).toBe(21); // CONSTANT
    expect(layout.escalationPanelRows).toBe(4); // 2 * 2 rows per escalation
    expect(layout.overlayRows).toBe(6); // 4 (esc panel) + 1 (hint) + 1 (input)
  });

  it('command mode, 10 escalations: escalation panel capped at 6 rows', () => {
    const layout = calculateLayout(24, 'command', 10);
    expect(layout.ptyViewportRows).toBe(21); // CONSTANT
    expect(layout.escalationPanelRows).toBe(6); // capped at MAX_ESCALATION_PANEL_ROWS
    expect(layout.overlayRows).toBe(8); // 6 (esc panel) + 1 (hint) + 1 (input) = 8 = MAX_OVERLAY_ROWS
  });

  it('minimum viewport height is 1 row', () => {
    const layout = calculateLayout(2, 'pty', 0);
    expect(layout.ptyViewportRows).toBe(1); // min(1, 2-2=0) -> max(1, 0)
  });

  it('small terminal: 3 rows', () => {
    const layout = calculateLayout(3, 'pty', 0);
    expect(layout.ptyViewportRows).toBe(1); // min clamp
    expect(layout.footerY).toBe(2);
  });

  it('overlay Y position is correct', () => {
    const layout = calculateLayout(30, 'command', 1);
    // ptyViewport: 27 rows (30 - 3)
    // escalation panel: 2 rows (1 * 2)
    // overlay: 4 rows (2 esc + 1 hint + 1 input)
    // overlayY = 1 + 27 - 4 = 24
    expect(layout.overlayY).toBe(24);
  });
});
