# Web UI Matrix Rain — Login Page Cinematic

## 1. Overview

Replace the plain gradient background on the web UI auth-token page with a Canvas 2D Matrix rain animation that
assembles falling katakana characters into the "IronCurtain" wordmark at screen center, then transitions to a
low-density ambient rain that persists behind the login form until the user authenticates.

This is a direct visual port of the terminal splash in `src/mux/mux-splash.ts` (same pixel font, same target-locking
drop algorithm, same color gradient) rendered through HTML5 Canvas at retina-native resolution, then extended with
an "ambient" second phase that the terminal version does not have because its splash is one-shot.

The animation is a sibling to §3.1 of `docs/brainstorm/visualization.md` ("Data-Driven Matrix Rain"), but scoped
down: no live token ingestion, no FSM reactivity, no theme coupling. It is a pre-auth cinematic that establishes
atmosphere. Once the user connects, the canvas unmounts and the existing dashboard renders normally.

### Animation phases

| Phase | Timing | Visual |
|-------|--------|--------|
| Assembly | 0 – 2.5s | Full-bleed Matrix rain; drops fall into target positions to form the "IronCurtain" wordmark in the viewport center |
| Hold | 2.5 – 4.0s | Wordmark held static; briefly dims (opacity 1.0 → 0.55) |
| Ambient | 4.0s+ | Wordmark held at 0.55 opacity; new free-falling drops at low density, loops indefinitely |

Login card fades in at ~2.5s (coinciding with assembly completion) via the existing `animate-fade-in` keyframe with
a 2300ms `animation-delay`. The card uses `backdrop-blur-md` and a semi-transparent background so the rain remains
visible but form text stays legible.

Canvas unmounts when `appState.hasToken === true` (same condition that currently hides the auth gate).

## 2. Module structure

All new files live in the web-ui package (`packages/web-ui/`). The design splits into three layers with narrow,
single-responsibility interfaces:

```
packages/web-ui/
  src/
    lib/
      matrix-rain/
        engine.ts             -- Pure engine: state machine, drops, layout, tick advance.
                                   NO DOM, NO Canvas, NO Svelte. Produces FrameState snapshots.
        renderer.ts           -- Pure drawing: FrameState + ctx -> pixels. NO engine coupling.
        font.ts               -- FONT dict (character glyph grids) ported from mux-splash.ts
        types.ts              -- RainPhase, EngineOptions, LayoutPlan, FrameState, Drop, etc.
        layout.ts             -- computeLayout(), scaleForViewport() — pure math
        palette.ts            -- Color helpers (hex strings for head/near/far/locked)
      components/
        features/
          matrix-rain.svelte  -- Thin glue: canvas binding, RAF loop, ResizeObserver,
                                   lifecycle. Calls engine.step() -> getFrame() -> drawFrame(ctx).
  test/
    matrix-rain-engine.test.ts
    matrix-rain-renderer.test.ts
    matrix-rain-layout.test.ts
```

### Three-layer architecture

The split enforces clean boundaries:

1. **Engine (`engine.ts`)** — pure logic. Owns the state machine, drop positions, tick advance, phase
   transitions. Never touches the DOM. Never allocates a `CanvasRenderingContext2D`. Emits a plain-data
   `FrameState` snapshot describing what should be drawn. Testable with a seeded RNG and no browser.
2. **Renderer (`renderer.ts`)** — pure drawing. A single exported function `drawFrame(ctx, frame, layout)`
   consumes a `FrameState` and paints it. No knowledge of the engine, no access to internal engine state.
   Testable with a mock `CanvasRenderingContext2D` that records calls.
3. **Svelte wrapper (`matrix-rain.svelte`)** — thin glue. Owns the canvas element, RAF loop, ResizeObserver,
   lifecycle. Calls `engine.step(now)`, then `engine.getFrame()`, then `drawFrame(ctx, frame, layout)`.

The narrow interface between engine and renderer is `FrameState` — a plain-data description of drawable
content. Neither side knows about the other.

### Why the split matters

- **Testability.** Each layer is unit-testable in isolation. The engine uses a deterministic RNG, the
  renderer uses a mock context, the wrapper is verified visually + in integration tests.
- **Retargetability.** The same engine + renderer pair can later power a Storybook demo, a marketing-page
  Astro island, or the full-screen idle-state rain from `visualization.md` §3.1. Swapping Svelte for
  another framework touches only the wrapper.
- **Clarity of responsibility.** When a bug appears, the layer it lives in is obvious: wrong positions =
  engine; wrong pixels = renderer; flicker on resize = wrapper.

## 3. Engine API

```typescript
// matrix-rain/types.ts

/** Visible lifecycle phases for the animation. */
export type RainPhase = 'assembly' | 'hold' | 'ambient';

/** Internal dimensions are expressed in logical CSS pixels. DPR is applied by the Svelte wrapper. */
export interface EngineOptions {
  /** Pre-computed layout. Never null here — the wrapper has already validated viewport fits. */
  readonly layout: LayoutPlan;
  /** The word to assemble. Default: "IronCurtain". */
  readonly word?: string;
  /** Seed for deterministic tests. Default: Math.random-based. */
  readonly rng?: () => number;
  /** If true, skip assembly; emit FrameState with locked wordmark only, no ambient drops. */
  readonly reducedMotion?: boolean;
  /**
   * Color palette. Default: phosphor green matching mux-splash.ts:
   *   head: '#B4FFB4', near: '#00FF46', far: '#007800', locked: '#00C800'.
   */
  readonly palette?: Readonly<RainPalette>;
}

export interface RainPalette {
  readonly head: string;   // bright head character
  readonly near: string;   // 1-2 chars behind head
  readonly far: string;    // tail
  readonly locked: string; // wordmark cells after assembly
}

/** Plain-data snapshot of what to draw this frame. Produced by the engine, consumed by the renderer. */
export interface FrameState {
  readonly phase: RainPhase;
  /** Global alpha for the entire frame. Renderer applies once, resets at end. */
  readonly globalAlpha: number;
  /** Locked wordmark cells. Drawn LAST so they occlude overlapping drops. */
  readonly lockedCells: ReadonlyArray<LockedCellSnapshot>;
  /** Active falling drops (assembly unlocked drops + ambient drops). Empty during hold. */
  readonly drops: ReadonlyArray<DropSnapshot>;
}

export interface LockedCellSnapshot {
  readonly col: number;   // cell-coordinate column (wordmark-relative is OK; renderer offsets by layout.originX/Y)
  readonly row: number;
  readonly color: string; // hex; typically palette.locked, but the engine may progressively reveal during assembly
  /**
   * 0.0..1.0. For the assembly phase the engine MAY emit partially-revealed locked cells (e.g. as drops
   * land). For hold/ambient this is 1.0; the frame-level globalAlpha handles the dim.
   */
  readonly alpha: number;
}

export interface DropSnapshot {
  readonly col: number;
  readonly headRow: number; // may be fractional for ambient drops
  /** Trail characters from head (index 0) to tail. Renderer draws each with its color. */
  readonly trail: ReadonlyArray<{ readonly row: number; readonly char: string; readonly color: string }>;
}

export interface RainEngine {
  /**
   * Advance internal state toward `nowMs`. Time semantics:
   *   - Calling step() with monotonically increasing timestamps converges the engine's state.
   *   - Calling step() with the same nowMs twice in a row is a no-op (no state advance).
   *   - If (nowMs - lastTick) exceeds MAX_CATCH_UP_TICKS * FRAME_MS (see §3.1 below), the engine
   *     performs exactly ONE tick of progress and resets lastTick = nowMs. This prevents the
   *     "background tab freeze" failure mode where a suspended RAF resumes with a multi-minute delta
   *     and tries to synchronously run thousands of ticks.
   */
  step(nowMs: number): void;

  /** Produce a plain-data snapshot of the current drawable state. No side effects. */
  getFrame(): FrameState;

  /** Update with a new layout. Engine re-seeds drops if cellSize changed; otherwise reuses state. */
  resize(newLayout: LayoutPlan): void;

  /** Current phase (read-only). */
  readonly phase: RainPhase;

  /** True after assembly has finished (phase !== 'assembly'). */
  readonly wordmarkReady: boolean;
}

export function createRainEngine(options: EngineOptions): RainEngine;
```

### 3.1 Tick semantics and catch-up cap

The engine is driven by a monotonic `nowMs` supplied by the wrapper (via `requestAnimationFrame`). Two
constants govern tick behavior:

- `FRAME_MS = 33` (roughly 30Hz logical ticks — same as mux-splash). A "logical tick" advances all drops
  by one cell.
- `MAX_CATCH_UP_TICKS = 3`. Bounds how many logical ticks can run per `step()` call.

Algorithm:

```typescript
function step(nowMs: number): void {
  if (lastTick === 0) { lastTick = nowMs; return; }  // first call: prime, no advance
  const delta = nowMs - lastTick;
  if (delta <= 0) return;                            // same or rewound timestamp: no-op

  if (delta >= MAX_CATCH_UP_TICKS * FRAME_MS) {
    // Soft pause (e.g., tab was hidden). Skip the catch-up entirely; advance one tick and resync.
    advanceOneLogicalTick();
    lastTick = nowMs;
    return;
  }

  while (nowMs - lastTick >= FRAME_MS) {
    lastTick += FRAME_MS;
    advanceOneLogicalTick();
  }
}
```

Why the cap is part of the public contract (not just an implementation detail): the wrapper does not need
to do its own visibility detection; the engine tolerates arbitrary deltas gracefully. Tests can assert this
behavior directly.

### 3.2 Construction precondition

`createRainEngine()` requires a non-null `LayoutPlan`. The wrapper is responsible for calling
`computeLayout()` first; if it returns `null` (viewport too small), the wrapper skips engine construction
entirely and renders a static fallback. This keeps the engine's preconditions simple: valid layout in,
engine out.

### 3.3 Render cadence

RAF runs at display refresh rate (60Hz or 120Hz). The wrapper calls `step(nowMs)` and then `getFrame()`
followed by `drawFrame(ctx, frame, layout)` every RAF tick. The engine internally advances 0 or 1 logical
ticks per call (see 3.1). This guarantees the rain "feels" identical across 60Hz and 120Hz monitors while
rendering stays smooth.

### 3.4 Assembly safety cap

A compile-time constant `MAX_ASSEMBLY_TICKS = 120` (4 seconds at 30Hz) guards against a bug where assembly
never completes. If the engine has executed this many logical ticks in the `assembly` phase without every
drop locking, it force-locks all drops and transitions to `hold`. This ensures the animation cannot be
stuck forever.

## 4. Visual idiom: all cells are text

**Decision:** every visible cell — falling drop character AND locked wordmark cell — is drawn via
`ctx.fillText()`. Drops use katakana/digit characters; locked cells use the Unicode full block `'\u2588'`.

Rationale:

- `fillRect` for locked cells and `fillText` for drops produces a visible metric mismatch at the moment a
  drop locks: the character "jumps" from an antialiased glyph to a geometric square of a different
  effective size. Using `fillText('\u2588', ...)` for locked cells keeps font metrics, baseline, and
  alignment identical.
- The terminal splash uses `'\u2588'` as a character too. Matching that idiom produces the same chunky
  CRT/terminal look without introducing a second rendering path.
- One rendering path is simpler. The renderer has exactly one shape: "draw a char at a cell."

The pixel font (`FONT` dict from mux-splash) is used only for determining *which cells* are locked in the
wordmark. Each `#` in a glyph's 6-row grid becomes one `(col, row)` pair in `layout.wordmarkCells`. At
render time each such cell gets a `fillText('\u2588', x, y)` in `palette.locked`.

Port FONT and `RAIN_CHARS` verbatim to `matrix-rain/font.ts`. Keep `GLYPH_HEIGHT = 6` and `GLYPH_SPACING = 1`
constants.

## 5. Drop lifecycle

### Assembly phase (port of mux-splash)

1. The wrapper calls `computeLayout()` which determines `cellSize`, `originX`, `originY`, and the list of
   wordmark cells.
2. The engine creates one `Drop { col, targetRow, startFrame, headRow, locked: false }` per wordmark cell.
3. On each logical tick, for each unlocked drop whose `startFrame <= frame`, increment `headRow`. When
   `headRow >= targetRow`, mark `locked = true`.
4. When all drops are locked (or `MAX_ASSEMBLY_TICKS` is reached — see §3.4), transition to `hold` phase.
5. The engine emits `FrameState` with: one `DropSnapshot` per active (unlocked) drop with a 4-character
   trail (head, near-1, near-2, far); one `LockedCellSnapshot` per already-locked cell at `alpha=1.0`.

### Hold phase

- Duration: 1500ms.
- `drops` is empty.
- `lockedCells` contains every wordmark cell at `alpha=1.0`.
- During the final 500ms, the engine emits a linearly-decreasing `globalAlpha` from 1.0 → 0.55 on the
  frame as a whole. Individual `lockedCells[].alpha` remains 1.0.

### Ambient phase (new — not in mux-splash)

Inspired by the free-fall approach in `observe-tui-rain.ts` but simpler (no token queue, no color kinds,
no word drops):

- `lockedCells` still contains every wordmark cell. Frame `globalAlpha` is 0.55.
- Spawn free-falling drops at low density: ~1 new drop per 5 logical ticks across the full canvas width,
  with per-column cooldowns to prevent rapid double-spawns in the same column.
- Each ambient drop has: `col`, `headRow` (float, increases by `speed ∈ [1.0, 2.0]` cells/tick),
  `trailLen ∈ [4, 7]`, and a ring buffer of characters (head gets a fresh random char each logical tick).
- Drops die when `headRow - trailLen >= layout.viewportRows`.
- Ambient phase runs indefinitely; the canvas unmounts when auth succeeds. The frame counter is a
  JavaScript Number so overflow is not a concern within the session lifetime.

### Locked-cell occlusion (draw order)

The draw order is prescribed (see §6) to resolve the ambient/wordmark overlap cleanly. In short: ambient
drops draw first, locked cells draw second at full opacity, the frame's `globalAlpha` of 0.55 dims the
entire composite uniformly. Drops that happen to pass through a locked cell are visually hidden by the
locked cell's fill — no alpha-blended ghosting, no spawner occupancy checks. See §6 for the exact
sequence.

## 6. Renderer and draw order

The renderer is a single pure function:

```typescript
// matrix-rain/renderer.ts

/**
 * Paint a single frame. The caller is responsible for:
 *   - applying DPR transform to `ctx` (ctx.setTransform(dpr, 0, 0, dpr, 0, 0))
 *   - passing the same `layout` the engine was constructed with
 * The renderer is stateless — it assumes nothing about prior frames and resets every piece of context
 * state it uses (font, textBaseline, textAlign, fillStyle, globalAlpha).
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  layout: LayoutPlan,
  fontFamily: string,
): void;
```

### Draw-order contract

Every call to `drawFrame` executes this exact sequence:

1. **Clear.** `ctx.globalAlpha = 1.0; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height)`.
2. **Set draw preconditions** (must be set every frame; see §6.1):
   `ctx.font = '${cellSize}px ${fontFamily}'; ctx.textBaseline = 'top'; ctx.textAlign = 'center'`.
3. **Apply frame alpha.** `ctx.globalAlpha = frame.globalAlpha`.
4. **Draw drops.** For each drop in `frame.drops`, for each trail entry from tail to head, call
   `ctx.fillStyle = entry.color; ctx.fillText(entry.char, cx, cy)`. Drops may be empty (hold phase).
5. **Draw locked cells.** For each locked cell, `ctx.fillStyle = cell.color; ctx.fillText('\u2588', cx, cy)`.
   Locked cells are drawn AFTER drops so they occlude any ambient drop passing "behind" the wordmark.
   (Per-cell alpha below 1.0 — rare, only during progressive assembly reveal if the engine ever uses
   that — is handled via `ctx.globalAlpha = frame.globalAlpha * cell.alpha` scoped via save/restore.)
6. **Reset.** `ctx.globalAlpha = 1.0`.

### 6.1 Draw preconditions

The renderer sets `font`, `textBaseline`, `textAlign`, `fillStyle`, and `globalAlpha` on every frame.
It MUST NOT rely on Canvas context state persisting across frames, because:

- `canvas.width = ...` on resize resets all context state.
- Future refactors may introduce other ctx mutations (e.g., transforms) that reset state.
- Stateless draws are trivially correct.

Treat this as a renderer contract, not a micro-optimization.

### 6.2 No glow / bloom

The design deliberately omits `shadowBlur`. It is expensive enough to drop 120Hz frames on retina at our
drop counts (200-400). The head/near/far gradient already sells the phosphor-CRT aesthetic. If a future
pass wants glow, use a single offscreen low-res canvas with a pre-blurred sprite composited once per
frame — not per-character `shadowBlur`.

### 6.3 Head color variation

Unlike the terminal (fixed `CLR_HEAD`), the engine emits per-trail-position colors: `palette.head` for
index 0, `palette.near` for index 1-2, `palette.far` for index 3+. Locked cells use `palette.locked`.
No theme coupling — the login page is always phosphor green regardless of the selected theme.

## 7. Svelte wrapper

`matrix-rain.svelte` is the thin glue layer. It is responsible for:

- Binding `<canvas>` with `bind:this` and acquiring a 2D context
- Starting and cancelling the `requestAnimationFrame` loop
- Watching container size via `ResizeObserver`, debounced via RAF
- DevicePixelRatio handling (backing store size, transform)
- Cleanup on unmount
- Receiving `reducedMotion` as a prop (set by App.svelte — see §10)

### 7.1 Props (Svelte 5 `$props()` idiom)

```svelte
<script lang="ts">
  interface Props {
    word?: string;
    reducedMotion?: boolean;
    onready?: () => void;   // optional signal for tests/telemetry only — NOT used for card fade timing
    class?: string;
  }

  const { word = 'IronCurtain', reducedMotion = false, onready, class: className = '' } = $props();
</script>
```

### 7.2 Construction boundary

The wrapper owns the "too small to animate" decision:

```typescript
onMount(() => {
  const { width, height } = container.getBoundingClientRect();
  const layout = computeLayout(word, width, height);
  if (!layout) {
    // Viewport too small — render nothing (parent's black background shows through).
    return;
  }
  engine = createRainEngine({ layout, reducedMotion, ... });
  ctx = canvas.getContext('2d')!;
  resizeCanvas(canvas, width, height);
  rafId = requestAnimationFrame(tick);
});
```

If `computeLayout` returns `null`, the engine is never constructed. The wrapper renders nothing additional;
the outer black background (from App.svelte) simply shows through.

### 7.3 DPR handling

Fractional device-pixel ratios (e.g. 1.5 on some Windows/ChromeOS devices) are rounded via `Math.floor`
for the CSS style size and multiplied for the backing store, keeping integer alignment on the backing
buffer:

```typescript
function resizeCanvas(canvas: HTMLCanvasElement, w: number, h: number): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.floor(w);
  const cssH = Math.floor(h);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = cssW * dpr;   // integer: cssW is integer, dpr may be fractional, product is the backing size
  canvas.height = cssH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Note: setting canvas.width/height resets all ctx state. The renderer sets what it needs per frame (§6.1).
}
```

### 7.4 Resize during assembly

Policy: on significant resize mid-assembly (Δ cellSize ≥ 1), the wrapper destroys the current engine and
creates a new one in `assembly` phase with the new layout. Minor resizes (Δ cellSize = 0) preserve engine
state and update only the backing store. The card's `animation-delay` is wall-clock from page load; it
does NOT restart. If the user is resizing mid-assembly they are not carefully watching the animation, so
the jump is acceptable.

### 7.5 RAF loop

```typescript
function tick(nowMs: number): void {
  engine.step(nowMs);
  const frame = engine.getFrame();
  drawFrame(ctx, frame, layout, fontFamily);

  if (!readyFired && engine.wordmarkReady) {
    readyFired = true;
    onready?.();
  }
  rafId = requestAnimationFrame(tick);
}
```

### 7.6 Cleanup

On `onDestroy`, the wrapper explicitly releases every resource it acquired:

- `cancelAnimationFrame(rafId)`
- `resizeObserver?.disconnect()`
- `reducedMotionMql?.removeEventListener('change', onReducedMotionChange)` (if the wrapper subscribes —
  see §10 for why this generally lives in App.svelte)
- Clear references: `ctx = null; engine = null`

No global listeners are attached; there is nothing more to remove.

## 8. Responsive layout

The wordmark scales with viewport width. The layout algorithm:

1. Compute ideal `cellSize` = `floor(viewportWidth / (glyphWidths + padding) / targetColsMultiplier)`.
2. Clamp to `[MIN_CELL_SIZE, MAX_CELL_SIZE]`. Reasonable values: `MIN_CELL_SIZE = 6`, `MAX_CELL_SIZE = 18`.
3. Additionally apply `FONT_SIZE_TUNING = 1.0` multiplier (exposed as a constant in `layout.ts`) so visual
   tuning of `fillText` metrics (which render slightly smaller than their font size) can be adjusted
   without touching layout logic.
4. Verify `wordmarkWidthPx <= viewportWidth * 0.85` (leave 15% margin). If not, reduce cellSize by 1 until it fits.
5. If the viewport is too small for `MIN_CELL_SIZE` to fit (< ~400px wide), return `null`.

```typescript
// matrix-rain/layout.ts
export interface LayoutPlan {
  readonly cellSize: number;
  readonly originX: number;       // top-left of wordmark in pixels
  readonly originY: number;
  readonly wordmarkCells: ReadonlyArray<{ x: number; y: number }>; // cell coordinates of every '#'
  readonly viewportCols: number;  // columns available for ambient drops
  readonly viewportRows: number;
  readonly viewportWidth: number; // logical CSS pixels
  readonly viewportHeight: number;
}

export function computeLayout(
  word: string,
  viewportWidth: number,
  viewportHeight: number,
): LayoutPlan | null;  // null if viewport too small
```

### Debounce

Resize events fire rapidly during window drag. Debounce via `requestAnimationFrame` (don't use setTimeout):

```typescript
let pendingResize = false;
const ro = new ResizeObserver((entries) => {
  if (pendingResize) return;
  pendingResize = true;
  requestAnimationFrame(() => {
    pendingResize = false;
    const { width, height } = entries[0].contentRect;
    applyResize(width, height);
  });
});
```

## 9. Performance

### Target

- 60fps on M1/M2 retina (DPR=2) at viewport 1440×900
- Degrades gracefully (no jank, just slower frame rate) on Intel integrated GPUs
- 6-8KB gzipped for the engine + renderer + font + layout modules combined; Svelte component adds ~500B

### Expected load

- Assembly phase: 80-120 drops (one per `#` cell in the "IronCurtain" wordmark, which has ~100 filled cells
  given the font data)
- Ambient phase: 30-60 drops active at any time (much lower density than mux-splash)
- Per-frame operations: ~200-400 `fillText` calls at peak, well within Canvas 2D budgets

### Allocation discipline

- No object allocations in the hot path. Drops are mutated in place; a free-list pattern isn't needed at
  these counts but *never* use `.map()`, spread, or `filter()` inside `step()`/`getFrame()`/`drawFrame()`.
- `getFrame()` returns references to internal buffers typed as `ReadonlyArray`. The renderer must not
  mutate them; the engine reuses them next tick.
- Pre-allocate the drops array to max capacity at engine construction.
- Pre-compute random characters as a string indexed by `Math.floor(rng() * chars.length)` — already the
  pattern in both reference files.
- Clear via single `fillRect` over the whole canvas (cheaper than `clearRect` on most hardware because it
  avoids the alpha-channel zero-out path).

## 10. Accessibility

### prefers-reduced-motion — read once, by App.svelte

Reduced motion is detected **synchronously at App.svelte mount**, not inside the MatrixRain wrapper, and
not via any `onready` callback:

```svelte
<!-- App.svelte -->
<script lang="ts">
  const reducedMotion = $state(
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  let cardDelayMs = $derived(reducedMotion ? 0 : 2300);
  // Optionally react to changes:
  // window.matchMedia(...).addEventListener('change', (e) => reducedMotion = e.matches);
</script>
```

The same boolean is passed to `<MatrixRain reducedMotion={reducedMotion} />` AND used to compute the
card's `animation-delay`. There is no race: both values come from the same synchronous read at mount.

Why not use `onready` for this? Changing `animation-delay` on a div *mid-session* does not restart or
retime a CSS animation — the keyframe's position in the timeline is frozen once the animation starts.
So an `onready`-triggered delay change would silently fail. Pulling the decision forward to mount time
removes the race entirely.

### What `onready` is for

`onready` stays in the component API but its purpose is narrower: test assertions and telemetry. It fires
when `engine.wordmarkReady` first becomes true (or immediately on mount if `reducedMotion` is true — the
engine initializes to `ambient` phase with wordmark already locked). App.svelte does not subscribe.

### Behavior under reduced motion

- Engine is constructed with `reducedMotion: true` and initializes directly to the `ambient` phase with
  all wordmark cells already locked. No assembly, no hold ramp.
- Ambient drops are suppressed (engine never spawns in reduced-motion mode). The canvas shows only the
  static wordmark over a black background.
- Login card's `animation-delay` is 0; card appears immediately alongside the static wordmark.

### Contrast / readability

The login card uses `backdrop-blur-md` + `bg-card/75` (semi-transparent card background). In dark themes
(Iron, Midnight) this gives sufficient contrast over the black+green rain. In the `daylight` theme the
card is white-ish, also fine over black+green. No theme-specific rain palette needed.

### No audio

The splash is silent. Do not add audio. (A future marketing-only variant could have a single subtle
"click" on assembly complete, but that must be opt-in and behind user interaction.)

## 11. Integration with App.svelte

Modified auth-gate branch of `App.svelte`:

```svelte
<script lang="ts">
  import MatrixRain from '$lib/components/features/matrix-rain.svelte';

  const reducedMotion = $state(
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const cardDelayMs = $derived(reducedMotion ? 0 : 2300);
  // ... existing imports
</script>

{#if !appState.connected && !appState.hasToken}
  <div class="relative min-h-screen overflow-hidden bg-black">
    <!-- Layer 0: Matrix rain canvas (full-bleed, z-0) -->
    <MatrixRain class="absolute inset-0 z-0" word="IronCurtain" {reducedMotion} />

    <!-- Layer 1: Login card (z-10, fades in after assembly completes) -->
    <div class="relative z-10 flex items-center justify-center min-h-screen">
      <div
        class="w-full max-w-sm mx-4 animate-fade-in"
        style="animation-delay: {cardDelayMs}ms; animation-fill-mode: both;"
      >
        <div class="text-center mb-8">
          <div class="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-primary/10 border border-primary/20 mb-4 backdrop-blur-md">
            <ShieldCheck size={28} class="text-primary" weight="duotone" />
          </div>
          <h1 class="text-2xl font-semibold tracking-tight text-white drop-shadow">IronCurtain</h1>
          <p class="text-sm text-white/60 mt-1">Secure Agent Runtime</p>
        </div>

        <div class="bg-card/75 backdrop-blur-md border border-border/50 rounded-xl p-6 shadow-2xl shadow-black/40">
          <p class="text-sm text-muted-foreground mb-5">Paste the auth token from the daemon output to connect.</p>
          <form onsubmit={handleTokenSubmit}>
            <Input type="text" bind:value={tokenInput} placeholder="Auth token..." class="font-mono" />
            <Button type="submit" class="w-full mt-3">Connect</Button>
          </form>
        </div>

        <div class="flex justify-center gap-1 mt-6 opacity-80">
          {#each themes as t (t.id)}
            <Button
              variant="ghost"
              size="sm"
              onclick={() => switchTheme(t.id)}
              class={currentTheme === t.id ? 'bg-primary/15 text-primary font-medium' : 'text-white/60'}
            >
              {t.label}
            </Button>
          {/each}
        </div>
      </div>
    </div>
  </div>
{:else}
  <!-- existing authenticated branch unchanged -->
{/if}
```

### Animation-delay and reduced motion

The `animation-delay` is computed once, at mount, from the same `reducedMotion` boolean that is passed
to `<MatrixRain>`. No mid-session `animation-delay` mutation, no `onready`-triggered delay change, no
race with the CSS animation timeline. The full-motion path uses 2300ms (card emerges just as assembly
completes); reduced-motion uses 0 (card appears immediately).

`animation-fill-mode: both` keeps the card at opacity 0 during the delay so it doesn't flash.

## 12. Testing strategy

Tests focus on **observable behavior and call counts**, not full rendering sequences. Full sequences
are brittle; call-count assertions catch regressions without pinning implementation details.

### 12.1 Engine tests (`matrix-rain-engine.test.ts`)

Engine is testable with no DOM, no Canvas, just a seeded RNG:

- `computeLayout()` returns expected cellSize / origin / cell counts for a representative viewport; returns
  `null` below the threshold; clamps at `MAX_CELL_SIZE` for very wide viewports.
- Given a deterministic RNG, after N calls to `step()` with specific timestamps, `phase` transitions
  `'assembly'` → `'hold'` → `'ambient'` at the expected timestamps.
- `reducedMotion: true` starts in `'ambient'` phase with `wordmarkReady = true` and `drops.length === 0`.
- **Catch-up cap:** calling `step(0)`, then `step(10_000_000)` produces exactly ONE tick of progress
  (not thousands). Verify via observable state (e.g. drops advanced at most once).
- **No-op on same timestamp:** `step(1000); const a = snapshot(); step(1000); const b = snapshot();`
  asserts `a` and `b` are equivalent.
- **Assembly safety cap:** force a degenerate scenario (drops with impossibly distant targets) and assert
  that after `MAX_ASSEMBLY_TICKS` the phase is `'hold'` regardless.
- `resize()` with unchanged cellSize preserves drops; with changed cellSize re-seeds.

### 12.2 Renderer tests (`matrix-rain-renderer.test.ts`)

Renderer is testable with a mock `CanvasRenderingContext2D` that records calls as an array. Assertions
focus on **call counts and ordering**, not exact arg sequences:

- Given a `FrameState` with K locked cells and D drops with combined trail length T: assert `fillText`
  was called exactly `K + T` times.
- Assert that the first call per frame is the full-canvas clear (`fillRect` at 0,0,w,h).
- Assert that `fillText` calls for drops precede `fillText` calls for locked cells (draw order §6).
- Assert `globalAlpha` is set to `frame.globalAlpha` before drawing and reset to 1.0 at end.
- Assert that `font`, `textBaseline`, `textAlign` are set every call (§6.1 preconditions).
- Do NOT pin exact x/y coordinates for every call; pin only one representative case.

### 12.3 Layout tests (`matrix-rain-layout.test.ts`)

Pure math tests:

- Edge cases: zero-width viewport, negative dimensions, empty word.
- Clamping: huge viewport clamps cellSize to `MAX_CELL_SIZE`; tiny viewport returns `null`.
- Wordmark positioning: `originX + glyphWidth <= viewportWidth`; wordmark horizontally centered.

### 12.4 Component / integration

Not everything is unit-testable. Manual verification required for:

- 60fps on retina (Chrome DevTools Performance tab)
- Smooth transitions between phases (no flash, no flicker)
- Legibility of the login card over the ambient rain in all three themes
- Correct fade-in timing (card appears just as assembly completes)
- Responsive behavior (resize window; resize to very narrow → fallback)
- Reduced-motion: static wordmark immediately, no flashing, login card appears without delay
- Background-tab behavior: switch tabs for 5 minutes, return, verify no freeze and animation resumes
  smoothly within one tick.

### 12.5 Dev affordance (optional)

Consider a dev-only `?debug-splash=1` URL param that forces the auth gate and loops the animation
indefinitely without needing to log out. Small guard in App.svelte. Not required for initial implementation.

## 13. Implementation phases

Ordered from most foundational to most polished. Each phase is independently shippable and reviewable.

### Phase 1 — Engine and layout (no DOM)

Files: `matrix-rain/types.ts`, `matrix-rain/font.ts`, `matrix-rain/layout.ts`, `matrix-rain/palette.ts`,
`matrix-rain/engine.ts`.

- Port `FONT` and `RAIN_CHARS` constants.
- Implement `computeLayout()`.
- Implement `createRainEngine()` with assembly + hold + ambient phases.
- Implement catch-up cap (§3.1) and assembly safety cap (§3.4).
- Unit tests for layout, phase transitions, catch-up behavior, reduced motion.

**Acceptance:** `npm test -w packages/web-ui` passes a new `matrix-rain-engine.test.ts` and
`matrix-rain-layout.test.ts` covering layout math, phase transitions (including reducedMotion and catch-up
cap), and basic drop mechanics.

### Phase 2 — Renderer (pure drawing)

File: `matrix-rain/renderer.ts`, `test/matrix-rain-renderer.test.ts`.

- Implement `drawFrame(ctx, frame, layout, fontFamily)` per §6.
- Mock-ctx unit tests (call counts, draw order, preconditions).
- Verify no context state is assumed across frames.

**Acceptance:** renderer tests pass. Renderer imports nothing from `engine.ts` except `FrameState` (type
only). Build passes `tsc --noEmit`.

### Phase 3 — Svelte wrapper

File: `components/features/matrix-rain.svelte`.

- Canvas element bound via `bind:this`.
- `onMount` computes layout; if null, render nothing; else create engine and start RAF loop.
- `onDestroy` cancels RAF, disconnects ResizeObserver, clears refs.
- ResizeObserver on parent, debounced via RAF.
- `reducedMotion` prop (set by App.svelte).
- `onready` callback prop (for tests/telemetry, not card fade timing).

**Acceptance:** A dev page (temporary) renders `<MatrixRain>` full-bleed and the animation runs at 60fps
on retina. Resize works. Reduced-motion toggles work. Background-tab resume does not freeze.

### Phase 4 — App.svelte integration

- Replace the existing auth-gate gradient with the `<MatrixRain>` layer.
- Read `prefers-reduced-motion` at App mount, pass prop, set `cardDelayMs`.
- Re-layout the card with `backdrop-blur-md` and `animation-delay`.
- Verify the card unmounts cleanly when `appState.hasToken` becomes true (no flash of black canvas).

**Acceptance:** Start daemon with `--web-ui`, open the URL without a token, see the assembly animation
and ambient rain, paste a token, see the card + canvas unmount cleanly into the dashboard.

### Phase 5 — Visual polish

- Tune assembly timing (`FRAME_MS`, `MAX_START_FRAME`) so it feels snappy but readable.
- Tune ambient density (drops per tick, speed range) for the right "just-there" background feel.
- Tune hold-phase alpha ramp (1.0 → 0.55 feels right but should be verified against real card contrast).
- Tune `FONT_SIZE_TUNING` constant for optimal visual density.
- Verify gzipped bundle size stays within 6-8KB for engine + renderer + font + layout.

**Acceptance:** Product/marketing sign-off on the cinematic feel. Lighthouse performance score
unchanged on the login page (the canvas should not regress it).

### Phase 6 (optional) — Dev affordances

- Add `?debug-splash=1` URL param for iteration.
- Add a Storybook story if Storybook is added to the web-ui package (currently not present).

**Acceptance:** Optional — skip if product is satisfied after Phase 5.

## 14. Open questions

These deliberately do **not** block the initial design; list them for tracking during implementation review.

1. **Sprite-cached glyph rendering.** If profiling reveals `fillText` as a bottleneck, pre-render each
   katakana character at each of the three color tiers into a single offscreen sprite sheet and
   `drawImage` slices. This is a Phase 5 optimization, not initial scope.
2. **Theme coupling.** Current decision: hardcoded phosphor green regardless of theme. If product
   wants a Midnight-theme variant (blue rain) or Daylight-theme variant (dark-on-light), add a
   `theme` prop and a palette mapping in `palette.ts`. Trivial to add later.
3. **Wordmark dissolution on auth success.** Currently the canvas hard-unmounts when `hasToken` becomes
   true. A nicer effect would be a reverse-assembly: locked cells dissolve back into falling drops and
   fall off-screen. Out of scope for v1 but designed into the phase enum (could add a `'dissolution'`
   phase later).
4. **Live token ingestion from §3.1.** The broader vision has the rain represent live LLM tokens. For
   the login-page v1, drops are just random katakana. If the ingestion pipeline is built later
   (§6 of `visualization.md`), the engine's internal `spawnDrop` function is the only touch point:
   accept an optional character override per spawn.
5. **Canvas-less fallback.** Currently the wrapper renders nothing when `computeLayout` returns `null`.
   We could instead render a static SVG wordmark as a fallback for small screens; skip for v1.

## 15. Files changed / created

**Created:**
- `packages/web-ui/src/lib/matrix-rain/types.ts`
- `packages/web-ui/src/lib/matrix-rain/font.ts`
- `packages/web-ui/src/lib/matrix-rain/layout.ts`
- `packages/web-ui/src/lib/matrix-rain/palette.ts`
- `packages/web-ui/src/lib/matrix-rain/engine.ts`
- `packages/web-ui/src/lib/matrix-rain/renderer.ts`
- `packages/web-ui/src/lib/components/features/matrix-rain.svelte`
- `packages/web-ui/test/matrix-rain-engine.test.ts`
- `packages/web-ui/test/matrix-rain-renderer.test.ts`
- `packages/web-ui/test/matrix-rain-layout.test.ts`

**Modified:**
- `packages/web-ui/src/App.svelte` — auth-gate branch replaced with rain + card layout; adds
  `prefers-reduced-motion` detection at mount.

**Unchanged:**
- `packages/web-ui/src/app.css` — `animate-fade-in` keyframe re-used as-is; no new CSS needed
- `packages/web-ui/src/lib/stores.svelte.ts` — no changes; rain is purely presentational
- `src/mux/mux-splash.ts` — reference only; not imported
- `src/observe/observe-tui-rain.ts` — reference only; not imported

No new dependencies required. No new npm scripts. The design fits entirely within the existing Vite
build pipeline and the existing test harness.
