# Design: Observe TUI v2 -- Rain Enhancements and Text Panel Improvements

## Overview

This document specifies two sets of enhancements to the observe TUI. **Part A**
adds visual richness to the rain panel: word drops that materialize and dissolve,
phase-driven color transitions, and a narrower rain column. **Part B** improves
the text panel's signal-to-noise ratio: accumulating tool input into clean
summaries, extracting thinking text from raw events, filtering zero-value
protocol noise, and enriching the status bar with phase and model information.

All changes are additive to the existing architecture. The module boundaries
remain the same: `observe-tui-types.ts` (types and constants),
`observe-tui-rain.ts` (rain engine), `observe-tui-text-panel.ts` (text panel),
and `observe-tui.ts` (orchestrator). No new files are needed.

---

## 1. Types and Data Structures

### 1.1 New types in `observe-tui-types.ts`

```typescript
// ---------------------------------------------------------------------------
// Agent phase (rename/expand existing)
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
// Word drop types (Part A1)
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
}

// ---------------------------------------------------------------------------
// Tool accumulator types (Part B1)
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
// Filtered raw event types (Part B3)
// ---------------------------------------------------------------------------

/** Raw SSE event types that are suppressed in --raw mode (shown only in --debug). */
export const SUPPRESSED_RAW_EVENTS: ReadonlySet<string> = new Set([
  'content_block_stop',
  'message_stop',
  'ping',
  'signature_delta',
]);
```

### 1.2 Extended `SessionState`

Add two fields to the existing `SessionState` interface:

```typescript
export interface SessionState {
  // ... existing fields ...

  /** Name of the tool currently being invoked (null when not in tool_use phase). */
  currentToolName: string | null;
}
```

### 1.3 Extended `ObserveTuiOptions`

```typescript
export interface ObserveTuiOptions {
  readonly raw: boolean;
  readonly showLabel: boolean;
  /** Show absolutely all events including protocol noise. Implies raw. */
  readonly debug: boolean;
}
```

### 1.4 New SGR constants

```typescript
// Add to the SGR object:

// Word drop colors (brighter than regular rain to stand out)
WORD_TEXT:  '\x1b[1;38;2;150;255;150m',  // bright green (text fragments)
WORD_TOOL:  '\x1b[1;38;2;100;255;255m',  // bright cyan (tool names)
WORD_PHASE: '\x1b[1;38;2;255;255;180m',  // bright warm yellow (phase labels)
WORD_MODEL: '\x1b[1;38;2;180;180;255m',  // bright lavender (model name)

// Thinking text in text panel (Part B2)
TEXT_THINKING: '\x1b[2;3;38;2;0;200;100m',  // dim italic green

// Status bar phase indicators
STATUS_PHASE_THINKING: '\x1b[38;2;0;255;70m',   // green
STATUS_PHASE_TOOL:     '\x1b[38;2;0;200;255m',   // cyan
STATUS_PHASE_IDLE:     '\x1b[38;2;80;80;80m',     // dim grey
STATUS_PHASE_ERROR:    '\x1b[38;2;255;70;70m',    // red
```

### 1.5 Updated constants

```typescript
/** Fraction of terminal width allocated to the rain panel. */
// Changed from 0.27 to 0.18 (Part A3)
export const RAIN_WIDTH_FRACTION = 0.18;
```

---

## 2. Rain Engine Changes (`observe-tui-rain.ts`)

### 2.1 Word drops (A1)

#### Extended `RainEngine` interface

```typescript
export interface RainEngine {
  // ... existing methods ...

  /**
   * Queue a word for materialization in the rain panel.
   * The engine will display it when space is available.
   * Words that cannot be placed (too wide, too many active) are silently dropped.
   */
  enqueueWord(word: string, source: WordDropSource): void;

  /**
   * Set the current agent phase. Affects the default colorKind
   * for newly spawned drops (A2).
   */
  setPhase(phase: AgentPhase): void;
}
```

#### Word drop lifecycle implementation

The rain engine maintains:

- `activeWordDrops: WordDrop[]` -- currently visible word drops (max 2).
- `wordQueue: Array<{ word: string; source: WordDropSource }>` -- pending words
  (max 4; oldest dropped when full).

**Spawn check** (called each frame before regular drop spawning):

1. If `activeWordDrops.length >= 2`, skip.
2. If `wordQueue` is empty, skip.
3. Dequeue the oldest word. Truncate to `rainCols - 2` characters (leave margin).
4. Pick a random row in `[2, rows - 3]` (avoid top/bottom edges).
5. Pick a random column in `[1, rainCols - word.length - 1]`.
6. Check for overlap with existing word drops: no word drop may occupy any cell
   within a 2-row vertical gap and overlapping column range of another word drop.
   If overlap detected, try up to 3 alternative positions. If all fail, re-queue
   the word (push back to front of queue) and skip this frame.
7. Create a `WordDrop` in `'forming'` phase.

**Phase transitions** (timing at 15fps):

| Phase | Duration | Behavior |
|-------|----------|----------|
| `forming` | `word.length` frames (1 char/frame), min 5, max 10 | Characters appear left-to-right. `revealedCount` increments each frame. |
| `holding` | 45-90 frames (3-6 seconds) | All characters visible. Rendered brighter than surrounding rain. Random hold duration chosen at formation. |
| `dissolving` | `word.length` frames, min 10, max 15 | Characters release in random order. Each released character spawns a regular `RainDrop` at that position (inheriting the character and a matching `colorKind`), creating a "dripping away" effect. |

**Dissolution detail**: When transitioning to `'dissolving'`, build
`dissolveOrder` as a Fisher-Yates shuffle of `[0, 1, ..., word.length-1]`. Each
frame, the next index in `dissolveOrder` is "released": that character position
becomes invisible in the word drop, and a new `RainDrop` is spawned at
`(col + charIndex, row)` with the word's character and an appropriate
`colorKind` derived from the word's `source`. The spawned drop has `headRow =
row` (it starts where the character was) and falls normally from there.

**Rendering**: Word drop characters are rendered after regular drops (so they
appear on top). Each visible character is positioned with CSI and colored
according to the word's `source`:

```typescript
const WORD_COLORS: Record<WordDropSource, string> = {
  text:  SGR.WORD_TEXT,
  tool:  SGR.WORD_TOOL,
  phase: SGR.WORD_PHASE,
  model: SGR.WORD_MODEL,
};
```

During the `forming` phase, unrevealed characters are not rendered (the
background rain shows through). During `dissolving`, dissolved characters are
also not rendered (the spawned rain drops take over).

#### Word sources (priority feeding from orchestrator)

The orchestrator calls `rainEngine.enqueueWord()` in `pushEvents()`:

1. **tool_use** with non-empty `toolName`: enqueue `toolName` with source `'tool'`.
   Only enqueue when `toolName` is non-empty (the `content_block_start` event,
   not the `input_json_delta` events which have `toolName: ''`).
2. **message_start**: enqueue `model` with source `'model'`.
3. **Phase transitions**: when `SessionState.phase` changes, enqueue the new
   phase label with source `'phase'`:
   - `'thinking'` -> enqueue `"thinking..."`
   - `'tool_use'` -> (skip, the tool_use handler above already enqueues the tool name)
   - `'idle'` -> (skip, not interesting)
4. **text_delta**: enqueue the first word (first whitespace-delimited token) of
   the first `text_delta` after a `message_start`, if it is 4+ characters.
   Use a per-session flag `firstTextEnqueued` to avoid flooding.

### 2.2 Phase-driven rain color transitions (A2)

Add a `currentPhase: AgentPhase` field to the rain engine's internal state,
initialized to `'idle'`. The orchestrator calls `setPhase()` whenever the
aggregate phase changes.

**Aggregate phase computation** (in the orchestrator): the "dominant" phase
across all active sessions. Priority: `error > tool_use > thinking > idle`.
Computed from the `sessions` map whenever `updateSessionState()` changes a
session's phase.

**Effect on drop spawning**: when the engine spawns a new drop (whether from the
token queue or as an idle drop), the `colorKind` is determined as follows:

```typescript
function resolveDropColor(token: RainToken | undefined, phase: AgentPhase): RainColorKind {
  // If we have a real token, use its kind
  if (token) return token.kind;

  // For idle/ambient drops, color is phase-driven
  switch (phase) {
    case 'thinking': return 'text';     // green
    case 'tool_use': return 'tool';     // cyan
    case 'error':    return 'error';    // red
    case 'idle':     return 'idle';     // dim green
  }
}
```

This means:
- During `thinking`, ambient rain glows green.
- During `tool_use`, ambient rain shifts to cyan. Token-derived drops (from the
  queue) keep their original color, but new idle drops are cyan.
- During `error`, a red burst of ambient drops appears.
- During `idle`, drops are very dim green (existing behavior).

**Existing drops are not recolored**. The transition is gradual: old drops
continue with their original color while new drops spawn with the phase color.
Over 1-2 seconds, the panel naturally shifts as old drops fall off-screen and
new phase-colored drops replace them.

### 2.3 Reduced rain width (A3)

Change `RAIN_WIDTH_FRACTION` from `0.27` to `0.18` in `observe-tui-types.ts`.
No other code changes needed -- `calculateTuiLayout()` already uses this
constant. The text panel gains approximately 9 more columns on an 100-column
terminal (from ~73 to ~82).

---

## 3. Text Panel Changes (`observe-tui-text-panel.ts`)

### 3.1 Tool input accumulation (B1)

#### Extended `TextPanel` interface

```typescript
export interface TextPanel {
  // ... existing methods ...

  /**
   * Flush any pending tool accumulator for the given session.
   * Called when a non-tool_use event arrives or on session end,
   * signaling that the tool call is complete.
   */
  flushToolAccumulator(label: number, showLabel: boolean): void;
}
```

#### Internal state

Add a `Map<number, ToolAccumulator>` keyed by session label, alongside the
existing `Map<number, SessionPartialLine>` for text accumulation.

#### Event handling changes

The `appendEvent()` method's `tool_use` case changes from rendering each
fragment immediately to accumulating:

```typescript
case 'tool_use': {
  if (!options.raw) return;

  let acc = toolAccumulators.get(label);

  if (event.toolName !== '') {
    // content_block_start: new tool invocation.
    // Flush any previous accumulator first.
    flushToolAccumulator(label, options.showLabel);

    acc = { toolName: event.toolName, inputBuffer: '', hasInput: false };
    toolAccumulators.set(label, acc);

    // Show a "working..." indicator line
    const { prefix } = labelInfo(label, options.showLabel);
    const ansi = `${prefix}${SGR.TEXT_TOOL}\u25B8 ${event.toolName}${SGR.TEXT_DIM} working...${SGR.RESET}`;
    lines.push(makeLine(ansi));
  } else if (acc) {
    // input_json_delta: accumulate
    acc.inputBuffer += event.inputDelta;
    acc.hasInput = true;
  }
  break;
}
```

For all other event kinds, `appendEvent()` calls `flushToolAccumulator()` before
processing (so the accumulated tool input is rendered before the next event
appears):

```typescript
// At the top of appendEvent(), before the switch:
if (event.kind !== 'tool_use') {
  flushToolAccumulator(label, options.showLabel);
}
```

#### Flush logic

`flushToolAccumulator()` does the following:

1. If no accumulator exists for the session, return.
2. Remove the accumulator from the map.
3. If `!hasInput`, return (tool was just started, no input to render -- the
   "working..." line is already in the buffer).
4. Try to parse `inputBuffer` as JSON.
5. **For `execute_code` tools**: extract the `code` field from the parsed JSON.
   If found, render the code as a multi-line block with `TEXT_TOOL_DIM` color,
   each line word-wrapped and indented. Prefix the block with a tool header line.
6. **For other tools**: render a compact key=value summary on one or two lines.
   Each key-value pair from the parsed JSON is formatted as `key=value`, values
   truncated to 40 chars. Pairs are joined with ` | ` separators.
7. If JSON parsing fails, render the raw accumulated string truncated to
   `textCols`.

**Rendered format for `execute_code`**:

```
[2]  execute_code
[2]    const result = await fetch('https://...');
[2]    const data = await result.json();
[2]    console.log(data.items.length);
```

Header line in `TEXT_TOOL`, code lines in `TEXT_TOOL_DIM` with 2-space indent
(plus label prefix indent).

**Rendered format for other tools**:

```
[2]  read_file  path=/src/index.ts
```

Or for multi-argument tools:

```
[2]  search_files  path=/src | pattern=TODO | include=*.ts
```

### 3.2 Thinking text extraction (B2)

Thinking deltas arrive as `raw` events with `eventType === 'content_block_delta'`
and a JSON `data` payload containing `{"type":"thinking_delta","thinking":"..."}`.

#### Detection and extraction

In the `raw` event handler, before the generic raw rendering, add a check:

```typescript
case 'raw': {
  if (!options.raw) return;

  // B2: Extract thinking text from content_block_delta events
  if (event.eventType === 'content_block_delta') {
    const thinkingText = extractThinkingText(event.data);
    if (thinkingText !== null) {
      handleThinkingDelta(label, thinkingText, options.showLabel);
      return;
    }
  }

  // B3: Filter zero-value protocol events
  if (!options.debug && SUPPRESSED_RAW_EVENTS.has(event.eventType)) {
    return;
  }

  handleRaw(label, event.eventType, event.data, options.showLabel);
  break;
}
```

#### `extractThinkingText()` helper

```typescript
function extractThinkingText(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const delta = parsed['delta'] as Record<string, unknown> | undefined;
    if (delta && delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
      return delta['thinking'] as string;
    }
  } catch {
    // Not JSON or wrong shape -- not a thinking delta
  }
  return null;
}
```

#### `handleThinkingDelta()`

Routes the thinking text through the same partial-line accumulation as
`text_delta`, but with a distinct color (`TEXT_THINKING`). This requires a
separate partial line map (or a flag on `SessionPartialLine` indicating the
current style).

**Approach**: Use the same `SessionPartialLine` mechanism but with a separate
map (`thinkingPartials: Map<number, SessionPartialLine>`) to avoid interleaving
with regular text output. When a thinking delta arrives:

1. Flush any regular text partial for this session (thinking and text don't
   interleave within a single content block in practice, but this ensures clean
   boundaries).
2. Accumulate into the thinking partial, using the same newline-splitting logic
   as `handleTextDelta()`.
3. When rendering finalized thinking lines, use `TEXT_THINKING` instead of
   `TEXT_NORMAL`.

When a non-thinking event arrives for a session that has an active thinking
partial, flush the thinking partial first.

### 3.3 Filter zero-value protocol events (B3)

In `--raw` mode, the following event types are suppressed:

| Event type | Reason |
|------------|--------|
| `content_block_stop` | End-of-block marker, no content |
| `message_stop` | End-of-message marker, no content |
| `ping` | SSE heartbeat |
| `signature_delta` | Cryptographic signature fragments |

These are identified by their `eventType` field on `raw` events.

A new `--debug` flag on the observe command shows absolutely everything,
including suppressed events. `--debug` implies `--raw`.

#### Command-line changes

In `observe-command.ts`, add a `debug` option:

```typescript
options: {
  // ... existing ...
  debug: { type: 'boolean' },
},
```

The `ObserveTuiOptions` gains `debug: boolean`. The `TextPanelOptions` also
gains `debug: boolean`.

The filtering logic lives in `appendEvent()` as shown in section 3.2 above.

### 3.4 Enriched status bar (B4)

The status bar currently shows: `sessions N/M | tokens NNk | tok/s NN.N | queue N | Ctrl+C exit`

The enriched version adds model name and agent phase:

```
sessions 1/1 | claude-sonnet-4-6 | THINKING | tokens 415 | tok/s 63.5 | Ctrl+C exit
```

During tool use, the current tool name is shown:

```
sessions 1/1 | claude-sonnet-4-6 | TOOL: execute_code | tokens 415 | tok/s 63.5 | Ctrl+C exit
```

#### Implementation

The `AggregateMetrics` interface gains:

```typescript
interface AggregateMetrics {
  // ... existing fields ...
  /** Model name from the most recently active session. */
  model: string | null;
  /** Dominant agent phase across active sessions. */
  phase: AgentPhase;
  /** Current tool name (when phase is tool_use). */
  currentToolName: string | null;
}
```

The `computeMetrics()` function computes `model` (from the most recently active
non-ended session with a non-null model), `phase` (dominant across sessions:
`error > tool_use > thinking > idle`), and `currentToolName` (from the session
in `tool_use` phase, or null).

The `renderStatusBar()` function inserts model and phase segments between
sessions and tokens:

```typescript
// Model name (if known)
if (metrics.model) {
  parts.push(
    `${SGR.STATUS_VALUE}${metrics.model}${SGR.RESET}`
  );
}

// Phase indicator
const phaseColor = {
  thinking: SGR.STATUS_PHASE_THINKING,
  tool_use: SGR.STATUS_PHASE_TOOL,
  idle:     SGR.STATUS_PHASE_IDLE,
  error:    SGR.STATUS_PHASE_ERROR,
}[metrics.phase];

const phaseLabel = metrics.phase === 'tool_use' && metrics.currentToolName
  ? `TOOL: ${metrics.currentToolName}`
  : metrics.phase.toUpperCase();

parts.push(`${phaseColor}${phaseLabel}${SGR.RESET}`);
```

---

## 4. Orchestrator Changes (`observe-tui.ts`)

### 4.1 Phase tracking and rain communication

The orchestrator already tracks `SessionState.phase` via `updateSessionState()`.
The changes needed:

1. **Extend `updateSessionState()`** to also track `currentToolName`:

   ```typescript
   case 'tool_use':
     state.phase = 'tool_use';
     state.toolCount++;
     if (event.toolName !== '') {
       state.currentToolName = event.toolName;
     }
     break;
   ```

   And clear `currentToolName` on phase transitions away from `tool_use`:

   ```typescript
   case 'text_delta':
     state.phase = 'thinking';
     state.currentToolName = null;
     break;
   case 'message_end':
     state.phase = 'idle';
     state.currentToolName = null;
     break;
   ```

2. **Compute aggregate phase** after each event batch and call
   `rainEngine.setPhase()`:

   ```typescript
   // In pushEvents(), after processing all events:
   const dominantPhase = computeDominantPhase(sessions);
   rainEngine.setPhase(dominantPhase);
   ```

   ```typescript
   function computeDominantPhase(sessions: Map<number, SessionState>): AgentPhase {
     let dominant: AgentPhase = 'idle';
     for (const s of sessions.values()) {
       if (s.ended) continue;
       if (s.phase === 'tool_use' && dominant !== 'error') dominant = 'tool_use';
       if (s.phase === 'thinking' && dominant === 'idle') dominant = 'thinking';
     }
     return dominant;
   }
   ```

   Note: `'error'` phase is set transiently when an error event arrives and
   auto-clears after 30 frames (2 seconds). This is tracked as a separate
   counter in the orchestrator, not in SessionState.phase.

3. **Enqueue word drops** in `pushEvents()`:

   ```typescript
   for (const event of events) {
     const previousPhase = state.phase;
     updateSessionState(state, event);

     // Word drops (A1)
     if (event.kind === 'tool_use' && event.toolName !== '') {
       rainEngine.enqueueWord(event.toolName, 'tool');
     }
     if (event.kind === 'message_start') {
       rainEngine.enqueueWord(event.model, 'model');
       state._firstTextEnqueued = false; // reset for this message
     }
     if (event.kind === 'text_delta' && !state._firstTextEnqueued) {
       const firstWord = event.text.trim().split(/\s+/)[0];
       if (firstWord && firstWord.length >= 4) {
         rainEngine.enqueueWord(firstWord, 'text');
         state._firstTextEnqueued = true;
       }
     }
     if (previousPhase !== state.phase && state.phase === 'thinking') {
       rainEngine.enqueueWord('thinking...', 'phase');
     }

     // ... existing rain token and text panel forwarding ...
   }
   ```

### 4.2 Tool accumulator flushing on session end

When `sessionEnded()` is called on the orchestrator, call
`textPanel.flushToolAccumulator(label, showLabel)` before calling
`textPanel.sessionEnded()` to ensure any pending tool input is rendered.

### 4.3 Debug flag threading

The `ObserveTuiOptions.debug` field is threaded through to `TextPanelOptions`
when calling `textPanel.appendEvent()`:

```typescript
textPanel.appendEvent(label, event, { raw: raw || debug, showLabel, debug });
```

### 4.4 Status bar enrichment

The `computeMetrics()` function is extended to include model, phase, and
currentToolName from the session state map (see section 3.4).

---

## 5. Implementation Phases

### Phase 1: Foundation types and constants (small, safe)

**Files changed**: `observe-tui-types.ts`

1. Add `AgentPhase` type alias.
2. Add `WordDrop`, `WordDropPhase`, `WordDropSource` types.
3. Add `ToolAccumulator` type.
4. Add `SUPPRESSED_RAW_EVENTS` set.
5. Add new SGR constants (word drop colors, thinking text, status phase).
6. Change `RAIN_WIDTH_FRACTION` from `0.27` to `0.18`.
7. Add `currentToolName` field to `SessionState`.
8. Add `debug` to `ObserveTuiOptions`.

**Tests**: Update layout tests that assert specific column widths to reflect the
new rain fraction. Add a test that `SUPPRESSED_RAW_EVENTS` contains the expected
event types.

### Phase 2: Phase-driven rain colors (A2) and rain width (A3)

**Files changed**: `observe-tui-rain.ts`, `observe-tui.ts`

1. Add `setPhase()` to the rain engine and internal `currentPhase` state.
2. Modify `spawnDrops()` to use `resolveDropColor()` with the current phase.
3. In the orchestrator, compute dominant phase and call `setPhase()`.
4. Update `updateSessionState()` to track `currentToolName` and clear it
   appropriately.

**Tests**:
- Rain engine: verify that `setPhase('tool_use')` causes idle drops to spawn
  with `colorKind: 'tool'`.
- Rain engine: verify that token-derived drops retain their original color
  regardless of phase.
- Orchestrator: verify `computeDominantPhase()` priority ordering.

### Phase 3: Word drops (A1)

**Files changed**: `observe-tui-rain.ts`, `observe-tui.ts`

1. Add `enqueueWord()` to rain engine interface and implement word queue.
2. Implement word drop spawn logic with overlap checking.
3. Implement three-phase lifecycle (forming, holding, dissolving).
4. Implement dissolution -> rain drop conversion.
5. Implement word drop rendering (after regular drops).
6. In the orchestrator, enqueue words from tool_use, message_start, phase
   transitions, and first text_delta.

**Tests**:
- Word drop lifecycle: formation reveals characters left-to-right.
- Word drop lifecycle: hold phase lasts the expected number of frames.
- Word drop lifecycle: dissolution spawns rain drops at character positions.
- Overlap detection: second word drop does not overlap the first.
- Queue capacity: excess words are dropped, not buffered indefinitely.
- Truncation: words wider than the rain panel are truncated.

### Phase 4: Tool input accumulation (B1)

**Files changed**: `observe-tui-text-panel.ts`

1. Add `ToolAccumulator` map alongside the existing partials map.
2. Modify `tool_use` event handler to accumulate instead of rendering per-fragment.
3. Implement `flushToolAccumulator()` with JSON parsing and formatted rendering.
4. Add the flush call before non-tool_use events in `appendEvent()`.
5. Add `execute_code` special-case formatting (extract code field).

**Tests**:
- Accumulation: multiple `inputDelta` fragments are joined correctly.
- Flush on next event: tool summary appears before the next text_delta.
- `execute_code` formatting: code field is extracted and rendered as multi-line block.
- Other tools: key=value summary is rendered compactly.
- JSON parse failure: raw accumulated string is shown truncated.
- Session end flushes pending accumulator.

### Phase 5: Thinking extraction and event filtering (B2, B3)

**Files changed**: `observe-tui-text-panel.ts`, `observe-tui.ts`,
`observe-command.ts`

1. Implement `extractThinkingText()` helper.
2. Add thinking partial line map and `handleThinkingDelta()`.
3. Add suppression logic for `SUPPRESSED_RAW_EVENTS` in the `raw` case.
4. Add `--debug` flag to `observe-command.ts` argument parsing.
5. Thread `debug` through `ObserveTuiOptions` and `TextPanelOptions`.

**Tests**:
- Thinking text: `content_block_delta` with `thinking_delta` type renders as
  accumulated text with `TEXT_THINKING` color.
- Thinking text: non-JSON data falls through to regular raw handling.
- Event filtering: `content_block_stop` is suppressed in raw mode.
- Event filtering: `content_block_stop` is shown in debug mode.
- Debug flag: implies raw mode for all event routing.

### Phase 6: Status bar enrichment (B4)

**Files changed**: `observe-tui.ts`

1. Extend `AggregateMetrics` with `model`, `phase`, `currentToolName`.
2. Extend `computeMetrics()` to populate new fields from session state.
3. Extend `renderStatusBar()` to render model, phase indicator, and tool name.
4. Use phase-specific colors for the status bar phase indicator.

**Tests**:
- Status bar renders model name when available.
- Status bar shows `TOOL: execute_code` during tool_use phase.
- Status bar shows `THINKING` during thinking phase.
- Status bar shows `IDLE` in dim grey when no active sessions.
- Phase color matches the expected SGR sequence.

---

## 6. Testing Strategy

### Unit testing approach

All new logic is testable through the existing factory-function pattern. The rain
engine accepts an injectable `RainRng` for deterministic behavior. The text panel
is tested by calling `appendEvent()` and inspecting `render()` output.

### New test helpers

```typescript
/** Create a tool_use event with a tool name (content_block_start style). */
function toolStart(toolName: string): TokenStreamEvent {
  return { kind: 'tool_use', toolName, inputDelta: '', timestamp: Date.now() };
}

/** Create a tool_use event with input delta (input_json_delta style). */
function toolInput(inputDelta: string): TokenStreamEvent {
  return { kind: 'tool_use', toolName: '', inputDelta, timestamp: Date.now() };
}

/** Create a raw event simulating a thinking_delta. */
function thinkingDelta(text: string): TokenStreamEvent {
  const data = JSON.stringify({
    type: 'content_block_delta',
    delta: { type: 'thinking_delta', thinking: text },
  });
  return { kind: 'raw', eventType: 'content_block_delta', data, timestamp: Date.now() };
}
```

### Rain engine word drop tests

Word drop tests use the seeded RNG to control placement and timing:

```typescript
it('word drop forms left-to-right over word.length frames', () => {
  const rng = createSeededRng([0.5, 0.5, 0.5, ...]); // deterministic positioning
  const layout = calculateTuiLayout(80, 20);
  const engine = createRainEngine({ layout, rng });

  engine.enqueueWord('hello', 'tool');

  // Tick through formation phase
  for (let i = 0; i < 5; i++) {
    engine.tick();
    const output = engine.render();
    // Verify progressively more characters are visible
    // (exact positions depend on seeded RNG values)
  }
});
```

### Text panel tool accumulation tests

```typescript
it('accumulates tool input and renders summary on flush', () => {
  const panel = createTextPanel(0, 80, 20);
  const opts: TextPanelOptions = { raw: true, showLabel: false, debug: false };

  panel.appendEvent(0, toolStart('read_file'), opts);
  panel.appendEvent(0, toolInput('{"path":"/src/'), opts);
  panel.appendEvent(0, toolInput('index.ts"}'), opts);

  // Next non-tool event triggers flush
  panel.appendEvent(0, textDelta('file contents here\n'), opts);

  const output = stripAnsi(panel.render());
  expect(output).toContain('read_file');
  expect(output).toContain('path=/src/index.ts');
});
```

### Integration-level testing

The orchestrator tests in `observe-tui.test.ts` already test
`updateSessionState()` and `extractRainTokens()` as exported functions. The new
`computeDominantPhase()` function should also be exported for direct testing.

### Visual regression

No automated visual tests. Manual verification with the daemon using:
- `ironcurtain observe --all --raw` -- verify tool accumulation and thinking text
- `ironcurtain observe --all --debug` -- verify suppressed events reappear
- `ironcurtain observe <label>` -- verify word drops and phase color transitions
- Resize terminal during observation to verify word drops handle resize gracefully

---

## 7. Migration Notes

### Backward compatibility

- The `--debug` flag is additive; existing `--raw` behavior changes only in that
  4 event types are now suppressed (B3). This is intentional signal improvement.
- The rain width change (A3) is a visual-only change with no API impact.
- The `SessionState.currentToolName` field is additive and defaults to `null`.

### SSE extractor consideration (B2)

The thinking text extraction (B2) operates entirely within the TUI's text panel
by parsing the `data` field of `raw` events. An alternative approach would be to
add `thinking_delta` as a first-class `TokenStreamEvent` kind in the SSE
extractor. This design intentionally avoids that change because:

1. The extractor's `raw` fallback already correctly delivers thinking deltas.
2. Adding a new event kind to `TokenStreamEvent` is a cross-cutting change that
   affects the bus, the web UI, the plain renderer, and all consumers.
3. The TUI is currently the only consumer that needs thinking text rendered
   differently.

If thinking text becomes important to other consumers (e.g., the web UI), the
extractor should be extended at that point and the TUI's extraction logic can be
simplified to handle the new event kind directly.

### TextPanelOptions expansion

Adding `debug` to `TextPanelOptions` means all call sites that construct
options must include the new field. Since `TextPanelOptions` is only
constructed in two places (the orchestrator's `pushEvents()` and test helpers),
this is a small change. Test helpers should be updated to include
`debug: false` by default.
