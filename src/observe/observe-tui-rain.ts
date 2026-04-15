/**
 * Rain engine for the observe TUI.
 *
 * Manages a pool of falling "drops" fed by a bounded token queue.
 * Each drop carries characters from LLM token events (text, tool, error)
 * or random katakana when idle, rendered with per-kind color gradients.
 *
 * Adapted from mux-splash.ts drop mechanics but uses continuous
 * free-falling drops instead of target-locking drops.
 */

import {
  type RainToken,
  type RainDrop,
  type RainColorKind,
  type TuiLayout,
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
  let rows = options.layout.rows;
  let clearLine = ' '.repeat(rainCols);

  // Active drops
  const drops: RainDrop[] = [];

  // Per-column cooldown: frames remaining before a new drop can spawn
  let cooldowns = new Array<number>(rainCols).fill(0);

  // Frame counter (for idle detection)
  let frameCount = 0;
  let lastTokenFrame = 0;

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

    // Build list of available columns (cooldown expired)
    const available: number[] = [];
    for (let c = 0; c < rainCols; c++) {
      if (cooldowns[c] <= 0) available.push(c);
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
        colorKind = 'idle';
      } else {
        const token = queue.shift();
        if (token) {
          char = token.char;
          colorKind = token.kind;
        } else {
          // Queue drained mid-spawn: fill with idle char
          char = randChar(rainChars, rng);
          colorKind = 'idle';
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

    tick(): void {
      frameCount++;
      advanceDrops();
      spawnDrops();
    },

    render(): string {
      if (rainCols <= 0) return '';

      const buf: string[] = [];
      clearRainPanel(buf);

      for (const drop of drops) {
        renderDrop(drop, buf);
      }

      buf.push(SGR.RESET);
      return buf.join('');
    },

    resize(layout: TuiLayout): void {
      rainCols = layout.rainCols;
      rows = layout.rows;
      clearLine = ' '.repeat(rainCols);

      // Kill out-of-bounds drops
      let wi = 0;
      for (let i = 0; i < drops.length; i++) {
        if (drops[i].col < rainCols && drops[i].alive) drops[wi++] = drops[i];
      }
      drops.length = wi;

      // Resize cooldowns array
      const newCooldowns = new Array<number>(rainCols).fill(0);
      for (let c = 0; c < Math.min(cooldowns.length, rainCols); c++) {
        newCooldowns[c] = cooldowns[c];
      }
      cooldowns = newCooldowns;
    },
  };
}
