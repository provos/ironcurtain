/**
 * Shared types, constants, and layout calculation for the observe TUI.
 *
 * This module is types-and-constants only -- no behavior, no rendering,
 * no I/O. All TUI modules depend on this file; it depends on nothing
 * except Node built-ins (for locale detection).
 */

import type { TokenStreamEvent } from '../docker/token-stream-types.js';

// ---------------------------------------------------------------------------
// Character sets
// ---------------------------------------------------------------------------

/** Half-width katakana + digits -- same set as mux-splash.ts RAIN_CHARS. */
export const RAIN_CHARS = 'ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789';

/** ASCII fallback for non-UTF-8 locales. */
export const ASCII_RAIN_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz@#$%&*+=<>~';

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Target frame interval in milliseconds (~15 FPS). */
export const FRAME_MS = 66;

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Fraction of terminal width allocated to the rain panel. */
export const RAIN_WIDTH_FRACTION = 0.18;

/** Minimum columns for the rain panel when visible. */
export const MIN_RAIN_COLS = 15;

/** Minimum columns for the text panel. */
export const MIN_TEXT_COLS = 40;

/** Below this total width, rain is hidden and text takes the full width. */
export const MIN_TOTAL_COLS = 60;

/** Below this row count, only the status bar is rendered (rain + text suppressed). */
export const MIN_USABLE_ROWS = 5;

/** Width of the vertical divider between rain and text panels. */
export const DIVIDER_WIDTH = 1;

// ---------------------------------------------------------------------------
// Capacity limits
// ---------------------------------------------------------------------------

/** Maximum characters queued for rain display before oldest are dropped. */
export const RAIN_QUEUE_CAPACITY = 2048;

/** Maximum lines retained in the text panel ring buffer. */
export const TEXT_BUFFER_CAPACITY = 10_000;

// ---------------------------------------------------------------------------
// SGR color palette
// ---------------------------------------------------------------------------

/**
 * SGR escape sequences (true-color 24-bit).
 * Adapted from mux-splash.ts CLR_* constants.
 * Inline SGR avoids chalk dependency for zero-allocation frame rendering.
 */
export const SGR = {
  RESET: '\x1b[0m',

  // Rain colors by event kind
  RAIN_HEAD_TEXT: '\x1b[1;38;2;180;255;180m', // bright white-green (text_delta head)
  RAIN_NEAR_TEXT: '\x1b[38;2;0;255;70m', // bright green trail
  RAIN_FAR_TEXT: '\x1b[38;2;0;120;0m', // dim green trail
  RAIN_HEAD_TOOL: '\x1b[1;38;2;180;255;255m', // bright white-cyan (tool_use head)
  RAIN_NEAR_TOOL: '\x1b[38;2;0;200;255m', // bright cyan trail
  RAIN_FAR_TOOL: '\x1b[38;2;0;100;130m', // dim cyan trail
  RAIN_HEAD_ERROR: '\x1b[1;38;2;255;180;180m', // bright white-red (error head)
  RAIN_NEAR_ERROR: '\x1b[38;2;255;70;70m', // bright red trail
  RAIN_FAR_ERROR: '\x1b[38;2;130;0;0m', // dim red trail
  RAIN_IDLE: '\x1b[38;2;0;80;0m', // very dim green (ambient)

  // Text panel
  TEXT_NORMAL: '\x1b[38;2;200;200;200m', // light grey prose
  TEXT_TOOL: '\x1b[38;2;0;200;255m', // cyan tool headers
  TEXT_TOOL_DIM: '\x1b[38;2;0;130;170m', // dim cyan tool input
  TEXT_ERROR: '\x1b[38;2;255;80;80m', // red errors
  TEXT_SEPARATOR: '\x1b[38;2;80;80;80m', // dim grey separators
  TEXT_META: '\x1b[38;2;100;100;100m', // very dim metadata
  TEXT_DIM: '\x1b[2m', // generic dim

  // Session label colors (cycled per label number)
  SESSION_0: '\x1b[38;2;0;255;70m', // green
  SESSION_1: '\x1b[38;2;0;200;255m', // cyan
  SESSION_2: '\x1b[38;2;200;150;255m', // purple
  SESSION_3: '\x1b[38;2;255;200;0m', // amber
  SESSION_4: '\x1b[38;2;255;100;100m', // salmon
  SESSION_5: '\x1b[38;2;100;255;200m', // mint

  // Divider
  DIVIDER: '\x1b[38;2;40;60;40m', // very dim green vertical line

  // Status bar (cyberpunk palette)
  STATUS_BG: '\x1b[48;2;10;15;10m', // near-black green tint background
  STATUS_LABEL: '\x1b[1;38;2;0;255;70m', // bright green labels
  STATUS_VALUE: '\x1b[38;2;0;200;180m', // teal values
  STATUS_SEPARATOR: '\x1b[38;2;40;70;40m', // dim green separators
  STATUS_HINT: '\x1b[38;2;60;80;60m', // very dim hint text
  STATUS_ERROR: '\x1b[1;38;2;255;70;70m', // bright red for connection lost

  // Word drop colors (brighter than regular rain to stand out)
  WORD_TEXT: '\x1b[1;38;2;150;255;150m', // bright green (text fragments)
  WORD_TOOL: '\x1b[1;38;2;100;255;255m', // bright cyan (tool names)
  WORD_PHASE: '\x1b[1;38;2;255;255;180m', // bright warm yellow (phase labels)
  WORD_MODEL: '\x1b[1;38;2;180;180;255m', // bright lavender (model name)

  // Thinking text in text panel
  TEXT_THINKING: '\x1b[2;3;38;2;0;200;100m', // dim italic green

  // Status bar phase indicators
  STATUS_PHASE_THINKING: '\x1b[38;2;0;255;70m', // green
  STATUS_PHASE_TOOL: '\x1b[38;2;0;200;255m', // cyan
  STATUS_PHASE_IDLE: '\x1b[38;2;80;80;80m', // dim grey
  STATUS_PHASE_ERROR: '\x1b[38;2;255;70;70m', // red
} as const;

/** Session label colors, indexed by `label % SESSION_COLORS.length`. */
export const SESSION_COLORS = [
  SGR.SESSION_0,
  SGR.SESSION_1,
  SGR.SESSION_2,
  SGR.SESSION_3,
  SGR.SESSION_4,
  SGR.SESSION_5,
] as const;

/** Returns the SGR color sequence for a given session label number. */
export function sessionColor(label: number): string {
  return SESSION_COLORS[label % SESSION_COLORS.length];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Computed screen layout for the TUI. */
export interface TuiLayout {
  readonly cols: number;
  readonly rows: number;
  /** Number of columns for the rain panel (0 when terminal too narrow). */
  readonly rainCols: number;
  /** Column index of the vertical divider. */
  readonly dividerCol: number;
  /** First column of the text panel. */
  readonly textStartCol: number;
  /** Usable width of the text panel. */
  readonly textCols: number;
  /** Rows available for text content (rows - 1, reserving status bar). */
  readonly textRows: number;
  /** 0-indexed row for the status bar. */
  readonly statusRow: number;
}

/**
 * Computes the TUI layout for the given terminal dimensions.
 *
 * When `cols >= MIN_TOTAL_COLS`, the rain panel gets ~18% of the width.
 * Otherwise the rain panel is hidden and text takes the full width.
 */
export function calculateTuiLayout(cols: number, rows: number): TuiLayout {
  const statusRow = rows - 1;
  const textRows = rows - 1;

  if (cols < MIN_TOTAL_COLS) {
    // Too narrow for split: full-width text panel, no rain
    return {
      cols,
      rows,
      rainCols: 0,
      dividerCol: 0,
      textStartCol: 0,
      textCols: cols,
      textRows,
      statusRow,
    };
  }

  const rainCols = Math.max(MIN_RAIN_COLS, Math.floor(cols * RAIN_WIDTH_FRACTION));
  const dividerCol = rainCols;
  const textStartCol = rainCols + DIVIDER_WIDTH;
  const textCols = cols - textStartCol;

  return {
    cols,
    rows,
    rainCols,
    dividerCol,
    textStartCol,
    textCols: Math.max(1, textCols),
    textRows,
    statusRow,
  };
}

// ---------------------------------------------------------------------------
// Agent phase
// ---------------------------------------------------------------------------

/**
 * Agent phase as tracked by the orchestrator and communicated
 * to the rain engine for color selection.
 *
 * Extends the existing SessionState.phase with an 'error' pseudo-phase
 * that the rain engine can react to (triggered by error events, auto-clears).
 */
export type AgentPhase = 'thinking' | 'tool_use' | 'idle' | 'error';

// ---------------------------------------------------------------------------
// Word drop types
// ---------------------------------------------------------------------------

/** Lifecycle phase of a word drop. */
export type WordDropPhase = 'forming' | 'holding' | 'dissolving';

/** Source category for word drop content, determines color. */
export type WordDropSource = 'tool' | 'phase' | 'model' | 'text';

/**
 * A word that materializes horizontally in the rain panel.
 *
 * The word occupies a contiguous horizontal span at a fixed row.
 * Each character tracks whether it has been "revealed" (formation),
 * is "held" (static), or "released" (converted to a falling drop).
 */
export interface WordDrop {
  /** The word to display. */
  readonly word: string;
  /** Source category (determines color). */
  readonly source: WordDropSource;
  /** Top-left column (0-indexed within rain panel). */
  readonly col: number;
  /** Row position (0-indexed). */
  readonly row: number;
  /** Current lifecycle phase. */
  phase: WordDropPhase;
  /** Frame counter within the current phase. */
  phaseFrame: number;
  /**
   * Per-character state.
   * - During 'forming': index < revealedCount are visible.
   * - During 'holding': all visible.
   * - During 'dissolving': dissolveOrder tracks release sequence.
   */
  revealedCount: number;
  /**
   * Randomized dissolution order. Indices into `word` specifying
   * which character dissolves on each frame of the dissolving phase.
   * Length = word.length. Built once at transition to 'dissolving'.
   */
  dissolveOrder: number[];
  /** Number of characters dissolved so far. */
  dissolvedCount: number;
  /** Number of frames to hold (chosen at formation). */
  holdDuration: number;
}

// ---------------------------------------------------------------------------
// Tool accumulator types
// ---------------------------------------------------------------------------

/** Tracks accumulated tool_use input fragments per session. */
export interface ToolAccumulator {
  /** Tool name from the content_block_start event. */
  toolName: string;
  /** Accumulated inputDelta JSON fragments. */
  inputBuffer: string;
  /** Whether we have received at least one inputDelta fragment. */
  hasInput: boolean;
}

// ---------------------------------------------------------------------------
// Filtered raw event types
// ---------------------------------------------------------------------------

/** Raw SSE event types that are suppressed in --raw mode (shown only in --debug). */
export const SUPPRESSED_RAW_EVENTS: ReadonlySet<string> = new Set([
  'content_block_stop',
  'message_stop',
  'ping',
  'signature_delta',
]);

// ---------------------------------------------------------------------------
// Rain types
// ---------------------------------------------------------------------------

/** Event kind that determines rain drop coloring. */
export type RainColorKind = 'text' | 'tool' | 'error' | 'idle';

/** A character queued for rain display, tagged with its event kind. */
export interface RainToken {
  readonly char: string;
  readonly kind: 'text' | 'tool' | 'error';
}

/** State of a single falling rain drop. */
export interface RainDrop {
  /** Column within the rain panel (0-indexed). */
  col: number;
  /** Current head row position (can be negative during entry). */
  headRow: number;
  /** Rows per frame (1-3, fractional via speedAccum). */
  speed: number;
  /** Fractional speed accumulator for sub-integer movement. */
  speedAccum: number;
  /** Number of trailing characters (3-6). */
  trailLen: number;
  /** Color scheme for this drop. */
  colorKind: RainColorKind;
  /** Fixed-size ring buffer of characters (length = trailLen + 1). */
  chars: string[];
  /** Rotating write index into chars; wraps at chars.length. */
  headIdx: number;
  /** False once the drop has fully exited the screen. */
  alive: boolean;
}

// ---------------------------------------------------------------------------
// Text panel types
// ---------------------------------------------------------------------------

/** A single pre-formatted line in the text panel ring buffer. */
export interface PanelLine {
  /** Pre-formatted content with SGR codes (no cursor positioning). */
  readonly ansi: string;
  /** Visible character width (excluding ANSI escape sequences). */
  readonly plainLen: number;
}

/** Tracks an incomplete text line for a session (text_delta accumulation). */
export interface SessionPartialLine {
  /** Accumulated text not yet terminated by a newline. */
  buffer: string;
  /** ANSI prefix for the current line (session label SGR, if showLabel). */
  prefix: string;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/** Per-session tracking for the TUI status bar and metrics. */
export interface SessionState {
  /** Session label number. */
  readonly label: number;
  /** Running sum of input tokens from message_end events. */
  inputTokens: number;
  /** Running sum of output tokens from message_end events. */
  outputTokens: number;
  /** Count of tool_use events observed. */
  toolCount: number;
  /** Model name from the most recent message_start event. */
  model: string | null;
  /** Current agent phase: thinking, using tools, or idle. */
  phase: 'thinking' | 'tool_use' | 'idle';
  /** Timestamp (Date.now()) of the last event received. */
  lastEventTime: number;
  /** Whether the session has ended. */
  ended: boolean;
  /** Reason for session end, if ended. */
  endReason: string | null;
  /** Name of the tool currently being invoked (null when not in tool_use phase). */
  currentToolName: string | null;
}

// ---------------------------------------------------------------------------
// Event sink interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over the rendering backend for observe events.
 * Both the plain text renderer and the TUI implement this interface,
 * allowing observe-command.ts to route events without knowing which
 * renderer is active.
 */
export interface ObserveEventSink {
  /** Feed a batch of token stream events from one session. */
  pushEvents(label: number, events: readonly TokenStreamEvent[]): void;
  /** Notify that a session ended. */
  sessionEnded(label: number, reason: string): void;
  /** Notify that the WebSocket connection to the daemon was lost. */
  connectionLost(reason: string): void;
}

// ---------------------------------------------------------------------------
// TUI options
// ---------------------------------------------------------------------------

/** Options for creating an ObserveTui instance. */
export interface ObserveTuiOptions {
  /** Show all event kinds, not just text_delta. */
  readonly raw: boolean;
  /** Prefix output lines with a session label (multi-session mode). */
  readonly showLabel: boolean;
  /** Show absolutely all events including protocol noise. Implies raw. */
  readonly debug: boolean;
}

// ---------------------------------------------------------------------------
// Locale detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the current locale supports UTF-8 output.
 * Checks `LANG`, `LC_ALL`, and `LC_CTYPE` environment variables.
 */
export function isUtf8Locale(): boolean {
  const vars = [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG];
  for (const v of vars) {
    if (v) {
      const upper = v.toUpperCase();
      if (upper.includes('UTF-8') || upper.includes('UTF8')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns the appropriate rain character set based on locale.
 * Uses half-width katakana for UTF-8 locales, ASCII fallback otherwise.
 */
export function getRainChars(): string {
  return isUtf8Locale() ? RAIN_CHARS : ASCII_RAIN_CHARS;
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

/** Regex matching SGR escape sequences (e.g. \x1b[38;2;0;255;70m). */
// eslint-disable-next-line no-control-regex
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip SGR escape sequences, returning only visible characters. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Visible character count of a string with embedded ANSI escape sequences. */
export function visibleLength(s: string): number {
  return stripAnsi(s).length;
}
