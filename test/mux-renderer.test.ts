import { describe, it, expect } from 'vitest';
import type { Terminal as TerminalType } from '@xterm/headless';
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
import {
  readTerminalBuffer,
  buildSgrSequence,
  cellStyleEquals,
  colorEquals,
  computeVisualLines,
  cursorToVisualPosition,
  truncate,
  fitTabLabels,
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

describe('computeVisualLines', () => {
  it('empty string produces one empty visual line', () => {
    const lines = computeVisualLines('', 20);
    expect(lines).toEqual([{ text: '', bufferOffset: 0 }]);
  });

  it('short string fits in one visual line', () => {
    const lines = computeVisualLines('hello', 20);
    expect(lines).toEqual([{ text: 'hello', bufferOffset: 0 }]);
  });

  it('wraps at contentWidth', () => {
    const lines = computeVisualLines('abcdefghij', 5);
    expect(lines).toEqual([
      { text: 'abcde', bufferOffset: 0 },
      { text: 'fghij', bufferOffset: 5 },
    ]);
  });

  it('handles hard newlines', () => {
    const lines = computeVisualLines('abc\ndef', 20);
    expect(lines).toEqual([
      { text: 'abc', bufferOffset: 0 },
      { text: 'def', bufferOffset: 4 },
    ]);
  });

  it('handles mixed hard newlines and wrapping', () => {
    const lines = computeVisualLines('abcde\nfghij', 3);
    expect(lines).toEqual([
      { text: 'abc', bufferOffset: 0 },
      { text: 'de', bufferOffset: 3 },
      { text: 'fgh', bufferOffset: 6 },
      { text: 'ij', bufferOffset: 9 },
    ]);
  });

  it('trailing newline produces an empty visual line', () => {
    const lines = computeVisualLines('abc\n', 20);
    expect(lines).toEqual([
      { text: 'abc', bufferOffset: 0 },
      { text: '', bufferOffset: 4 },
    ]);
  });

  it('multiple consecutive newlines produce empty visual lines', () => {
    const lines = computeVisualLines('a\n\nb', 20);
    expect(lines).toEqual([
      { text: 'a', bufferOffset: 0 },
      { text: '', bufferOffset: 2 },
      { text: 'b', bufferOffset: 3 },
    ]);
  });
});

describe('cursorToVisualPosition', () => {
  it('cursor at start', () => {
    const lines = computeVisualLines('hello', 20);
    expect(cursorToVisualPosition(lines, 0)).toEqual({ row: 0, col: 0 });
  });

  it('cursor at end of single line', () => {
    const lines = computeVisualLines('hello', 20);
    expect(cursorToVisualPosition(lines, 5)).toEqual({ row: 0, col: 5 });
  });

  it('cursor at wrap point belongs to next line', () => {
    const lines = computeVisualLines('abcdefghij', 5);
    // Position 5 is start of second visual line
    expect(cursorToVisualPosition(lines, 5)).toEqual({ row: 1, col: 0 });
  });

  it('cursor after hard newline', () => {
    const lines = computeVisualLines('abc\ndef', 20);
    // Position 4 is 'd' on second line
    expect(cursorToVisualPosition(lines, 4)).toEqual({ row: 1, col: 0 });
  });

  it('cursor at end of buffer with trailing newline', () => {
    const lines = computeVisualLines('abc\n', 20);
    // Position 4 is on the empty line after \n
    expect(cursorToVisualPosition(lines, 4)).toEqual({ row: 1, col: 0 });
  });

  it('cursor in middle of wrapped second line', () => {
    const lines = computeVisualLines('abcdefghij', 5);
    // Position 7 is 'h', col 2 of second visual line
    expect(cursorToVisualPosition(lines, 7)).toEqual({ row: 1, col: 2 });
  });
});

describe('truncate', () => {
  it('returns string unchanged when within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates with ellipsis when over limit', () => {
    expect(truncate('hello world', 5)).toBe('hell\u2026');
    expect(truncate('abcdef', 3)).toBe('ab\u2026');
  });
});

describe('fitTabLabels', () => {
  const makeTabs = (...names: string[]) =>
    names.map((name, i) => ({ displayNumber: i + 1, label: `[${i + 1}] ${name}` }));

  it('fits all tabs when width is sufficient', () => {
    const tabs = makeTabs('server/tool');
    const result = fitTabLabels(tabs, 1, 50);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ label: '[1] server/tool', isFocused: true });
  });

  it('fits multiple tabs', () => {
    const tabs = makeTabs('a/b', 'c/d');
    // [1] a/b = 7 chars + 2 spaces = 9; [2] c/d = 7 + 2 = 9; total = 18
    const result = fitTabLabels(tabs, 2, 20);
    expect(result).toHaveLength(2);
    expect(result[0].isFocused).toBe(false);
    expect(result[1].isFocused).toBe(true);
  });

  it('truncates focused tab when it overflows', () => {
    const tabs = makeTabs('longservername/longtoolname');
    // Label: "[1] longservername/longtoolname" = 30 chars, needs 32 with spaces
    const result = fitTabLabels(tabs, 1, 15);
    expect(result).toHaveLength(1);
    expect(result[0].isFocused).toBe(true);
    // 15 width - 2 spaces = 13 chars for label, truncated with ellipsis
    expect(result[0].label.length).toBe(13);
    expect(result[0].label).toMatch(/\u2026$/);
  });

  it('does not render focused tab when remaining space is less than 3', () => {
    const tabs = makeTabs('a/b', 'longservername/longtoolname');
    // First tab "[1] a/b" = 7 + 2 = 9 written
    // Remaining = 10 - 9 = 1, which is < 3
    const result = fitTabLabels(tabs, 2, 10);
    expect(result).toHaveLength(1);
    expect(result[0].isFocused).toBe(false);
  });

  it('renders focused tab with exactly 3 remaining columns', () => {
    const tabs = makeTabs('a/b', 'longservername/longtoolname');
    // First tab "[1] a/b" = 7 + 2 = 9 written
    // Remaining = 12 - 9 = 3, which is exactly 3 → fits 1 char
    const result = fitTabLabels(tabs, 2, 12);
    expect(result).toHaveLength(2);
    expect(result[1].isFocused).toBe(true);
    expect(result[1].label.length).toBe(1);
  });

  it('never exceeds width', () => {
    const tabs = makeTabs('server/tool', 'another/tool', 'third/tool');
    for (const width of [3, 5, 10, 15, 20, 30, 50]) {
      const result = fitTabLabels(tabs, 2, width);
      const totalWritten = result.reduce((sum, t) => sum + t.label.length + 2, 0);
      expect(totalWritten).toBeLessThanOrEqual(width);
    }
  });

  it('skips non-focused tabs that do not fit', () => {
    const tabs = makeTabs('longservername/longtoolname');
    // Not focused, so don't truncate — just skip
    const result = fitTabLabels(tabs, 999, 10);
    expect(result).toHaveLength(0);
  });
});
