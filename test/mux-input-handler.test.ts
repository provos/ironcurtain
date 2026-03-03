import { describe, it, expect } from 'vitest';
import { createMuxInputHandler } from '../src/mux/mux-input-handler.js';

describe('MuxInputHandler', () => {
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

    it('Escape clears buffer and returns to PTY mode', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('b');
      const action = handler.handleKey('ESCAPE');
      expect(action).toEqual({ kind: 'enter-pty-mode' });
      expect(handler.mode).toBe('pty');
      expect(handler.inputBuffer).toBe('');
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
  });
});
