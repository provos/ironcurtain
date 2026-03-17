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
import {
  calculateLayout,
  isPickerMode,
  isBottomPanelPicker,
  type InputMode,
  type Layout,
  type MuxTab,
} from './types.js';
import type { ListenerState } from '../escalation/listener-state.js';
import type { PickerState, ResumePickerState, PersonaPickerState, EscalationPickerState } from './mux-input-handler.js';
import { createSplashScreen, type SplashScreen } from './mux-splash.js';
import { formatRelativeTime } from './session-scanner.js';

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

/** A visual line produced by soft-wrapping the input buffer. */
export interface VisualLine {
  /** Content of this visual line (no trailing \n). */
  readonly text: string;
  /** Character offset in the original buffer where this visual line starts. */
  readonly bufferOffset: number;
}

/**
 * Splits the input buffer into visual lines by honoring hard newlines
 * and soft-wrapping at `contentWidth` characters.
 */
export function computeVisualLines(buffer: string, contentWidth: number): VisualLine[] {
  if (buffer.length === 0) {
    return [{ text: '', bufferOffset: 0 }];
  }

  const width = Math.max(1, contentWidth);
  const result: VisualLine[] = [];
  const logicalLines = buffer.split('\n');
  let offset = 0;

  for (let i = 0; i < logicalLines.length; i++) {
    const line = logicalLines[i];
    if (line.length === 0) {
      result.push({ text: '', bufferOffset: offset });
    } else {
      for (let j = 0; j < line.length; j += width) {
        result.push({ text: line.slice(j, j + width), bufferOffset: offset + j });
      }
    }
    // Account for the \n character between logical lines
    offset += line.length + 1;
  }

  return result;
}

/**
 * Maps a buffer cursor position to a visual row and column
 * within the visual lines array.
 */
export function cursorToVisualPosition(lines: VisualLine[], cursorPos: number): { row: number; col: number } {
  // Walk backwards through lines to find the last one whose bufferOffset <= cursorPos
  // and where cursorPos <= bufferOffset + text.length.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.bufferOffset <= cursorPos && cursorPos <= line.bufferOffset + line.text.length) {
      return { row: i, col: cursorPos - line.bufferOffset };
    }
  }
  // Fallback: end of last line
  const last = lines[lines.length - 1];
  return { row: lines.length - 1, col: last.text.length };
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
  getResumePickerState: () => ResumePickerState | null;
  getPersonaPickerState: () => PersonaPickerState | null;
  getEscalationPickerState: () => EscalationPickerState | null;
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

  // Splash screen (shown when no tabs exist)
  let _splash: SplashScreen | null = null;

  // Multiline input scroll offset (first visible visual line index)
  let _inputScrollOffset = 0;

  // Cached visual lines from recalcLayout(), reused by drawCommandOverlay()
  let _cachedVisualLines: VisualLine[] = [{ text: '', bufferOffset: 0 }];

  // Transient flash message
  let _flashMessage: string | null = null;
  let _flashTimeout: ReturnType<typeof setTimeout> | null = null;
  const FLASH_DURATION_MS = 3000;

  /** Content width for the input area: _cols minus 2-char left margin minus 2-char prompt prefix. */
  function contentWidth(): number {
    return Math.max(1, _cols - 4);
  }

  function recalcLayout(): void {
    if (deps.getMode() === 'command') {
      _cachedVisualLines = computeVisualLines(deps.getInputBuffer(), contentWidth());
    } else {
      _cachedVisualLines = [{ text: '', bufferOffset: 0 }];
      _inputScrollOffset = 0;
    }
    _layout = calculateLayout(_rows, deps.getMode(), deps.getPendingCount(), _cachedVisualLines.length);
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

  function tearDownSplash(): void {
    if (_splash) {
      _splash.stop();
      _splash = null;
    }
  }

  /** Returns the number of viewport rows reserved by the current overlay. */
  function activeOverlayRows(): number {
    const mode = deps.getMode();
    if (mode === 'command') return _layout.overlayRows;
    // Escalation picker floats over the full viewport -- no rows reserved.
    if (isBottomPanelPicker(mode)) return _layout.pickerRows;
    return 0;
  }

  function drawPtyViewport(): void {
    const activeTab = deps.getActiveTab();
    if (!activeTab) {
      if (deps.getTabs().length === 0) {
        const reserved = activeOverlayRows();
        // Lazily create and start the splash screen
        if (!_splash) {
          _splash = createSplashScreen(term, _cols, _layout.ptyViewportRows, _layout.ptyViewportY, reserved);
          _splash.start();
        } else {
          // Update reserved rows in case mode changed (e.g. command -> picker)
          _splash.resize(_cols, _layout.ptyViewportRows, _layout.ptyViewportY, reserved);
        }
        _splash.draw();
      } else {
        tearDownSplash();
        for (let y = _layout.ptyViewportY; y < _layout.ptyViewportY + _layout.ptyViewportRows; y++) {
          clearLine(y);
        }
      }
      return;
    }

    tearDownSplash();

    const xtermTerminal = activeTab.bridge.terminal;
    const baseY = xtermTerminal.buffer.active.baseY;
    const scrollOffset = deps.getScrollOffset();
    const readFrom = scrollOffset ?? baseY;
    const cells = readTerminalBuffer(xtermTerminal, readFrom, _layout.ptyViewportRows, _cols);

    // Determine how many rows to render (skip overlay in command/bottom-panel picker mode).
    // Escalation picker floats over the full viewport -- no rows subtracted.
    const mode = deps.getMode();
    let visibleRows = _layout.ptyViewportRows;
    if (mode === 'command') visibleRows -= _layout.overlayRows;
    else if (isBottomPanelPicker(mode)) visibleRows -= _layout.pickerRows;

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
            ` command mode \u00b7 ${pendingCount} escalation${pendingCount !== 1 ? 's' : ''} pending \u2014 Ctrl-E to review`,
          );
        } else {
          term.dim(' command mode \u00b7 type a message to enable auto-approver \u00b7 Shift+drag to select');
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
      term.dim(' clear');
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

        // Whitelist candidate line (shows what /approve+ would whitelist)
        if (
          rowsUsed < _layout.escalationPanelRows &&
          esc.request.whitelistCandidates &&
          esc.request.whitelistCandidates.length > 0
        ) {
          const candidate = esc.request.whitelistCandidates[0];
          clearLine(currentY);
          moveTo(6, currentY);
          term.dim('/approve+ ');
          term.cyan(candidate.description);
          if (candidate.warning) {
            term.yellow(` (${candidate.warning})`);
          }
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
      term.cyan('/approve+');
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
      term.cyan('/resume');
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

    // Multiline input area (visual lines cached by recalcLayout)
    const cp = deps.getCursorPos();
    const visualLines = _cachedVisualLines;
    const cursorVis = cursorToVisualPosition(visualLines, cp);
    const allocatedRows = _layout.inputLineRows;

    // Adjust scroll to keep cursor visible
    if (cursorVis.row < _inputScrollOffset) {
      _inputScrollOffset = cursorVis.row;
    } else if (cursorVis.row >= _inputScrollOffset + allocatedRows) {
      _inputScrollOffset = cursorVis.row - allocatedRows + 1;
    }

    // Render each visible visual line
    for (let i = 0; i < allocatedRows; i++) {
      const visLineIdx = _inputScrollOffset + i;
      clearLine(currentY);
      moveTo(2, currentY);

      // Prompt: "> " on the first visual line, "  " on continuation lines
      if (visLineIdx === 0) {
        term('> ');
      } else {
        term('  ');
      }

      if (visLineIdx < visualLines.length) {
        const vLine = visualLines[visLineIdx];
        if (visLineIdx === cursorVis.row) {
          // This line contains the cursor
          term(vLine.text.slice(0, cursorVis.col));
          term.bgWhite.black(cursorVis.col < vLine.text.length ? vLine.text[cursorVis.col] : ' ');
          term.styleReset();
          term(vLine.text.slice(cursorVis.col + 1));
        } else {
          term(vLine.text);
        }
      } else if (i === 0) {
        // Empty buffer: show cursor on blank line
        term.bgWhite.black(' ');
        term.styleReset();
      }

      term.eraseLineAfter();
      currentY++;
    }

    // Position real terminal cursor for accessibility
    const cursorScreenRow = startY + _layout.escalationPanelRows + 1 + (cursorVis.row - _inputScrollOffset);
    moveTo(2 + 2 + cursorVis.col, cursorScreenRow);
  }

  /**
   * Draws a single row of the escalation dialog box at the given screen
   * position, wrapped in box-drawing side borders. Content is rendered
   * by the `renderContent` callback which receives the inner width.
   */
  function drawBoxRow(y: number, boxX: number, innerWidth: number, renderContent: (w: number) => void): void {
    moveTo(boxX, y);
    term.brightCyan('\u2502');
    term(' ');
    renderContent(innerWidth);
    // Pad to fill the inner width, then close with right border
    term.eraseLineAfter(); // clear rest first
    moveTo(boxX + innerWidth + 2, y);
    term(' ');
    term.brightCyan('\u2502');
    term.eraseLineAfter();
  }

  function drawEscalationPickerOverlay(): void {
    const eps = deps.getEscalationPickerState();
    if (!eps) return;

    const pending = deps.getEscalationState().pendingEscalations;
    const sortedEscalations = [...pending.values()].sort((a, b) => a.displayNumber - b.displayNumber);
    if (sortedEscalations.length === 0) return;

    const focused = pending.get(eps.focusedDisplayNumber);
    if (!focused) return;

    // Compute dialog dimensions -- centered in the PTY viewport
    const viewportRows = _layout.ptyViewportRows;
    const viewportY = _layout.ptyViewportY;

    // Content rows: tab bar + separator + header + separator + detail area + separator + hint bar
    const minContentRows = 7; // minimum: tab + sep + header + sep + 1 detail + sep + hints
    const maxContentRows = Math.max(minContentRows, viewportRows - 4); // leave 2 rows margin top+bottom
    const detailBudget = maxContentRows - 6; // 6 = tab bar + 2 separators + header + separator + hint bar

    // Collect detail lines to determine actual height needed
    const argLines = formatArgLines(focused.request.arguments, _cols - 12);
    const detailLines: Array<{ kind: 'label' | 'arg' | 'reason' | 'whitelist'; text: string }> = [];

    if (argLines.length > 0) {
      detailLines.push({ kind: 'label', text: 'Arguments:' });
      for (const line of argLines) {
        detailLines.push({ kind: 'arg', text: line });
      }
    }
    detailLines.push({ kind: 'reason', text: `Reason: ${focused.request.reason}` });
    if (focused.request.whitelistCandidates && focused.request.whitelistCandidates.length > 0) {
      const candidate = focused.request.whitelistCandidates[0];
      const wlText = candidate.warning ? `${candidate.description} (${candidate.warning})` : candidate.description;
      detailLines.push({ kind: 'whitelist', text: `/approve+ ${wlText}` });
    }

    const actualDetailRows = Math.min(detailLines.length, detailBudget);
    const totalBoxRows = 6 + actualDetailRows; // includes top+bottom border
    const totalBoxHeight = totalBoxRows + 2; // +2 for top and bottom border lines

    if (totalBoxHeight > viewportRows) return; // terminal too small

    // Vertical centering within the viewport
    const startY = viewportY + Math.max(0, Math.floor((viewportRows - totalBoxHeight) / 2));

    // Horizontal sizing: leave 3-column margin on each side, max 80 inner width
    const boxMargin = 3;
    const maxInnerWidth = 80;
    const innerWidth = Math.min(maxInnerWidth, Math.max(20, _cols - boxMargin * 2 - 4));
    const boxWidth = innerWidth + 4; // 4 = border + space on each side
    const boxX = Math.max(0, Math.floor((_cols - boxWidth) / 2));

    let currentY = startY;

    // Top border with title
    moveTo(boxX, currentY);
    const title = ' Escalation ';
    const borderAfterTitle = Math.max(0, boxWidth - 2 - title.length);
    term.brightCyan('\u250c' + title);
    term.brightCyan('\u2500'.repeat(borderAfterTitle) + '\u2510');
    term.styleReset();
    currentY++;

    // Escalation tab bar
    drawBoxRow(currentY, boxX, innerWidth, (w) => {
      let written = 0;
      for (const esc of sortedEscalations) {
        const isFocused = esc.displayNumber === eps.focusedDisplayNumber;
        const label = `[${esc.displayNumber}] ${esc.request.serverName}/${esc.request.toolName}`;
        if (written + label.length + 2 > w) break;
        if (isFocused) {
          term.bgCyan.black(' ' + label + ' ');
          term.styleReset();
        } else {
          term.dim(' ' + label + ' ');
          term.styleReset();
        }
        written += label.length + 2;
      }
      const pad = Math.max(0, w - written);
      if (pad > 0) term(' '.repeat(pad));
    });
    currentY++;

    // Separator
    drawBoxRow(currentY, boxX, innerWidth, (w) => {
      term.dim('\u2500'.repeat(w));
      term.styleReset();
    });
    currentY++;

    // Tool header
    drawBoxRow(currentY, boxX, innerWidth, (w) => {
      const timeAgo = formatTimeSince(focused.receivedAt);
      const headerText = `Session #${focused.sessionDisplayNumber}  ${focused.request.serverName}/${focused.request.toolName}  ${timeAgo}`;
      // Render with colors using terminal-kit chaining
      term(`Session #${focused.sessionDisplayNumber}  `);
      term.cyan(`${focused.request.serverName}/${focused.request.toolName}`);
      term.dim(`  ${timeAgo}`);
      // Pad remainder
      const textLen = headerText.length;
      const pad = Math.max(0, w - textLen);
      if (pad > 0) term(' '.repeat(pad));
    });
    currentY++;

    // Separator
    drawBoxRow(currentY, boxX, innerWidth, (w) => {
      term.dim('\u2500'.repeat(w));
      term.styleReset();
    });
    currentY++;

    // Detail rows
    for (let i = 0; i < actualDetailRows; i++) {
      const detail = detailLines[i];
      drawBoxRow(currentY, boxX, innerWidth, (w) => {
        const indent = detail.kind === 'arg' ? 2 : 0;
        const maxTextWidth = w - indent;
        const text = truncate(detail.text, maxTextWidth);
        if (indent > 0) term(' '.repeat(indent));
        if (detail.kind === 'label') {
          term.dim(text);
        } else if (detail.kind === 'reason') {
          // Render "Reason: " dim, rest normal
          term.dim('Reason: ');
          term.styleReset();
          term(truncate(focused.request.reason, maxTextWidth - 8));
        } else if (detail.kind === 'whitelist') {
          term.dim('/approve+ ');
          term.styleReset();
          const candidate = focused.request.whitelistCandidates?.[0];
          if (candidate) {
            term.cyan(truncate(candidate.description, maxTextWidth - 10));
            if (candidate.warning) {
              term.yellow(` (${candidate.warning})`);
            }
          }
        } else {
          term(text);
        }
        term.styleReset();
        // Pad to fill -- compute remaining based on what was written
        const writtenLen = indent + text.length;
        const pad = Math.max(0, w - writtenLen);
        if (pad > 0) term(' '.repeat(pad));
      });
      currentY++;
    }

    // Separator before hint bar
    drawBoxRow(currentY, boxX, innerWidth, (w) => {
      term.dim('\u2500'.repeat(w));
      term.styleReset();
    });
    currentY++;

    // Hint bar
    drawBoxRow(currentY, boxX, innerWidth, () => {
      term.bgWhite.black(' a ');
      term.styleReset();
      term.dim(' approve ');
      term.bgWhite.black(' d ');
      term.styleReset();
      term.dim(' deny ');
      term.bgWhite.black(' w ');
      term.styleReset();
      term.dim(' approve+ ');
      if (sortedEscalations.length > 1) {
        term.bgWhite.black(' A ');
        term.styleReset();
        term.dim(' all ');
        term.bgWhite.black(' D ');
        term.styleReset();
        term.dim(' deny all ');
        term.bgWhite.black(' \u2190\u2192 ');
        term.styleReset();
        term.dim(' switch ');
      }
      term.bgWhite.black(' Esc ');
      term.styleReset();
      term.dim(' dismiss');
    });
    currentY++;

    // Bottom border
    moveTo(boxX, currentY);
    term.brightCyan('\u2514' + '\u2500'.repeat(boxWidth - 2) + '\u2518');
    term.styleReset();
  }

  function drawActiveOverlay(): void {
    const mode = deps.getMode();
    if (mode === 'command') {
      drawCommandOverlay();
    } else if (mode === 'picker') {
      drawPickerOverlay();
    } else if (mode === 'resume-picker') {
      drawResumePickerOverlay();
    } else if (mode === 'persona-picker') {
      drawPersonaPickerOverlay();
    } else if (mode === 'escalation-picker') {
      drawEscalationPickerOverlay();
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
    const hasPersonas = ps.menuItemCount >= 3;
    const menuHeight = hasPersonas ? 5 : 4;
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
    if (hasPersonas) {
      drawMenuOption(y0 + 3, ' Use a persona', ps.menuSelection === 2, boxWidth);
    }

    // Bottom border
    const bottomY = hasPersonas ? y0 + 4 : y0 + 3;
    clearLine(bottomY);
    moveTo(2, bottomY);
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

  function drawResumePickerOverlay(): void {
    const rps = deps.getResumePickerState();
    if (!rps) return;

    const startY = _layout.pickerY;
    const totalRows = _layout.pickerRows;
    if (totalRows < 3) return;

    let currentY = startY;

    // Title
    clearLine(currentY);
    moveTo(2, currentY);
    term.cyan('/resume');
    term.dim(' \u2014 select a session to resume');
    term.eraseLineAfter();
    currentY++;

    if (rps.sessions.length === 0) {
      clearLine(currentY);
      moveTo(4, currentY);
      term.dim('No resumable sessions found');
      term.eraseLineAfter();
      currentY++;

      for (let y = currentY; y < startY + totalRows; y++) {
        clearLine(y);
      }
      return;
    }

    // Session list
    const listRows = Math.max(0, totalRows - 2); // title + hint bar

    // Scroll adjustment (render-time only; do not mutate rps)
    let scrollOffset = rps.scrollOffset;
    if (rps.selectedIndex < scrollOffset) {
      scrollOffset = rps.selectedIndex;
    } else if (rps.selectedIndex >= scrollOffset + listRows) {
      scrollOffset = rps.selectedIndex - listRows + 1;
    }

    for (let i = 0; i < listRows; i++) {
      clearLine(currentY);
      const idx = scrollOffset + i;
      if (idx < rps.sessions.length) {
        const s = rps.sessions[idx];
        const isSelected = idx === rps.selectedIndex;
        const shortId = s.sessionId.substring(0, 8);
        const timeAgo = formatRelativeTime(s.lastActivity);
        const line = `${shortId}  ${s.agent}  ${s.label}  ${timeAgo}  [${s.status}]`;

        moveTo(2, currentY);
        if (isSelected) {
          term.bgCyan.black('> ' + truncate(line, Math.max(1, _cols - 6)));
          term.styleReset();
        } else {
          term('  ');
          term.dim(shortId);
          term('  ');
          term(s.agent);
          term('  ');
          term.cyan(truncate(s.label, Math.max(10, _cols - 50)));
          term('  ');
          term.dim(timeAgo);
          term('  ');
          term.dim(`[${s.status}]`);
        }
      }
      term.eraseLineAfter();
      currentY++;
    }

    // Hint bar
    clearLine(currentY);
    moveTo(2, currentY);
    term.bgWhite.black(' Enter ');
    term.styleReset();
    term.dim(' resume  ');
    term.bgWhite.black(' Esc ');
    term.styleReset();
    term.dim(' cancel');
    term.styleReset();
    term.eraseLineAfter();
  }

  function drawPersonaPickerOverlay(): void {
    const pps = deps.getPersonaPickerState();
    if (!pps) return;

    const startY = _layout.pickerY;
    const totalRows = _layout.pickerRows;
    if (totalRows < 3) return;

    let currentY = startY;

    // Title
    clearLine(currentY);
    moveTo(2, currentY);
    term.cyan('/new');
    term.dim(' \u2014 select a persona');
    term.eraseLineAfter();
    currentY++;

    if (pps.personas.length === 0) {
      clearLine(currentY);
      moveTo(4, currentY);
      term.dim('No personas found');
      term.eraseLineAfter();
      currentY++;

      for (let y = currentY; y < startY + totalRows; y++) {
        clearLine(y);
      }
      return;
    }

    // Persona list
    const listRows = Math.max(0, totalRows - 2); // title + hint bar

    // Scroll adjustment
    let scrollOffset = pps.scrollOffset;
    if (pps.selectedIndex < scrollOffset) {
      scrollOffset = pps.selectedIndex;
    } else if (pps.selectedIndex >= scrollOffset + listRows) {
      scrollOffset = pps.selectedIndex - listRows + 1;
    }

    for (let i = 0; i < listRows; i++) {
      clearLine(currentY);
      const idx = scrollOffset + i;
      if (idx < pps.personas.length) {
        const p = pps.personas[idx];
        const isSelected = idx === pps.selectedIndex;
        const status = p.compiled ? '' : ' [not compiled]';
        const desc = truncate(p.description, Math.max(10, _cols - p.name.length - status.length - 10));
        const line = `${p.name}  ${desc}${status}`;

        moveTo(2, currentY);
        if (isSelected) {
          term.bgCyan.black('> ' + truncate(line, Math.max(1, _cols - 6)));
          term.styleReset();
        } else {
          term('  ');
          if (p.compiled) {
            term.cyan(p.name);
          } else {
            term.dim(p.name);
          }
          term('  ');
          term.dim(desc);
          if (!p.compiled) {
            term.yellow(status);
          }
        }
      }
      term.eraseLineAfter();
      currentY++;
    }

    // Hint bar
    clearLine(currentY);
    moveTo(2, currentY);
    term.bgWhite.black(' Enter ');
    term.styleReset();
    term.dim(' spawn  ');
    term.bgWhite.black(' Esc ');
    term.styleReset();
    term.dim(' cancel');
    term.styleReset();
    term.eraseLineAfter();
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
      if (mode === 'command' || isPickerMode(mode)) {
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
      _splash?.resize(_cols, _layout.ptyViewportRows, _layout.ptyViewportY, activeOverlayRows());
    },

    destroy(): void {
      tearDownSplash();
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
 * Appends SGR color parameters for a single color slot (fg or bg).
 * `base` is 38 for foreground, 48 for background; the default-color
 * reset code is always base+1 (39 / 49).
 */
function pushColorSgr(sgr: number[], color: TermkitColor, base: 38 | 48): void {
  if (color === 'default') {
    sgr.push(base + 1);
  } else if (typeof color === 'number') {
    sgr.push(base, 5, color);
  } else {
    sgr.push(base, 2, color.r, color.g, color.b);
  }
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

  pushColorSgr(sgr, cell.fg, 38);
  pushColorSgr(sgr, cell.bg, 48);

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

function formatTimeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
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
