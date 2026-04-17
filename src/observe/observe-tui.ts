/**
 * TUI orchestrator for the observe command.
 *
 * Manages the screen lifecycle (alternate buffer, cursor, raw mode),
 * runs the 15fps frame loop, routes token stream events to the rain
 * engine and text panel, and renders the divider and status bar.
 *
 * Computes the dominant agent phase across active sessions and
 * communicates it to the rain engine for phase-driven color shifts.
 * Uses TF-IDF scoring to select interesting words from LLM output
 * and tool calls for rain panel word drops.
 *
 * Depends on observe-tui-types.ts, observe-tui-rain.ts,
 * observe-tui-text-panel.ts, and observe-tui-word-scorer.ts.
 * No external dependencies beyond Node built-ins.
 */

import type { TokenStreamEvent } from '../docker/token-stream-types.js';
import { truncate } from '../mux/mux-renderer.js';
import {
  type AgentPhase,
  type ObserveEventSink,
  type ObserveTuiOptions,
  type RainToken,
  type SessionState,
  type TuiLayout,
  FRAME_MS,
  MIN_USABLE_ROWS,
  SGR,
  calculateTuiLayout,
  isUtf8Locale,
  visibleLength,
} from './observe-tui-types.js';
import { createRainEngine, type RainEngine } from './observe-tui-rain.js';
import { createTextPanel, type TextPanel } from './observe-tui-text-panel.js';
import {
  type SessionWordState,
  createWordScorer,
  createSessionWordState,
  processEventForWords,
} from './observe-tui-word-scorer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum visible characters for model name in status bar. */
const STATUS_MODEL_MAX_LEN = 20;

/** Maximum visible characters for tool name in status bar. */
const STATUS_TOOL_MAX_LEN = 25;

/** Frames to keep error phase active (~2 seconds at 15fps). */
const ERROR_PHASE_FRAMES = 30;

// ---------------------------------------------------------------------------
// Rain token extraction
// ---------------------------------------------------------------------------

/**
 * Extract rain tokens from a single token stream event.
 *
 * - text_delta: each character -> RainToken kind='text'
 * - tool_use: each character of toolName -> kind='tool'
 * - error: each character of message -> kind='error'
 * - Other event kinds produce no rain tokens.
 */
export function extractRainTokens(event: TokenStreamEvent): RainToken[] {
  switch (event.kind) {
    case 'text_delta':
      return charsToTokens(event.text, 'text');
    case 'tool_use':
      return charsToTokens(event.toolName, 'tool');
    case 'tool_result':
      // Extract a few characters from tool result content for rain effect
      return charsToTokens(event.content.slice(0, 8), 'tool');
    case 'error':
      return charsToTokens(event.message, 'error');
    default:
      return [];
  }
}

function charsToTokens(text: string, kind: RainToken['kind']): RainToken[] {
  const tokens: RainToken[] = [];
  for (const char of text) {
    tokens.push({ char, kind });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Session state management
// ---------------------------------------------------------------------------

function createSessionState(label: number): SessionState {
  return {
    label,
    inputTokens: 0,
    outputTokens: 0,
    toolCount: 0,
    model: null,
    phase: 'idle',
    lastEventTime: Date.now(),
    ended: false,
    endReason: null,
    currentToolName: null,
  };
}

/**
 * Update a SessionState from a single event.
 * Mutates the state in place.
 */
export function updateSessionState(state: SessionState, event: TokenStreamEvent): void {
  state.lastEventTime = Date.now();

  switch (event.kind) {
    case 'text_delta':
      state.phase = 'thinking';
      state.currentToolName = null;
      break;
    case 'tool_use':
      state.phase = 'tool_use';
      // Only increment toolCount for new tool calls (non-empty toolName)
      if (event.toolName !== '') {
        state.toolCount++;
        state.currentToolName = event.toolName;
      }
      break;
    case 'message_start':
      state.model = event.model;
      break;
    case 'message_end':
      state.inputTokens += event.inputTokens;
      state.outputTokens += event.outputTokens;
      state.phase = 'idle';
      state.currentToolName = null;
      break;
    // error, tool_result, and raw events do not change phase or counters
  }
}

// ---------------------------------------------------------------------------
// Dominant phase computation
// ---------------------------------------------------------------------------

/**
 * Compute the dominant agent phase across all active sessions.
 * Priority: error > tool_use > thinking > idle.
 * Error phase is tracked separately via errorFramesRemaining.
 */
export function computeDominantPhase(sessions: Map<number, SessionState>, errorActive: boolean): AgentPhase {
  if (errorActive) return 'error';

  let dominant: AgentPhase = 'idle';
  for (const s of sessions.values()) {
    if (s.ended) continue;
    if (s.phase === 'tool_use') dominant = 'tool_use';
    if (s.phase === 'thinking' && dominant === 'idle') dominant = 'thinking';
  }
  return dominant;
}

// ---------------------------------------------------------------------------
// Aggregate metrics
// ---------------------------------------------------------------------------

interface AggregateMetrics {
  totalTokens: number;
  activeSessions: number;
  totalSessions: number;
  queueDepth: number;
  tokensPerSec: number;
  /** Model name from the most recently active session. */
  model: string | null;
  /** Dominant agent phase across active sessions. */
  phase: AgentPhase;
  /** Current tool name (when phase is tool_use). */
  currentToolName: string | null;
}

/**
 * Sliding window tracker for tokens/sec computation.
 * Records (timestamp, cumulativeTokens) snapshots and computes
 * the rate over the most recent windowMs period.
 */
export class TokenRateTracker {
  private readonly windowMs: number;
  private readonly samples: Array<{ time: number; tokens: number }> = [];

  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
  }

  /** Record a new snapshot of cumulative token count. */
  record(now: number, totalTokens: number): void {
    this.samples.push({ time: now, tokens: totalTokens });
    // Evict samples older than the window
    const cutoff = now - this.windowMs;
    while (this.samples.length > 1 && this.samples[0].time < cutoff) {
      this.samples.shift();
    }
  }

  /** Compute tokens/sec over the sliding window. */
  rate(): number {
    if (this.samples.length < 2) return 0;
    const oldest = this.samples[0];
    const newest = this.samples[this.samples.length - 1];
    const elapsed = (newest.time - oldest.time) / 1000;
    if (elapsed <= 0) return 0;
    return (newest.tokens - oldest.tokens) / elapsed;
  }
}

function computeMetrics(
  sessions: Map<number, SessionState>,
  queueDepth: number,
  rateTracker: TokenRateTracker,
  dominantPhase: AgentPhase,
): AggregateMetrics {
  let totalTokens = 0;
  let activeSessions = 0;
  let model: string | null = null;
  let currentToolName: string | null = null;
  let latestEventTime = 0;

  for (const s of sessions.values()) {
    totalTokens += s.inputTokens + s.outputTokens;
    if (!s.ended) {
      activeSessions++;
      // Track model from most recently active non-ended session
      if (s.model && s.lastEventTime > latestEventTime) {
        model = s.model;
        latestEventTime = s.lastEventTime;
      }
      // Track current tool name from session in tool_use phase
      if (s.phase === 'tool_use' && s.currentToolName) {
        currentToolName = s.currentToolName;
      }
    }
  }

  rateTracker.record(Date.now(), totalTokens);

  return {
    totalTokens,
    activeSessions,
    totalSessions: sessions.size,
    queueDepth,
    tokensPerSec: rateTracker.rate(),
    model,
    phase: dominantPhase,
    currentToolName,
  };
}

// ---------------------------------------------------------------------------
// Divider rendering
// ---------------------------------------------------------------------------

const BOX_VERTICAL = '\u2502'; // |
const ASCII_VERTICAL = '|';

function renderDivider(layout: TuiLayout, utf8: boolean): string {
  if (layout.rainCols <= 0) return '';

  const buf: string[] = [];
  const col = layout.dividerCol + 1; // 1-indexed
  const char = utf8 ? BOX_VERTICAL : ASCII_VERTICAL;

  for (let row = 0; row < layout.textRows; row++) {
    buf.push(`\x1b[${row + 1};${col}H${SGR.DIVIDER}${char}`);
  }
  buf.push(SGR.RESET);
  return buf.join('');
}

// ---------------------------------------------------------------------------
// Status bar rendering
// ---------------------------------------------------------------------------

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function renderStatusBar(layout: TuiLayout, metrics: AggregateMetrics, connectionError: string | null): string {
  const row = layout.statusRow + 1; // 1-indexed
  const sep = `${SGR.STATUS_SEPARATOR} \u2502 ${SGR.RESET}`;

  if (connectionError) {
    const msg = ` ${SGR.STATUS_ERROR}\u26a0 ${connectionError}${SGR.RESET}`;
    const padding = Math.max(0, layout.cols - visibleLength(msg));
    return `\x1b[${row};1H${SGR.STATUS_BG}${msg}${' '.repeat(padding)}${SGR.RESET}`;
  }

  const parts: string[] = [];

  // Session count
  if (metrics.totalSessions > 0) {
    parts.push(
      `${SGR.STATUS_LABEL}sessions${SGR.RESET} ${SGR.STATUS_VALUE}${metrics.activeSessions}/${metrics.totalSessions}${SGR.RESET}`,
    );
  }

  // Model name (truncated)
  if (metrics.model) {
    const truncModel = truncate(metrics.model, STATUS_MODEL_MAX_LEN);
    parts.push(`${SGR.STATUS_VALUE}${truncModel}${SGR.RESET}`);
  }

  // Phase indicator with color
  const phaseColor: Record<AgentPhase, string> = {
    thinking: SGR.STATUS_PHASE_THINKING,
    tool_use: SGR.STATUS_PHASE_TOOL,
    idle: SGR.STATUS_PHASE_IDLE,
    error: SGR.STATUS_PHASE_ERROR,
  };
  const pColor = phaseColor[metrics.phase];
  let phaseLabel: string;
  if (metrics.phase === 'tool_use' && metrics.currentToolName) {
    const truncTool = truncate(metrics.currentToolName, STATUS_TOOL_MAX_LEN);
    phaseLabel = `TOOL: ${truncTool}`;
  } else {
    phaseLabel = metrics.phase.toUpperCase();
  }
  parts.push(`${pColor}${phaseLabel}${SGR.RESET}`);

  // Total tokens (input + output)
  parts.push(
    `${SGR.STATUS_LABEL}tokens${SGR.RESET} ${SGR.STATUS_VALUE}${formatTokenCount(metrics.totalTokens)}${SGR.RESET}`,
  );

  // Tokens/sec rate (only when > 0)
  if (metrics.tokensPerSec > 0) {
    const rateStr =
      metrics.tokensPerSec >= 100 ? Math.round(metrics.tokensPerSec).toString() : metrics.tokensPerSec.toFixed(1);
    parts.push(`${SGR.STATUS_LABEL}tok/s${SGR.RESET} ${SGR.STATUS_VALUE}${rateStr}${SGR.RESET}`);
  }

  // Queue depth (only when non-zero)
  if (metrics.queueDepth > 0) {
    parts.push(`${SGR.STATUS_LABEL}queue${SGR.RESET} ${SGR.STATUS_VALUE}${metrics.queueDepth}${SGR.RESET}`);
  }

  // Exit hint
  parts.push(`${SGR.STATUS_HINT}Ctrl+C exit${SGR.RESET}`);

  let content = ` ${parts.join(sep)} `;

  // If content exceeds terminal width, drop low-priority segments
  while (visibleLength(content) > layout.cols && parts.length > 3) {
    // Drop second-to-last segment (queue or tok/s, before exit hint)
    parts.splice(parts.length - 2, 1);
    content = ` ${parts.join(sep)} `;
  }

  const padding = Math.max(0, layout.cols - visibleLength(content));

  return `\x1b[${row};1H${SGR.STATUS_BG}${content}${' '.repeat(padding)}${SGR.RESET}`;
}

// ---------------------------------------------------------------------------
// TUI factory
// ---------------------------------------------------------------------------

/** Return type: ObserveEventSink + start/destroy lifecycle methods. */
export interface ObserveTui extends ObserveEventSink {
  start(): void;
  destroy(): void;
}

/** Read current terminal dimensions with sensible fallbacks. */
function getTerminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

export function createObserveTui(options: ObserveTuiOptions): ObserveTui {
  const { raw, showLabel, debug } = options;
  const effectiveRaw = raw || debug;
  const utf8 = isUtf8Locale();

  // State
  const sessions = new Map<number, SessionState>();
  const sessionWordStates = new Map<number, SessionWordState>();
  const wordScorer = createWordScorer();
  let started = false;
  let destroyed = false;
  let frameTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  // Layout (initialized on start)
  const { cols, rows } = getTerminalSize();
  let layout: TuiLayout = calculateTuiLayout(cols, rows);

  // Sub-systems (created lazily on start)
  let rainEngine: RainEngine;
  let textPanel: TextPanel;

  // Dirty flags for conditional rendering
  let dividerDirty = true;
  let textDirty = true;
  let statusDirty = true;

  // Cached divider ANSI string (recomputed only on resize)
  let cachedDivider = '';

  // Token rate tracking (3-second sliding window)
  const rateTracker = new TokenRateTracker();

  // Connection error state (shown in status bar)
  let connectionError: string | null = null;
  let connectionExitTimer: ReturnType<typeof setTimeout> | null = null;

  let errorFramesRemaining = 0;

  // Current dominant phase (cached for status bar)
  let dominantPhase: AgentPhase = 'idle';

  // Signal handlers (stored for removal on destroy)
  let sigintHandler: (() => void) | null = null;
  let sigtermHandler: (() => void) | null = null;
  let sigwinchHandler: (() => void) | null = null;
  let stdinHandler: ((data: Buffer) => void) | null = null;

  // ------------------------------------------------------------------
  // Phase computation helper
  // ------------------------------------------------------------------

  function recomputePhase(): void {
    dominantPhase = computeDominantPhase(sessions, errorFramesRemaining > 0);
    rainEngine.setPhase(dominantPhase);
  }

  // ------------------------------------------------------------------
  // Frame loop
  // ------------------------------------------------------------------

  /** Schedule the next frame, yielding to I/O between frames. */
  function scheduleNextFrame(): void {
    if (destroyed) return;
    frameTimer = setTimeout(tick, FRAME_MS);
  }

  function tick(): void {
    if (destroyed) return;

    // Decrement error counter
    if (errorFramesRemaining > 0) {
      errorFramesRemaining--;
      if (errorFramesRemaining === 0) {
        recomputePhase();
        statusDirty = true;
      }
    }

    const buf: string[] = [];
    const tooSmall = layout.rows < MIN_USABLE_ROWS;

    if (!tooSmall) {
      // 1. Rain panel
      rainEngine.tick();
      buf.push(rainEngine.render());

      // 2. Divider (only when dirty -- content only changes on resize)
      if (dividerDirty && layout.rainCols > 0) {
        cachedDivider = renderDivider(layout, utf8);
        dividerDirty = false;
      }
      if (cachedDivider) buf.push(cachedDivider);

      // 3. Text panel (only when dirty)
      if (textDirty) {
        buf.push(textPanel.render());
        textDirty = false;
      }
    } else {
      // Terminal too small: just advance rain state without rendering
      rainEngine.tick();
    }

    // 4. Status bar (always re-render when metrics may have changed)
    if (statusDirty) {
      const metrics = computeMetrics(sessions, rainEngine.queueDepth, rateTracker, dominantPhase);
      buf.push(renderStatusBar(layout, metrics, connectionError));
      statusDirty = false;
    }

    // 5. Flush
    buf.push(SGR.RESET);
    process.stdout.write(buf.join(''));

    // 6. Schedule next frame (yields to event loop for I/O)
    scheduleNextFrame();
  }

  // ------------------------------------------------------------------
  // Resize handling
  // ------------------------------------------------------------------

  function handleResize(): void {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      const size = getTerminalSize();
      layout = calculateTuiLayout(size.cols, size.rows);
      rainEngine.resize(layout);
      textPanel.resize(layout.textStartCol, layout.textCols, layout.textRows);
      dividerDirty = true;
      textDirty = true;
      statusDirty = true;
      cachedDivider = '';
      // Clear entire screen to avoid artifacts
      process.stdout.write('\x1b[2J');
    }, 100);
  }

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;

    // 1. Stop frame loop
    if (frameTimer) {
      clearTimeout(frameTimer);
      frameTimer = null;
    }

    // 2. Cancel pending timers
    if (resizeTimer) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    if (connectionExitTimer) {
      clearTimeout(connectionExitTimer);
      connectionExitTimer = null;
    }

    // 3. Remove signal handlers
    if (sigintHandler) process.off('SIGINT', sigintHandler);
    if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
    if (sigwinchHandler) process.off('SIGWINCH', sigwinchHandler);

    // 4. Remove stdin listener and restore raw mode
    if (stdinHandler) {
      process.stdin.off('data', stdinHandler);
      stdinHandler = null;
    }
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Ignore errors if stdin is already closed
      }
    }
    // Allow the process to exit naturally (stdin keeps it alive in raw mode)
    process.stdin.unref();

    // 5. Restore terminal
    process.stdout.write('\x1b[?25h'); // show cursor
    process.stdout.write('\x1b[?1049l'); // leave alternate screen
    process.stdout.write('\n'); // clean shell return
  }

  // ------------------------------------------------------------------
  // Public interface
  // ------------------------------------------------------------------

  return {
    start(): void {
      if (destroyed || started) return;
      started = true;

      // Calculate initial layout
      const size = getTerminalSize();
      layout = calculateTuiLayout(size.cols, size.rows);

      // Create sub-systems
      rainEngine = createRainEngine({ layout });
      textPanel = createTextPanel(layout.textStartCol, layout.textCols, layout.textRows);

      // Enter alternate screen and hide cursor
      process.stdout.write('\x1b[?1049h');
      process.stdout.write('\x1b[?25l');

      // Enable raw mode for Ctrl+C detection
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }

      // Listen for keypress (Ctrl+C)
      stdinHandler = (data: Buffer) => {
        if (data[0] === 0x03) {
          destroy();
          process.exit(0);
        }
      };
      process.stdin.on('data', stdinHandler);

      // Signal handlers
      sigintHandler = () => {
        destroy();
        process.exit(0);
      };
      sigtermHandler = () => {
        destroy();
        process.exit(0);
      };
      process.on('SIGINT', sigintHandler);
      process.on('SIGTERM', sigtermHandler);

      // Resize handler
      sigwinchHandler = handleResize;
      process.on('SIGWINCH', sigwinchHandler);

      // Safety net: restore terminal on unexpected exit
      process.on('exit', () => {
        process.stdout.write('\x1b[?25h\x1b[?1049l');
      });

      // Start frame loop (setTimeout-based to yield to I/O between frames)
      scheduleNextFrame();
    },

    destroy,

    pushEvents(label: number, events: readonly TokenStreamEvent[]): void {
      if (!started || destroyed) return;

      // Ensure session state exists
      let state = sessions.get(label);
      if (!state) {
        state = createSessionState(label);
        sessions.set(label, state);
      }

      // Ensure per-session word scoring state exists
      let wordState = sessionWordStates.get(label);
      if (!wordState) {
        wordState = createSessionWordState();
        sessionWordStates.set(label, wordState);
      }

      for (const event of events) {
        const previousPhase = state.phase;

        // Update session state
        updateSessionState(state, event);

        // Extract and enqueue rain tokens
        const rainTokens = extractRainTokens(event);
        if (rainTokens.length > 0) {
          rainEngine.enqueueTokens(rainTokens);
        }

        // TF-IDF word scoring: process event for word drop candidates
        const candidates = processEventForWords(event, wordState, wordScorer);
        for (const c of candidates) {
          rainEngine.enqueueWord(c.word, c.source);
        }

        // Word drops: phase transition to thinking
        if (previousPhase !== state.phase && state.phase === 'thinking') {
          rainEngine.enqueueWord('thinking...', 'phase');
        }

        if (event.kind === 'error') {
          errorFramesRemaining = ERROR_PHASE_FRAMES;
        }

        // Forward to text panel (with debug flag threading)
        textPanel.appendEvent(label, event, {
          raw: effectiveRaw,
          showLabel,
          debug,
        });
      }

      // Recompute dominant phase after processing all events
      recomputePhase();

      textDirty = true;
      statusDirty = true;
    },

    sessionEnded(label: number, reason: string): void {
      if (!started || destroyed) return;

      const state = sessions.get(label);
      if (state) {
        state.ended = true;
        state.endReason = reason;
        state.phase = 'idle';
        state.currentToolName = null;
      }

      textPanel.sessionEnded(label, reason, showLabel);

      recomputePhase();
      textDirty = true;
      statusDirty = true;
    },

    connectionLost(reason: string): void {
      if (!started || destroyed) return;

      // Show in text panel
      textPanel.connectionLost(reason);
      textDirty = true;
      statusDirty = true;

      // Show in status bar (overrides normal metrics display)
      connectionError = `Connection lost: ${reason}`;

      // Start 3-second exit timer (rain keeps draining during this window)
      if (!connectionExitTimer) {
        connectionExitTimer = setTimeout(() => {
          destroy();
          process.exit(0);
        }, 3000);
      }
    },
  };
}
