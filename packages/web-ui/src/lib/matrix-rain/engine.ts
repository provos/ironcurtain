/**
 * Pure-logic Matrix rain engine.
 *
 * Owns the state machine (`assembly` -> `hold` -> `ambient`), the drop population,
 * and the tick loop. The engine never touches the DOM or Canvas; it emits
 * plain-data `FrameState` snapshots that the renderer consumes.
 *
 * Time is driven by the wrapper via `step(nowMs)`. Internally the engine
 * advances in fixed-size logical ticks of `FRAME_MS` so the animation feels
 * identical on 60Hz and 120Hz displays. See the `RainEngine.step` JSDoc in
 * `types.ts` for exact timing semantics.
 *
 * Assembly has two sub-phases:
 *   1. Title assembly -- one drop per title cell falls toward its target.
 *   2. Subtitle reveal -- after all title drops lock, subtitle cells are
 *      progressively revealed row-by-row over `SUBTITLE_REVEAL_TICKS` ticks.
 */

import { RAIN_CHARS } from './font.js';
import { ALPHA_AMBIENT, ALPHA_ASSEMBLY, ALPHA_HOLD_END, ALPHA_HOLD_START } from './palette.js';
import type {
  DropColorKind,
  DropSnapshot,
  DropTrailSnapshot,
  FrameState,
  LayoutPlan,
  LockedCellCoord,
  LockedCellSnapshot,
  RainEngine,
  RainEngineOptions,
  RainPhase,
  RainRng,
} from './types.js';

// ---------------------------------------------------------------------------
// Timing and behavior constants
// ---------------------------------------------------------------------------

/** Logical tick duration in milliseconds (~30 Hz). */
export const FRAME_MS = 33;

/**
 * Upper bound on ticks-per-`step()` before the engine switches to the
 * fast-forward branch. Crossed when a background tab resumes.
 */
export const MAX_CATCH_UP_TICKS = 3;

/** Target duration of the assembly phase in ticks (~2.5s at 30Hz). */
export const ASSEMBLY_TARGET_TICKS = 75;

/** Hard safety cap: force `hold` if assembly hasn't completed by this tick. */
export const MAX_ASSEMBLY_TICKS = 120;

/** Number of logical ticks in the hold phase (~1.5s at 30Hz). */
export const HOLD_TICKS = 45;

/** Number of ticks to progressively reveal subtitle cells (~0.5s at 30Hz). */
export const SUBTITLE_REVEAL_TICKS = 15;

/** Upper bound on per-drop start offset during assembly, in ticks. */
const MAX_ASSEMBLY_START_FRAME = 15;

/** Length of the drop trail (head + 4 trail cells). */
const ASSEMBLY_TRAIL_LEN = 4;

// Ambient-phase tunables
const AMBIENT_MIN_TRAIL = 4;
const AMBIENT_MAX_TRAIL = 7;
const AMBIENT_MIN_SPEED = 1.0;
const AMBIENT_MAX_SPEED = 2.0;
/** Per-column cooldown in ticks after a spawn to suppress rapid double-spawns. */
const AMBIENT_COLUMN_COOLDOWN = 6;
/**
 * Target active-drop population. Given ~50-tick drop lifetime on a typical
 * 900px viewport with `cellSize=12` (~75 rows, speed ~1.5), spawning ~1
 * drop/tick up to this cap sustains a population near this target.
 */
const AMBIENT_TARGET_MAX = 60;
/** Per-tick spawn budget while below `AMBIENT_TARGET_MAX`. */
const AMBIENT_SPAWN_PER_TICK = 1;

// ---------------------------------------------------------------------------
// Public RNG helper
// ---------------------------------------------------------------------------

/**
 * Deterministic RNG using mulberry32. Seed 0 is disallowed (folds to a
 * degenerate sequence); callers passing 0 get seed 1.
 */
export function createSeededRng(seed: number): RainRng {
  let state = seed | 0 || 1;
  return {
    random(): number {
      // mulberry32
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

const defaultRng: RainRng = { random: () => Math.random() };

// ---------------------------------------------------------------------------
// Internal mutable drop records
// ---------------------------------------------------------------------------

/**
 * Assembly drop: falls from above toward `targetRow`, then locks.
 *
 * Characters for the head + trail are carried on the drop and advanced
 * during `step()`, not during snapshot construction — this keeps the
 * engine's RNG stream independent of how many times `getFrame()` is
 * called. Index 0 is the head; indices 1..ASSEMBLY_TRAIL_LEN are the
 * trail cells in increasing distance from the head.
 */
interface AssemblyDrop {
  col: number;
  targetRow: number;
  startFrame: number;
  headRow: number;
  locked: boolean;
  chars: string[];
}

/**
 * Ambient drop: free-falls at sub-cell speed; characters in the ring buffer
 * roll over as the head advances. Dies when the tail has cleared the bottom.
 */
interface AmbientDrop {
  col: number;
  /** Head row, float. */
  headRow: number;
  speed: number;
  /** Carries the sub-cell remainder from the last tick. */
  speedAccum: number;
  trailLen: number;
  /** Ring buffer of characters (size = trailLen + 1). */
  chars: string[];
  /** Next write index in the ring. `(headIdx - 1)` is the current head char. */
  headIdx: number;
  alive: boolean;
}

// ---------------------------------------------------------------------------
// Cell partitioning helper
// ---------------------------------------------------------------------------

/** Split locked cells into title and subtitle groups. */
function partitionCells(cells: ReadonlyArray<LockedCellCoord>): {
  titleCells: LockedCellCoord[];
  subtitleCells: LockedCellCoord[];
} {
  const titleCells: LockedCellCoord[] = [];
  const subtitleCells: LockedCellCoord[] = [];
  for (const cell of cells) {
    if (cell.group === 'subtitle') {
      subtitleCells.push(cell);
    } else {
      // 'title' or undefined (backward compat with group-less layouts)
      titleCells.push(cell);
    }
  }
  return { titleCells, subtitleCells };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a rain engine for the given layout.
 *
 * @param layout Pre-computed layout from `computeLayout()`.
 * @param options Engine options (RNG, seed, reducedMotion).
 */
export function createRainEngine(layout: LayoutPlan, options: RainEngineOptions = {}): RainEngine {
  const rng: RainRng = options.rng ?? (options.seed !== undefined ? createSeededRng(options.seed) : defaultRng);
  const reducedMotion = options.reducedMotion === true;

  let currentLayout: LayoutPlan = layout;
  let phase: RainPhase = 'assembly';
  let phaseTick = 0; // ticks spent in the current phase
  let lastTick = 0; // wall-clock anchor for step()
  let hasPrimedLastTick = false;

  // Partition locked cells into title and subtitle groups.
  let { titleCells, subtitleCells } = partitionCells(currentLayout.lockedCells);

  // Assembly state -- one drop per title cell (Change 3: guaranteed coverage).
  let assemblyDrops: AssemblyDrop[] = buildAssemblyDrops(titleCells, rng);
  // Locked wordmark snapshot (grows during assembly; full after hold starts).
  let lockedSnapshotBuf: LockedCellSnapshot[] = [];
  // Active drops snapshot buffer (reused across frames; truncated per-frame).
  const dropSnapshotBuf: DropSnapshot[] = [];

  // Subtitle reveal state: tracks progressive row-by-row reveal between
  // title assembly completing and transitioning to hold.
  let subtitleRevealActive = false;
  let subtitleRevealTick = 0;
  let subtitleRevealedCells: LockedCellSnapshot[] = [];
  let subtitleRowOrder: number[] = [];

  // Ambient state
  let ambientDrops: AmbientDrop[] = [];
  let ambientCooldowns: number[] = new Array<number>(currentLayout.cols).fill(0);

  // Reduced motion: jump directly to ambient with everything locked.
  if (reducedMotion) {
    phase = 'ambient';
    phaseTick = 0;
    assemblyDrops = [];
    lockedSnapshotBuf = allLockedCellsSnapshot(currentLayout);
  }

  // -----------------------------------------------------------------------
  // Tick advancement
  // -----------------------------------------------------------------------

  /**
   * Phase-dependent spawn rate multiplier for background ambient drops.
   * Assembly gets sparse rain so it doesn't overwhelm the target-locking
   * drops; hold gets moderate; ambient gets full density.
   */
  function ambientSpawnRateMultiplier(): number {
    if (phase === 'assembly') return 0.3;
    if (phase === 'hold') return 0.5;
    return 1.0;
  }

  function advanceOneLogicalTick(): void {
    if (phase === 'assembly') {
      advanceAssemblyTick();
    } else if (phase === 'hold') {
      advanceHoldTick();
    } else {
      advanceAmbientTick();
    }

    // Background ambient drops run in every phase (assembly, hold, ambient).
    // During the ambient phase, `advanceAmbientTick()` already handles this,
    // so only run the background logic during assembly and hold.
    if (phase !== 'ambient' && !reducedMotion) {
      advanceBackgroundAmbientDrops();
    }

    phaseTick++;
  }

  /** Advance + spawn background ambient drops during non-ambient phases. */
  function advanceBackgroundAmbientDrops(): void {
    advanceAmbientDrops();
    decrementAmbientCooldowns();
    spawnAmbientDrops(ambientSpawnRateMultiplier());
  }

  function advanceAssemblyTick(): void {
    // Sub-phase 2: subtitle reveal (title drops already locked).
    if (subtitleRevealActive) {
      advanceSubtitleReveal();
      return;
    }

    // Sub-phase 1: title assembly.
    let allLocked = true;
    for (const drop of assemblyDrops) {
      if (drop.locked) continue;
      if (phaseTick < drop.startFrame) {
        allLocked = false;
        continue;
      }
      drop.headRow++;
      // Advance characters: shift trail down and generate a new head char.
      // Doing this in step() (rather than getFrame()) keeps snapshot
      // construction free of RNG side effects.
      for (let i = drop.chars.length - 1; i > 0; i--) drop.chars[i] = drop.chars[i - 1];
      drop.chars[0] = pickRandomChar();
      if (drop.headRow >= drop.targetRow) {
        drop.locked = true;
      } else {
        allLocked = false;
      }
    }

    // Safety cap: never let assembly run forever.
    if (phaseTick >= MAX_ASSEMBLY_TICKS - 1) {
      for (const drop of assemblyDrops) {
        drop.locked = true;
        drop.headRow = drop.targetRow;
      }
      allLocked = true;
    }

    if (allLocked) {
      beginSubtitleReveal();
    }
  }

  function beginSubtitleReveal(): void {
    if (subtitleCells.length === 0) {
      // No subtitle cells -- go straight to hold.
      transitionTo('hold');
      return;
    }
    subtitleRevealActive = true;
    subtitleRevealTick = 0;
    subtitleRevealedCells = [];

    // Compute sorted unique rows for progressive reveal.
    const rowSet = new Set<number>();
    for (const cell of subtitleCells) rowSet.add(cell.row);
    subtitleRowOrder = [...rowSet].sort((a, b) => a - b);
  }

  function advanceSubtitleReveal(): void {
    subtitleRevealTick++;
    const progress = Math.min(1, subtitleRevealTick / SUBTITLE_REVEAL_TICKS);
    const rowsToReveal = Math.ceil(progress * subtitleRowOrder.length);
    const revealedRowSet = new Set(subtitleRowOrder.slice(0, rowsToReveal));

    subtitleRevealedCells = [];
    for (const cell of subtitleCells) {
      if (revealedRowSet.has(cell.row)) {
        subtitleRevealedCells.push({ col: cell.col, row: cell.row, alpha: 1.0 });
      }
    }

    if (subtitleRevealTick >= SUBTITLE_REVEAL_TICKS) {
      transitionTo('hold');
    }
  }

  function advanceHoldTick(): void {
    // phaseTick increments after this returns -- the transition check uses
    // `>= HOLD_TICKS - 1` so we spend exactly HOLD_TICKS ticks in hold.
    if (phaseTick >= HOLD_TICKS - 1) {
      transitionTo('ambient');
    }
  }

  function advanceAmbientTick(): void {
    if (reducedMotion) return;
    advanceAmbientDrops();
    decrementAmbientCooldowns();
    spawnAmbientDrops(ambientSpawnRateMultiplier());
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
        const newChar = pickRandomChar();
        drop.chars[drop.headIdx] = newChar;
        drop.headIdx = (drop.headIdx + 1) % drop.chars.length;
      }
      if (drop.headRow - drop.trailLen >= rows) drop.alive = false;
    }
    // Compact in place (no allocations).
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

  function spawnAmbientDrops(rateMultiplier: number = 1.0): void {
    const cap = Math.floor(AMBIENT_TARGET_MAX * rateMultiplier);
    if (ambientDrops.length >= cap) return;
    const cols = currentLayout.cols;
    if (cols <= 0) return;

    // Probabilistic spawn: for fractional multipliers, use the fractional
    // part as a spawn probability each tick.
    const spawnsThisTick = AMBIENT_SPAWN_PER_TICK * rateMultiplier;
    const guaranteed = Math.floor(spawnsThisTick);
    const fractional = spawnsThisTick - guaranteed;

    const totalSpawns = guaranteed + (rng.random() < fractional ? 1 : 0);

    for (let i = 0; i < totalSpawns; i++) {
      const col = pickAvailableColumn();
      if (col < 0) return;
      ambientDrops.push(createAmbientDrop(col));
      ambientCooldowns[col] = AMBIENT_COLUMN_COOLDOWN;
    }
  }

  function pickAvailableColumn(): number {
    const cols = currentLayout.cols;
    // Try up to 6 random picks; if all are on cooldown, skip this tick.
    for (let attempt = 0; attempt < 6; attempt++) {
      const col = Math.floor(rng.random() * cols);
      if (ambientCooldowns[col] === 0) return col;
    }
    return -1;
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

  // -----------------------------------------------------------------------
  // Phase transitions
  // -----------------------------------------------------------------------

  function transitionTo(next: RainPhase): void {
    if (next === 'hold') {
      phase = 'hold';
      phaseTick = -1; // -1 so the next phaseTick++ yields 0 inside the hold phase
      lockedSnapshotBuf = allLockedCellsSnapshot(currentLayout);
      assemblyDrops = [];
      subtitleRevealActive = false;
      subtitleRevealedCells = [];
    } else if (next === 'ambient') {
      phase = 'ambient';
      phaseTick = -1;
      // lockedSnapshotBuf already populated by the hold transition.
    }
  }

  // -----------------------------------------------------------------------
  // Snapshot building
  // -----------------------------------------------------------------------

  function buildFrame(): FrameState {
    const globalAlpha = computeGlobalAlpha();
    const drops = buildDropSnapshots();
    return {
      phase,
      globalAlpha,
      lockedCells: phase === 'assembly' ? lockedSnapshotFromAssembly() : lockedSnapshotBuf,
      drops,
    };
  }

  function computeGlobalAlpha(): number {
    if (phase === 'assembly') return ALPHA_ASSEMBLY;
    if (phase === 'ambient') return ALPHA_AMBIENT;
    // Hold: linearly ramp ALPHA_HOLD_START -> ALPHA_HOLD_END across HOLD_TICKS.
    const t = Math.min(1, Math.max(0, phaseTick / Math.max(1, HOLD_TICKS - 1)));
    return ALPHA_HOLD_START + (ALPHA_HOLD_END - ALPHA_HOLD_START) * t;
  }

  function lockedSnapshotFromAssembly(): LockedCellSnapshot[] {
    const out: LockedCellSnapshot[] = [];
    // Title cells revealed by locked assembly drops.
    for (const drop of assemblyDrops) {
      if (drop.locked) out.push({ col: drop.col, row: drop.targetRow, alpha: 1.0 });
    }
    // Subtitle cells revealed progressively during subtitle-reveal sub-phase.
    if (subtitleRevealActive) {
      for (const cell of subtitleRevealedCells) {
        out.push(cell);
      }
    }
    return out;
  }

  function buildDropSnapshots(): DropSnapshot[] {
    dropSnapshotBuf.length = 0;

    // Background ambient drops are rendered in every phase.
    // During assembly, they use the 'far' color kind so they don't compete
    // visually with the brighter assembly drops.
    const bgColorOverride: DropColorKind | null = phase === 'assembly' ? 'far' : null;
    for (const drop of ambientDrops) {
      dropSnapshotBuf.push(buildAmbientDropSnapshot(drop, bgColorOverride));
    }

    // Assembly drops on top of the background rain.
    if (phase === 'assembly') {
      for (const drop of assemblyDrops) {
        if (drop.locked) continue;
        if (phaseTick < drop.startFrame) continue;
        if (drop.headRow < 0) continue; // still above the top edge
        dropSnapshotBuf.push(buildAssemblyDropSnapshot(drop));
      }
    }

    return dropSnapshotBuf;
  }

  function buildAssemblyDropSnapshot(drop: AssemblyDrop): DropSnapshot {
    const head = drop.headRow;
    const trail: DropTrailSnapshot[] = [];
    for (let d = 1; d <= ASSEMBLY_TRAIL_LEN; d++) {
      const row = head - d;
      if (row < 0) break;
      trail.push({
        col: drop.col,
        row,
        char: drop.chars[d],
        colorKind: trailColorKind(d),
      });
    }
    return {
      col: drop.col,
      row: head,
      char: drop.chars[0],
      colorKind: 'head',
      trail,
    };
  }

  function buildAmbientDropSnapshot(drop: AmbientDrop, colorOverride: DropColorKind | null = null): DropSnapshot {
    const headRowFloor = Math.floor(drop.headRow);
    const ringLen = drop.chars.length;
    const headCharIdx = (drop.headIdx - 1 + ringLen) % ringLen;
    const headChar = drop.chars[headCharIdx];

    const trail: DropTrailSnapshot[] = [];
    for (let d = 1; d <= drop.trailLen; d++) {
      const row = headRowFloor - d;
      if (row < 0) break;
      const idx = (drop.headIdx - 1 - d + ringLen * (drop.trailLen + 2)) % ringLen;
      trail.push({
        col: drop.col,
        row,
        char: drop.chars[idx],
        colorKind: colorOverride ?? trailColorKind(d),
      });
    }
    return {
      col: drop.col,
      row: drop.headRow,
      char: headChar,
      colorKind: colorOverride ?? 'head',
      trail,
    };
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
      const cellSizeChanged = newLayout.cellSize !== currentLayout.cellSize;
      // A viewport shape change can shift wordmark centering even when
      // cellSize stays the same — every `(col, row)` in `lockedCells`
      // moves. Without this check, hold/ambient would keep emitting
      // stale coordinates and assembly drops would target stale cells.
      const lockedCellsChanged = !lockedCellsEqual(currentLayout.lockedCells, newLayout.lockedCells);
      // `cols`/`rows` can shift without `cellSize` (e.g. viewport width
      // changes by less than one cellSize step). Ambient drops in cols
      // that no longer exist would otherwise keep occupying the cap
      // while rendering off-canvas, reducing visible density.
      const gridDimsChanged =
        cellSizeChanged || newLayout.cols !== currentLayout.cols || newLayout.rows !== currentLayout.rows;
      currentLayout = newLayout;
      const partitioned = partitionCells(currentLayout.lockedCells);
      titleCells = partitioned.titleCells;
      subtitleCells = partitioned.subtitleCells;

      if (cellSizeChanged || lockedCellsChanged) {
        if (phase === 'assembly') {
          assemblyDrops = buildAssemblyDrops(titleCells, rng);
          lockedSnapshotBuf = [];
          subtitleRevealActive = false;
          subtitleRevealedCells = [];
        } else {
          lockedSnapshotBuf = allLockedCellsSnapshot(currentLayout);
        }
      }
      // Any change to the grid dimensions invalidates the ambient
      // population; a pure wordmark re-centering (grid intact) leaves
      // rain uninterrupted.
      if (gridDimsChanged) {
        ambientDrops = [];
      }
      // Always resize the cooldown array to the new column count.
      if (ambientCooldowns.length !== currentLayout.cols) {
        const next = new Array<number>(currentLayout.cols).fill(0);
        const shared = Math.min(ambientCooldowns.length, next.length);
        for (let c = 0; c < shared; c++) next[c] = ambientCooldowns[c];
        ambientCooldowns = next;
      }
    },

    get phase(): RainPhase {
      return phase;
    },

    get wordmarkReady(): boolean {
      return phase !== 'assembly';
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (no closure state)
// ---------------------------------------------------------------------------

/**
 * Build one assembly drop per title cell. Each drop targets that cell's
 * exact (col, row) with a staggered start frame so they arrive at different
 * times. This guarantees every title cell is covered (Change 3).
 */
function buildAssemblyDrops(titleCells: ReadonlyArray<LockedCellCoord>, rng: RainRng): AssemblyDrop[] {
  const drops: AssemblyDrop[] = [];
  for (const cell of titleCells) {
    const chars = new Array<string>(ASSEMBLY_TRAIL_LEN + 1);
    for (let i = 0; i < chars.length; i++) {
      chars[i] = RAIN_CHARS[Math.floor(rng.random() * RAIN_CHARS.length)];
    }
    drops.push({
      col: cell.col,
      targetRow: cell.row,
      startFrame: Math.floor(rng.random() * MAX_ASSEMBLY_START_FRAME),
      headRow: -1 - Math.floor(rng.random() * 5),
      locked: false,
      chars,
    });
  }
  return drops;
}

function allLockedCellsSnapshot(layout: LayoutPlan): LockedCellSnapshot[] {
  const out: LockedCellSnapshot[] = [];
  for (const cell of layout.lockedCells) {
    out.push({ col: cell.col, row: cell.row, alpha: 1.0 });
  }
  return out;
}

function trailColorKind(distFromHead: number): DropColorKind {
  if (distFromHead === 0) return 'head';
  if (distFromHead <= 2) return 'near';
  return 'far';
}

/**
 * Shallow structural equality for two locked-cell arrays. A few hundred
 * cells at most; a linear scan on resize is free.
 */
function lockedCellsEqual(a: ReadonlyArray<LockedCellCoord>, b: ReadonlyArray<LockedCellCoord>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].col !== b[i].col || a[i].row !== b[i].row || a[i].group !== b[i].group) {
      return false;
    }
  }
  return true;
}
