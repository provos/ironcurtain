/**
 * MuxInputHandler -- key routing state machine for the terminal multiplexer.
 *
 * Two input modes:
 * - PTY mode: all keystrokes go to the active PtyBridge except Ctrl-A
 * - Command mode: keystrokes collected in a line buffer, dispatched on Enter
 *
 * Ctrl-A toggles between modes (following screen/tmux convention).
 * Pressing Ctrl-A in PTY mode enters command mode; pressing it again
 * returns to PTY mode.
 */

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { expandTilde } from '../types/argument-roles.js';
import type { InputMode, MuxAction } from './types.js';

export type PickerPhase = 'menu' | 'browse';

export interface PickerState {
  phase: PickerPhase;
  // menu phase
  menuSelection: number; // 0 or 1
  // browse phase
  inputPath: string;
  cursorPos: number;
  entries: string[]; // directory entries (dirs have trailing /)
  selectedIndex: number;
  scrollOffset: number;
  inList: boolean; // true when focus is in the entry list (vs. the input field)
  error: string | null;
}

export interface MuxInputHandler {
  /** Current input mode. */
  readonly mode: InputMode;

  /** Current command-mode input buffer (for display). */
  readonly inputBuffer: string;

  /** Cursor position within the input buffer. */
  readonly cursorPos: number;

  /** Current picker state (null when not in picker mode). */
  readonly pickerState: PickerState | null;

  /** Enter picker mode (called by /new command handler). */
  enterPickerMode(): void;

  /** Re-enter picker browse phase with a validation error. */
  enterBrowseWithError(path: string, error: string): void;

  /** Exit picker mode and return to PTY mode (no side effects). */
  exitPickerMode(): void;

  /**
   * Processes a key event from terminal-kit.
   * Returns a MuxAction describing what the orchestrator should do.
   */
  handleKey(key: string): MuxAction;
}

/** terminal-kit key names for special keys. */
const CTRL_A = 'CTRL_A';
const ENTER = 'ENTER';
const ESCAPE = 'ESCAPE';
const CTRL_C = 'CTRL_C';
const BACKSPACE = 'BACKSPACE';
const DELETE = 'DELETE';
const LEFT = 'LEFT';
const RIGHT = 'RIGHT';
const UP = 'UP';
const DOWN = 'DOWN';
const TAB = 'TAB';

/**
 * Maps terminal-kit key names to raw escape sequences for the PTY.
 * terminal-kit emits human-readable names (e.g. 'ENTER'), but the
 * child PTY expects raw bytes (e.g. '\r').
 */
const KEY_TO_SEQUENCE: Record<string, string> = {
  ENTER: '\r',
  BACKSPACE: '\x7f',
  ESCAPE: '\x1b',
  DELETE: '\x1b[3~',
  TAB: '\t',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',
  HOME: '\x1b[H',
  END: '\x1b[F',
  PAGE_UP: '\x1b[5~',
  PAGE_DOWN: '\x1b[6~',
  INSERT: '\x1b[2~',
  // Ctrl keys -> raw bytes
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, i) => [`CTRL_${String.fromCharCode(65 + i)}`, String.fromCharCode(i + 1)]),
  ),
};

/**
 * Splits a path input into the directory portion and the filename prefix.
 */
function splitDirPrefix(inputPath: string): { dir: string; prefix: string } {
  const lastSlash = inputPath.lastIndexOf('/');
  if (lastSlash === -1) {
    return { dir: homedir(), prefix: inputPath };
  }
  return { dir: inputPath.slice(0, lastSlash) || '/', prefix: inputPath.slice(lastSlash + 1) };
}

// Cache for directory listings to avoid re-reading on every keystroke
// when only the prefix (filename portion) changes.
let _cachedDir: string | null = null;
let _cachedDirents: import('node:fs').Dirent[] = [];

/**
 * Reads directory entries for the picker's browse phase.
 * Returns entries matching the prefix, with trailing `/` for directories.
 * Directories are sorted first, then alphabetical.
 * Caches the raw directory listing; only re-reads when the directory changes.
 */
function refreshEntries(inputPath: string): string[] {
  const { dir: rawDir, prefix } = splitDirPrefix(inputPath);
  const dir = expandTilde(rawDir);

  try {
    if (dir !== _cachedDir) {
      _cachedDirents = readdirSync(dir, { withFileTypes: true });
      _cachedDir = dir;
    }

    const entries: { name: string; isDir: boolean }[] = [];
    for (const ent of _cachedDirents) {
      if (!ent.name.startsWith(prefix)) continue;
      if (ent.name.startsWith('.') && !prefix.startsWith('.')) continue;
      entries.push({ name: ent.name, isDir: ent.isDirectory() });
    }

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return entries.map((e) => (e.isDir ? e.name + '/' : e.name));
  } catch {
    return [];
  }
}

/**
 * Finds the longest common prefix among a list of strings.
 */
function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix.length === 0) return '';
    }
  }
  return prefix;
}

export interface MuxInputHandlerOptions {
  initialMode?: InputMode;
}

export function createMuxInputHandler(options?: MuxInputHandlerOptions): MuxInputHandler {
  let _mode: InputMode = options?.initialMode ?? 'pty';
  let _inputBuffer = '';
  let _cursorPos = 0;
  let _pickerState: PickerState | null = null;

  function enterPickerMode(): void {
    _mode = 'picker';
    _pickerState = {
      phase: 'menu',
      menuSelection: 0,
      inputPath: '',
      cursorPos: 0,
      entries: [],
      selectedIndex: 0,
      scrollOffset: 0,
      inList: false,
      error: null,
    };
  }

  /** Resets entry selection and scroll after refreshing entries. */
  function resetEntrySelection(ps: PickerState): void {
    ps.entries = refreshEntries(ps.inputPath);
    ps.selectedIndex = 0;
    ps.scrollOffset = 0;
  }

  function initBrowsePhase(path?: string): void {
    if (!_pickerState) return;
    const browsePath = path ?? homedir() + '/';
    _pickerState.phase = 'browse';
    _pickerState.inputPath = browsePath;
    _pickerState.cursorPos = browsePath.length;
    _pickerState.inList = false;
    _pickerState.error = null;
    resetEntrySelection(_pickerState);
  }

  function enterBrowseWithError(path: string, error: string): void {
    _mode = 'picker';
    _pickerState = {
      phase: 'browse',
      menuSelection: 0,
      inputPath: path,
      cursorPos: path.length,
      entries: [],
      selectedIndex: 0,
      scrollOffset: 0,
      inList: false,
      error,
    };
    resetEntrySelection(_pickerState);
  }

  function exitPickerMode(): void {
    _mode = 'pty';
    _pickerState = null;
  }

  function executeMenuSelection(selection: number): MuxAction {
    if (selection === 0) {
      _mode = 'pty';
      _pickerState = null;
      return { kind: 'picker-spawn' };
    }
    initBrowsePhase();
    return { kind: 'redraw-picker' };
  }

  function handleMenuKey(key: string): MuxAction {
    const ps = _pickerState;
    if (!ps) return { kind: 'none' };

    if (key === '1') return executeMenuSelection(0);
    if (key === '2') return executeMenuSelection(1);
    if (key === ENTER) return executeMenuSelection(ps.menuSelection);

    if (key === UP || key === DOWN) {
      ps.menuSelection = ps.menuSelection === 0 ? 1 : 0;
      return { kind: 'redraw-picker' };
    }

    if (key === ESCAPE || key === CTRL_C) {
      _mode = 'command';
      _pickerState = null;
      return { kind: 'picker-cancel' };
    }

    return { kind: 'none' };
  }

  function handleBrowseKey(key: string): MuxAction {
    const ps = _pickerState;
    if (!ps) return { kind: 'none' };
    ps.error = null;

    if (key === ESCAPE || key === CTRL_C) {
      if (ps.inList) {
        // Return from list to input field
        ps.inList = false;
        return { kind: 'redraw-picker' };
      }
      // Return to menu phase
      ps.phase = 'menu';
      ps.menuSelection = 0;
      return { kind: 'redraw-picker' };
    }

    // Tab completion (only when in input field)
    if (key === TAB && !ps.inList) {
      if (ps.entries.length === 0) {
        return { kind: 'none' };
      }

      const { dir: dirPart, prefix } = splitDirPrefix(ps.inputPath);
      const base = dirPart === homedir() && !ps.inputPath.includes('/') ? '' : dirPart + '/';

      if (ps.entries.length === 1) {
        ps.inputPath = base + ps.entries[0];
        ps.cursorPos = ps.inputPath.length;
        resetEntrySelection(ps);
      } else {
        const names = ps.entries.map((e) => e.replace(/\/$/, ''));
        const lcp = longestCommonPrefix(names);
        if (lcp.length > prefix.length) {
          ps.inputPath = base + lcp;
          ps.cursorPos = ps.inputPath.length;
          resetEntrySelection(ps);
        }
      }
      return { kind: 'redraw-picker' };
    }

    // Up/Down navigation
    if (key === DOWN) {
      if (!ps.inList) {
        // Move focus from input field into the entry list
        if (ps.entries.length > 0) {
          ps.inList = true;
          ps.selectedIndex = 0;
          ps.scrollOffset = 0;
        }
      } else if (ps.selectedIndex < ps.entries.length - 1) {
        ps.selectedIndex++;
      }
      return { kind: 'redraw-picker' };
    }

    if (key === UP) {
      if (ps.inList) {
        if (ps.selectedIndex > 0) {
          ps.selectedIndex--;
          if (ps.selectedIndex < ps.scrollOffset) {
            ps.scrollOffset = ps.selectedIndex;
          }
        } else {
          // At top of list — return focus to input field
          ps.inList = false;
        }
      }
      return { kind: 'redraw-picker' };
    }

    // When in list mode, Enter picks the entry into the input field
    if (key === ENTER && ps.inList) {
      if (ps.selectedIndex < ps.entries.length) {
        const selected = ps.entries[ps.selectedIndex];
        const { dir: dirPart } = splitDirPrefix(ps.inputPath);
        ps.inputPath = dirPart + '/' + selected;
        ps.cursorPos = ps.inputPath.length;
        ps.inList = false;
        resetEntrySelection(ps);
      }
      return { kind: 'redraw-picker' };
    }

    // When in input field, Enter submits the current path
    if (key === ENTER && !ps.inList) {
      if (ps.inputPath.trim()) {
        const workspacePath = ps.inputPath.replace(/\/+$/, '');
        _mode = 'pty';
        _pickerState = null;
        return { kind: 'picker-spawn', workspacePath };
      }
      return { kind: 'redraw-picker' };
    }

    // Keys below only apply when focus is on the input field
    if (ps.inList) {
      return { kind: 'none' };
    }

    // Cursor movement within input path
    if (key === LEFT) {
      if (ps.cursorPos > 0) ps.cursorPos--;
      return { kind: 'redraw-picker' };
    }

    if (key === RIGHT) {
      if (ps.cursorPos < ps.inputPath.length) ps.cursorPos++;
      return { kind: 'redraw-picker' };
    }

    // Backspace
    if (key === BACKSPACE) {
      if (ps.cursorPos > 0) {
        ps.inputPath = ps.inputPath.slice(0, ps.cursorPos - 1) + ps.inputPath.slice(ps.cursorPos);
        ps.cursorPos--;
        resetEntrySelection(ps);
      }
      return { kind: 'redraw-picker' };
    }

    // Delete
    if (key === DELETE) {
      if (ps.cursorPos < ps.inputPath.length) {
        ps.inputPath = ps.inputPath.slice(0, ps.cursorPos) + ps.inputPath.slice(ps.cursorPos + 1);
        resetEntrySelection(ps);
      }
      return { kind: 'redraw-picker' };
    }

    // Printable character
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      ps.inputPath = ps.inputPath.slice(0, ps.cursorPos) + key + ps.inputPath.slice(ps.cursorPos);
      ps.cursorPos++;
      resetEntrySelection(ps);
      return { kind: 'redraw-picker' };
    }

    return { kind: 'none' };
  }

  function handlePickerKey(key: string): MuxAction {
    if (!_pickerState) return { kind: 'none' };
    if (_pickerState.phase === 'menu') return handleMenuKey(key);
    return handleBrowseKey(key);
  }

  function handlePtyKey(key: string): MuxAction {
    if (key === CTRL_A) {
      _mode = 'command';
      _inputBuffer = '';
      _cursorPos = 0;
      return { kind: 'enter-command-mode' };
    }

    return { kind: 'write-pty', data: KEY_TO_SEQUENCE[key] ?? key };
  }

  function handleCommandKey(key: string): MuxAction {
    // Ctrl-A in command mode returns to PTY mode
    if (key === CTRL_A) {
      _mode = 'pty';
      _inputBuffer = '';
      _cursorPos = 0;
      return { kind: 'enter-pty-mode' };
    }

    // Escape: discard buffer, return to PTY mode
    if (key === ESCAPE) {
      _mode = 'pty';
      _inputBuffer = '';
      _cursorPos = 0;
      return { kind: 'enter-pty-mode' };
    }

    // Ctrl-C: clear input buffer
    if (key === CTRL_C) {
      _inputBuffer = '';
      _cursorPos = 0;
      return { kind: 'redraw-input' };
    }

    // Enter: dispatch command or trusted input
    if (key === ENTER) {
      const text = _inputBuffer.trim();
      _inputBuffer = '';
      _cursorPos = 0;

      if (!text) {
        return { kind: 'redraw-input' };
      }

      // Commands start with /
      if (text.startsWith('/')) {
        const parts = text.slice(1).split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);
        return { kind: 'command', command, args };
      }

      // Non-command text -> trusted input
      return { kind: 'trusted-input', text };
    }

    // Backspace
    if (key === BACKSPACE) {
      if (_cursorPos > 0) {
        _inputBuffer = _inputBuffer.slice(0, _cursorPos - 1) + _inputBuffer.slice(_cursorPos);
        _cursorPos--;
        return { kind: 'redraw-input' };
      }
      return { kind: 'none' };
    }

    // Delete
    if (key === DELETE) {
      if (_cursorPos < _inputBuffer.length) {
        _inputBuffer = _inputBuffer.slice(0, _cursorPos) + _inputBuffer.slice(_cursorPos + 1);
        return { kind: 'redraw-input' };
      }
      return { kind: 'none' };
    }

    // Arrow keys
    if (key === LEFT) {
      if (_cursorPos > 0) {
        _cursorPos--;
        return { kind: 'redraw-input' };
      }
      return { kind: 'none' };
    }

    if (key === RIGHT) {
      if (_cursorPos < _inputBuffer.length) {
        _cursorPos++;
        return { kind: 'redraw-input' };
      }
      return { kind: 'none' };
    }

    // Alt-1 through Alt-9: quick tab switching
    const altMatch = /^ALT_(\d)$/.exec(key);
    if (altMatch) {
      return { kind: 'command', command: 'tab', args: [altMatch[1]] };
    }

    // Regular printable character
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      _inputBuffer = _inputBuffer.slice(0, _cursorPos) + key + _inputBuffer.slice(_cursorPos);
      _cursorPos++;
      return { kind: 'redraw-input' };
    }

    return { kind: 'none' };
  }

  return {
    get mode() {
      return _mode;
    },
    get inputBuffer() {
      return _inputBuffer;
    },
    get cursorPos() {
      return _cursorPos;
    },
    get pickerState() {
      return _pickerState;
    },

    enterPickerMode,
    enterBrowseWithError,
    exitPickerMode,

    handleKey(key: string): MuxAction {
      if (_mode === 'pty') {
        return handlePtyKey(key);
      }
      if (_mode === 'picker') {
        return handlePickerKey(key);
      }
      return handleCommandKey(key);
    },
  };
}
