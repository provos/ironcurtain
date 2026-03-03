/**
 * Matrix-style splash screen for `ironcurtain mux`.
 *
 * Renders a Matrix rain animation where characters fall from the top
 * and lock into ASCII art positions forming "IronCurtain".
 * Shows usage info below the art after the animation completes.
 */

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TerminalKit = any;

// ---------------------------------------------------------------------------
// Font data
// ---------------------------------------------------------------------------

const GLYPH_HEIGHT = 6;
const GLYPH_SPACING = 1;

interface Glyph {
  rows: string[]; // '#' = filled, ' ' = empty
  width: number;
}

const FONT: Record<string, Glyph> = {
  I: {
    width: 5,
    rows: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '#####'],
  },
  r: {
    width: 5,
    rows: ['     ', '     ', '# ## ', '##  #', '#    ', '#    '],
  },
  o: {
    width: 5,
    rows: ['     ', '     ', ' ### ', '#   #', '#   #', ' ### '],
  },
  n: {
    width: 5,
    rows: ['     ', '     ', '# ## ', '##  #', '#   #', '#   #'],
  },
  C: {
    width: 7,
    rows: [' ##### ', '#     #', '#      ', '#      ', '#     #', ' ##### '],
  },
  u: {
    width: 5,
    rows: ['     ', '     ', '#   #', '#   #', '#   #', ' ### '],
  },
  t: {
    width: 5,
    rows: ['  #  ', '  #  ', '#####', '  #  ', '  #  ', '  ## '],
  },
  a: {
    width: 5,
    rows: ['     ', ' ### ', '    #', ' ####', '#   #', ' ####'],
  },
  i: {
    width: 3,
    rows: [' # ', '   ', '## ', ' # ', ' # ', '###'],
  },
};

const WORD = 'IronCurtain';

// ---------------------------------------------------------------------------
// Animation constants
// ---------------------------------------------------------------------------

const RAIN_CHARS = 'ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789';
const TRAIL_LEN = 4;
const FRAME_MS = 33; // ~30 FPS
const MAX_START_FRAME = 15;

// SGR color sequences (true-color)
const CLR_HEAD = '\x1b[1;38;2;180;255;180m'; // bright white-green head
const CLR_NEAR = '\x1b[38;2;0;255;70m'; // bright green trail
const CLR_FAR = '\x1b[38;2;0;120;0m'; // dim green trail
const CLR_ART = '\x1b[38;2;0;200;0m'; // locked art
const SGR_RESET = '\x1b[0m';

// Info text colors
const CLR_CYAN = '\x1b[36m';
const CLR_BOLD_GREEN = '\x1b[1;32m';
const CLR_DIM = '\x1b[2m';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface WordLayout {
  startX: number;
  startY: number;
  totalWidth: number;
  glyphs: Array<{ char: string; glyph: Glyph; offsetX: number }>;
}

const INFO_ROWS = 10; // header + blank + 4 commands + blank + ctrl-a + margin

function computeWordLayout(cols: number, viewportRows: number): WordLayout | null {
  let totalWidth = 0;
  const glyphs: WordLayout['glyphs'] = [];

  for (const char of WORD) {
    const glyph = FONT[char];
    glyphs.push({ char, glyph, offsetX: totalWidth });
    totalWidth += glyph.width + GLYPH_SPACING;
  }
  totalWidth -= GLYPH_SPACING; // remove trailing spacing

  // Too narrow or too short -> fallback
  if (totalWidth > cols || viewportRows < GLYPH_HEIGHT + 6) {
    return null;
  }

  const startX = Math.floor((cols - totalWidth) / 2);
  const startY = Math.max(0, Math.floor((viewportRows - GLYPH_HEIGHT - INFO_ROWS) / 2));

  return { startX, startY, totalWidth, glyphs };
}

// ---------------------------------------------------------------------------
// Rain columns
// ---------------------------------------------------------------------------

interface RainColumn {
  screenX: number;
  targetY: number; // viewport-relative
  startFrame: number;
  headY: number; // viewport-relative (can be negative)
  locked: boolean;
}

function buildRainColumns(layout: WordLayout): RainColumn[] {
  const columns: RainColumn[] = [];

  for (const { glyph, offsetX } of layout.glyphs) {
    for (let row = 0; row < GLYPH_HEIGHT; row++) {
      for (let col = 0; col < glyph.width; col++) {
        if (glyph.rows[row][col] === '#') {
          columns.push({
            screenX: layout.startX + offsetX + col,
            targetY: layout.startY + row,
            startFrame: Math.floor(Math.random() * MAX_START_FRAME),
            headY: -1 - Math.floor(Math.random() * 5),
            locked: false,
          });
        }
      }
    }
  }

  return columns;
}

function randChar(): string {
  return RAIN_CHARS[Math.floor(Math.random() * RAIN_CHARS.length)];
}

// ---------------------------------------------------------------------------
// SplashScreen
// ---------------------------------------------------------------------------

export interface SplashScreen {
  start(): void;
  stop(): void;
  draw(): void;
  resize(cols: number, viewportRows: number, viewportY: number, reservedBottom: number): void;
  readonly active: boolean;
}

export function createSplashScreen(
  term: TerminalKit,
  cols: number,
  viewportRows: number,
  viewportY: number,
  reservedBottom: number,
): SplashScreen {
  let _cols = cols;
  let _viewportRows = viewportRows;
  let _viewportY = viewportY;
  let _reservedBottom = reservedBottom;
  let _layout: WordLayout | null = null;
  let _rain: RainColumn[] = [];
  let _frame = 0;
  let _interval: ReturnType<typeof setInterval> | null = null;
  let _active = false;
  let _done = false;

  function init(): void {
    _layout = computeWordLayout(_cols, _viewportRows - _reservedBottom);
    if (_layout) {
      _rain = buildRainColumns(_layout);
    }
    _frame = 0;
    _done = false;
  }

  // -- Render helpers -------------------------------------------------------

  /** Number of rows the splash may draw in (viewport minus reserved overlay). */
  function drawableRows(): number {
    return Math.max(0, _viewportRows - _reservedBottom);
  }

  /** Returns a buffer pre-filled with escape sequences to clear drawable rows. */
  function clearViewport(): string[] {
    const buf: string[] = [];
    const rows = drawableRows();
    for (let r = 0; r < rows; r++) {
      buf.push(`\x1b[${_viewportY + r + 1};1H\x1b[2K`);
    }
    return buf;
  }

  /** Renders a single animation frame (or the final static state). */
  function render(): void {
    if (!_layout) {
      renderFallback();
      return;
    }

    const buf = clearViewport();
    const maxY = drawableRows();

    // Set of locked positions so trails don't overwrite them
    const lockedSet = new Set<string>();
    for (const rc of _rain) {
      if (rc.locked) lockedSet.add(`${rc.screenX},${rc.targetY}`);
    }

    // Draw rain trails (under locked cells)
    if (!_done) {
      for (const rc of _rain) {
        if (rc.locked || _frame < rc.startFrame) continue;
        for (let d = 0; d <= TRAIL_LEN; d++) {
          const y = rc.headY - d;
          if (y < 0 || y >= maxY) continue;
          if (lockedSet.has(`${rc.screenX},${y}`)) continue;
          const clr = d === 0 ? CLR_HEAD : d <= 2 ? CLR_NEAR : CLR_FAR;
          buf.push(`\x1b[${_viewportY + y + 1};${rc.screenX + 1}H${clr}${randChar()}`);
        }
      }
    }

    // Draw locked cells
    for (const rc of _rain) {
      if (!rc.locked) continue;
      if (rc.targetY >= maxY) continue;
      buf.push(`\x1b[${_viewportY + rc.targetY + 1};${rc.screenX + 1}H${CLR_ART}\u2588`);
    }

    buf.push(SGR_RESET);
    term.noFormat(buf.join(''));

    if (_done) renderInfo();
  }

  /** Plain-text fallback for terminals too small for the art. */
  function renderFallback(): void {
    const label = 'IronCurtain';
    const maxY = drawableRows();
    const y = Math.floor(maxY / 2);
    const x = Math.max(0, Math.floor((_cols - label.length) / 2));

    const buf = clearViewport();
    buf.push(`\x1b[${_viewportY + y + 1};${x + 1}H${CLR_BOLD_GREEN}${label}${SGR_RESET}`);

    const hint = '/new \u2014 Spawn session  |  /quit \u2014 Exit  |  Ctrl-A \u2014 Toggle mode';
    const hx = Math.max(0, Math.floor((_cols - hint.length) / 2));
    if (y + 2 < maxY) {
      buf.push(`\x1b[${_viewportY + y + 3};${hx + 1}H${CLR_DIM}${hint}${SGR_RESET}`);
    }

    term.noFormat(buf.join(''));
    _done = true;
  }

  /** Draws the info text block below the art. */
  function renderInfo(): void {
    if (!_layout) return;

    const infoY = _viewportY + _layout.startY + GLYPH_HEIGHT + 2;

    const header = 'IronCurtain';
    const subtitle = ' \u2014 Secure* Agent Runtime';
    const headerX = Math.max(0, Math.floor((_cols - header.length - subtitle.length) / 2));

    const commands: Array<{ cmd: string; desc: string } | null> = [
      null,
      { cmd: '/new', desc: 'Spawn a new session (sandbox or workspace)' },
      { cmd: '/tab N', desc: 'Switch to tab N' },
      { cmd: '/close', desc: 'Close the current tab' },
      { cmd: '/quit', desc: 'Exit the multiplexer' },
      null,
      { cmd: 'Ctrl-A', desc: 'Toggle command / PTY mode' },
    ];

    const CMD_WIDTH = 14;
    const maxDescWidth = commands.reduce((max, c) => (c ? Math.max(max, c.desc.length) : max), 0);
    const maxWidth = CMD_WIDTH + maxDescWidth + 4; // 2 leading spaces + 2 padding
    const blockX = Math.max(0, Math.floor((_cols - maxWidth) / 2));

    const buf: string[] = [];

    const maxScreenY = _viewportY + drawableRows();

    // Header
    if (infoY < maxScreenY) {
      buf.push(
        `\x1b[${infoY + 1};${headerX + 1}H${CLR_BOLD_GREEN}${header}${SGR_RESET}${CLR_DIM}${subtitle}${SGR_RESET}`,
      );
    }

    // Command lines
    let y = infoY + 1;
    for (const line of commands) {
      if (y >= maxScreenY) break;
      if (!line) {
        y++;
        continue;
      }
      buf.push(
        `\x1b[${y + 1};${blockX + 1}H  ${CLR_CYAN}${line.cmd.padEnd(CMD_WIDTH)}${SGR_RESET}${CLR_DIM}${line.desc}${SGR_RESET}`,
      );
      y++;
    }

    term.noFormat(buf.join(''));
  }

  // -- Animation tick -------------------------------------------------------

  function tick(): void {
    _frame++;

    let allLocked = true;
    for (const rc of _rain) {
      if (rc.locked) continue;
      allLocked = false;
      if (_frame >= rc.startFrame) {
        rc.headY++;
        if (rc.headY >= rc.targetY) {
          rc.locked = true;
        }
      }
    }

    if (allLocked) {
      _done = true;
      if (_interval) {
        clearInterval(_interval);
        _interval = null;
      }
    }

    render();
  }

  // -- Initialize -----------------------------------------------------------

  init();

  // -- Public interface -----------------------------------------------------

  return {
    get active() {
      return _active;
    },

    start(): void {
      if (_active) return;
      _active = true;

      if (!_layout) {
        render();
        return;
      }

      _interval = setInterval(tick, FRAME_MS);
      _interval.unref();
    },

    stop(): void {
      _active = false;
      if (_interval) {
        clearInterval(_interval);
        _interval = null;
      }
    },

    draw(): void {
      render();
    },

    resize(cols: number, viewportRows: number, viewportY: number, reservedBottom: number): void {
      _cols = cols;
      _viewportRows = viewportRows;
      _viewportY = viewportY;
      _reservedBottom = reservedBottom;

      _layout = computeWordLayout(_cols, _viewportRows - _reservedBottom);

      if (!_layout) {
        // Terminal too small: stop animation, fall back to plain text on next draw
        _rain = [];
        if (_interval) {
          clearInterval(_interval);
          _interval = null;
        }
      } else if (_done) {
        // Re-render final state with new layout
        _rain = buildRainColumns(_layout);
        for (const rc of _rain) rc.locked = true;
      } else {
        // Restart animation with new positions
        _rain = buildRainColumns(_layout);
        _frame = 0;
      }
    },
  };
}
