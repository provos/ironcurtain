/**
 * Shared types for the terminal multiplexer (`ironcurtain mux`).
 */

import type { PtyBridge } from './pty-bridge.js';

/** Input mode for the mux. */
export type InputMode = 'pty' | 'command' | 'picker';

/** A single tab in the mux. */
export interface MuxTab {
  /** Sequential tab number (1-based, for display). */
  readonly number: number;
  /** The PtyBridge instance for this tab. */
  readonly bridge: PtyBridge;
  /** Display label for the tab. */
  label: string;
  /** Whether the child process has exited. */
  status: 'running' | 'exited';
  /** Exit code if exited. */
  exitCode?: number;
  /** Whether escalation watching is available for this session. */
  escalationAvailable: boolean;
  /** Scroll offset into xterm buffer (null = live/bottom). */
  scrollOffset: number | null;
}

/**
 * Actions produced by the input handler for the orchestrator to execute.
 */
export type MuxAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'write-pty'; readonly data: string }
  | { readonly kind: 'enter-command-mode' }
  | { readonly kind: 'enter-pty-mode' }
  | { readonly kind: 'command'; readonly command: string; readonly args: string[] }
  | { readonly kind: 'trusted-input'; readonly text: string }
  | { readonly kind: 'redraw-input' }
  | { readonly kind: 'enter-picker-mode' }
  | { readonly kind: 'picker-spawn'; readonly workspacePath?: string }
  | { readonly kind: 'picker-cancel' }
  | { readonly kind: 'redraw-picker' }
  | { readonly kind: 'scroll-up'; readonly amount: number }
  | { readonly kind: 'scroll-down'; readonly amount: number }
  | { readonly kind: 'quit' };

/**
 * Layout calculations for the screen regions.
 */
export interface Layout {
  /** Y position of the tab bar (always 0). */
  readonly tabBarY: number;
  /** Y position of the PTY viewport. */
  readonly ptyViewportY: number;
  /** Height of the PTY viewport in rows (CONSTANT -- never changes on mode switch). */
  readonly ptyViewportRows: number;
  /** Y position of the footer. */
  readonly footerY: number;
  /** Total overlay rows in command mode (0 in PTY mode). */
  readonly overlayRows: number;
  /** Y position where overlay starts. */
  readonly overlayY: number;
  /** Height of the escalation panel within the overlay. */
  readonly escalationPanelRows: number;
  /** Rows available for the picker overlay (half of viewport). */
  readonly pickerRows: number;
  /** Y position where the picker overlay starts. */
  readonly pickerY: number;
  /** Actual number of input rows allocated (after clamping). */
  readonly inputLineRows: number;
}

// Layout constants
const TAB_BAR_ROWS = 1;
const FOOTER_ROWS = 2;
const HINT_BAR_ROWS = 1;
const MIN_INPUT_LINE_ROWS = 1;
export const MAX_INPUT_LINE_ROWS = 6;
const ESCALATION_ROWS_PER_ITEM = 4;
const MAX_ESCALATION_PANEL_ROWS = 12;

/**
 * Calculates the screen layout.
 *
 * The PTY viewport is CONSTANT: totalRows - TAB_BAR_ROWS - FOOTER_ROWS.
 * In command mode, the overlay paints over the bottom rows of the PTY viewport.
 *
 * @param inputLineRows - Number of input rows requested (default 1). Clamped
 *   between MIN_INPUT_LINE_ROWS and MAX_INPUT_LINE_ROWS, then further clamped
 *   by available viewport space.
 */
export function calculateLayout(totalRows: number, mode: InputMode, pendingCount: number, inputLineRows = 1): Layout {
  // Ensure footer fits on screen; degrade gracefully on tiny terminals
  const footerRows = Math.min(FOOTER_ROWS, Math.max(0, totalRows - TAB_BAR_ROWS));
  const ptyViewportRows = Math.max(1, totalRows - TAB_BAR_ROWS - footerRows);

  let overlayRows = 0;
  let escalationPanelRows = 0;
  let allocatedInputRows = MIN_INPUT_LINE_ROWS;

  if (mode === 'command') {
    if (pendingCount > 0) {
      escalationPanelRows = Math.min(pendingCount * ESCALATION_ROWS_PER_ITEM, MAX_ESCALATION_PANEL_ROWS);
    }
    const actualInputRows = Math.min(Math.max(inputLineRows, MIN_INPUT_LINE_ROWS), MAX_INPUT_LINE_ROWS);
    // Ensure overlay fits at least the hint bar + 1 input row, even on tiny terminals.
    const minOverlay = Math.min(ptyViewportRows, HINT_BAR_ROWS + MIN_INPUT_LINE_ROWS);
    overlayRows = Math.max(
      minOverlay,
      Math.min(escalationPanelRows + HINT_BAR_ROWS + actualInputRows, Math.floor(ptyViewportRows / 2), ptyViewportRows),
    );
    // Clamp escalation panel to fit within overlay budget, reserving
    // space for the hint bar and at least one input row.
    escalationPanelRows = Math.min(escalationPanelRows, Math.max(0, overlayRows - HINT_BAR_ROWS - MIN_INPUT_LINE_ROWS));
    allocatedInputRows = Math.max(MIN_INPUT_LINE_ROWS, overlayRows - escalationPanelRows - HINT_BAR_ROWS);
  }

  const pickerRows = mode === 'picker' ? Math.min(Math.floor(ptyViewportRows / 2), ptyViewportRows) : 0;
  const pickerY = TAB_BAR_ROWS + ptyViewportRows - pickerRows;

  return {
    tabBarY: 0,
    ptyViewportY: TAB_BAR_ROWS,
    ptyViewportRows,
    footerY: TAB_BAR_ROWS + ptyViewportRows,
    overlayRows,
    overlayY: TAB_BAR_ROWS + ptyViewportRows - overlayRows,
    escalationPanelRows,
    pickerRows,
    pickerY,
    inputLineRows: mode === 'command' ? allocatedInputRows : 1,
  };
}
