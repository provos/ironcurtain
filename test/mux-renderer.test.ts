import { describe, it, expect } from 'vitest';
import type { Terminal as TerminalType } from '@xterm/headless';
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
import {
  readTerminalBuffer,
  buildSgrSequence,
  cellStyleEquals,
  colorEquals,
  type TranslatedCell,
  type TermkitColor,
} from '../src/mux/mux-renderer.js';

/** Helper: write data to terminal and wait for it to be processed. */
function writeSync(terminal: TerminalType, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

describe('readTerminalBuffer', () => {
  it('translates basic text correctly', async () => {
    const terminal = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
    await writeSync(terminal, 'Hello');

    const cells = readTerminalBuffer(terminal, 0, 1, 10);
    expect(cells).toHaveLength(1);

    const row = cells[0];
    expect(row.length).toBeGreaterThanOrEqual(5);
    expect(row[0].char).toBe('H');
    expect(row[1].char).toBe('e');
    expect(row[2].char).toBe('l');
    expect(row[3].char).toBe('l');
    expect(row[4].char).toBe('o');
  });

  it('empty cells are spaces', () => {
    const terminal = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
    // Don't write anything -- buffer should be all spaces

    const cells = readTerminalBuffer(terminal, 0, 1, 10);
    expect(cells).toHaveLength(1);

    for (const cell of cells[0]) {
      expect(cell.char).toBe(' ');
    }
  });

  it('handles multiple rows', async () => {
    const terminal = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
    await writeSync(terminal, 'Line1\r\nLine2');

    const cells = readTerminalBuffer(terminal, 0, 2, 10);
    expect(cells).toHaveLength(2);

    expect(cells[0][0].char).toBe('L');
    expect(cells[0][4].char).toBe('1');
    expect(cells[1][0].char).toBe('L');
    expect(cells[1][4].char).toBe('2');
  });

  it('reads correct number of rows and columns', () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });

    const cells = readTerminalBuffer(terminal, 0, 5, 40);
    expect(cells).toHaveLength(5);
    for (const row of cells) {
      expect(row.length).toBeLessThanOrEqual(40);
    }
  });

  it('translates default colors', async () => {
    const terminal = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
    await writeSync(terminal, 'A');

    const cells = readTerminalBuffer(terminal, 0, 1, 10);
    const cell = cells[0][0];

    // Default colors should be 'default' or 0
    expect(cell.fg === 'default' || cell.fg === 0).toBe(true);
    expect(cell.bg === 'default' || cell.bg === 0).toBe(true);
  });

  it('translates bold attribute', async () => {
    const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    // ESC[1m enables bold, ESC[0m resets
    await writeSync(terminal, '\x1b[1mBold\x1b[0m');

    const cells = readTerminalBuffer(terminal, 0, 1, 20);
    expect(cells[0][0].bold).toBe(true);
    expect(cells[0][0].char).toBe('B');
  });

  it('translates 256-color palette', async () => {
    const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    // ESC[38;5;196m sets fg to color 196 (red)
    await writeSync(terminal, '\x1b[38;5;196mRed\x1b[0m');

    const cells = readTerminalBuffer(terminal, 0, 1, 20);
    expect(cells[0][0].char).toBe('R');
    expect(cells[0][0].fg).toBe(196);
  });

  it('translates 24-bit RGB colors', async () => {
    const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    // ESC[38;2;255;128;0m sets fg to RGB(255, 128, 0)
    await writeSync(terminal, '\x1b[38;2;255;128;0mOrange\x1b[0m');

    const cells = readTerminalBuffer(terminal, 0, 1, 20);
    const fg = cells[0][0].fg;
    expect(typeof fg).toBe('object');
    if (typeof fg === 'object') {
      expect(fg.r).toBe(255);
      expect(fg.g).toBe(128);
      expect(fg.b).toBe(0);
    }
  });

  it('translates multiple attributes', async () => {
    const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    // Bold + italic + underline
    await writeSync(terminal, '\x1b[1;3;4mStyled\x1b[0m');

    const cells = readTerminalBuffer(terminal, 0, 1, 20);
    const cell = cells[0][0];
    expect(cell.bold).toBe(true);
    expect(cell.italic).toBe(true);
    expect(cell.underline).toBe(true);
  });

  it('returns empty row for out-of-bounds line', () => {
    const terminal = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });

    // Request rows beyond what has content
    const cells = readTerminalBuffer(terminal, 100, 1, 10);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveLength(0);
  });

  it('reads from baseY to show current viewport after scrollback', async () => {
    const terminal = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });

    // Write 10 lines to force scrollback (only 5 fit in the viewport)
    for (let i = 0; i < 10; i++) {
      await writeSync(terminal, `Line ${i}\r\n`);
    }

    const baseY = terminal.buffer.active.baseY;
    expect(baseY).toBeGreaterThan(0);

    // Reading from baseY should show the current viewport (latest lines)
    const viewportCells = readTerminalBuffer(terminal, baseY, 5, 80);
    expect(viewportCells[0][0].char).toBe('L');
    // First viewport line should be Line 6 (lines 0-5 scrolled off)
    const firstLine = viewportCells[0]
      .map((c) => c.char)
      .join('')
      .trim();
    expect(firstLine).toContain('Line 6');

    // Reading from 0 would show stale scrollback (Line 0), not the viewport
    const staleContent = readTerminalBuffer(terminal, 0, 5, 80);
    const staleLine = staleContent[0]
      .map((c) => c.char)
      .join('')
      .trim();
    expect(staleLine).toContain('Line 0');
  });
});

// Helper to create a TranslatedCell with defaults
function makeCell(overrides: Partial<TranslatedCell> = {}): TranslatedCell {
  return {
    char: ' ',
    width: 1,
    fg: 'default' as TermkitColor,
    bg: 'default' as TermkitColor,
    bold: false,
    italic: false,
    underline: false,
    dim: false,
    inverse: false,
    strikethrough: false,
    ...overrides,
  };
}

describe('colorEquals', () => {
  it('matches identical default colors', () => {
    expect(colorEquals('default', 'default')).toBe(true);
  });

  it('matches identical palette numbers', () => {
    expect(colorEquals(196, 196)).toBe(true);
  });

  it('rejects different palette numbers', () => {
    expect(colorEquals(196, 42)).toBe(false);
  });

  it('matches identical RGB objects', () => {
    expect(colorEquals({ r: 255, g: 128, b: 0 }, { r: 255, g: 128, b: 0 })).toBe(true);
  });

  it('rejects different RGB objects', () => {
    expect(colorEquals({ r: 255, g: 128, b: 0 }, { r: 0, g: 128, b: 255 })).toBe(false);
  });

  it('rejects mixed types', () => {
    expect(colorEquals('default', 196)).toBe(false);
    expect(colorEquals(196, { r: 0, g: 0, b: 0 })).toBe(false);
    expect(colorEquals('default', { r: 0, g: 0, b: 0 })).toBe(false);
  });
});

describe('cellStyleEquals', () => {
  it('matches identical default cells', () => {
    expect(cellStyleEquals(makeCell(), makeCell())).toBe(true);
  });

  it('ignores char and width differences', () => {
    expect(cellStyleEquals(makeCell({ char: 'A', width: 1 }), makeCell({ char: 'Z', width: 2 }))).toBe(true);
  });

  it('detects bold difference', () => {
    expect(cellStyleEquals(makeCell({ bold: true }), makeCell({ bold: false }))).toBe(false);
  });

  it('detects fg color difference', () => {
    expect(cellStyleEquals(makeCell({ fg: 196 }), makeCell({ fg: 42 }))).toBe(false);
  });

  it('detects bg color difference', () => {
    expect(cellStyleEquals(makeCell({ bg: { r: 0, g: 0, b: 0 } }), makeCell({ bg: 'default' }))).toBe(false);
  });

  it('matches cells with identical non-default attributes', () => {
    const style = { bold: true, italic: true, fg: 196 as TermkitColor, bg: { r: 10, g: 20, b: 30 } as TermkitColor };
    expect(cellStyleEquals(makeCell(style), makeCell(style))).toBe(true);
  });
});

describe('buildSgrSequence', () => {
  it('produces reset + default colors for plain cell', () => {
    const sgr = buildSgrSequence(makeCell());
    expect(sgr).toBe('0;39;49');
  });

  it('includes bold code', () => {
    const sgr = buildSgrSequence(makeCell({ bold: true }));
    expect(sgr).toContain(';1;');
  });

  it('includes 256-color fg', () => {
    const sgr = buildSgrSequence(makeCell({ fg: 196 }));
    expect(sgr).toContain('38;5;196');
  });

  it('includes RGB bg', () => {
    const sgr = buildSgrSequence(makeCell({ bg: { r: 10, g: 20, b: 30 } }));
    expect(sgr).toContain('48;2;10;20;30');
  });

  it('includes multiple attributes', () => {
    const sgr = buildSgrSequence(makeCell({ bold: true, italic: true, underline: true }));
    // Should start with 0 (reset) then have 1, 3, 4
    expect(sgr).toMatch(/^0;1;3;4;/);
  });
});
