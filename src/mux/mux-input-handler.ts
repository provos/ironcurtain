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

import type { InputMode, MuxAction } from './types.js';

export interface MuxInputHandler {
  /** Current input mode. */
  readonly mode: InputMode;

  /** Current command-mode input buffer (for display). */
  readonly inputBuffer: string;

  /** Cursor position within the input buffer. */
  readonly cursorPos: number;

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
 * Creates a new MuxInputHandler.
 */
export function createMuxInputHandler(): MuxInputHandler {
  let _mode: InputMode = 'pty';
  let _inputBuffer = '';
  let _cursorPos = 0;

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

    handleKey(key: string): MuxAction {
      if (_mode === 'pty') {
        return handlePtyKey(key);
      }
      return handleCommandKey(key);
    },
  };
}
