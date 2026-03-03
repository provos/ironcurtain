/**
 * MuxRenderer -- composes all UI regions into terminal output
 * and draws to the real terminal with throttled rendering.
 *
 * UI regions (top to bottom):
 *   [tab bar]          1 row
 *   [pty viewport]     variable height (fills remaining space)
 *   [escalation panel] 0 or N rows (only in command mode with pending escalations)
 *   [hint bar]         1 row
 *   [input line]       0 or 1 row (only in command mode)
 *
 * The PTY viewport size is constant regardless of input mode.
 * Command-mode UI overlays the bottom of the viewport.
 */

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import type { Terminal as TerminalType } from '@xterm/headless';
import { calculateLayout, type InputMode, type Layout, type MuxTab } from './types.js';
import type { ListenerState } from '../escalation/listener-state.js';
import type { PickerState } from './mux-input-handler.js';

// -- xterm.js color mode constants (from IBufferCell.getFgColorMode/getBgColorMode) --
const CM_DEFAULT = 0;
const CM_P16 = 16777216; // 0x01000000
const CM_P256 = 33554432; // 0x02000000
const CM_RGB = 50331648; // 0x03000000

/** Color type compatible with terminal-kit ScreenBufferHD. */
export type TermkitColor = number | { r: number; g: number; b: number } | 'default';

/** A cell translated from xterm.js buffer to terminal-kit format. */
export interface TranslatedCell {
  readonly char: string;
  readonly width: number;
  readonly fg: TermkitColor;
  readonly bg: TermkitColor;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly dim: boolean;
  readonly inverse: boolean;
  readonly strikethrough: boolean;
}

/** Minimum render interval (~60 FPS). */
const MIN_RENDER_INTERVAL_MS = 16;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TerminalKit = any;

export interface MuxRenderer {
  /** Full redraw of all regions. */
  fullRedraw(): void;
  /** Incremental redraw of only the PTY viewport. */
  redrawPty(): void;
  /** Redraws just the tab bar. */
  redrawTabBar(): void;
  /** Redraws the command area (escalation panel + hint bar + input). */
  redrawCommandArea(): void;
  /** Handles terminal resize. */
  resize(cols: number, rows: number): void;
  /** Cleans up resources. */
  destroy(): void;
  /** Schedule a throttled PTY redraw. */
  scheduleRedraw(): void;
  /** Shows a transient message in the footer that auto-clears. */
  showMessage(message: string): void;
  /** Current layout. */
  readonly layout: Layout;
}

export interface MuxRendererDeps {
  getActiveTab: () => MuxTab | undefined;
  getTabs: () => MuxTab[];
  getActiveTabIndex: () => number;
  getMode: () => InputMode;
  getInputBuffer: () => string;
  getCursorPos: () => number;
  getEscalationState: () => ListenerState;
  getPendingCount: () => number;
  getPickerState: () => PickerState | null;
  /** Returns the active tab's scroll offset (null = live/bottom). */
  getScrollOffset: () => number | null;
}

/**
 * Creates a MuxRenderer.
 */
export function createMuxRenderer(term: TerminalKit, cols: number, rows: number, deps: MuxRendererDeps): MuxRenderer {
  let _cols = cols;
  let _rows = rows;
  let _layout = calculateLayout(_rows, deps.getMode(), deps.getPendingCount());

  // Render throttling
  let renderScheduled = false;
  let lastRenderTime = 0;
  let renderTimeout: ReturnType<typeof setTimeout> | null = null;

  // Transient flash message
  let _flashMessage: string | null = null;
  let _flashTimeout: ReturnType<typeof setTimeout> | null = null;
  const FLASH_DURATION_MS = 3000;

  function recalcLayout(): void {
    _layout = calculateLayout(_rows, deps.getMode(), deps.getPendingCount());
  }

  function moveTo(x: number, y: number): void {
    term.moveTo(x + 1, y + 1); // terminal-kit is 1-indexed
  }

  function clearLine(y: number): void {
    moveTo(0, y);
    term.eraseLine();
  }

  function drawTabBar(): void {
    clearLine(_layout.tabBarY);
    moveTo(0, _layout.tabBarY);

    const tabs = deps.getTabs();
    const activeIdx = deps.getActiveTabIndex();

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      const isActive = i === activeIdx;
      const statusSuffix = tab.status === 'exited' ? ' exited' : '';
      const label = ` #${tab.number} ${tab.label}${statusSuffix} `;

      if (isActive) {
        term.bgWhite.black(label);
      } else {
        term.bgDefaultColor.dim(label);
      }
    }

    // Escalation badge
    const pendingCount = deps.getPendingCount();
    if (pendingCount > 0) {
      const badge = ` [!${pendingCount} pending] `;
      const badgeX = Math.max(0, _cols - badge.length);
      moveTo(badgeX, _layout.tabBarY);
      term.bgYellow.black(badge);
    }

    term.styleReset();
    term.eraseLineAfter();
  }

  function drawPtyViewport(): void {
    const activeTab = deps.getActiveTab();
    if (!activeTab) {
      for (let y = _layout.ptyViewportY; y < _layout.ptyViewportY + _layout.ptyViewportRows; y++) {
        clearLine(y);
      }
      return;
    }

    const xtermTerminal = activeTab.bridge.terminal;
    const baseY = xtermTerminal.buffer.active.baseY;
    const scrollOffset = deps.getScrollOffset();
    const readFrom = scrollOffset ?? baseY;
    const cells = readTerminalBuffer(xtermTerminal, readFrom, _layout.ptyViewportRows, _cols);

    // Determine how many rows to render (skip overlay in command/picker mode)
    const mode = deps.getMode();
    let visibleRows = _layout.ptyViewportRows;
    if (mode === 'command') visibleRows -= _layout.overlayRows;
    else if (mode === 'picker') visibleRows -= _layout.pickerRows;

    let lastStyle: TranslatedCell | null = null;
    for (let y = 0; y < visibleRows; y++) {
      moveTo(0, _layout.ptyViewportY + y);
      const row = cells[y];
      if (row.length === 0) {
        term.eraseLineAfter();
        lastStyle = null;
        continue;
      }

      renderRow(term, row, lastStyle);
      term.noFormat('\x1b[0m'); // reset before eraseLineAfter
      term.eraseLineAfter();
      lastStyle = null;
    }

    // Position cursor where xterm.js says it should be (only when at live viewport)
    if (mode === 'pty' && scrollOffset === null) {
      const buffer = xtermTerminal.buffer.active;
      moveTo(buffer.cursorX, _layout.ptyViewportY + buffer.cursorY);
    }
  }

  function drawFooter(): void {
    const row1 = _layout.footerY;
    const row2 = _layout.footerY + 1;

    clearLine(row1);
    clearLine(row2);

    const activeTab = deps.getActiveTab();
    const mode = deps.getMode();
    const pendingCount = deps.getPendingCount();

    if (mode === 'pty') {
      // Row 1: status — tab label left, scroll indicator + escalation badge right
      moveTo(0, row1);
      const tabLabel = activeTab ? `PTY #${activeTab.number} ${activeTab.label}` : 'No session';
      term.dim(`  [${tabLabel}]`);

      // Right-aligned badges: scroll indicator + escalation badge
      const scrollOffset = deps.getScrollOffset();
      const scrollBadge =
        scrollOffset !== null && activeTab
          ? ` [\u2191 ${activeTab.bridge.terminal.buffer.active.baseY - scrollOffset} lines] `
          : '';
      const escalationBadge = pendingCount > 0 ? ` [!${pendingCount} pending] ` : '';
      const rightContent = scrollBadge + escalationBadge;

      if (rightContent.length > 0) {
        moveTo(Math.max(0, _cols - rightContent.length), row1);
        if (scrollBadge) term.cyan(scrollBadge);
        if (escalationBadge) {
          term.bgYellow.black(escalationBadge);
          term.styleReset();
        }
      }
      term.eraseLineAfter();

      // Row 2: flash message or guidance
      moveTo(0, row2);
      if (_flashMessage) {
        term.yellow(`  ${_flashMessage}`);
      } else {
        term('  ');
        term.bgWhite.black(' ^^A ');
        term.styleReset();
        if (pendingCount > 0) {
          term.dim(
            ` command mode \u00b7 ${pendingCount} escalation${pendingCount !== 1 ? 's' : ''} pending \u2014 /approve or /deny`,
          );
        } else {
          term.dim(' command mode \u00b7 type a message to enable auto-approver');
        }
      }
      term.styleReset();
      term.eraseLineAfter();
    } else {
      // Row 1: command mode — badge-style keys
      moveTo(0, row1);
      term('  ');
      term.bgWhite.black(' CMD ');
      term('  ');
      term.bgWhite.black(' ^^A ');
      term.styleReset();
      term.dim(' pty  ');
      term.bgWhite.black(' Esc ');
      term.styleReset();
      term.dim(' back');
      term.eraseLineAfter();

      // Row 2: flash message or trusted input hint
      moveTo(0, row2);
      if (_flashMessage) {
        term.yellow(`  ${_flashMessage}`);
      } else {
        term.dim('  type a message to send as trusted input to the agent');
      }
      term.styleReset();
      term.eraseLineAfter();
    }
  }

  function drawCommandOverlay(): void {
    if (deps.getMode() !== 'command') return;
    const startY = _layout.overlayY;

    let currentY = startY;

    // Escalation panel
    if (_layout.escalationPanelRows > 0) {
      const pendingEscalations = [...deps.getEscalationState().pendingEscalations.values()].sort(
        (a, b) => a.displayNumber - b.displayNumber,
      );

      let rowsUsed = 0;
      let shownCount = 0;
      for (const esc of pendingEscalations) {
        if (rowsUsed >= _layout.escalationPanelRows) break;

        // Row 1: header — [N] Session #M  server/tool
        clearLine(currentY);
        moveTo(2, currentY);
        term.yellow(`[${esc.displayNumber}]`);
        term(` Session #${esc.sessionDisplayNumber}  `);
        term.cyan(`${esc.request.serverName}/${esc.request.toolName}`);
        currentY++;
        rowsUsed++;
        shownCount++;

        // Row 2+: arguments — packed key: value pairs
        if (rowsUsed < _layout.escalationPanelRows) {
          const argLines = formatArgLines(esc.request.arguments, _cols - 6);
          for (const line of argLines) {
            if (rowsUsed >= _layout.escalationPanelRows) break;
            clearLine(currentY);
            moveTo(6, currentY);
            term(line);
            currentY++;
            rowsUsed++;
          }
        }

        // Reason line
        if (rowsUsed < _layout.escalationPanelRows) {
          clearLine(currentY);
          moveTo(6, currentY);
          term.dim(`Reason: ${esc.request.reason}`);
          currentY++;
          rowsUsed++;
        }
      }

      // Overflow indicator when not all escalations fit
      const remaining = pendingEscalations.length - shownCount;
      if (remaining > 0 && rowsUsed >= _layout.escalationPanelRows) {
        const lastY = startY + _layout.escalationPanelRows - 1;
        clearLine(lastY);
        moveTo(6, lastY);
        term.dim(`[+${remaining} more \u2014 /approve all or /deny all]`);
      }
    }

    // Hint bar
    clearLine(currentY);
    moveTo(2, currentY);
    const pendingCount = deps.getPendingCount();
    if (pendingCount > 0) {
      term.cyan('/approve');
      term.dim(' N  ');
      term.cyan('/deny');
      term.dim(' N  ');
      term.cyan('/approve all');
      term.dim(' \u2502 ');
      term.cyan('/new');
      term.dim('  ');
      term.cyan('/quit');
    } else {
      term.cyan('/new');
      term.dim('  ');
      term.cyan('/tab');
      term.dim(' N  ');
      term.cyan('/close');
      term.dim('  ');
      term.cyan('/sessions');
      term.dim('  ');
      term.cyan('/quit');
    }
    term.styleReset();
    currentY++;

    // Input line
    clearLine(currentY);
    moveTo(2, currentY);
    term('> ');
    term(deps.getInputBuffer());
    term.eraseLineAfter();

    // Position cursor at input
    moveTo(2 + 2 + deps.getCursorPos(), currentY);
  }

  function drawActiveOverlay(): void {
    const mode = deps.getMode();
    if (mode === 'command') {
      drawCommandOverlay();
    } else if (mode === 'picker') {
      drawPickerOverlay();
    }
  }

  function drawPickerOverlay(): void {
    const ps = deps.getPickerState();
    if (!ps) return;

    const startY = _layout.pickerY;
    const totalRows = _layout.pickerRows;
    if (totalRows < 4) return; // not enough space

    if (ps.phase === 'menu') {
      drawPickerMenu(ps, startY, totalRows);
    } else {
      drawPickerBrowse(ps, startY, totalRows);
    }
  }

  function drawMenuOption(y: number, label: string, selected: boolean, boxWidth: number): void {
    clearLine(y);
    moveTo(2, y);
    term.cyan('\u2502');
    term(' ');
    if (selected) {
      term.bgCyan.black('>' + label);
      term.styleReset();
    } else {
      term(' ' + label);
    }
    const pad = Math.max(0, boxWidth - label.length - 2);
    term(' '.repeat(pad));
    term.cyan('\u2502');
  }

  function drawPickerMenu(ps: PickerState, startY: number, totalRows: number): void {
    const menuHeight = 4;
    const topPad = Math.max(0, Math.floor((totalRows - menuHeight) / 2));

    for (let y = startY; y < startY + totalRows; y++) {
      clearLine(y);
    }

    const y0 = startY + topPad;
    const boxWidth = Math.min(34, _cols - 4);

    // Top border
    moveTo(2, y0);
    term.cyan('\u250c /new ' + '\u2500'.repeat(Math.max(0, boxWidth - 6)) + '\u2510');

    drawMenuOption(y0 + 1, ' New sandbox', ps.menuSelection === 0, boxWidth);
    drawMenuOption(y0 + 2, ' Existing directory', ps.menuSelection === 1, boxWidth);

    // Bottom border
    clearLine(y0 + 3);
    moveTo(2, y0 + 3);
    term.cyan('\u2514' + '\u2500'.repeat(boxWidth) + '\u2518');

    term.styleReset();
  }

  function drawPickerBrowse(ps: PickerState, startY: number, totalRows: number): void {
    // Row 0: path input line with cursor
    // Row 1: separator
    // Rows 2..N-2: entry list
    // Row N-1: hint bar (or error)
    let currentY = startY;

    // Path input line — render with visible cursor block
    clearLine(currentY);
    moveTo(2, currentY);
    term.cyan('Path: ');
    const pathPrefix = 'Path: ';
    const beforeCursor = ps.inputPath.slice(0, ps.cursorPos);
    const cursorChar = ps.cursorPos < ps.inputPath.length ? ps.inputPath[ps.cursorPos] : ' ';
    const afterCursor = ps.cursorPos < ps.inputPath.length ? ps.inputPath.slice(ps.cursorPos + 1) : '';
    term(beforeCursor);
    if (!ps.inList) {
      // Show block cursor when input field has focus
      term.bgWhite.black(cursorChar);
      term.styleReset();
    } else {
      term(cursorChar);
    }
    term(afterCursor);
    term.eraseLineAfter();
    const cursorX = 2 + pathPrefix.length + ps.cursorPos;
    currentY++;

    // Separator
    clearLine(currentY);
    moveTo(2, currentY);
    term.dim('\u2500'.repeat(Math.max(0, _cols - 4)));
    term.styleReset();
    currentY++;

    // Entry list
    const listRows = Math.max(0, totalRows - 3); // subtract input, separator, hint bar

    // Only adjust scroll when focus is in the list
    if (ps.inList) {
      if (ps.selectedIndex < ps.scrollOffset) {
        ps.scrollOffset = ps.selectedIndex;
      } else if (ps.selectedIndex >= ps.scrollOffset + listRows) {
        ps.scrollOffset = ps.selectedIndex - listRows + 1;
      }
    }

    for (let i = 0; i < listRows; i++) {
      clearLine(currentY);
      const entryIdx = ps.scrollOffset + i;
      if (entryIdx < ps.entries.length) {
        moveTo(2, currentY);
        const entry = ps.entries[entryIdx];
        const isHighlighted = ps.inList && entryIdx === ps.selectedIndex;
        const isDir = entry.endsWith('/');

        if (isHighlighted) {
          term.bgCyan.black('> ' + entry);
          term.styleReset();
        } else {
          term('  ');
          if (isDir) {
            term.cyan(entry);
          } else {
            term(entry);
          }
        }
      }
      term.eraseLineAfter();
      currentY++;
    }

    // Hint bar / error
    clearLine(currentY);
    moveTo(2, currentY);
    if (ps.error) {
      term.red(truncate(ps.error, _cols - 4));
    } else if (ps.inList) {
      term.bgWhite.black(' Enter ');
      term.styleReset();
      term.dim(' pick  ');
      term.bgWhite.black(' Esc ');
      term.styleReset();
      term.dim(' back to input');
    } else {
      term.bgWhite.black(' Enter ');
      term.styleReset();
      term.dim(' submit  ');
      term.bgWhite.black(' Tab ');
      term.styleReset();
      term.dim(' complete  ');
      term.bgWhite.black(' \u2193 ');
      term.styleReset();
      term.dim(' browse  ');
      term.bgWhite.black(' Esc ');
      term.styleReset();
      term.dim(' back');
    }
    term.styleReset();
    term.eraseLineAfter();

    // Position terminal cursor on the input line (for accessibility)
    moveTo(cursorX, startY);
  }

  return {
    get layout() {
      return _layout;
    },

    fullRedraw(): void {
      recalcLayout();
      term.clear();
      drawTabBar();
      drawPtyViewport();
      drawFooter();
      drawActiveOverlay();
    },

    redrawPty(): void {
      recalcLayout();
      drawPtyViewport();
      drawActiveOverlay();
    },

    redrawTabBar(): void {
      drawTabBar();
    },

    redrawCommandArea(): void {
      recalcLayout();
      const mode = deps.getMode();
      if (mode === 'command' || mode === 'picker') {
        // Repaint viewport first to clear stale overlay rows from a
        // previously larger overlay (e.g., after resolving an escalation).
        drawPtyViewport();
        drawActiveOverlay();
      } else {
        drawFooter();
      }
    },

    resize(newCols: number, newRows: number): void {
      _cols = newCols;
      _rows = newRows;
      recalcLayout();
    },

    destroy(): void {
      if (renderTimeout) {
        clearTimeout(renderTimeout);
        renderTimeout = null;
      }
      if (_flashTimeout) {
        clearTimeout(_flashTimeout);
        _flashTimeout = null;
      }
    },

    showMessage(message: string): void {
      _flashMessage = message;
      if (_flashTimeout) clearTimeout(_flashTimeout);
      _flashTimeout = setTimeout(() => {
        _flashMessage = null;
        _flashTimeout = null;
        drawFooter();
      }, FLASH_DURATION_MS);
      drawFooter();
    },

    scheduleRedraw(): void {
      if (renderScheduled) return;
      renderScheduled = true;

      const elapsed = Date.now() - lastRenderTime;
      const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - elapsed);

      renderTimeout = setTimeout(() => {
        renderScheduled = false;
        lastRenderTime = Date.now();
        recalcLayout();
        drawPtyViewport();
        drawFooter();
        drawActiveOverlay();
      }, delay);
    },
  };
}

// -- Cell translation --

function translateColor(mode: number, colorValue: number): TermkitColor {
  switch (mode) {
    case CM_DEFAULT:
      return 'default';
    case CM_P16:
    case CM_P256:
      return colorValue;
    case CM_RGB:
      return {
        r: (colorValue >> 16) & 0xff,
        g: (colorValue >> 8) & 0xff,
        b: colorValue & 0xff,
      };
    default:
      return 'default';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateCell(cell: any): TranslatedCell | null {
  const width = cell.getWidth() as number;
  if (width === 0) return null; // Wide char placeholder

  const char = (cell.getChars() as string) || ' ';
  const fg = translateColor(cell.getFgColorMode() as number, cell.getFgColor() as number);
  const bg = translateColor(cell.getBgColorMode() as number, cell.getBgColor() as number);

  return {
    char,
    width,
    fg,
    bg,
    bold: (cell.isBold() as number) !== 0,
    italic: (cell.isItalic() as number) !== 0,
    underline: (cell.isUnderline() as number) !== 0,
    dim: (cell.isDim() as number) !== 0,
    inverse: (cell.isInverse() as number) !== 0,
    strikethrough: (cell.isStrikethrough() as number) !== 0,
  };
}

/**
 * Reads the headless terminal buffer and translates each cell.
 */
export function readTerminalBuffer(
  terminal: TerminalType,
  startRow: number,
  rows: number,
  cols: number,
): TranslatedCell[][] {
  const buffer = terminal.buffer.active;
  const result: TranslatedCell[][] = [];

  for (let y = 0; y < rows; y++) {
    const lineIndex = startRow + y;
    const line = buffer.getLine(lineIndex);
    if (!line) {
      result.push([]);
      continue;
    }

    const row: TranslatedCell[] = [];
    let reusableCell: ReturnType<typeof line.getCell> | undefined;
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x, reusableCell);
      if (!cell) continue;
      reusableCell = cell;

      const translated = translateCell(cell);
      if (translated) row.push(translated);
    }
    result.push(row);
  }
  return result;
}

/**
 * Builds the SGR parameter string for a cell's style attributes.
 */
export function buildSgrSequence(cell: TranslatedCell): string {
  const sgr: number[] = [0];

  if (cell.bold) sgr.push(1);
  if (cell.dim) sgr.push(2);
  if (cell.italic) sgr.push(3);
  if (cell.underline) sgr.push(4);
  if (cell.inverse) sgr.push(7);
  if (cell.strikethrough) sgr.push(9);

  // Foreground
  if (cell.fg === 'default') {
    sgr.push(39);
  } else if (typeof cell.fg === 'number') {
    sgr.push(38, 5, cell.fg);
  } else {
    sgr.push(38, 2, cell.fg.r, cell.fg.g, cell.fg.b);
  }

  // Background
  if (cell.bg === 'default') {
    sgr.push(49);
  } else if (typeof cell.bg === 'number') {
    sgr.push(48, 5, cell.bg);
  } else {
    sgr.push(48, 2, cell.bg.r, cell.bg.g, cell.bg.b);
  }

  return sgr.join(';');
}

export function colorEquals(a: TermkitColor, b: TermkitColor): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && typeof b === 'object') {
    return a.r === b.r && a.g === b.g && a.b === b.b;
  }
  return false;
}

export function cellStyleEquals(a: TranslatedCell, b: TranslatedCell): boolean {
  return (
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.strikethrough === b.strikethrough &&
    colorEquals(a.fg, b.fg) &&
    colorEquals(a.bg, b.bg)
  );
}

/**
 * Renders a row by batching consecutive same-styled cells into runs.
 * Skips SGR output when the run's style matches the last emitted style
 * (Option C). Returns the style of the last emitted run for cross-row
 * carry-over.
 */
function renderRow(term: TerminalKit, row: TranslatedCell[], lastStyle: TranslatedCell | null): void {
  let prevStyle = lastStyle;
  let i = 0;
  while (i < row.length) {
    // Find the end of the current same-style run
    let j = i + 1;
    while (j < row.length && cellStyleEquals(row[i], row[j])) {
      j++;
    }

    // Collect characters for this run
    let chars = '';
    for (let k = i; k < j; k++) {
      chars += row[k].char;
    }

    // Only emit SGR if the style changed from the last emitted style
    if (prevStyle && cellStyleEquals(prevStyle, row[i])) {
      term.noFormat(chars);
    } else {
      term.noFormat(`\x1b[${buildSgrSequence(row[i])}m${chars}`);
    }

    prevStyle = row[i];
    i = j;
  }
}

/**
 * Formats tool call arguments into packed display lines.
 * Each line contains as many `key: value` pairs as fit within maxWidth,
 * separated by double spaces.
 */
function formatArgLines(args: Record<string, unknown>, maxWidth: number): string[] {
  const entries = Object.entries(args);
  if (entries.length === 0) return [];

  const lines: string[] = [];
  let currentLine = '';

  for (const [key, value] of entries) {
    const formatted = formatArgValue(value);
    const pair = `${key}: ${formatted}`;

    if (currentLine.length === 0) {
      currentLine = pair;
    } else if (currentLine.length + 2 + pair.length <= maxWidth) {
      currentLine += '  ' + pair;
    } else {
      lines.push(truncate(currentLine, maxWidth));
      currentLine = pair;
    }
  }

  if (currentLine.length > 0) {
    lines.push(truncate(currentLine, maxWidth));
  }

  return lines;
}

function formatArgValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return String(value);
  return JSON.stringify(value);
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}
