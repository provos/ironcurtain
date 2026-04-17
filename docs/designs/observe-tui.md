# Design: Observe TUI ("Spectrograph")

## Overview

`ironcurtain observe` currently streams plain text to stdout. This design adds a
split-screen TUI mode: a data-driven Matrix rain panel on the left (25-30% width)
fed by real LLM token output, and a readable text panel on the right (70-75%)
showing formatted agent output. The TUI activates automatically when stdout is a
TTY and falls back to the existing plain renderer otherwise.

The implementation reuses the proven rain mechanics from `mux-splash.ts` (drop
lifecycle, character sets, color gradients, frame timing) but replaces
target-locking drops with continuous free-falling drops fed by a token queue.

## 1. Module Structure

```
src/observe/
  observe-command.ts          # existing -- gains --tui/--no-tui flag, mode dispatch
  observe-renderer.ts         # existing -- plain text renderer (unchanged)
  observe-tui.ts              # NEW -- TUI lifecycle: screen setup, frame loop, cleanup
  observe-tui-rain.ts         # NEW -- rain engine: drop model, token queue, rendering
  observe-tui-text-panel.ts   # NEW -- text panel: line buffer, scrolling, formatting
  observe-tui-types.ts        # NEW -- shared types, color constants, layout calculation
```

### Dependency graph

```
observe-command.ts
  |-- observe-renderer.ts        (plain mode, existing)
  |-- observe-tui.ts             (TUI mode, new)
        |-- observe-tui-rain.ts
        |-- observe-tui-text-panel.ts
        |-- observe-tui-types.ts
```

The TUI modules depend only on `observe-tui-types.ts` and Node built-ins.
No `terminal-kit` dependency -- the TUI writes raw ANSI escape sequences via
`process.stdout.write()`, following the same pattern `mux-splash.ts` uses with
its `buf.push()` + `term.noFormat(buf.join(''))` approach, but cutting out the
`terminal-kit` intermediary since the observe TUI owns the entire screen.

No `chalk` dependency in the TUI modules either -- all color is via inline SGR
sequences for zero-allocation rendering in the hot frame loop.

## 2. Types and Layout (`observe-tui-types.ts`)

### Color palette

```typescript
// SGR escape sequences -- true-color (24-bit)
// Adapted from mux-splash.ts CLR_* constants

export const SGR = {
  RESET: '\x1b[0m',

  // Rain colors by event kind
  RAIN_HEAD_TEXT:    '\x1b[1;38;2;180;255;180m',  // bright white-green (text_delta head)
  RAIN_NEAR_TEXT:    '\x1b[38;2;0;255;70m',        // bright green trail
  RAIN_FAR_TEXT:     '\x1b[38;2;0;120;0m',         // dim green trail
  RAIN_HEAD_TOOL:    '\x1b[1;38;2;180;255;255m',  // bright white-cyan (tool_use head)
  RAIN_NEAR_TOOL:    '\x1b[38;2;0;200;255m',      // bright cyan trail
  RAIN_FAR_TOOL:     '\x1b[38;2;0;100;130m',      // dim cyan trail
  RAIN_HEAD_ERROR:   '\x1b[1;38;2;255;180;180m',  // bright white-red (error head)
  RAIN_NEAR_ERROR:   '\x1b[38;2;255;70;70m',      // bright red trail
  RAIN_FAR_ERROR:    '\x1b[38;2;130;0;0m',         // dim red trail
  RAIN_IDLE:         '\x1b[38;2;0;80;0m',          // very dim green (ambient)

  // Text panel
  TEXT_NORMAL:    '\x1b[38;2;200;200;200m',  // light grey prose
  TEXT_TOOL:      '\x1b[38;2;0;200;255m',    // cyan tool headers
  TEXT_TOOL_DIM:  '\x1b[38;2;0;130;170m',    // dim cyan tool input
  TEXT_ERROR:     '\x1b[38;2;255;80;80m',    // red errors
  TEXT_SEPARATOR: '\x1b[38;2;80;80;80m',     // dim grey separators
  TEXT_META:      '\x1b[38;2;100;100;100m',  // very dim metadata
  TEXT_DIM:       '\x1b[2m',                 // generic dim

  // Session label colors (cycled per label number)
  SESSION_0: '\x1b[38;2;0;255;70m',    // green
  SESSION_1: '\x1b[38;2;0;200;255m',   // cyan
  SESSION_2: '\x1b[38;2;200;150;255m', // purple
  SESSION_3: '\x1b[38;2;255;200;0m',   // amber
  SESSION_4: '\x1b[38;2;255;100;100m', // salmon
  SESSION_5: '\x1b[38;2;100;255;200m', // mint

  // Divider
  DIVIDER: '\x1b[38;2;40;60;40m',  // very dim green vertical line
} as const;

export const SESSION_COLORS = [
  SGR.SESSION_0, SGR.SESSION_1, SGR.SESSION_2,
  SGR.SESSION_3, SGR.SESSION_4, SGR.SESSION_5,
] as const;

export function sessionColor(label: number): string {
  return SESSION_COLORS[label % SESSION_COLORS.length];
}
```

### Layout

```typescript
export const FRAME_MS = 33; // ~30 FPS (matches mux-splash.ts)
export const RAIN_WIDTH_FRACTION = 0.27; // 27% of terminal width
export const MIN_RAIN_COLS = 15;
export const MIN_TEXT_COLS = 40;
export const MIN_TOTAL_COLS = 60; // below this, text-only (no rain)
export const DIVIDER_WIDTH = 1; // single vertical bar

export interface TuiLayout {
  readonly cols: number;
  readonly rows: number;
  readonly rainCols: number;      // 0 when terminal too narrow
  readonly dividerCol: number;    // column index of the vertical divider
  readonly textStartCol: number;  // first column of text panel
  readonly textCols: number;      // usable width of text panel
  readonly textRows: number;      // rows - 1 (reserve bottom row for status bar)
  readonly statusRow: number;     // 0-indexed row for status bar
}

export function calculateTuiLayout(cols: number, rows: number): TuiLayout {
  const statusRow = rows - 1;
  const textRows = rows - 1;

  if (cols < MIN_TOTAL_COLS) {
    // Too narrow for split: full-width text panel, no rain
    return {
      cols, rows,
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
    cols, rows,
    rainCols,
    dividerCol,
    textStartCol,
    textCols: Math.max(1, textCols),
    textRows,
    statusRow,
  };
}
```

### Token queue item

```typescript
/** A character queued for rain display, tagged with its event kind. */
export interface RainToken {
  readonly char: string;
  readonly kind: 'text' | 'tool' | 'error';
}
```

### Rain drop state

```typescript
export type RainColorKind = 'text' | 'tool' | 'error' | 'idle';

export interface RainDrop {
  col: number;         // column within the rain panel (0-indexed)
  headRow: number;     // current head position (can be negative during entry)
  speed: number;       // rows per frame (1-3, fractional via accumulator)
  speedAccum: number;  // fractional speed accumulator
  trailLen: number;    // 3-6 characters of trail
  colorKind: RainColorKind;
  chars: string[];     // fixed-size ring buffer of length trailLen + 1
  headIdx: number;     // rotating write index into chars; wraps at chars.length
  alive: boolean;      // false once fully off-screen
}
```

## 3. Rain Engine (`observe-tui-rain.ts`)

### Token queue

The rain engine maintains a FIFO queue of `RainToken` items. When `TokenStreamEvent`
values arrive from the WebSocket, the TUI controller extracts characters and pushes
them onto the queue:

- `text_delta`: each character of `event.text` becomes a `RainToken { char, kind: 'text' }`
- `tool_use`: each character of `event.toolName + ' ' + event.inputDelta` becomes `{ char, kind: 'tool' }`
- `error`: each character of `event.message` becomes `{ char, kind: 'error' }`
- Other event kinds are not fed to the rain

The queue has a bounded capacity (e.g. 2048 characters). When full, oldest tokens
are silently dropped. This prevents memory growth during bursts.

```typescript
export interface RainEngine {
  /** Push characters from a token stream event into the rain queue. */
  enqueue(tokens: readonly RainToken[]): void;
  /** Advance one frame. Returns ANSI string to write for the rain panel. */
  tick(): string;
  /** Update dimensions after terminal resize. */
  resize(rainCols: number, rows: number): void;
  /** Current queue depth (for status bar display). */
  readonly queueDepth: number;
}
```

### Drop lifecycle

Adapted from `mux-splash.ts` but with continuous spawning instead of
target-locking:

1. **Spawn**: Each frame, the engine attempts to spawn 0-N new drops depending on
   queue depth and column count. The spawn rate scales with queue depth:
   - Queue has tokens: spawn rate = `ceil(rainCols / 8)` drops per frame, distributed
     randomly across columns. Characters are dequeued from the token queue.
   - Queue empty (idle): spawn rate = `ceil(rainCols / 25)` drops per frame using
     random katakana/half-width characters from `RAIN_CHARS` (same set as
     `mux-splash.ts`). Idle drops use the `idle` color kind.

2. **Fall**: Each frame, each drop advances by its speed. Speed is assigned at spawn
   time: 1-3 rows per frame, with a fractional accumulator for smooth sub-integer
   speeds (e.g. speed 1.5 means advance 1 row on even frames, 2 on odd). This
   creates depth through parallax -- faster drops feel closer.

3. **Character rotation**: As the drop falls, characters rotate through a
   fixed-size ring buffer. The ring has length `trailLen + 1` (head + trail)
   and uses a rotating head index to avoid shift/pop overhead:

   ```typescript
   // Within RainDrop:
   chars: string[];    // fixed-size array of length trailLen + 1
   headIdx: number;    // index where the next new character is written
   ```

   On each step, the engine writes a new character (from the token queue or
   `randChar()`) at `chars[headIdx]`, then advances: `headIdx = (headIdx + 1) %
   chars.length`. Rendering reads backward from `headIdx`: position 0 (the head)
   is `chars[(headIdx - 1 + chars.length) % chars.length]`, position 1 is
   `chars[(headIdx - 2 + chars.length) % chars.length]`, and so on.

   This gives the visual effect of characters "flickering" in the trail -- the
   same illusion `mux-splash.ts` achieves by calling `randChar()` every frame
   for trail positions -- but without array allocation per frame.

4. **Despawn**: When `headRow - trailLen >= rows`, the drop is marked `alive = false`
   and removed from the active list on the next frame.

### Column cooldown

To prevent visual clumping, each column has a cooldown counter (in frames) that
must reach zero before a new drop can spawn in that column. Cooldown is set to
`trailLen + random(2, 5)` when a drop spawns, ensuring vertical separation between
drops in the same column.

### Rendering

Each frame, the engine builds an ANSI string buffer (array of escape sequences
joined at the end, same pattern as `mux-splash.ts` `render()`).

**Per-frame clearing**: Before drawing any drops, the engine clears all rain
column cells by writing a space to every cell in the rain panel region. This
prevents ghost trails -- without it, when a drop moves from row 5 to row 6,
the character at row 5 remains on screen as a stale artifact. This matches
`mux-splash.ts`'s `clearViewport()` approach where each frame starts from a
clean slate.

```typescript
function clearRainPanel(buf: string[], rainCols: number, rows: number): void {
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < rainCols; col++) {
      buf.push(`\x1b[${row + 1};${col + 1}H `);
    }
  }
}

function renderDrop(drop: RainDrop, buf: string[]): void {
  const { headColors, nearColors, farColors } = colorForKind(drop.colorKind);
  const len = drop.chars.length; // trailLen + 1

  for (let i = 0; i <= drop.trailLen; i++) {
    const row = drop.headRow - i;
    if (row < 0 || row >= rows) continue;

    // Read from ring buffer: headIdx-1 is the most recently written (head),
    // headIdx-2 is the next trail position, etc.
    const char = drop.chars[(drop.headIdx - 1 - i + len) % len] ?? randChar();
    const color = i === 0 ? headColors
                : i <= 2 ? nearColors
                : farColors;

    // CSI row;col H + SGR + char
    buf.push(`\x1b[${row + 1};${drop.col + 1}H${color}${char}`);
  }
}
```

The `tick()` method calls `clearRainPanel()` first, then iterates over all
active drops calling `renderDrop()`. Drops write their characters on top of
the cleared spaces, so only currently-active drop positions have visible
characters after each frame.

The three-tier color gradient (head/near/far) mirrors `mux-splash.ts`:
- `CLR_HEAD` (bright white-tinted) for position 0 (the head)
- `CLR_NEAR` (bright saturated) for positions 1-2
- `CLR_FAR` (dim) for positions 3+

But we have three gradient sets (green/cyan/red) plus a fourth (very dim green)
for idle drops.

### Idle behavior

When the token queue is empty for more than ~500ms (15 frames), the engine
transitions to idle mode:

- Spawn rate drops to `ceil(rainCols / 25)` (sparse ambient rain)
- Characters come from `RAIN_CHARS` (katakana + digits, same as `mux-splash.ts`)
- Color uses `RAIN_IDLE` (very dim green) -- much darker than active data rain
- When new tokens arrive, the engine immediately transitions back to active mode;
  idle drops already on screen continue falling with their idle coloring

This creates a clear visual distinction: dim ambient rain = waiting, bright
colorful rain = data flowing.

## 4. Text Panel (`observe-tui-text-panel.ts`)

### Interface

```typescript
export interface TextPanel {
  /** Append a formatted event to the panel. */
  appendEvent(label: number, event: TokenStreamEvent, options: TextPanelOptions): void;
  /** Render the visible portion of the panel. Returns ANSI string. */
  render(): string;
  /** Update dimensions after terminal resize. */
  resize(startCol: number, cols: number, rows: number): void;
  /** Total lines in the buffer (for status bar). */
  readonly lineCount: number;
}

export interface TextPanelOptions {
  /** Show all event kinds, not just text_delta. */
  readonly raw: boolean;
  /** Prefix lines with session labels (multi-session mode). */
  readonly showLabel: boolean;
}
```

### Line buffer

The panel maintains a ring buffer of pre-formatted lines. Each line is a pair of
`{ ansi: string, plainLen: number }` where `ansi` is the ready-to-write string
(including ANSI color codes but NOT cursor positioning) and `plainLen` is the
visible character count (for width validation during formatting).

Buffer capacity: 10,000 lines. When full, oldest lines are dropped from the
front. This bounds memory usage while keeping enough scroll-back context.

```typescript
interface PanelLine {
  readonly ansi: string;     // pre-formatted content with SGR codes
  readonly plainLen: number; // visible character width
}
```

### Event formatting

Events are formatted into panel lines as follows. Word wrapping is applied at
`textCols` width. The formatting logic mirrors `observe-renderer.ts` but uses
inline SGR sequences instead of `chalk`:

**`text_delta`** (always shown):
```
{sessionPrefix}{text}
```
Text deltas accumulate into a per-session partial line buffer until a newline
character appears. Each session's partial state is tracked explicitly:

```typescript
interface SessionPartialLine {
  /** Accumulated text not yet terminated by a newline. */
  buffer: string;
  /** ANSI prefix for the current line (session label SGR, if showLabel). */
  prefix: string;
}
```

The `appendEvent()` handler for `text_delta` processes `event.text` as follows:

1. Split `event.text` on `\n` into `segments`.
2. Append `segments[0]` to the session's `partialLine.buffer`.
3. If `segments.length > 1` (at least one newline was present):
   a. Finalize the current partial line: apply word wrapping at `textCols`,
      push the resulting line(s) to the ring buffer.
   b. For each middle segment (`segments[1]` through `segments[length - 2]`),
      create a complete line, apply word wrapping, and push to the ring buffer.
   c. Set `partialLine.buffer` to the last segment (`segments[length - 1]`),
      which becomes the new partial line for subsequent deltas.
4. If `segments.length === 1` (no newlines), the partial buffer just grew;
   mark the panel dirty so the un-finalized partial line is re-rendered.

The session prefix (`[3] ` in `SESSION_3` color) is prepended at the start of
each new visual line when `showLabel` is true. The `SessionPartialLine` map
is keyed by session label number and lives on the `TextPanel` instance.

**`tool_use`** (shown in `--raw` mode):
```
{sessionPrefix}[tool: filesystem__read_file] {"path":"/src/..."}
```
Rendered on a single line with `TEXT_TOOL` for the tool header and `TEXT_TOOL_DIM`
for the truncated input. The input is truncated to fit the available width.

**`message_start`** (shown in `--raw` mode):
```
--- message start (claude-sonnet-4-20250514) ---
```
Full-width separator in `TEXT_SEPARATOR` color.

**`message_end`** (shown in `--raw` mode):
```
--- message end (end_turn, 1234+567 tokens) ---
```
Full-width separator with token usage metadata.

**`error`** (always shown):
```
[error] Connection refused
```
In `TEXT_ERROR` color.

**`raw`** (shown in `--raw` mode):
```
[content_block_start] {"type":"text"...}
```
In `TEXT_META` color, truncated.

### Scrolling

The text panel auto-scrolls to the bottom (most recent output). The view offset
tracks the first visible line index. As new lines are appended, the offset
advances to keep the newest content visible.

No manual scroll interaction in v1 -- the panel always shows the tail. This
avoids the complexity of scroll state management and keyboard input handling
beyond Ctrl+C. A future version could add Page Up/Down if needed.

### Word wrapping

Word wrapping is applied **only to finalized lines** (lines terminated by a
newline character). The wrapping algorithm for finalized lines:

1. If the line exceeds `textCols`, break at the last space before the limit.
   If no space exists (e.g. long URLs), hard-break at `textCols`.
2. Continuation lines do NOT get a session label prefix (to avoid visual noise),
   but they are indented by the label width to maintain alignment.

**Partial (un-finalized) lines** are NOT word-wrapped. They are rendered at
their current accumulated length. If a partial line grows beyond `textCols`,
it is truncated at `textCols` for display (the buffer retains the full text
so that when the line is eventually finalized, wrapping is applied correctly
to the complete content). This avoids the complexity of re-wrapping a growing
partial line on every delta and prevents visual jitter as characters arrive.

### Rendering

Each frame, the panel renders the visible window of lines. Because the text
panel content only changes when events arrive (not every frame), the panel
tracks a `dirty` flag. The frame loop only re-renders the text panel when dirty
or after a resize.

```typescript
function renderPanel(buf: string[]): void {
  const startLine = Math.max(0, lineCount - visibleRows);
  for (let i = 0; i < visibleRows; i++) {
    const lineIdx = startLine + i;
    const row = i; // 0-indexed screen row
    buf.push(`\x1b[${row + 1};${startCol + 1}H\x1b[K`); // position + clear to EOL

    if (lineIdx < lineCount) {
      buf.push(lines[lineIdx].ansi);
    }
  }
}
```

The `\x1b[K` (erase to end of line) before each line's content ensures clean
overwrites without residual characters from previous frames. The erase only
affects columns from the cursor position rightward, so it does not touch the
rain panel.

## 5. TUI Lifecycle (`observe-tui.ts`)

### Interface

```typescript
export interface ObserveTui {
  /** Start the TUI (enters alternate screen, begins frame loop). */
  start(): void;
  /** Feed a batch of token stream events from one session. */
  pushEvents(label: number, events: readonly TokenStreamEvent[]): void;
  /** Notify that a session ended. */
  sessionEnded(label: number, reason: string): void;
  /** Notify that the WebSocket connection was lost. */
  connectionLost(reason: string): void;
  /** Shut down (restores terminal, exits alternate screen). */
  destroy(): void;
}

export function createObserveTui(options: {
  raw: boolean;
  showLabel: boolean;
}): ObserveTui;
```

### Screen setup

On `start()`:

1. Enter alternate screen buffer: `\x1b[?1049h`
2. Hide cursor: `\x1b[?25l`
3. Enable raw mode: `if (process.stdin.isTTY) process.stdin.setRawMode(true)`
   (for Ctrl+C detection). If stdin is not a TTY (e.g. piped input), skip raw
   mode -- Ctrl+C still works via the default SIGINT handler in that case.
4. Set up `process.stdin` listener for keypress handling
5. Register `SIGWINCH` handler for terminal resize
6. Register `SIGINT` and `SIGTERM` handlers for cleanup
7. Create `RainEngine` and `TextPanel` instances
8. Start frame loop via `setInterval(tick, FRAME_MS)`

### Cleanup

On `destroy()` (or signal handler):

1. Clear the frame interval
2. Remove signal handlers
3. Restore stdin raw mode: `if (process.stdin.isTTY) process.stdin.setRawMode(false)`
4. Show cursor: `\x1b[?25h`
5. Exit alternate screen buffer: `\x1b[?1049l`
6. Write a final newline to stdout for clean shell return

Critical: cleanup must be idempotent (guard with a `destroyed` flag) and must
run even on uncaught exceptions. The signal handlers call `destroy()` then
`process.exit()`.

```typescript
function setupCleanup(destroy: () => void): void {
  const handler = () => { destroy(); process.exit(0); };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);

  // Safety net: if the process exits without going through our handler,
  // at least restore the terminal
  process.on('exit', () => {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  });
}
```

### Frame loop

The frame loop runs at 30 FPS (`FRAME_MS = 33`), matching `mux-splash.ts`:

```typescript
function tick(): void {
  const buf: string[] = [];

  // 1. Rain panel (always redraws -- animation)
  buf.push(rainEngine.tick());

  // 2. Divider
  if (layout.rainCols > 0) {
    renderDivider(buf, layout);
  }

  // 3. Text panel (only when dirty)
  if (textPanel needs redraw) {
    buf.push(textPanel.render());
  }

  // 4. Status bar
  renderStatusBar(buf, layout, metrics);

  // 5. Flush
  buf.push(SGR.RESET);
  process.stdout.write(buf.join(''));
}
```

The rain panel redraws every frame (animation requires it). The text panel and
status bar only redraw when their content changes, controlled by dirty flags.
This minimizes write volume per frame.

### Divider rendering

The divider is a single-column vertical line between rain and text panels:

```typescript
function renderDivider(buf: string[], layout: TuiLayout): void {
  const col = layout.dividerCol + 1; // 1-indexed
  for (let row = 0; row < layout.textRows; row++) {
    buf.push(`\x1b[${row + 1};${col}H${SGR.DIVIDER}\u2502`); // BOX DRAWINGS LIGHT VERTICAL
  }
}
```

The divider only redraws on resize (it is static). A `dividerDirty` flag
controls this.

### Terminal resize (SIGWINCH)

The SIGWINCH handler is debounced at 100ms to avoid redundant layout
recalculations during rapid resize drags. On receiving SIGWINCH, any pending
resize timer is cleared and a new one is set. Layout recalculation and screen
clearing happen only after the debounce period elapses.

```typescript
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

process.on('SIGWINCH', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    const { columns, rows } = process.stdout;
    layout = calculateTuiLayout(columns ?? 80, rows ?? 24);
    rainEngine.resize(layout.rainCols, layout.textRows);
    textPanel.resize(layout.textStartCol, layout.textCols, layout.textRows);

    // Full redraw on next frame
    dividerDirty = true;
    textPanelDirty = true;

    // Clear entire screen to avoid artifacts
    process.stdout.write('\x1b[2J');
  }, 100);
});
```

### Input handling

Minimal: only Ctrl+C is handled (sends SIGINT via raw mode). No other keyboard
input in v1. The `process.stdin` listener detects `\x03` (ETX) and triggers
cleanup:

```typescript
process.stdin.on('data', (data: Buffer) => {
  if (data[0] === 0x03) { // Ctrl+C
    destroy();
    process.exit(0);
  }
});
```

stdin is set to raw mode so that Ctrl+C is delivered as a data event rather than
generating SIGINT directly. This ensures our cleanup handler runs before exit.

### Status bar

A single row at the bottom of the screen showing aggregate metrics:

```
 [3 sessions]  12.4k tokens  queue: 847  30fps  Ctrl+C to exit
```

Content:
- Session count (in multi-session mode) or session label (single mode)
- Total tokens observed (sum of `message_end` inputTokens + outputTokens)
- Rain queue depth (visual indicator of data pressure)
- Frame rate indicator (computed from actual frame timing)
- Exit hint

Rendered in `TEXT_META` color on the `layout.statusRow`.

## 6. Event routing and state management

### Per-session state

The TUI controller (in `observe-tui.ts`) maintains a `Map<number, SessionState>`:

```typescript
interface SessionState {
  label: number;
  totalTokens: number;         // running sum from message_end events
  lastEventTime: number;       // Date.now() of last event
  ended: boolean;
  endReason: string | null;
}
```

This state drives:
- Status bar metrics (total tokens across sessions)
- Session label color assignment (stable: label number mod palette size)
- Ended-session display (grey out label in status bar)

### Event flow

```
WebSocket message
  |
  v
observe-command.ts: handlePushEvent()
  |
  v
ObserveTui.pushEvents(label, events)
  |
  +---> for each event:
  |      |
  |      +---> rainEngine.enqueue(extractRainTokens(event))
  |      |
  |      +---> textPanel.appendEvent(label, event, options)
  |      |
  |      +---> update SessionState metrics
  |
  (next frame tick picks up the new data)
```

This is a push model: the WebSocket handler calls `pushEvents()` which
synchronously enqueues rain tokens and appends text panel lines. The frame loop
then reads from the rain engine and text panel on the next tick. No locking is
needed because Node.js is single-threaded and the frame interval callback and
WebSocket message handler never interleave.

### Metrics aggregation

```typescript
interface AggregateMetrics {
  totalTokens: number;
  activeSessions: number;
  totalSessions: number;
  queueDepth: number;        // from rainEngine.queueDepth
  lastFrameMs: number;       // actual time of last frame (for fps display)
}
```

Updated on each `pushEvents()` call and each frame tick.

## 7. Integration with `observe-command.ts`

### Mode selection

The observe command gains a `--tui` / `--no-tui` flag. Default behavior:

```typescript
const useTui = isTty && !jsonMode;
```

Where `isTty = process.stdout.isTTY === true` and `jsonMode` is the existing
`--json` flag. The `--no-tui` flag forces plain mode even on a TTY. The `--tui`
flag is a no-op (TUI is the default on TTY) but exists for explicitness.

### Updated command spec

```typescript
const observeSpec: CommandSpec = {
  name: 'ironcurtain observe',
  description: 'Watch live LLM token output for running sessions',
  usage: [
    'ironcurtain observe <label>             Watch a single session by label',
    'ironcurtain observe --all               Watch all active sessions',
    'ironcurtain observe --workflow <name>    Watch sessions in a workflow',
  ],
  options: [
    { flag: 'all', description: 'Observe all active sessions' },
    { flag: 'workflow', description: 'Observe all sessions in a named workflow', placeholder: '<name>' },
    { flag: 'raw', description: 'Show all event types, not just text' },
    { flag: 'json', description: 'Output events as newline-delimited JSON' },
    { flag: 'no-tui', description: 'Disable TUI mode (plain text output)' },
  ],
  examples: [
    'ironcurtain observe 3                 # Watch session #3 (TUI mode)',
    'ironcurtain observe --all             # Watch all sessions',
    'ironcurtain observe 3 --no-tui        # Plain text output',
    'ironcurtain observe --all --json      # NDJSON output for piping',
    'ironcurtain observe 3 --raw           # Show tool use + message markers in TUI',
  ],
};
```

### Dispatch logic

The existing `handlePushEvent()` function is refactored to accept an event sink
interface, allowing both the plain renderer and the TUI to consume events through
the same WebSocket handler:

```typescript
interface ObserveEventSink {
  pushEvents(label: number, events: readonly TokenStreamEvent[]): void;
  sessionEnded(label: number, reason: string): void;
  /** Notify that the WebSocket connection to the daemon was lost. */
  connectionLost(reason: string): void;
}
```

The plain renderer implements this by calling `renderEventBatch()` and writing to
stdout. The TUI implements this as `ObserveTui.pushEvents()` /
`ObserveTui.sessionEnded()`.

```typescript
// In runObserveCommand():
let sink: ObserveEventSink;

if (useTui) {
  const tui = createObserveTui({ raw: !!values.raw, showLabel: isMultiSession });
  tui.start();
  sink = tui;
  // cleanup on exit:
  cleanupFn = () => tui.destroy();
} else {
  sink = {
    pushEvents(label, events) {
      const output = renderEventBatch(label, events, renderOptions);
      if (output) process.stdout.write(output);
    },
    sessionEnded(label, reason) {
      process.stderr.write(renderSessionEnded(label, reason));
    },
    connectionLost(reason) {
      process.stderr.write(`\nConnection lost: ${reason}\n`);
      // Resolve any pending cleanup promise so observe-command exits
    },
  };
}
```

The WebSocket message handler, signal handlers, and cleanup logic remain in
`observe-command.ts`. Only the rendering path changes.

### Single-session exit behavior

When observing a single session that ends, the TUI shows a "Session ended"
message in the text panel, waits 2 seconds for the user to read it, then calls
`destroy()` and exits. This mirrors the current behavior where the command exits
on `session.ended`.

## 8. Rendering approach: direct ANSI vs. double buffering

The TUI uses **direct ANSI writes** rather than a full double-buffer/diff
approach. Rationale:

- The rain panel redraws every frame anyway (every cell potentially changes), so
  diffing saves nothing there
- The text panel only writes when dirty, and writes specific rows, so it is
  already incrementally updated
- The divider is static and only redraws on resize
- The status bar is a single row, trivial to overwrite

This matches the `mux-splash.ts` approach: build an array of positioned ANSI
sequences, join, write once per frame. The total write volume per frame is
roughly:

- Rain: `rainCols * rows * ~20 bytes` per drop cell (CSI positioning + SGR + char).
  With ~30% column coverage at any time and `trailLen=4`, this is approximately
  `rainCols * rows * 0.3 * 5 * 20 = rainCols * rows * 30` bytes. For a 24-col
  rain panel and 50 rows: ~36KB per frame. At 30fps: ~1MB/s. Acceptable for
  modern terminals.
- Text panel: 0 bytes when not dirty; up to `textCols * rows * ~5 bytes` on full
  redraw (~12KB for 60 cols x 50 rows).

Optimization: the rain engine skips `buf.push()` for cells where no drop is
present, so empty columns contribute zero bytes. The actual write volume depends
on drop density.

## 9. Reusable patterns from `mux-splash.ts`

| Pattern | Source | Adaptation |
|---------|--------|------------|
| Character set | `RAIN_CHARS` constant (katakana + digits) | Reuse as-is for idle rain |
| Color gradient | `CLR_HEAD/CLR_NEAR/CLR_FAR` | Triplicate for text/tool/error/idle |
| Frame timing | `FRAME_MS = 33` | Reuse as-is |
| Buffer-then-flush | `buf.push()` + `term.noFormat(buf.join(''))` | Same pattern, `process.stdout.write()` instead of `term.noFormat()` |
| Random char | `randChar()` | Reuse as-is |
| Drop struct | `RainColumn` | Adapted: no `targetY`/`locked`, adds `speed`/`trailLen`/`chars` |
| Viewport clearing | `clearViewport()` with CSI sequences | Adapted for split layout |

### Key differences from `mux-splash.ts`

1. **No target locking**: Splash drops fall to a target row and lock. TUI drops
   fall continuously off-screen.
2. **Continuous spawning**: Splash spawns all drops at init. TUI spawns
   continuously based on queue state.
3. **Variable speed**: Splash drops all move at 1 row/frame. TUI drops have
   variable speed (1-3) for depth parallax.
4. **Data-driven characters**: Splash uses random chars. TUI uses real token
   characters when available, random only for idle.
5. **Multiple color kinds**: Splash uses one gradient (green). TUI uses four
   (green/cyan/red/dim-green).
6. **No terminal-kit**: Splash renders through `term.noFormat()`. TUI writes
   directly to `process.stdout` since it owns the entire screen.

## 10. Edge cases and error handling

### Terminal too small

When `cols < MIN_TOTAL_COLS` (60): rain panel is hidden, text panel gets full
width. The layout calculator returns `rainCols: 0`, and the frame loop skips
rain rendering and divider drawing.

When `rows < 5` at startup: the TUI is impractical. Fall back to plain mode
automatically (same as `--no-tui`).

When a resize results in `rows < 5` mid-run: the TUI does **not** fall back to
plain mode (switching renderers mid-session is error-prone). Instead, it
renders only the status bar on the single available row -- rain, text panel,
and divider are all suppressed. The frame loop checks `layout.rows < 5` and
skips all panel rendering, writing only the status bar content at row 1.
Normal rendering resumes automatically when the terminal is enlarged past the
threshold.

### Non-TTY stdout

Detected before TUI creation: `process.stdout.isTTY !== true`. Falls back to
plain renderer. Pipe-friendly: `ironcurtain observe --all | tee log.txt` works
because the non-TTY detection triggers plain mode.

### WebSocket disconnection

When the WebSocket disconnects, `observe-command.ts` calls
`sink.connectionLost(reason)`. In the TUI implementation, `connectionLost()`:

1. Displays a red-colored message in the status bar: `Connection lost: {reason}`
   (using `TEXT_ERROR` SGR).
2. Starts a 3-second timer. When it fires, calls `destroy()` and exits.
3. The rain panel continues animating during the 3-second window (draining
   any remaining queued tokens) to provide visual feedback that the TUI is
   still responsive.

In the plain renderer adapter, `connectionLost()` writes the reason to stderr
and resolves the cleanup promise so that `observe-command.ts` can exit.

### Rapid event bursts

The token queue has a 2048-character bound. During bursts (e.g. large code
output), excess characters are silently dropped from the rain queue. The text
panel still receives all events (its ring buffer is much larger at 10k lines).
This means the text panel is always complete; the rain is a best-effort
visualization.

### Unicode width

Rain characters (katakana half-width, digits) are all single-column. Token
characters from `text_delta` may include full-width Unicode. For the rain panel,
full-width characters are replaced with a random `RAIN_CHARS` character to
maintain column alignment. The text panel handles full-width characters via its
word-wrapping logic (using a `wcwidth`-aware string width function if needed,
or a simpler heuristic that treats characters in the CJK Unified Ideographs
range as width-2).

### Non-UTF8 locale

If `process.env.LANG` does not contain `UTF` (case-insensitive check), the
terminal may not support Unicode rendering. In this case:

- **Rain characters**: fall back to ASCII printable characters -- digits (`0-9`),
  uppercase letters (`A-Z`), and symbols (`!@#$%^&*`). The katakana half-width
  characters from `RAIN_CHARS` are not used.
- **Divider**: use `|` (ASCII pipe, U+007C) instead of `\u2502` (BOX DRAWINGS
  LIGHT VERTICAL).

This detection is performed once at TUI startup and stored as a boolean flag
(e.g. `useAsciiOnly`) that the rain engine and divider renderer consult. The
text panel is unaffected -- it displays whatever characters the agent produces.

## 11. Testing strategy

### Unit tests

- **`observe-tui-types.ts`**: `calculateTuiLayout()` tested for various terminal
  sizes, edge cases (very narrow, very short), fraction rounding.
- **`observe-tui-rain.ts`**: `RainEngine` tested in isolation:
  - Enqueue tokens, verify they appear in `tick()` output
  - Verify idle mode activates after empty frames
  - Verify queue capacity enforcement
  - Verify column cooldown prevents clumping
  - Verify drops despawn after falling off-screen
- **`observe-tui-text-panel.ts`**: `TextPanel` tested in isolation:
  - Event formatting matches expected ANSI output
  - Word wrapping at various widths
  - Ring buffer eviction when at capacity
  - Session label prefixing in multi-session mode
  - `text_delta` accumulation across multiple events
- **`observe-command.ts`**: Test mode selection logic (TTY detection, flag
  combinations).

All TUI module tests are pure unit tests that verify returned strings -- no
terminal or screen interaction needed.

### Integration test

A single integration test that:
1. Creates an `ObserveTui` with a mock stdout (writable stream capturing output)
2. Pushes a sequence of events
3. Verifies the output contains expected ANSI sequences
4. Calls `destroy()` and verifies cleanup sequences are written

### Visual testing

Manual testing with the daemon running real sessions. No automated visual
regression testing in v1.

## 12. Implementation plan

### Phase 1: Types and layout (small, no behavior)
- Create `observe-tui-types.ts` with all types, constants, `calculateTuiLayout()`
- Add unit tests for layout calculation

### Phase 2: Rain engine (self-contained)
- Create `observe-tui-rain.ts` with `createRainEngine()`
- Port `RAIN_CHARS` and `randChar()` from `mux-splash.ts`
- Implement token queue, drop lifecycle, column cooldown
- Add unit tests for rain mechanics

### Phase 3: Text panel (self-contained)
- Create `observe-tui-text-panel.ts` with `createTextPanel()`
- Implement event formatting, word wrapping, ring buffer
- Add unit tests for formatting and wrapping

### Phase 4: TUI orchestrator
- Create `observe-tui.ts` with `createObserveTui()`
- Implement screen setup/teardown, frame loop, resize handling
- Wire rain engine and text panel together

### Phase 5: Integration
- Modify `observe-command.ts`: add `--tui`/`--no-tui` flags
- Add `ObserveEventSink` interface
- Wire TUI into the WebSocket event handler
- Update command spec and help text

### Phase 6: Polish
- Tune spawn rates, speeds, and colors for visual appeal
- Add status bar with live metrics
- Test on various terminal sizes and emulators
- Verify cleanup on all exit paths (Ctrl+C, session end, WS disconnect, error)
