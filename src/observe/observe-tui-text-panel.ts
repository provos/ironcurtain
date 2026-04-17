/**
 * Text panel for the observe TUI.
 *
 * Manages a ring buffer of pre-formatted ANSI lines, handles
 * per-session text_delta accumulation with word wrapping, and
 * renders the visible viewport for the right-hand panel.
 *
 * Supports tool input accumulation (rendering compact summaries
 * instead of raw JSON fragments), thinking text extraction from
 * raw SSE events, and filtering of zero-value protocol events.
 *
 * Depends on observe-tui-types.ts, mux-renderer.ts (truncate), and Node built-ins.
 */

import type { TokenStreamEvent } from '../docker/token-stream-types.js';
import { truncate } from '../mux/mux-renderer.js';
import {
  type PanelLine,
  type SessionPartialLine,
  type ToolAccumulator,
  SGR,
  SUPPRESSED_RAW_EVENTS,
  TEXT_BUFFER_CAPACITY,
  sessionColor,
  visibleLength,
} from './observe-tui-types.js';

// ---------------------------------------------------------------------------
// TextPanel interface
// ---------------------------------------------------------------------------

/** Options controlling event formatting. */
export interface TextPanelOptions {
  /** Show all event kinds, not just text_delta and error. */
  readonly raw: boolean;
  /** Prefix lines with session labels (multi-session mode). */
  readonly showLabel: boolean;
  /** Show absolutely all events including protocol noise. Implies raw. */
  readonly debug: boolean;
}

/** Public interface for the text panel. */
export interface TextPanel {
  /** Append a formatted event to the panel. */
  appendEvent(label: number, event: TokenStreamEvent, options: TextPanelOptions): void;
  /** Render the visible portion of the panel. Returns ANSI string. */
  render(): string;
  /** Update dimensions after terminal resize. New lines use the updated width. */
  resize(startCol: number, cols: number, rows: number): void;
  /** Mark a session as ended with a separator line. */
  sessionEnded(label: number, reason: string, showLabel: boolean): void;
  /** Add a connection-lost error marker. */
  connectionLost(reason: string): void;
  /** Flush any pending tool accumulator for the given session. */
  flushToolAccumulator(label: number, showLabel: boolean): void;
  /** Total lines in the buffer (for status bar). */
  readonly lineCount: number;
}

// ---------------------------------------------------------------------------
// Line formatting helpers
// ---------------------------------------------------------------------------

/** Build the session label prefix string (e.g. "[3] " in session color). */
function buildLabelPrefix(label: number): string {
  return `${sessionColor(label)}[${label}] ${SGR.RESET}`;
}

/** Visible width of a label prefix (e.g. "[3] " = 4 chars). */
function labelPrefixWidth(label: number): number {
  return `[${label}] `.length;
}

/** Returns the ANSI prefix and its visible width for a session label. */
function labelInfo(label: number, showLabel: boolean): { prefix: string; prefixWidth: number } {
  return showLabel
    ? { prefix: buildLabelPrefix(label), prefixWidth: labelPrefixWidth(label) }
    : { prefix: '', prefixWidth: 0 };
}

/** Create a PanelLine from an ANSI-formatted string. */
function makeLine(ansi: string): PanelLine {
  return { ansi, plainLen: visibleLength(ansi) };
}

/** Build a centered separator like "---- model ----" with optional label prefix. */
function buildCenteredSeparator(prefix: string, inner: string, textCols: number, prefixWidth: number): PanelLine {
  const dashCount = Math.max(0, textCols - prefixWidth - inner.length);
  const leftDashes = Math.floor(dashCount / 2);
  const rightDashes = dashCount - leftDashes;
  const separator = '\u2500'.repeat(leftDashes) + inner + '\u2500'.repeat(rightDashes);
  const ansi = `${prefix}${SGR.TEXT_SEPARATOR}${separator}${SGR.RESET}`;
  return makeLine(ansi);
}

// ---------------------------------------------------------------------------
// Word wrapping
// ---------------------------------------------------------------------------

/**
 * Word-wrap a plain text string at the given width.
 * Returns an array of plain-text lines (no ANSI codes).
 *
 * - Breaks at the last space before the limit.
 * - Hard-breaks if no space is found (e.g. long URLs).
 */
function wordWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  if (text.length <= width) return [text];

  const lines: string[] = [];
  let remaining = text;

  while (remaining.length > width) {
    // Find the last space within the width limit
    let breakIdx = remaining.lastIndexOf(' ', width);
    if (breakIdx <= 0) {
      // No space found: hard-break at width
      breakIdx = width;
    }
    lines.push(remaining.slice(0, breakIdx));
    // Skip the space at the break point if we broke on a space
    remaining = remaining[breakIdx] === ' ' ? remaining.slice(breakIdx + 1) : remaining.slice(breakIdx);
  }
  if (remaining.length > 0) {
    lines.push(remaining);
  }
  return lines;
}

/**
 * Wrap a finalized line with optional label prefix and configurable color.
 *
 * The first visual line gets the label prefix.
 * Continuation lines are indented by the label width but have no prefix.
 */
function wrapFinalizedLine(
  text: string,
  textCols: number,
  showLabel: boolean,
  label: number,
  color: string = SGR.TEXT_NORMAL,
): PanelLine[] {
  const { prefix, prefixWidth } = labelInfo(label, showLabel);
  const contentWidth = textCols - prefixWidth;

  if (contentWidth <= 0) {
    // Terminal is too narrow for any content
    return [makeLine(prefix)];
  }

  const wrappedPlain = wordWrap(text, contentWidth);
  const result: PanelLine[] = [];

  for (let i = 0; i < wrappedPlain.length; i++) {
    if (i === 0) {
      const ansi = `${prefix}${color}${wrappedPlain[i]}${SGR.RESET}`;
      result.push(makeLine(ansi));
    } else {
      // Continuation line: indent by label width, no prefix
      const indent = ' '.repeat(prefixWidth);
      const ansi = `${indent}${color}${wrappedPlain[i]}${SGR.RESET}`;
      result.push(makeLine(ansi));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Thinking text extraction
// ---------------------------------------------------------------------------

/**
 * Extract thinking text from a content_block_delta raw event.
 * Returns the thinking string, or null if the event is not a thinking delta.
 */
export function extractThinkingText(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const delta = parsed['delta'] as Record<string, unknown> | undefined;
    if (delta && delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
      return delta['thinking'];
    }
  } catch {
    // Not JSON or wrong shape -- not a thinking delta
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool accumulator flush rendering
// ---------------------------------------------------------------------------

/** Maximum value length in compact key=value rendering. */
const MAX_KV_VALUE_LEN = 40;

/**
 * Render a compact key=value summary for a tool's parsed input JSON.
 * Each key-value pair is formatted as key=value, joined with " | ".
 */
function renderCompactToolInput(
  toolName: string,
  input: Record<string, unknown>,
  textCols: number,
  prefixWidth: number,
): PanelLine[] {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const valStr = typeof value === 'string' ? value : JSON.stringify(value);
    const truncVal = truncate(valStr, MAX_KV_VALUE_LEN);
    pairs.push(`${key}=${truncVal}`);
  }
  const summary = pairs.join(' | ');
  const headerText = `\u25B8 ${toolName}`;
  const available = textCols - prefixWidth - visibleLength(headerText) - 2;
  const truncSummary = available > 0 ? '  ' + truncate(summary, available) : '';
  return [makeLine(headerText + truncSummary)];
}

/**
 * Render execute_code tool input as a multi-line code block.
 * Extracts the "code" field from the parsed JSON.
 */
function renderExecuteCodeInput(
  input: Record<string, unknown>,
  textCols: number,
  label: number,
  showLabel: boolean,
): PanelLine[] {
  const { prefix, prefixWidth } = labelInfo(label, showLabel);
  const lines: PanelLine[] = [];

  // Header line
  const headerAnsi = `${prefix}${SGR.TEXT_TOOL}\u25B8 execute_code${SGR.RESET}`;
  lines.push(makeLine(headerAnsi));

  // Extract code field
  const code = typeof input['code'] === 'string' ? input['code'] : null;
  if (!code) return lines;

  const contentWidth = textCols - prefixWidth - 2; // 2-space indent
  if (contentWidth <= 0) return lines;

  const codeLines = code.split('\n');
  for (const codeLine of codeLines) {
    const wrapped = wordWrap(codeLine, contentWidth);
    for (const wl of wrapped) {
      const indent = ' '.repeat(prefixWidth) + '  ';
      const ansi = `${indent}${SGR.TEXT_TOOL_DIM}${wl}${SGR.RESET}`;
      lines.push(makeLine(ansi));
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity ring buffer with front-eviction.
 * Stores PanelLine items for the text panel viewport.
 */
class LineRingBuffer {
  private readonly buf: Array<PanelLine | undefined>;
  private head = 0;
  private _size = 0;

  constructor(readonly capacity: number) {
    this.buf = new Array<PanelLine | undefined>(capacity);
  }

  get size(): number {
    return this._size;
  }

  /** Append a line, evicting the oldest if at capacity. */
  push(line: PanelLine): void {
    const writeIdx = (this.head + this._size) % this.capacity;
    this.buf[writeIdx] = line;

    if (this._size === this.capacity) {
      // Evict oldest by advancing head
      this.head = (this.head + 1) % this.capacity;
    } else {
      this._size++;
    }
  }

  /** Get line at logical index (0 = oldest visible line). */
  get(index: number): PanelLine | undefined {
    if (index < 0 || index >= this._size) return undefined;
    return this.buf[(this.head + index) % this.capacity];
  }

  /** Return all lines as an array (oldest first). Used for resize re-wrapping. */
  toArray(): PanelLine[] {
    const result: PanelLine[] = [];
    for (let i = 0; i < this._size; i++) {
      const line = this.buf[(this.head + i) % this.capacity];
      if (line) result.push(line);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// TextPanel factory
// ---------------------------------------------------------------------------

export function createTextPanel(startCol: number, textCols: number, textRows: number): TextPanel {
  let _startCol = startCol;
  let _textCols = textCols;
  let _textRows = textRows;

  const lines = new LineRingBuffer(TEXT_BUFFER_CAPACITY);
  const partials = new Map<number, SessionPartialLine>();
  const thinkingPartials = new Map<number, SessionPartialLine>();
  const toolAccumulators = new Map<number, ToolAccumulator>();

  // ------------------------------------------------------------------
  // Partial line management
  // ------------------------------------------------------------------

  function getOrCreatePartial(
    map: Map<number, SessionPartialLine>,
    label: number,
    showLabel: boolean,
  ): SessionPartialLine {
    let partial = map.get(label);
    if (!partial) {
      partial = {
        buffer: '',
        prefix: showLabel ? buildLabelPrefix(label) : '',
      };
      map.set(label, partial);
    }
    return partial;
  }

  function finalizePartial(
    map: Map<number, SessionPartialLine>,
    label: number,
    showLabel: boolean,
    color: string = SGR.TEXT_NORMAL,
  ): void {
    const partial = map.get(label);
    if (!partial || partial.buffer.length === 0) {
      map.delete(label);
      return;
    }

    const wrapped = wrapFinalizedLine(partial.buffer, _textCols, showLabel, label, color);
    for (const line of wrapped) {
      lines.push(line);
    }

    partial.buffer = '';
  }

  // ------------------------------------------------------------------
  // Tool accumulator management
  // ------------------------------------------------------------------

  function doFlushToolAccumulator(label: number, showLabel: boolean): void {
    const acc = toolAccumulators.get(label);
    if (!acc) return;
    toolAccumulators.delete(label);

    if (!acc.hasInput) return;

    const { prefix, prefixWidth } = labelInfo(label, showLabel);

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(acc.inputBuffer) as Record<string, unknown>;
    } catch {
      // JSON parse failure: show raw truncated
    }

    if (parsed && acc.toolName === 'execute_code') {
      const codeLines = renderExecuteCodeInput(parsed, _textCols, label, showLabel);
      // Replace the "working..." line: we already pushed a header, now add code
      for (const line of codeLines) {
        lines.push(line);
      }
      return;
    }

    if (parsed) {
      const compactLines = renderCompactToolInput(acc.toolName, parsed, _textCols, prefixWidth);
      for (const cl of compactLines) {
        const ansi = `${prefix}${SGR.TEXT_TOOL}${cl.ansi}${SGR.RESET}`;
        lines.push(makeLine(ansi));
      }
      return;
    }

    // Fallback: raw accumulated string
    const available = _textCols - prefixWidth;
    const truncStr = available > 0 ? truncate(acc.inputBuffer, available) : '';
    const ansi = `${prefix}${SGR.TEXT_TOOL_DIM}${truncStr}${SGR.RESET}`;
    lines.push(makeLine(ansi));
  }

  // ------------------------------------------------------------------
  // Event handlers
  // ------------------------------------------------------------------

  /**
   * Shared handler for streaming text deltas (both regular text and thinking).
   * Flushes the alternate partial map, appends to the primary, and word-wraps
   * completed lines.
   */
  function handleStreamDelta(
    label: number,
    text: string,
    showLabel: boolean,
    primaryMap: Map<number, SessionPartialLine>,
    alternateMap: Map<number, SessionPartialLine>,
    color?: string,
  ): void {
    // Flush the alternate partial for this session (clean boundary)
    const altColor = alternateMap === thinkingPartials ? SGR.TEXT_THINKING : SGR.TEXT_NORMAL;
    finalizePartial(alternateMap, label, showLabel, altColor);

    const partial = getOrCreatePartial(primaryMap, label, showLabel);
    const segments = text.split('\n');

    // Append first segment to current partial
    partial.buffer += segments[0];

    if (segments.length > 1) {
      // Finalize current partial line
      finalizePartial(primaryMap, label, showLabel, color);

      // Push middle segments as complete lines
      for (let i = 1; i < segments.length - 1; i++) {
        const wrapped = wrapFinalizedLine(segments[i], _textCols, showLabel, label, color);
        for (const line of wrapped) {
          lines.push(line);
        }
      }

      // Last segment becomes new partial
      const newPartial = getOrCreatePartial(primaryMap, label, showLabel);
      newPartial.buffer = segments[segments.length - 1];
    }
  }

  function handleTextDelta(label: number, text: string, showLabel: boolean): void {
    handleStreamDelta(label, text, showLabel, partials, thinkingPartials);
  }

  function handleToolUse(label: number, toolName: string, inputDelta: string, showLabel: boolean): void {
    let acc = toolAccumulators.get(label);

    if (toolName !== '') {
      // content_block_start: new tool invocation. Flush any previous accumulator.
      doFlushToolAccumulator(label, showLabel);

      acc = { toolName, inputBuffer: '', hasInput: false };
      toolAccumulators.set(label, acc);

      // Show a "working..." indicator line
      const { prefix } = labelInfo(label, showLabel);
      const ansi = `${prefix}${SGR.TEXT_TOOL}\u25B8 ${toolName}${SGR.TEXT_DIM} working...${SGR.RESET}`;
      lines.push(makeLine(ansi));
    } else if (acc) {
      // input_json_delta: accumulate
      acc.inputBuffer += inputDelta;
      acc.hasInput = true;
    }
  }

  function handleThinkingDelta(label: number, text: string, showLabel: boolean): void {
    handleStreamDelta(label, text, showLabel, thinkingPartials, partials, SGR.TEXT_THINKING);
  }

  function handleMessageStart(label: number, model: string, showLabel: boolean): void {
    const { prefix, prefixWidth } = labelInfo(label, showLabel);
    lines.push(buildCenteredSeparator(prefix, ` ${model} `, _textCols, prefixWidth));
  }

  function handleMessageEnd(
    label: number,
    stopReason: string,
    inputTokens: number,
    outputTokens: number,
    showLabel: boolean,
  ): void {
    const { prefix, prefixWidth } = labelInfo(label, showLabel);
    lines.push(
      buildCenteredSeparator(prefix, ` ${stopReason}, ${inputTokens}+${outputTokens} tokens `, _textCols, prefixWidth),
    );
  }

  function handleError(label: number, message: string, showLabel: boolean): void {
    const { prefix } = labelInfo(label, showLabel);
    const ansi = `${prefix}${SGR.TEXT_ERROR}\u2717 ${message}${SGR.RESET}`;
    lines.push(makeLine(ansi));
  }

  function handleToolResult(label: number, content: string, isError: boolean, showLabel: boolean): void {
    const { prefix, prefixWidth } = labelInfo(label, showLabel);
    const color = isError ? SGR.TEXT_ERROR : SGR.TEXT_META;
    const icon = isError ? '\u2717' : '\u25C1';
    const headerText = `${icon} [tool_result] `;
    const available = _textCols - prefixWidth - headerText.length;
    // Show first line of content, truncated
    const firstLine = content.split('\n')[0];
    const truncContent = available > 0 ? truncate(firstLine, available) : '';
    const ansi = `${prefix}${color}${headerText}${truncContent}${SGR.RESET}`;
    lines.push(makeLine(ansi));
  }

  function handleRaw(label: number, eventType: string, data: string, showLabel: boolean): void {
    const { prefix, prefixWidth } = labelInfo(label, showLabel);
    const headerText = `[${eventType}] `;
    const availableForData = _textCols - prefixWidth - headerText.length;
    const truncatedData = availableForData > 0 ? truncate(data, availableForData) : '';

    const ansi = `${prefix}${SGR.TEXT_META}${headerText}${truncatedData}${SGR.RESET}`;
    lines.push(makeLine(ansi));
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  function renderPartialLine(partial: SessionPartialLine, color: string = SGR.TEXT_NORMAL): PanelLine | null {
    if (partial.buffer.length === 0) return null;

    const prefixWidth = visibleLength(partial.prefix);
    const contentWidth = _textCols - prefixWidth;

    // Truncate display (buffer retains full text for eventual finalization)
    const displayText = contentWidth > 0 ? truncate(partial.buffer, contentWidth) : '';
    const ansi = `${partial.prefix}${color}${displayText}${SGR.RESET}`;
    return makeLine(ansi);
  }

  // ------------------------------------------------------------------
  // Public interface
  // ------------------------------------------------------------------

  return {
    get lineCount(): number {
      return lines.size;
    },

    appendEvent(label: number, event: TokenStreamEvent, options: TextPanelOptions): void {
      // Flush tool accumulator before non-tool events
      if (event.kind !== 'tool_use') {
        doFlushToolAccumulator(label, options.showLabel);
      }

      switch (event.kind) {
        case 'text_delta':
          handleTextDelta(label, event.text, options.showLabel);
          break;

        case 'tool_use':
          if (!options.raw) return;
          handleToolUse(label, event.toolName, event.inputDelta, options.showLabel);
          break;

        case 'message_start':
          if (!options.raw) return;
          handleMessageStart(label, event.model, options.showLabel);
          break;

        case 'message_end':
          if (!options.raw) return;
          handleMessageEnd(label, event.stopReason, event.inputTokens, event.outputTokens, options.showLabel);
          break;

        case 'error':
          handleError(label, event.message, options.showLabel);
          break;

        case 'tool_result':
          // Show tool results in both raw and non-raw mode (informative)
          handleToolResult(label, event.content, event.isError, options.showLabel);
          break;

        case 'raw': {
          if (!options.raw) return;

          // Extract thinking text from content_block_delta events
          if (event.eventType === 'content_block_delta') {
            const thinkingText = extractThinkingText(event.data);
            if (thinkingText !== null) {
              handleThinkingDelta(label, thinkingText, options.showLabel);
              return;
            }
          }

          // Filter zero-value protocol events (unless in debug mode)
          if (!options.debug && SUPPRESSED_RAW_EVENTS.has(event.eventType)) {
            return;
          }

          handleRaw(label, event.eventType, event.data, options.showLabel);
          break;
        }
      }
    },

    render(): string {
      const buf: string[] = [];

      // Collect all partial lines that are active
      const activePartials: PanelLine[] = [];
      for (const partial of partials.values()) {
        const rendered = renderPartialLine(partial);
        if (rendered) activePartials.push(rendered);
      }
      for (const partial of thinkingPartials.values()) {
        const rendered = renderPartialLine(partial, SGR.TEXT_THINKING);
        if (rendered) activePartials.push(rendered);
      }

      const totalFinalized = lines.size;
      const totalWithPartials = totalFinalized + activePartials.length;

      // Determine which lines to show: last _textRows lines
      const viewStart = Math.max(0, totalWithPartials - _textRows);

      for (let row = 0; row < _textRows; row++) {
        const lineIdx = viewStart + row;
        // Position cursor: 1-indexed row, startCol + 1
        buf.push(`\x1b[${row + 1};${_startCol + 1}H\x1b[K`);

        if (lineIdx < totalFinalized) {
          const line = lines.get(lineIdx);
          if (line) buf.push(line.ansi);
        } else {
          const partialIdx = lineIdx - totalFinalized;
          if (partialIdx >= 0 && partialIdx < activePartials.length) {
            buf.push(activePartials[partialIdx].ansi);
          }
        }
      }

      buf.push(SGR.RESET);
      return buf.join('');
    },

    resize(startCol: number, cols: number, rows: number): void {
      _startCol = startCol;
      _textCols = cols;
      _textRows = rows;
    },

    sessionEnded(label: number, reason: string, showLabel: boolean): void {
      // Flush any pending partial line for this session before the end marker.
      const partial = partials.get(label);
      const hasLabel = partial !== undefined && partial.prefix.length > 0;
      finalizePartial(partials, label, hasLabel);

      // Flush thinking partials too
      finalizePartial(thinkingPartials, label, hasLabel, SGR.TEXT_THINKING);

      // Flush any pending tool accumulator
      doFlushToolAccumulator(label, showLabel);

      const { prefix, prefixWidth } = labelInfo(label, showLabel);
      lines.push(buildCenteredSeparator(prefix, ` session ${label} ended: ${reason} `, _textCols, prefixWidth));
    },

    connectionLost(reason: string): void {
      const ansi = `${SGR.TEXT_ERROR}\u2717 connection lost: ${reason}${SGR.RESET}`;
      lines.push(makeLine(ansi));
    },

    flushToolAccumulator(label: number, showLabel: boolean): void {
      doFlushToolAccumulator(label, showLabel);
    },
  };
}
