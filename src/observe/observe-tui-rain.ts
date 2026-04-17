/**
 * Rain engine for the observe TUI.
 *
 * Manages a pool of falling "drops" fed by a bounded token queue.
 * Each drop carries characters from LLM token events (text, tool, error)
 * or random katakana when idle, rendered with per-kind color gradients.
 *
 * Supports word drops (words that materialize horizontally, hold, then
 * dissolve back into falling rain) and phase-driven ambient color
 * transitions that shift the visual atmosphere based on agent state.
 *
 * Adapted from mux-splash.ts drop mechanics but uses continuous
 * free-falling drops instead of target-locking drops.
 */

import {
  type AgentPhase,
  type RainToken,
  type RainDrop,
  type RainColorKind,
  type TuiLayout,
  type WordDrop,
  type WordDropSource,
  SGR,
  RAIN_QUEUE_CAPACITY,
  getRainChars,
} from './observe-tui-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_COOLDOWN_JITTER = 3;
const MIN_TRAIL_LEN = 3;
const MAX_TRAIL_LEN = 6;
const MIN_SPEED = 1;
const MAX_SPEED = 3;

/** Frames with no tokens before transitioning to idle mode. */
const IDLE_THRESHOLD_FRAMES = 15;

/** Maximum number of simultaneously active word drops. */
const MAX_ACTIVE_WORD_DROPS = 2;

/** Maximum pending word queue size. */
const MAX_WORD_QUEUE = 4;

/** Minimum hold duration for word drops (in frames, ~3 seconds at 15fps). */
const MIN_HOLD_FRAMES = 45;

/** Maximum hold duration for word drops (in frames, ~6 seconds at 15fps). */
const MAX_HOLD_FRAMES = 90;

/** Minimum forming duration for word drops (frames). */
const MIN_FORMING_FRAMES = 5;

/** Maximum forming duration for word drops (frames). */
const MAX_FORMING_FRAMES = 10;

/** Minimum dissolving duration for word drops (frames). */
const MIN_DISSOLVING_FRAMES = 10;

/** Maximum dissolving duration for word drops (frames). */
const MAX_DISSOLVING_FRAMES = 15;

/** Vertical gap rows to keep between word drops for overlap checking. */
const WORD_DROP_VERTICAL_GAP = 2;

/** Max placement attempts before re-queuing a word. */
const MAX_PLACEMENT_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// RainEngine interface
// ---------------------------------------------------------------------------

/** Public interface for the rain engine. */
export interface RainEngine {
  /** Push characters from token stream events into the rain queue. */
  enqueueTokens(tokens: readonly RainToken[]): void;
  /** Advance one frame: move drops, despawn dead ones, spawn new ones. */
  tick(): void;
  /** Produce ANSI string for the entire rain panel for this frame. */
  render(): string;
  /** Update dimensions after terminal resize; kill out-of-bounds drops. */
  resize(layout: TuiLayout): void;
  /** Current queue depth (for status bar display). */
  readonly queueDepth: number;
  /** Queue a word for materialization in the rain panel. */
  enqueueWord(word: string, source: WordDropSource): void;
  /** Set the current agent phase for ambient color selection. */
  setPhase(phase: AgentPhase): void;
}

// ---------------------------------------------------------------------------
// Random helpers (injectable for testing)
// ---------------------------------------------------------------------------

/** Random number generation functions, injectable for deterministic tests. */
export interface RainRng {
  /** Return a random float in [0, 1). */
  random(): number;
}

const defaultRng: RainRng = { random: () => Math.random() };

/** Pick a random rain character from the locale-appropriate set. */
function randChar(chars: string, rng: RainRng): string {
  return chars[Math.floor(rng.random() * chars.length)];
}

/** Random integer in [min, max] inclusive. */
function randInt(min: number, max: number, rng: RainRng): number {
  return min + Math.floor(rng.random() * (max - min + 1));
}

// ---------------------------------------------------------------------------
// Color lookup
// ---------------------------------------------------------------------------

interface ColorSet {
  head: string;
  near: string;
  far: string;
}

const COLOR_SETS: Record<RainColorKind, ColorSet> = {
  text: { head: SGR.RAIN_HEAD_TEXT, near: SGR.RAIN_NEAR_TEXT, far: SGR.RAIN_FAR_TEXT },
  tool: { head: SGR.RAIN_HEAD_TOOL, near: SGR.RAIN_NEAR_TOOL, far: SGR.RAIN_FAR_TOOL },
  error: { head: SGR.RAIN_HEAD_ERROR, near: SGR.RAIN_NEAR_ERROR, far: SGR.RAIN_FAR_ERROR },
  idle: { head: SGR.RAIN_IDLE, near: SGR.RAIN_IDLE, far: SGR.RAIN_IDLE },
};

/** Return the SGR color for a trail position relative to the head. */
function trailColor(kind: RainColorKind, distFromHead: number): string {
  const set = COLOR_SETS[kind];
  if (distFromHead === 0) return set.head;
  if (distFromHead <= 2) return set.near;
  return set.far;
}

/** Map WordDropSource to SGR color string. */
const WORD_COLORS: Record<WordDropSource, string> = {
  text: SGR.WORD_TEXT,
  tool: SGR.WORD_TOOL,
  phase: SGR.WORD_PHASE,
  model: SGR.WORD_MODEL,
};

/** Map WordDropSource to RainColorKind for spawned rain drops on dissolution. */
const WORD_SOURCE_TO_COLOR_KIND: Record<WordDropSource, RainColorKind> = {
  text: 'text',
  tool: 'tool',
  phase: 'text',
  model: 'text',
};

// ---------------------------------------------------------------------------
// Phase-driven color resolution
// ---------------------------------------------------------------------------

/**
 * Determine the color kind for a newly spawned drop.
 * Token-derived drops keep their original color; idle/ambient drops
 * use the current agent phase to determine color.
 */
function resolveDropColor(token: RainToken | undefined, phase: AgentPhase): RainColorKind {
  if (token) return token.kind;
  switch (phase) {
    case 'thinking':
      return 'text';
    case 'tool_use':
      return 'tool';
    case 'error':
      return 'error';
    case 'idle':
      return 'idle';
  }
}

// ---------------------------------------------------------------------------
// Token queue (bounded FIFO)
// ---------------------------------------------------------------------------

/** Bounded FIFO queue backed by a circular buffer. */
class TokenQueue {
  private readonly buf: Array<RainToken | undefined>;
  private head = 0;
  private tail = 0;
  private _size = 0;

  constructor(readonly capacity: number) {
    this.buf = new Array<RainToken | undefined>(capacity);
  }

  get size(): number {
    return this._size;
  }

  /** Enqueue tokens, silently dropping oldest if at capacity. */
  pushMany(tokens: readonly RainToken[]): void {
    for (const t of tokens) {
      if (this._size === this.capacity) {
        // Drop oldest
        this.buf[this.head] = undefined;
        this.head = (this.head + 1) % this.capacity;
        this._size--;
      }
      this.buf[this.tail] = t;
      this.tail = (this.tail + 1) % this.capacity;
      this._size++;
    }
  }

  /** Dequeue one token, or undefined if empty. */
  shift(): RainToken | undefined {
    if (this._size === 0) return undefined;
    const token = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this._size--;
    return token;
  }
}

// ---------------------------------------------------------------------------
// Drop creation
// ---------------------------------------------------------------------------

function createDrop(col: number, char: string, colorKind: RainColorKind, rng: RainRng): RainDrop {
  const trailLen = randInt(MIN_TRAIL_LEN, MAX_TRAIL_LEN, rng);
  const speed = MIN_SPEED + rng.random() * (MAX_SPEED - MIN_SPEED);
  const ringSize = trailLen + 1;
  const chars = new Array<string>(ringSize).fill(char);

  return {
    col,
    headRow: -1,
    speed,
    speedAccum: 0,
    trailLen,
    colorKind,
    chars,
    headIdx: 1 % ringSize,
    alive: true,
  };
}

/** Create a drop at a specific row (used by word drop dissolution). */
function createDropAtRow(col: number, row: number, char: string, colorKind: RainColorKind, rng: RainRng): RainDrop {
  const drop = createDrop(col, char, colorKind, rng);
  drop.headRow = row;
  return drop;
}

// ---------------------------------------------------------------------------
// Spawn logic
// ---------------------------------------------------------------------------

/** Compute how many drops to attempt spawning this frame. */
function spawnCount(rainCols: number, idle: boolean): number {
  if (rainCols <= 0) return 0;
  return idle ? Math.max(1, Math.floor(rainCols / 30)) : Math.ceil(rainCols / 8);
}

/** Compute column cooldown frames after a spawn. */
function columnCooldown(trailLen: number, rng: RainRng): number {
  return trailLen + randInt(2, 2 + MAX_COOLDOWN_JITTER, rng);
}

// ---------------------------------------------------------------------------
// Word drop helpers
// ---------------------------------------------------------------------------

/** Fisher-Yates shuffle to produce a random dissolution order. */
function shuffleIndices(length: number, rng: RainRng): number[] {
  const indices = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(rng.random() * (i + 1));
    const tmp = indices[i];
    indices[i] = indices[j];
    indices[j] = tmp;
  }
  return indices;
}

/** Check if two word drops overlap (with vertical gap). */
function wordDropsOverlap(a: WordDrop, b: { col: number; row: number; wordLen: number }): boolean {
  const rowOverlap = Math.abs(a.row - b.row) <= WORD_DROP_VERTICAL_GAP;
  if (!rowOverlap) return false;
  const aEnd = a.col + a.word.length;
  const bEnd = b.col + b.wordLen;
  return a.col < bEnd && b.col < aEnd;
}

/** Get columns occupied by active word drops during forming/holding phases. */
function getOccupiedColumns(wordDrops: WordDrop[]): Set<number> {
  const occupied = new Set<number>();
  for (const wd of wordDrops) {
    if (wd.phase === 'forming' || wd.phase === 'holding') {
      for (let c = wd.col; c < wd.col + wd.word.length; c++) {
        occupied.add(c);
      }
    }
  }
  return occupied;
}

// ---------------------------------------------------------------------------
// RainEngine factory
// ---------------------------------------------------------------------------

export interface CreateRainEngineOptions {
  layout: TuiLayout;
  rng?: RainRng;
}

export function createRainEngine(options: CreateRainEngineOptions): RainEngine {
  const rng = options.rng ?? defaultRng;
  const rainChars = getRainChars();
  const queue = new TokenQueue(RAIN_QUEUE_CAPACITY);

  let rainCols = options.layout.rainCols;
  let rows = options.layout.textRows;
  let clearLine = ' '.repeat(rainCols);

  // Active drops
  const drops: RainDrop[] = [];

  // Per-column cooldown: frames remaining before a new drop can spawn
  let cooldowns = new Array<number>(rainCols).fill(0);

  // Frame counter (for idle detection)
  let frameCount = 0;
  let lastTokenFrame = 0;

  // Phase-driven color state
  let currentPhase: AgentPhase = 'idle';

  // Word drop state
  const activeWordDrops: WordDrop[] = [];
  const wordQueue: Array<{ word: string; source: WordDropSource }> = [];

  // ------------------------------------------------------------------
  // Tick: advance existing drops
  // ------------------------------------------------------------------

  function advanceDrops(): void {
    for (const drop of drops) {
      if (!drop.alive) continue;

      drop.speedAccum += drop.speed;
      const steps = Math.floor(drop.speedAccum);
      drop.speedAccum -= steps;

      for (let s = 0; s < steps; s++) {
        drop.headRow++;
        // Rotate a new character into the ring buffer on each step
        const newChar = randChar(rainChars, rng);
        drop.chars[drop.headIdx] = newChar;
        drop.headIdx = (drop.headIdx + 1) % drop.chars.length;
      }

      // Despawn when fully off-screen
      if (drop.headRow - drop.trailLen >= rows) {
        drop.alive = false;
      }
    }

    // Remove dead drops (in-place compaction avoids allocation)
    let writeIdx = 0;
    for (let i = 0; i < drops.length; i++) {
      if (drops[i].alive) drops[writeIdx++] = drops[i];
    }
    drops.length = writeIdx;
  }

  // ------------------------------------------------------------------
  // Tick: word drop lifecycle
  // ------------------------------------------------------------------

  function trySpawnWordDrop(): void {
    if (activeWordDrops.length >= MAX_ACTIVE_WORD_DROPS) return;
    if (wordQueue.length === 0) return;
    if (rainCols <= 4) return;

    const item = wordQueue.shift();
    if (!item) return;

    // Truncate to fit rain panel (leave 2-char margin)
    const maxLen = rainCols - 2;
    const word = item.word.length > maxLen ? item.word.slice(0, maxLen) : item.word;
    if (word.length === 0) return;

    // Try to find a non-overlapping position
    for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt++) {
      const row = randInt(2, Math.max(2, rows - 3), rng);
      const maxCol = Math.max(1, rainCols - word.length - 1);
      const col = randInt(1, maxCol, rng);

      const candidate = { col, row, wordLen: word.length };
      const overlaps = activeWordDrops.some((existing) => wordDropsOverlap(existing, candidate));

      if (!overlaps) {
        const holdDuration = randInt(MIN_HOLD_FRAMES, MAX_HOLD_FRAMES, rng);
        const wd: WordDrop = {
          word,
          source: item.source,
          col,
          row,
          phase: 'forming',
          phaseFrame: 0,
          revealedCount: 0,
          dissolveOrder: [],
          dissolvedCount: 0,
          holdDuration,
        };
        activeWordDrops.push(wd);
        return;
      }
    }

    // All attempts failed: re-queue at front for next frame
    wordQueue.unshift(item);
  }

  function advanceWordDrops(): void {
    let wi = 0;
    for (let i = 0; i < activeWordDrops.length; i++) {
      const wd = activeWordDrops[i];
      wd.phaseFrame++;

      if (wd.phase === 'forming') {
        // Reveal one character per frame
        if (wd.revealedCount < wd.word.length) {
          wd.revealedCount++;
        }
        const formDuration = Math.min(MAX_FORMING_FRAMES, Math.max(MIN_FORMING_FRAMES, wd.word.length));
        if (wd.phaseFrame >= formDuration && wd.revealedCount >= wd.word.length) {
          wd.phase = 'holding';
          wd.phaseFrame = 0;
        }
      } else if (wd.phase === 'holding') {
        if (wd.phaseFrame >= wd.holdDuration) {
          wd.phase = 'dissolving';
          wd.phaseFrame = 0;
          wd.dissolveOrder = shuffleIndices(wd.word.length, rng);
          wd.dissolvedCount = 0;
        }
      } else {
        // dissolving phase
        const dissolveDuration = Math.min(MAX_DISSOLVING_FRAMES, Math.max(MIN_DISSOLVING_FRAMES, wd.word.length));
        // Dissolve proportionally: release chars at even intervals
        const targetDissolved = Math.min(
          wd.word.length,
          Math.floor((wd.phaseFrame / dissolveDuration) * wd.word.length) + 1,
        );
        while (wd.dissolvedCount < targetDissolved && wd.dissolvedCount < wd.word.length) {
          const charIdx = wd.dissolveOrder[wd.dissolvedCount];
          const char = wd.word[charIdx];
          const dropCol = wd.col + charIdx;
          const colorKind = WORD_SOURCE_TO_COLOR_KIND[wd.source];
          if (dropCol < rainCols) {
            drops.push(createDropAtRow(dropCol, wd.row, char, colorKind, rng));
          }
          wd.dissolvedCount++;
        }
        if (wd.dissolvedCount >= wd.word.length) {
          // Word drop complete, remove
          continue; // skip the retain step
        }
      }
      activeWordDrops[wi++] = wd;
    }
    activeWordDrops.length = wi;
  }

  // ------------------------------------------------------------------
  // Tick: spawn new drops
  // ------------------------------------------------------------------

  function spawnDrops(): void {
    if (rainCols <= 0) return;

    // Decrement cooldowns
    for (let c = 0; c < cooldowns.length; c++) {
      if (cooldowns[c] > 0) cooldowns[c]--;
    }

    const idle = frameCount - lastTokenFrame >= IDLE_THRESHOLD_FRAMES;
    const count = spawnCount(rainCols, idle);

    // Columns occupied by forming/holding word drops suppress regular spawns
    const occupiedCols = getOccupiedColumns(activeWordDrops);

    // Build list of available columns (cooldown expired AND not occupied by word drops)
    const available: number[] = [];
    for (let c = 0; c < rainCols; c++) {
      if (cooldowns[c] <= 0 && !occupiedCols.has(c)) available.push(c);
    }

    for (let i = 0; i < count && available.length > 0; i++) {
      // Pick a random available column
      const idx = Math.floor(rng.random() * available.length);
      const col = available[idx];

      // Remove from available so we don't double-pick
      available.splice(idx, 1);

      let char: string;
      let colorKind: RainColorKind;

      if (idle) {
        char = randChar(rainChars, rng);
        colorKind = resolveDropColor(undefined, currentPhase);
      } else {
        const token = queue.shift();
        if (token) {
          char = token.char;
          colorKind = resolveDropColor(token, currentPhase);
        } else {
          // Queue drained mid-spawn: fill with ambient char
          char = randChar(rainChars, rng);
          colorKind = resolveDropColor(undefined, currentPhase);
        }
      }

      const drop = createDrop(col, char, colorKind, rng);
      drops.push(drop);

      // Set cooldown
      cooldowns[col] = columnCooldown(drop.trailLen, rng);
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  function clearRainPanel(buf: string[]): void {
    for (let row = 0; row < rows; row++) {
      buf.push(`\x1b[${row + 1};1H${clearLine}`);
    }
  }

  function renderDrop(drop: RainDrop, buf: string[]): void {
    const ringLen = drop.chars.length;

    for (let i = 0; i <= drop.trailLen; i++) {
      const row = drop.headRow - i;
      if (row < 0 || row >= rows) continue;

      // Read from ring buffer: headIdx-1 is the most recently written (head)
      const charIdx = (drop.headIdx - 1 - i + ringLen * (drop.trailLen + 2)) % ringLen;
      const char = drop.chars[charIdx];
      const color = trailColor(drop.colorKind, i);

      buf.push(`\x1b[${row + 1};${drop.col + 1}H${color}${char}`);
    }
  }

  function renderWordDrops(buf: string[]): void {
    for (const wd of activeWordDrops) {
      const color = WORD_COLORS[wd.source];
      const dissolvedSet = new Set<number>();

      if (wd.phase === 'dissolving') {
        for (let d = 0; d < wd.dissolvedCount; d++) {
          dissolvedSet.add(wd.dissolveOrder[d]);
        }
      }

      for (let ci = 0; ci < wd.word.length; ci++) {
        // During forming: only show revealed characters
        if (wd.phase === 'forming' && ci >= wd.revealedCount) continue;
        // During dissolving: skip dissolved characters
        if (wd.phase === 'dissolving' && dissolvedSet.has(ci)) continue;

        const screenCol = wd.col + ci + 1; // 1-indexed
        const screenRow = wd.row + 1; // 1-indexed
        if (screenRow <= rows) {
          buf.push(`\x1b[${screenRow};${screenCol}H${color}${wd.word[ci]}`);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Public interface
  // ------------------------------------------------------------------

  return {
    get queueDepth(): number {
      return queue.size;
    },

    enqueueTokens(tokens: readonly RainToken[]): void {
      queue.pushMany(tokens);
      lastTokenFrame = frameCount;
    },

    enqueueWord(word: string, source: WordDropSource): void {
      if (wordQueue.length >= MAX_WORD_QUEUE) {
        wordQueue.shift(); // drop oldest
      }
      wordQueue.push({ word, source });
    },

    setPhase(phase: AgentPhase): void {
      currentPhase = phase;
    },

    tick(): void {
      frameCount++;
      advanceDrops();
      trySpawnWordDrop();
      advanceWordDrops();
      spawnDrops();
    },

    render(): string {
      if (rainCols <= 0) return '';

      const buf: string[] = [];
      clearRainPanel(buf);

      for (const drop of drops) {
        renderDrop(drop, buf);
      }

      // Word drops render on top of regular drops
      renderWordDrops(buf);

      buf.push(SGR.RESET);
      return buf.join('');
    },

    resize(layout: TuiLayout): void {
      rainCols = layout.rainCols;
      rows = layout.textRows;
      clearLine = ' '.repeat(rainCols);

      // Kill out-of-bounds drops
      let wi = 0;
      for (let i = 0; i < drops.length; i++) {
        if (drops[i].col < rainCols && drops[i].alive) drops[wi++] = drops[i];
      }
      drops.length = wi;

      // Kill out-of-bounds word drops and clear queue
      let wdWi = 0;
      for (let i = 0; i < activeWordDrops.length; i++) {
        const wd = activeWordDrops[i];
        if (wd.col + wd.word.length <= rainCols && wd.row < rows) {
          activeWordDrops[wdWi++] = wd;
        }
      }
      activeWordDrops.length = wdWi;
      wordQueue.length = 0;

      // Resize cooldowns array
      const newCooldowns = new Array<number>(rainCols).fill(0);
      for (let c = 0; c < Math.min(cooldowns.length, rainCols); c++) {
        newCooldowns[c] = cooldowns[c];
      }
      cooldowns = newCooldowns;
    },
  };
}
