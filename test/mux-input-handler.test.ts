import { describe, it, expect } from 'vitest';
import { createMuxInputHandler } from '../src/mux/mux-input-handler.js';
import { createPersonaName } from '../src/persona/types.js';
import type { PersonaSnapshot } from '../src/mux/persona-scanner.js';

describe('MuxInputHandler', () => {
  describe('initialMode option', () => {
    it('starts in command mode when initialMode is "command"', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      expect(handler.mode).toBe('command');
    });

    it('starts in PTY mode when initialMode is "pty"', () => {
      const handler = createMuxInputHandler({ initialMode: 'pty' });
      expect(handler.mode).toBe('pty');
    });
  });

  describe('PTY mode (default)', () => {
    it('starts in PTY mode', () => {
      const handler = createMuxInputHandler();
      expect(handler.mode).toBe('pty');
    });

    it('forwards regular keys as write-pty actions', () => {
      const handler = createMuxInputHandler();
      const action = handler.handleKey('a');
      expect(action).toEqual({ kind: 'write-pty', data: 'a' });
    });

    it('Ctrl-A enters command mode', () => {
      const handler = createMuxInputHandler();
      const action = handler.handleKey('CTRL_A');
      expect(action).toEqual({ kind: 'enter-command-mode' });
      expect(handler.mode).toBe('command');
    });

    it('Ctrl-A Ctrl-A toggles back to PTY mode', () => {
      const handler = createMuxInputHandler();
      handler.handleKey('CTRL_A'); // enter command mode
      expect(handler.mode).toBe('command');

      const action = handler.handleKey('CTRL_A');
      expect(action).toEqual({ kind: 'enter-pty-mode' });
      expect(handler.mode).toBe('pty');
    });

    it('forwards special characters to PTY', () => {
      const handler = createMuxInputHandler();
      const action = handler.handleKey('\x1c'); // Ctrl-backslash
      expect(action).toEqual({ kind: 'write-pty', data: '\x1c' });
    });

    it('translates terminal-kit key names to raw sequences for PTY', () => {
      const handler = createMuxInputHandler();
      expect(handler.handleKey('ENTER')).toEqual({ kind: 'write-pty', data: '\r' });
      expect(handler.handleKey('BACKSPACE')).toEqual({ kind: 'write-pty', data: '\x7f' });
      expect(handler.handleKey('ESCAPE')).toEqual({ kind: 'write-pty', data: '\x1b' });
      expect(handler.handleKey('UP')).toEqual({ kind: 'write-pty', data: '\x1b[A' });
      expect(handler.handleKey('DOWN')).toEqual({ kind: 'write-pty', data: '\x1b[B' });
      expect(handler.handleKey('LEFT')).toEqual({ kind: 'write-pty', data: '\x1b[D' });
      expect(handler.handleKey('RIGHT')).toEqual({ kind: 'write-pty', data: '\x1b[C' });
      expect(handler.handleKey('CTRL_C')).toEqual({ kind: 'write-pty', data: '\x03' });
    });
  });

  describe('command mode', () => {
    function enterCommandMode() {
      const handler = createMuxInputHandler();
      handler.handleKey('CTRL_A'); // Ctrl-A enters command mode
      return handler;
    }

    it('input buffer starts empty', () => {
      const handler = enterCommandMode();
      expect(handler.inputBuffer).toBe('');
    });

    it('regular characters are appended to input buffer', () => {
      const handler = enterCommandMode();
      handler.handleKey('h');
      handler.handleKey('i');
      expect(handler.inputBuffer).toBe('hi');
    });

    it('Enter dispatches command starting with /', () => {
      const handler = enterCommandMode();
      handler.handleKey('/');
      handler.handleKey('a');
      handler.handleKey('p');
      handler.handleKey('p');
      handler.handleKey('r');
      handler.handleKey('o');
      handler.handleKey('v');
      handler.handleKey('e');
      handler.handleKey(' ');
      handler.handleKey('1');
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'command', command: 'approve', args: ['1'] });
    });

    it('/approve all parses correctly', () => {
      const handler = enterCommandMode();
      for (const c of '/approve all') handler.handleKey(c);
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'command', command: 'approve', args: ['all'] });
    });

    it('non-command text produces trusted-input', () => {
      const handler = enterCommandMode();
      for (const c of 'push my changes') handler.handleKey(c);
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'trusted-input', text: 'push my changes' });
    });

    it('empty Enter produces redraw-input', () => {
      const handler = enterCommandMode();
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'redraw-input' });
    });

    it('Escape clears buffer and stays in command mode', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('b');
      const action = handler.handleKey('ESCAPE');
      expect(action).toEqual({ kind: 'redraw-input' });
      expect(handler.mode).toBe('command');
      expect(handler.inputBuffer).toBe('');
      expect(handler.cursorPos).toBe(0);
    });

    it('Ctrl-C clears the input buffer', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('b');
      const action = handler.handleKey('CTRL_C');
      expect(action).toEqual({ kind: 'redraw-input' });
      expect(handler.inputBuffer).toBe('');
    });

    it('Ctrl-A in command mode returns to PTY mode', () => {
      const handler = enterCommandMode();
      const action = handler.handleKey('CTRL_A');
      expect(action).toEqual({ kind: 'enter-pty-mode' });
      expect(handler.mode).toBe('pty');
    });

    it('input buffer is preserved across Ctrl-A toggles', () => {
      const handler = createMuxInputHandler();
      // Enter command mode, type some text
      handler.handleKey('CTRL_A');
      expect(handler.mode).toBe('command');
      handler.handleKey('h');
      handler.handleKey('e');
      handler.handleKey('l');
      handler.handleKey('l');
      handler.handleKey('o');
      expect(handler.inputBuffer).toBe('hello');
      expect(handler.cursorPos).toBe(5);

      // Toggle to PTY mode
      handler.handleKey('CTRL_A');
      expect(handler.mode).toBe('pty');

      // Toggle back to command mode -- buffer should be preserved
      handler.handleKey('CTRL_A');
      expect(handler.mode).toBe('command');
      expect(handler.inputBuffer).toBe('hello');
      expect(handler.cursorPos).toBe(5);
    });

    it('ESC clears input buffer in command mode', () => {
      const handler = createMuxInputHandler();
      handler.handleKey('CTRL_A');
      handler.handleKey('t');
      handler.handleKey('e');
      handler.handleKey('s');
      handler.handleKey('t');
      expect(handler.inputBuffer).toBe('test');

      handler.handleKey('ESCAPE');
      expect(handler.inputBuffer).toBe('');
      expect(handler.cursorPos).toBe(0);
      expect(handler.mode).toBe('command');
    });

    it('Backspace deletes character', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('b');
      handler.handleKey('c');
      handler.handleKey('BACKSPACE');
      expect(handler.inputBuffer).toBe('ab');
    });

    it('cursor navigation works', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('b');
      handler.handleKey('c');
      expect(handler.cursorPos).toBe(3);

      handler.handleKey('LEFT');
      expect(handler.cursorPos).toBe(2);

      handler.handleKey('LEFT');
      expect(handler.cursorPos).toBe(1);

      handler.handleKey('RIGHT');
      expect(handler.cursorPos).toBe(2);
    });

    it('typing at cursor position inserts character', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('c');
      handler.handleKey('LEFT'); // cursor at position 1
      handler.handleKey('b'); // insert 'b' at position 1
      expect(handler.inputBuffer).toBe('abc');
    });

    it('clears input buffer after dispatch', () => {
      const handler = enterCommandMode();
      for (const c of 'hello') handler.handleKey(c);
      handler.handleKey('ENTER');
      expect(handler.inputBuffer).toBe('');
    });

    it('Up arrow moves cursor to previous line at same column', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('abc\ndef\nghi');
      // cursor at end: pos 11, on line 3 col 3
      expect(handler.cursorPos).toBe(11);
      handler.handleKey('UP');
      // should be on line 2, col 3 → pos 7 ("abc\ndef|")
      expect(handler.cursorPos).toBe(7);
      handler.handleKey('UP');
      // should be on line 1, col 3 → pos 3 ("abc|")
      expect(handler.cursorPos).toBe(3);
    });

    it('Up arrow clamps to shorter line length', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('ab\nc\ndef');
      // cursor at end: pos 7, line 3 col 2
      handler.handleKey('UP');
      // line 2 is "c" (length 1), col clamped to 1 → pos 4
      expect(handler.cursorPos).toBe(4);
    });

    it('Up arrow on first line is a no-op', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('abc');
      const action = handler.handleKey('UP');
      expect(action).toEqual({ kind: 'none' });
      expect(handler.cursorPos).toBe(3);
    });

    it('Down arrow moves cursor to next line at same column', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('abc\ndef\nghi');
      // move to beginning
      handler.handleKey('HOME');
      expect(handler.cursorPos).toBe(0);
      handler.handleKey('DOWN');
      // line 2, col 0 → pos 4
      expect(handler.cursorPos).toBe(4);
      handler.handleKey('DOWN');
      // line 3, col 0 → pos 8
      expect(handler.cursorPos).toBe(8);
    });

    it('Down arrow clamps to shorter line length', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('abc\nd');
      handler.handleKey('HOME');
      // cursor at pos 0, line 1 col 0
      // move right to col 2
      handler.handleKey('RIGHT');
      handler.handleKey('RIGHT');
      expect(handler.cursorPos).toBe(2);
      handler.handleKey('DOWN');
      // line 2 is "d" (length 1), col clamped to 1 → pos 5
      expect(handler.cursorPos).toBe(5);
    });

    it('Down arrow on last line is a no-op', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('abc');
      handler.handleKey('HOME');
      const action = handler.handleKey('DOWN');
      expect(action).toEqual({ kind: 'none' });
      expect(handler.cursorPos).toBe(0);
    });

    it('Home key moves cursor to position 0', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('b');
      handler.handleKey('c');
      expect(handler.cursorPos).toBe(3);
      const action = handler.handleKey('HOME');
      expect(action).toEqual({ kind: 'redraw-input' });
      expect(handler.cursorPos).toBe(0);
    });

    it('End key moves cursor to end of buffer', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('b');
      handler.handleKey('c');
      handler.handleKey('LEFT');
      handler.handleKey('LEFT');
      expect(handler.cursorPos).toBe(1);
      const action = handler.handleKey('END');
      expect(action).toEqual({ kind: 'redraw-input' });
      expect(handler.cursorPos).toBe(3);
    });
  });

  describe('handlePaste', () => {
    it('wraps text in bracketed paste markers for PTY mode', () => {
      const handler = createMuxInputHandler();
      const action = handler.handlePaste('hello world');
      expect(action).toEqual({
        kind: 'write-pty',
        data: '\x1b[200~hello world\x1b[201~',
      });
    });

    it('inserts text at cursor in command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      const action = handler.handlePaste('pasted text');
      expect(action).toEqual({ kind: 'redraw-input' });
      expect(handler.inputBuffer).toBe('pasted text');
      expect(handler.cursorPos).toBe(11);
    });

    it('inserts at mid-buffer cursor position in command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handleKey('a');
      handler.handleKey('b');
      handler.handleKey('LEFT'); // cursor at 1
      handler.handlePaste('XY');
      expect(handler.inputBuffer).toBe('aXYb');
      expect(handler.cursorPos).toBe(3);
    });

    it('preserves newlines (normalized to LF) in command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('line1\nline2\r\nline3');
      expect(handler.inputBuffer).toBe('line1\nline2\nline3');
      expect(handler.cursorPos).toBe(17);
    });

    it('returns none for empty paste', () => {
      const handler = createMuxInputHandler();
      expect(handler.handlePaste('')).toEqual({ kind: 'none' });
    });

    it('inserts into picker browse mode inputPath', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      // Navigate to browse phase
      handler.handleKey('2'); // select "Existing directory"
      expect(handler.pickerState?.phase).toBe('browse');

      const action = handler.handlePaste('/tmp/test');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.pickerState?.inputPath).toContain('/tmp/test');
    });

    it('returns none in picker menu phase', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      expect(handler.pickerState?.phase).toBe('menu');

      const action = handler.handlePaste('text');
      expect(action).toEqual({ kind: 'none' });
    });

    it('returns none in picker browse mode with list focused', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      handler.handleKey('2'); // browse phase
      // Move focus to list
      handler.handleKey('DOWN');

      const action = handler.handlePaste('text');
      expect(action).toEqual({ kind: 'none' });
    });
  });

  describe('picker mode transitions', () => {
    it('exitPickerMode returns to command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      expect(handler.mode).toBe('picker');

      handler.exitPickerMode();
      expect(handler.mode).toBe('command');
      expect(handler.pickerState).toBeNull();
    });

    it('/new quick-spawn (menu option 1) returns to command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      expect(handler.mode).toBe('picker');

      // Select option 1 (quick-spawn)
      const action = handler.handleKey('1');
      expect(action).toEqual({ kind: 'picker-spawn' });
      expect(handler.mode).toBe('command');
      expect(handler.pickerState).toBeNull();
    });

    it('/new browse path submit returns to command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      // Select option 2 (browse)
      handler.handleKey('2');
      expect(handler.pickerState?.phase).toBe('browse');

      // Clear the default path and type a custom one
      const ps = handler.pickerState!;
      while (ps.cursorPos > 0) {
        handler.handleKey('BACKSPACE');
      }
      for (const c of '/tmp/test') handler.handleKey(c);

      // Submit
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'picker-spawn', workspacePath: '/tmp/test' });
      expect(handler.mode).toBe('command');
      expect(handler.pickerState).toBeNull();
    });

    it('picker cancel (ESC from menu) returns to command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      expect(handler.mode).toBe('picker');

      const action = handler.handleKey('ESCAPE');
      expect(action).toEqual({ kind: 'picker-cancel' });
      expect(handler.mode).toBe('command');
    });
  });

  describe('resume picker mode', () => {
    const sessions = [
      {
        sessionId: 'session-aaa',
        status: 'user-exit' as const,
        exitCode: 0,
        lastActivity: '2026-03-10T18:00:00Z',

        workspacePath: '/workspace',
        agent: 'claude-code',
        label: 'Claude Code (interactive)',
        resumable: true,
      },
      {
        sessionId: 'session-bbb',
        status: 'crashed' as const,
        exitCode: 1,
        lastActivity: '2026-03-10T12:00:00Z',

        workspacePath: '/workspace',
        agent: 'claude-code',
        label: 'Claude Code (interactive)',
        resumable: true,
      },
    ];

    function enterResumePicker() {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterResumePickerMode(sessions);
      return handler;
    }

    it('enters resume-picker mode', () => {
      const handler = enterResumePicker();
      expect(handler.mode).toBe('resume-picker');
      expect(handler.resumePickerState).not.toBeNull();
      expect(handler.resumePickerState?.sessions).toHaveLength(2);
      expect(handler.resumePickerState?.selectedIndex).toBe(0);
    });

    it('navigates down in session list', () => {
      const handler = enterResumePicker();
      const action = handler.handleKey('DOWN');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.resumePickerState?.selectedIndex).toBe(1);
    });

    it('does not go below last session', () => {
      const handler = enterResumePicker();
      handler.handleKey('DOWN');
      handler.handleKey('DOWN');
      expect(handler.resumePickerState?.selectedIndex).toBe(1);
    });

    it('navigates up in session list', () => {
      const handler = enterResumePicker();
      handler.handleKey('DOWN');
      const action = handler.handleKey('UP');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.resumePickerState?.selectedIndex).toBe(0);
    });

    it('does not go above first session', () => {
      const handler = enterResumePicker();
      handler.handleKey('UP');
      expect(handler.resumePickerState?.selectedIndex).toBe(0);
    });

    it('Enter selects session and returns resume-spawn', () => {
      const handler = enterResumePicker();
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({
        kind: 'resume-spawn',
        sessionId: 'session-aaa',
        agent: 'claude-code',
      });
      expect(handler.mode).toBe('command');
      expect(handler.resumePickerState).toBeNull();
    });

    it('Enter selects second session after DOWN', () => {
      const handler = enterResumePicker();
      handler.handleKey('DOWN');
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({
        kind: 'resume-spawn',
        sessionId: 'session-bbb',
        agent: 'claude-code',
      });
    });

    it('Escape cancels resume picker', () => {
      const handler = enterResumePicker();
      const action = handler.handleKey('ESCAPE');
      expect(action).toEqual({ kind: 'picker-cancel' });
      expect(handler.mode).toBe('command');
      expect(handler.resumePickerState).toBeNull();
    });

    it('Ctrl-C cancels resume picker', () => {
      const handler = enterResumePicker();
      const action = handler.handleKey('CTRL_C');
      expect(action).toEqual({ kind: 'picker-cancel' });
      expect(handler.mode).toBe('command');
    });

    it('exitResumePickerMode returns to command mode', () => {
      const handler = enterResumePicker();
      handler.exitResumePickerMode();
      expect(handler.mode).toBe('command');
      expect(handler.resumePickerState).toBeNull();
    });

    it('handles empty session list gracefully', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterResumePickerMode([]);
      expect(handler.mode).toBe('resume-picker');

      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'picker-cancel' });
      expect(handler.mode).toBe('command');
    });
  });

  describe('persona picker mode', () => {
    const personas: PersonaSnapshot[] = [
      {
        name: createPersonaName('researcher'),
        description: 'Research assistant',
        compiled: true,
        workspacePath: '/home/user/research',
      },
      {
        name: createPersonaName('writer'),
        description: 'Writing helper',
        compiled: false,
        workspacePath: '/home/user/writing',
      },
    ];

    function enterPersonaPicker() {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode(personas);
      // Select option 3 (persona picker) from the /new menu
      handler.handleKey('3');
      expect(handler.mode).toBe('persona-picker');
      return handler;
    }

    it('ESC in persona picker returns to /new menu', () => {
      const handler = enterPersonaPicker();
      const action = handler.handleKey('ESCAPE');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.mode).toBe('picker');
      expect(handler.personaPickerState).toBeNull();
      expect(handler.pickerState).not.toBeNull();
      expect(handler.pickerState?.phase).toBe('menu');
    });

    it('ENTER on compiled persona transitions to browse with prefilled workspacePath', () => {
      const handler = enterPersonaPicker();
      // First persona (researcher) is compiled and selected by default
      expect(handler.personaPickerState?.selectedIndex).toBe(0);

      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.mode).toBe('picker');
      expect(handler.personaPickerState).toBeNull();
      expect(handler.pickerState).not.toBeNull();
      expect(handler.pickerState?.phase).toBe('browse');
      expect(handler.pickerState?.inputPath).toBe('/home/user/research/');
      expect(handler.pickerState?.persona).toBe('researcher');
    });

    it('ENTER on non-compiled persona is ignored', () => {
      const handler = enterPersonaPicker();
      // Navigate to second persona (writer, not compiled)
      handler.handleKey('DOWN');
      expect(handler.personaPickerState?.selectedIndex).toBe(1);

      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'none' });
      expect(handler.mode).toBe('persona-picker');
      expect(handler.personaPickerState).not.toBeNull();
    });

    it('browse submit with persona carries through to picker-spawn', () => {
      const handler = enterPersonaPicker();
      // Select compiled persona
      handler.handleKey('ENTER');
      expect(handler.pickerState?.phase).toBe('browse');
      expect(handler.pickerState?.persona).toBe('researcher');

      // Clear the prefilled path and type a custom one
      const ps = handler.pickerState!;
      while (ps.cursorPos > 0) {
        handler.handleKey('BACKSPACE');
      }
      for (const c of '/tmp/work') handler.handleKey(c);

      // Submit the path
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({
        kind: 'picker-spawn',
        workspacePath: '/tmp/work',
        persona: 'researcher',
      });
      expect(handler.mode).toBe('command');
      expect(handler.pickerState).toBeNull();
    });

    it('browse submit without persona omits persona field', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      // Select option 2 (browse, no personas)
      handler.handleKey('2');
      expect(handler.pickerState?.phase).toBe('browse');

      // Clear default path and type a custom one
      const ps = handler.pickerState!;
      while (ps.cursorPos > 0) {
        handler.handleKey('BACKSPACE');
      }
      for (const c of '/tmp/test') handler.handleKey(c);

      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'picker-spawn', workspacePath: '/tmp/test' });
      expect(action).not.toHaveProperty('persona');
    });
  });
});
