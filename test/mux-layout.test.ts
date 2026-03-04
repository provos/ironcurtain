import { describe, it, expect } from 'vitest';
import { calculateLayout, MAX_INPUT_LINE_ROWS } from '../src/mux/types.js';

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
    expect(layout.inputLineRows).toBe(1);
  });

  it('command mode, 2 escalations: escalation panel + hint + input', () => {
    const layout = calculateLayout(24, 'command', 2);
    expect(layout.ptyViewportRows).toBe(21); // CONSTANT
    expect(layout.escalationPanelRows).toBe(8); // 2 * 4 rows per escalation
    // overlay clamped to floor(21/2)=10
    expect(layout.overlayRows).toBe(10); // 8 (esc panel) + 1 (hint) + 1 (input)
  });

  it('command mode, 10 escalations: overlay capped at half viewport', () => {
    const layout = calculateLayout(24, 'command', 10);
    expect(layout.ptyViewportRows).toBe(21); // CONSTANT
    // overlay capped at floor(21/2)=10, escalation clamped to fit: 10-1(hint)-1(input)=8
    expect(layout.escalationPanelRows).toBe(8);
    expect(layout.overlayRows).toBe(10);
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
    // escalation panel: 4 rows (1 * 4)
    // 4 + 1 + 1 = 6, floor(27/2) = 13 => overlay = 6
    // overlayY = 1 + 27 - 6 = 22
    expect(layout.overlayY).toBe(22);
  });

  it('inputLineRows parameter increases overlay height', () => {
    const layout = calculateLayout(50, 'command', 0, 4);
    // ptyViewport: 47 rows, floor(47/2) = 23
    // 0 (esc) + 1 (hint) + 4 (input) = 5, clamped to min(5, 23) = 5
    expect(layout.overlayRows).toBe(5);
    expect(layout.inputLineRows).toBe(4);
  });

  it('inputLineRows is clamped to MAX_INPUT_LINE_ROWS', () => {
    const layout = calculateLayout(50, 'command', 0, 20);
    // Clamped to MAX_INPUT_LINE_ROWS=6: 0 + 1 + 6 = 7
    expect(layout.overlayRows).toBe(7);
    expect(layout.inputLineRows).toBe(MAX_INPUT_LINE_ROWS);
  });

  it('overlay does not exceed half viewport', () => {
    // With 10 rows total: viewport = 7, floor(7/2) = 3
    const layout = calculateLayout(10, 'command', 0, 6);
    expect(layout.ptyViewportRows).toBe(7);
    expect(layout.overlayRows).toBeLessThanOrEqual(Math.floor(7 / 2));
    // inputLineRows is clamped by the overlay budget
    expect(layout.inputLineRows).toBeGreaterThanOrEqual(1);
  });

  it('inputLineRows defaults to 1 when omitted', () => {
    const layout = calculateLayout(24, 'command', 0);
    expect(layout.inputLineRows).toBe(1);
  });

  it('inputLineRows is 1 in PTY mode', () => {
    const layout = calculateLayout(24, 'pty', 0);
    expect(layout.inputLineRows).toBe(1);
  });
});
