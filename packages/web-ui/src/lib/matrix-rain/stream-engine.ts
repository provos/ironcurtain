/**
 * Live-stream Matrix rain engine.
 *
 * Sibling to `createRainEngine` in `engine.ts` — shares the timing discipline
 * and drop-character machinery but drops the wordmark/assembly state machine
 * in favor of density-biased ambient rain plus TF-IDF word drops. See §A.2
 * of docs/designs/web-ui-workflow-visualization.md.
 *
 * The fork-interface contract: `step(nowMs)/getFrame()/resize()` matches the
 * login engine so the stream renderer can reuse `drawRainFrame`. Extras
 * (`enqueueWord`, `setDensityField`, `setIntensity`) live on the stream
 * engine only and the login engine is never re-exported with them.
 */

import { FRAME_MS, MAX_CATCH_UP_TICKS, createSeededRng } from './engine.js';
import { RAIN_CHARS } from './font.js';
import { clamp } from '../math-utils.js';
import type { DropColorKind, DropSnapshot, DropTrailSnapshot, FrameState, LayoutPlan, RainRng } from './types.js';
import type { WordDropPhase, WordDropSnapshot, WordDropSource } from './word-drop-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base ambient-drop population target (before intensity scaling). */
const AMBIENT_TARGET_MAX = 60;
/** Base per-tick spawn budget (before intensity scaling). */
const AMBIENT_SPAWN_PER_TICK = 1;
const AMBIENT_MIN_TRAIL = 4;
const AMBIENT_MAX_TRAIL = 7;
const AMBIENT_MIN_SPEED = 1.0;
const AMBIENT_MAX_SPEED = 2.0;
const AMBIENT_COLUMN_COOLDOWN = 6;

/** Max concurrent held word drops (§G Q6). FIFO slot frees when the word
 *  enters the dissolve phase — dissolving words still occupy `heldWords`
 *  while their chars shatter one-by-one but do not count against the cap. */
export const WORD_DROP_FIFO_CAP = 24;

// Word-drop lifecycle in logical ticks (FRAME_MS ~= 33ms).
// Materialize: chars flip on a per-char random schedule over
// MATERIALIZE_WINDOW_TICKS so the word coalesces organically rather than
// typing left-to-right like a teletype. Hold: ~2500ms at full opacity once
// every char is revealed. Dissolve: chars flip off on another per-char
// random schedule over DISSOLVE_WINDOW_TICKS, each flip spawning a tinted
// rain shard so the word shatters rather than wiping.
const MATERIALIZE_WINDOW_TICKS = 6;
const DISSOLVE_WINDOW_TICKS = 8;
const WORD_HOLD_TICKS = Math.round(2500 / FRAME_MS);

/**
 * Trail length for dissolve shards. Shorter than ambient trails so the
 * shatter reads as "char arrives then fades" rather than a new full-blown
 * rain stream emerging from mid-screen. Each shard's trail is built below
 * the head row, matching the ambient snapshot convention.
 */
const DISSOLVE_SHARD_TRAIL = 3;
/** Per-frame speed for dissolve shards — matches ambient min speed. */
const DISSOLVE_SHARD_SPEED = 1.0;

/** Word drops land in the top third so they don't collide with rain heads. */
const WORD_ROW_FRACTION = 1 / 3;

const INTENSITY_MIN = 0.3;
const INTENSITY_MAX = 2.0;

const STREAM_PHASE = 'stream' as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StreamRainEngineOptions {
  readonly rng?: RainRng;
  readonly seed?: number;
  readonly reducedMotion?: boolean;
}

export interface EnqueueWordOptions {
  readonly colorKind: WordDropSource;
}

/**
 * Rectangle in CSS pixel space that the engine must not spawn drops or word
 * drops inside. The theater declares these when graph nodes mount so rain
 * "parts" around opaque node chrome rather than bleeding through.
 */
export interface AvoidRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** How many times `enqueueWord` retries picking a non-avoided cell before giving up. */
export const WORD_PLACEMENT_MAX_ATTEMPTS = 10;

export interface StreamRainEngine {
  step(nowMs: number): void;
  getFrame(): FrameState;
  resize(newLayout: LayoutPlan): void;
  enqueueWord(word: string, opts: EnqueueWordOptions): void;
  /** Swap in per-column weights. Pass `null` to reset to uniform spawning. */
  setDensityField(field: Float32Array | null): void;
  /** Scale ambient population/spawn budget. Clamped to [0.3, 2.0]. */
  setIntensity(multiplier: number): void;
  /**
   * Declare rectangular regions (in CSS pixel space) where drops must not
   * spawn and word drops must not land. Existing drops whose head enters an
   * avoid region are retired so rain "parts" around them. Pass an empty array
   * (or call with no regions after resize) to clear.
   */
  setAvoidRegions(rects: ReadonlyArray<AvoidRect>): void;
  readonly phase: 'stream';
}

// ---------------------------------------------------------------------------
// Internal records
// ---------------------------------------------------------------------------

interface AmbientDrop {
  col: number;
  headRow: number;
  speed: number;
  speedAccum: number;
  trailLen: number;
  chars: string[];
  headIdx: number;
  alive: boolean;
  /**
   * Optional source tint for this drop. Set only on dissolve shards produced
   * from a word drop — the renderer uses it to pick a word-drop color palette
   * instead of the standard head/near/far phosphor greens. Omitted (undefined)
   * for normal ambient rain so those drops render in the usual green.
   */
  tint?: WordDropSource;
}

interface HeldWordDrop {
  col: number;
  row: number;
  word: string;
  source: WordDropSource;
  phase: WordDropPhase;
  /**
   * Per-character visibility bitmap, length === word.length. Source of truth
   * for what the renderer draws. Mutated in place as chars flip during
   * materialize/dissolve.
   */
  revealedMask: boolean[];
  /**
   * Tick offset (relative to the phase start) at which each char flips. Used
   * by materialize to know when to turn a bit from false->true, and by
   * dissolve to know when to turn it from true->false + spawn a shard.
   * Allocated once per phase (at enqueue for materialize, at hold->dissolve
   * transition for dissolve) so the hot path never allocates.
   */
  materializeSchedule: number[];
  dissolveSchedule: number[] | null;
  /** Ticks spent in the current phase — hold timeout + schedule clock. */
  phaseTicks: number;
}

// ---------------------------------------------------------------------------
// Default seed
// ---------------------------------------------------------------------------

/**
 * Default seed when no RNG is injected. Chosen arbitrarily; stream engines
 * want determinism off the shelf so tests never accidentally depend on
 * `Math.random()`.
 */
const DEFAULT_STREAM_SEED = 1729;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStreamRainEngine(layout: LayoutPlan, options: StreamRainEngineOptions = {}): StreamRainEngine {
  const rng: RainRng =
    options.rng ?? (options.seed !== undefined ? createSeededRng(options.seed) : createSeededRng(DEFAULT_STREAM_SEED));
  const reducedMotion = options.reducedMotion === true;

  let currentLayout: LayoutPlan = layout;
  let ambientDrops: AmbientDrop[] = [];
  let ambientCooldowns: number[] = new Array<number>(currentLayout.cols).fill(0);
  const heldWords: HeldWordDrop[] = [];

  // CDF cache for the weighted picker. `null` means uniform sampling (no
  // field set). Rebuilt lazily when setDensityField() is called.
  let densityField: Float32Array | null = null;
  let cdf: Float32Array | null = null;
  let cdfSum = 0;

  let intensity = 1.0;

  /** Avoid regions in CSS pixel space. Empty = no regions. */
  let avoidRegions: ReadonlyArray<AvoidRect> = [];

  // Time bookkeeping mirrors the login engine's step() semantics.
  let lastTick = 0;
  let hasPrimedLastTick = false;

  // Snapshot buffers reused across frames to avoid per-frame allocations.
  const dropSnapshotBuf: DropSnapshot[] = [];
  const wordDropSnapshotBuf: WordDropSnapshot[] = [];

  // -----------------------------------------------------------------------
  // CDF (weighted column picker)
  // -----------------------------------------------------------------------

  function rebuildCdfIfNeeded(): void {
    if (cdf !== null) return;
    if (densityField === null) return;
    const cols = currentLayout.cols;
    const field = densityField;
    const out = new Float32Array(cols);
    let acc = 0;
    // Clamp negatives to 0 so a theater passing weird data can't flip sign.
    for (let c = 0; c < cols; c++) {
      const w = field[c];
      if (w > 0) acc += w;
      out[c] = acc;
    }
    cdf = out;
    cdfSum = acc;
  }

  function pickWeightedColumn(): number {
    const cols = currentLayout.cols;
    if (cols <= 0) return -1;
    rebuildCdfIfNeeded();

    // Uniform fallback: no density field, or the field is identically zero
    // (theater hasn't resolved yet, or all sources have amplitude 0).
    if (cdf === null || cdfSum <= 0) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const col = Math.floor(rng.random() * cols);
        if (ambientCooldowns[col] === 0) return col;
      }
      return -1;
    }

    // Inverse-CDF draw with cooldown rejection — cheap: a handful of retries
    // keeps the common case O(log cols) + a few retries, and falls back to
    // -1 (skip this spawn) if every attempt hits a cooldown. Avoid regions are
    // not consulted at spawn time — drops start at row -1 (off-grid), and
    // `advanceAmbientDrops` retires them when their head enters a region.
    // That preserves full-density rain *above* each node instead of leaving
    // empty vertical stripes through every column a node spans.
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = rng.random() * cdfSum;
      const col = binarySearchCdf(cdf, r);
      if (col >= 0 && col < cols && ambientCooldowns[col] === 0) return col;
    }
    return -1;
  }

  /** Pure pick: ignores cooldowns (used for word drops, which don't care). */
  function pickWeightedColumnIgnoringCooldown(): number {
    const cols = currentLayout.cols;
    if (cols <= 0) return -1;
    rebuildCdfIfNeeded();
    if (cdf === null || cdfSum <= 0) {
      return Math.floor(rng.random() * cols);
    }
    const r = rng.random() * cdfSum;
    const col = binarySearchCdf(cdf, r);
    return col >= 0 && col < cols ? col : cols - 1;
  }

  // -----------------------------------------------------------------------
  // Avoid regions
  // -----------------------------------------------------------------------

  /**
   * True when a specific (col, row) cell falls inside any declared region.
   * Used to retire drops whose heads entered a region after the theater
   * published new node positions, and to gate word-drop placement.
   */
  function isCellInAvoidRegion(col: number, row: number): boolean {
    if (avoidRegions.length === 0) return false;
    const cellSize = currentLayout.cellSize;
    const cellX = col * cellSize;
    const cellY = row * cellSize;
    for (let i = 0; i < avoidRegions.length; i++) {
      const r = avoidRegions[i];
      if (cellX >= r.x && cellX < r.x + r.w && cellY >= r.y && cellY < r.y + r.h) return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Tick
  // -----------------------------------------------------------------------

  function advanceOneLogicalTick(): void {
    if (reducedMotion) {
      ageHeldWords();
      return;
    }
    advanceAmbientDrops();
    decrementAmbientCooldowns();
    spawnAmbientDrops();
    ageHeldWords();
  }

  function advanceAmbientDrops(): void {
    const rows = currentLayout.rows;
    for (const drop of ambientDrops) {
      if (!drop.alive) continue;
      drop.speedAccum += drop.speed;
      const steps = Math.floor(drop.speedAccum);
      drop.speedAccum -= steps;
      for (let s = 0; s < steps; s++) {
        drop.headRow += 1;
        drop.chars[drop.headIdx] = pickRandomChar();
        drop.headIdx = (drop.headIdx + 1) % drop.chars.length;
      }
      if (drop.headRow - drop.trailLen >= rows) drop.alive = false;
      // Retire once the head enters a declared avoid region. "Retire" (rather
      // than "stop moving") lets the trail continue to decay naturally on the
      // next frames so rain parts around nodes instead of clipping abruptly.
      if (drop.alive && isCellInAvoidRegion(drop.col, Math.floor(drop.headRow))) {
        drop.alive = false;
      }
    }
    // Compact in place.
    let w = 0;
    for (let i = 0; i < ambientDrops.length; i++) {
      if (ambientDrops[i].alive) ambientDrops[w++] = ambientDrops[i];
    }
    ambientDrops.length = w;
  }

  function decrementAmbientCooldowns(): void {
    for (let c = 0; c < ambientCooldowns.length; c++) {
      if (ambientCooldowns[c] > 0) ambientCooldowns[c]--;
    }
  }

  function spawnAmbientDrops(): void {
    const mult = clamp(intensity, INTENSITY_MIN, INTENSITY_MAX);
    const cap = Math.max(1, Math.floor(AMBIENT_TARGET_MAX * mult));
    if (ambientDrops.length >= cap) return;

    const spawnsThisTick = AMBIENT_SPAWN_PER_TICK * mult;
    const guaranteed = Math.floor(spawnsThisTick);
    const fractional = spawnsThisTick - guaranteed;
    const totalSpawns = guaranteed + (rng.random() < fractional ? 1 : 0);

    for (let i = 0; i < totalSpawns; i++) {
      const col = pickWeightedColumn();
      if (col < 0) return;
      ambientDrops.push(createAmbientDrop(col));
      ambientCooldowns[col] = AMBIENT_COLUMN_COOLDOWN;
    }
  }

  function createAmbientDrop(col: number): AmbientDrop {
    const trailLen = randInt(AMBIENT_MIN_TRAIL, AMBIENT_MAX_TRAIL);
    const speed = AMBIENT_MIN_SPEED + rng.random() * (AMBIENT_MAX_SPEED - AMBIENT_MIN_SPEED);
    const ringSize = trailLen + 1;
    const chars = new Array<string>(ringSize);
    const initialChar = pickRandomChar();
    for (let i = 0; i < ringSize; i++) chars[i] = initialChar;
    return {
      col,
      headRow: -1,
      speed,
      speedAccum: 0,
      trailLen,
      chars,
      headIdx: 1 % ringSize,
      alive: true,
    };
  }

  /**
   * Build a tinted falling drop that starts at the word's (col, row) with the
   * word's own character as the head. The shard uses a short trail and a
   * fixed slow speed so the dissolve reads as "this glyph sinks back into
   * the rain" rather than "a new column of rain appeared mid-screen."
   */
  function createDissolveShard(col: number, row: number, char: string, tint: WordDropSource): AmbientDrop {
    const trailLen = DISSOLVE_SHARD_TRAIL;
    const ringSize = trailLen + 1;
    const chars = new Array<string>(ringSize);
    // Seed the full ring with the word's glyph so the trail shows the same
    // character a couple of rows behind before the ring starts rotating in
    // random rain chars — softens the moment the word becomes rain.
    for (let i = 0; i < ringSize; i++) chars[i] = char;
    return {
      col,
      headRow: row,
      speed: DISSOLVE_SHARD_SPEED,
      speedAccum: 0,
      trailLen,
      chars,
      headIdx: 1 % ringSize,
      alive: true,
      tint,
    };
  }

  // -----------------------------------------------------------------------
  // Word drops
  // -----------------------------------------------------------------------

  /**
   * Advance the materialize -> hold -> dissolve state machine for every
   * held word. During materialize, flip mask bits to true as each char's
   * scheduled offset is reached. Hold waits out the read-time. Dissolve
   * flips bits back to false on its own per-char schedule; each false flip
   * spawns a tinted rain shard so the shatter is visible through the
   * normal rain pipeline. The held record is retired only after every
   * char has dissolved.
   */
  function ageHeldWords(): void {
    if (heldWords.length === 0) return;
    let w = 0;
    for (let i = 0; i < heldWords.length; i++) {
      const h = heldWords[i];
      h.phaseTicks++;

      if (h.phase === 'materialize') {
        advanceMaterialize(h);
        heldWords[w++] = h;
        continue;
      }

      if (h.phase === 'hold') {
        if (h.phaseTicks >= WORD_HOLD_TICKS) {
          beginDissolve(h);
        }
        heldWords[w++] = h;
        continue;
      }

      // dissolve: flip chars off as their schedule offsets arrive; retire
      // the held record only when every char has shattered into the rain.
      advanceDissolve(h);
      if (!isFullyDissolved(h)) {
        heldWords[w++] = h;
      }
    }
    heldWords.length = w;
  }

  function advanceMaterialize(h: HeldWordDrop): void {
    const t = h.phaseTicks;
    let allRevealed = true;
    for (let ci = 0; ci < h.word.length; ci++) {
      if (!h.revealedMask[ci] && t >= h.materializeSchedule[ci]) {
        h.revealedMask[ci] = true;
      }
      if (!h.revealedMask[ci]) allRevealed = false;
    }
    if (allRevealed) {
      h.phase = 'hold';
      h.phaseTicks = 0;
    }
  }

  function beginDissolve(h: HeldWordDrop): void {
    h.phase = 'dissolve';
    h.phaseTicks = 0;
    h.dissolveSchedule = buildStaggerSchedule(h.word.length, DISSOLVE_WINDOW_TICKS);
  }

  /**
   * Walk the dissolve schedule for this tick: for every char whose offset
   * has arrived and whose mask bit is still true, flip it off and spawn a
   * matching tinted shard. Bounds-check against the current layout so a
   * resize-driven truncation doesn't produce out-of-range shards.
   */
  function advanceDissolve(h: HeldWordDrop): void {
    const schedule = h.dissolveSchedule;
    if (schedule === null) return;
    const t = h.phaseTicks;
    for (let ci = 0; ci < h.word.length; ci++) {
      if (!h.revealedMask[ci]) continue;
      if (t < schedule[ci]) continue;
      h.revealedMask[ci] = false;
      const col = h.col + ci;
      if (col < 0 || col >= currentLayout.cols) continue;
      ambientDrops.push(createDissolveShard(col, h.row, h.word[ci], h.source));
    }
  }

  function isFullyDissolved(h: HeldWordDrop): boolean {
    for (let ci = 0; ci < h.word.length; ci++) {
      if (h.revealedMask[ci]) return false;
    }
    return true;
  }

  function countNonDissolving(): number {
    let n = 0;
    for (let i = 0; i < heldWords.length; i++) {
      if (heldWords[i].phase !== 'dissolve') n++;
    }
    return n;
  }

  function findOldestNonDissolving(): number {
    // heldWords is insertion-ordered; the first non-dissolving entry is the
    // oldest materialize/hold record.
    for (let i = 0; i < heldWords.length; i++) {
      if (heldWords[i].phase !== 'dissolve') return i;
    }
    return -1;
  }

  /**
   * Produce an array of per-char tick offsets in [0, windowTicks) using the
   * seeded RNG. Each char gets an independent uniform draw so the stagger
   * is deterministic for a given seed but visually scattered — neither
   * left-to-right nor in any fixed ordering.
   */
  function buildStaggerSchedule(length: number, windowTicks: number): number[] {
    const out = new Array<number>(length);
    for (let i = 0; i < length; i++) {
      out[i] = Math.floor(rng.random() * windowTicks);
    }
    return out;
  }

  // -----------------------------------------------------------------------
  // Snapshots (pure — no state mutation)
  // -----------------------------------------------------------------------

  function buildFrame(): FrameState {
    dropSnapshotBuf.length = 0;
    for (const drop of ambientDrops) {
      dropSnapshotBuf.push(buildAmbientDropSnapshot(drop));
    }

    wordDropSnapshotBuf.length = 0;
    for (const held of heldWords) {
      wordDropSnapshotBuf.push({
        col: held.col,
        row: held.row,
        word: held.word,
        source: held.source,
        phase: held.phase,
        revealedMask: held.revealedMask,
      });
    }

    return {
      phase: 'ambient',
      globalAlpha: 1.0,
      lockedCells: [],
      drops: dropSnapshotBuf,
      wordDrops: wordDropSnapshotBuf,
    };
  }

  function buildAmbientDropSnapshot(drop: AmbientDrop): DropSnapshot {
    const headRowFloor = Math.floor(drop.headRow);
    const ringLen = drop.chars.length;
    const headCharIdx = (drop.headIdx - 1 + ringLen) % ringLen;
    const trail: DropTrailSnapshot[] = [];
    for (let d = 1; d <= drop.trailLen; d++) {
      const row = headRowFloor - d;
      if (row < 0) break;
      const idx = (drop.headIdx - 1 - d + ringLen * (drop.trailLen + 2)) % ringLen;
      const trailCell: DropTrailSnapshot = drop.tint
        ? { col: drop.col, row, char: drop.chars[idx], colorKind: trailColorKind(d), tint: drop.tint }
        : { col: drop.col, row, char: drop.chars[idx], colorKind: trailColorKind(d) };
      trail.push(trailCell);
    }
    const head: DropSnapshot = drop.tint
      ? {
          col: drop.col,
          row: drop.headRow,
          char: drop.chars[headCharIdx],
          colorKind: 'head',
          trail,
          tint: drop.tint,
        }
      : {
          col: drop.col,
          row: drop.headRow,
          char: drop.chars[headCharIdx],
          colorKind: 'head',
          trail,
        };
    return head;
  }

  // -----------------------------------------------------------------------
  // Small helpers
  // -----------------------------------------------------------------------

  function pickRandomChar(): string {
    return RAIN_CHARS[Math.floor(rng.random() * RAIN_CHARS.length)];
  }

  function randInt(min: number, max: number): number {
    return min + Math.floor(rng.random() * (max - min + 1));
  }

  function wordDropRow(): number {
    const rows = currentLayout.rows;
    if (rows <= 1) return 0;
    const maxRow = Math.max(1, Math.floor(rows * WORD_ROW_FRACTION));
    return Math.floor(rng.random() * maxRow);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    step(nowMs: number): void {
      if (!hasPrimedLastTick) {
        lastTick = nowMs;
        hasPrimedLastTick = true;
        return;
      }
      const delta = nowMs - lastTick;
      if (delta <= 0) return;

      if (delta > MAX_CATCH_UP_TICKS * FRAME_MS) {
        advanceOneLogicalTick();
        lastTick = nowMs;
        return;
      }

      while (nowMs - lastTick >= FRAME_MS) {
        lastTick += FRAME_MS;
        advanceOneLogicalTick();
      }
    },

    getFrame(): FrameState {
      return buildFrame();
    },

    resize(newLayout: LayoutPlan): void {
      const gridChanged = newLayout.cols !== currentLayout.cols || newLayout.rows !== currentLayout.rows;
      currentLayout = newLayout;

      if (gridChanged) {
        // Invalidate the CDF — cols may have shifted, so stored weights are stale.
        cdf = null;
        cdfSum = 0;
        densityField = null;
        ambientDrops = [];
        if (ambientCooldowns.length !== currentLayout.cols) {
          ambientCooldowns = new Array<number>(currentLayout.cols).fill(0);
        }
        // Drop any held words that now fall outside the grid.
        let w = 0;
        for (let i = 0; i < heldWords.length; i++) {
          const h = heldWords[i];
          if (h.col < currentLayout.cols && h.row < currentLayout.rows) {
            heldWords[w++] = h;
          }
        }
        heldWords.length = w;
        // Avoid regions are in CSS pixel space; after a viewport resize the
        // theater will re-measure node bounding rects and re-publish. Clear
        // the stale set rather than keeping rects that may now point off-grid.
        avoidRegions = [];
      }
    },

    enqueueWord(word: string, opts: EnqueueWordOptions): void {
      if (word.length === 0) return;
      if (currentLayout.cols <= 0 || currentLayout.rows <= 0) return;
      // Retry placement up to WORD_PLACEMENT_MAX_ATTEMPTS times when avoid
      // regions are declared — a word that would land on a node is dropped
      // rather than "sliding out" to a permitted cell, since sliding would
      // bias placement toward region edges in ways the density field can't
      // correct.
      let col = -1;
      let row = -1;
      for (let attempt = 0; attempt < WORD_PLACEMENT_MAX_ATTEMPTS; attempt++) {
        const candidateCol = pickWeightedColumnIgnoringCooldown();
        if (candidateCol < 0) return;
        const candidateRow = wordDropRow();
        if (!isCellInAvoidRegion(candidateCol, candidateRow)) {
          col = candidateCol;
          row = candidateRow;
          break;
        }
      }
      if (col < 0 || row < 0) return;
      const revealedMask = new Array<boolean>(word.length).fill(false);
      // Allocate the materialize schedule once per word at enqueue so the
      // per-tick advance never allocates on the hot path. Dissolve schedule
      // is allocated lazily at the hold->dissolve transition.
      const materializeSchedule = buildStaggerSchedule(word.length, MATERIALIZE_WINDOW_TICKS);
      heldWords.push({
        col,
        row,
        word,
        source: opts.colorKind,
        phase: 'materialize',
        revealedMask,
        materializeSchedule,
        dissolveSchedule: null,
        phaseTicks: 0,
      });
      // FIFO eviction: only materialize/hold words count against the cap —
      // a dissolving word has already "freed" its slot per the lifecycle
      // spec, so its lingering record doesn't block new enqueues. Evict the
      // oldest non-dissolving entry when we overflow.
      while (countNonDissolving() > WORD_DROP_FIFO_CAP) {
        const idx = findOldestNonDissolving();
        if (idx < 0) break;
        heldWords.splice(idx, 1);
      }
    },

    setDensityField(field: Float32Array | null): void {
      densityField = field;
      cdf = null;
      cdfSum = 0;
    },

    setIntensity(multiplier: number): void {
      if (!Number.isFinite(multiplier)) return;
      intensity = clamp(multiplier, INTENSITY_MIN, INTENSITY_MAX);
    },

    setAvoidRegions(rects: ReadonlyArray<AvoidRect>): void {
      // Defensive copy so callers can mutate their list without tearing the
      // engine's state. Filter out degenerate rects (zero/negative area) —
      // they match nothing and just add cost to every per-cell predicate.
      const filtered: AvoidRect[] = [];
      for (const r of rects) {
        if (r.w > 0 && r.h > 0) filtered.push({ x: r.x, y: r.y, w: r.w, h: r.h });
      }
      avoidRegions = filtered;
    },

    get phase(): 'stream' {
      return STREAM_PHASE;
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function trailColorKind(distFromHead: number): DropColorKind {
  if (distFromHead === 0) return 'head';
  if (distFromHead <= 2) return 'near';
  return 'far';
}

/**
 * Locate the first index `i` with `cdf[i] >= target`. Assumes `cdf` is a
 * non-decreasing prefix-sum array. Returns -1 if empty.
 */
function binarySearchCdf(cdf: Float32Array, target: number): number {
  const n = cdf.length;
  if (n === 0) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cdf[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}
