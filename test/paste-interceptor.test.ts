import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPasteInterceptor, PASTE_START, PASTE_END } from '../src/mux/paste-interceptor.js';
import { EventEmitter } from 'node:events';

/**
 * Helper: creates a fake stdin-like EventEmitter and patches
 * process.stdin.emit for the duration of a test.
 */
function setupFakeStdin() {
  const fakeEmitter = new EventEmitter();
  const emitted: { event: string; data: string }[] = [];

  // Save and replace process.stdin.emit with our fake
  const realEmit = process.stdin.emit.bind(process.stdin);
  process.stdin.emit = function (event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'data') {
      const raw = args[0];
      const str = raw instanceof Buffer ? raw.toString('utf-8') : (raw as string);
      emitted.push({ event: event, data: str });
    }
    return fakeEmitter.emit(event, ...args);
  } as typeof process.stdin.emit;

  function simulateData(data: string): void {
    process.stdin.emit('data', data);
  }

  function restore(): void {
    process.stdin.emit = realEmit;
  }

  return { emitted, simulateData, restore };
}

describe('PasteInterceptor', () => {
  let fake: ReturnType<typeof setupFakeStdin>;

  beforeEach(() => {
    // Suppress bracketed paste escape sequences written by install/uninstall
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    fake = setupFakeStdin();
  });

  afterEach(() => {
    fake.restore();
    vi.restoreAllMocks();
  });

  it('passes through complete paste as single callback', () => {
    const pastes: string[] = [];
    const interceptor = createPasteInterceptor((text) => pastes.push(text));
    interceptor.install();

    fake.simulateData(PASTE_START + 'hello world' + PASTE_END);

    expect(pastes).toEqual(['hello world']);
    // No data events should have been emitted (paste was fully consumed)
    expect(fake.emitted).toEqual([]);

    interceptor.uninstall();
  });

  it('does not buffer escape sequences as partial start markers', () => {
    const pastes: string[] = [];
    const interceptor = createPasteInterceptor((text) => pastes.push(text));
    interceptor.install();

    // Escape sequences (arrows, etc.) must pass through immediately.
    // A lone \x1b should NOT be buffered as a partial PASTE_START.
    fake.simulateData('\x1b[A'); // cursor up
    fake.simulateData('\x1b[B'); // cursor down

    expect(pastes).toEqual([]);
    expect(fake.emitted.map((e) => e.data)).toEqual(['\x1b[A', '\x1b[B']);

    interceptor.uninstall();
  });

  it('handles end marker split across chunks', () => {
    const pastes: string[] = [];
    const interceptor = createPasteInterceptor((text) => pastes.push(text));
    interceptor.install();

    fake.simulateData(PASTE_START + 'text\x1b[201');
    fake.simulateData('~');

    expect(pastes).toEqual(['text']);
    expect(fake.emitted).toEqual([]);

    interceptor.uninstall();
  });

  it('handles end marker split at every byte boundary', () => {
    const pastes: string[] = [];
    const interceptor = createPasteInterceptor((text) => pastes.push(text));
    interceptor.install();

    // Start marker must arrive atomically (as terminals send it)
    fake.simulateData(PASTE_START + 'AB');
    // Send end marker one character at a time
    for (const ch of PASTE_END) {
      fake.simulateData(ch);
    }

    expect(pastes).toEqual(['AB']);

    interceptor.uninstall();
  });

  it('passes through lone ESC byte without buffering', () => {
    const pastes: string[] = [];
    const interceptor = createPasteInterceptor((text) => pastes.push(text));
    interceptor.install();

    // A lone \x1b must pass through immediately — it should NOT be
    // buffered as a potential start of \x1b[200~
    fake.simulateData('\x1b');
    fake.simulateData('[A');

    expect(pastes).toEqual([]);
    expect(fake.emitted.map((e) => e.data)).toEqual(['\x1b', '[A']);

    interceptor.uninstall();
  });

  it('handles empty paste', () => {
    const pastes: string[] = [];
    const interceptor = createPasteInterceptor((text) => pastes.push(text));
    interceptor.install();

    fake.simulateData(PASTE_START + PASTE_END);

    expect(pastes).toEqual(['']);
    expect(fake.emitted).toEqual([]);

    interceptor.uninstall();
  });

  it('handles multiple pastes in one chunk', () => {
    const pastes: string[] = [];
    const interceptor = createPasteInterceptor((text) => pastes.push(text));
    interceptor.install();

    fake.simulateData(PASTE_START + 'first' + PASTE_END + PASTE_START + 'second' + PASTE_END);

    expect(pastes).toEqual(['first', 'second']);
    expect(fake.emitted).toEqual([]);

    interceptor.uninstall();
  });

  it('passes through data before and after paste markers', () => {
    const pastes: string[] = [];
    const interceptor = createPasteInterceptor((text) => pastes.push(text));
    interceptor.install();

    fake.simulateData('before' + PASTE_START + 'pasted' + PASTE_END + 'after');

    expect(pastes).toEqual(['pasted']);
    expect(fake.emitted.map((e) => e.data)).toEqual(['before', 'after']);

    interceptor.uninstall();
  });

  it('passes through non-data events unchanged', () => {
    const pastes: string[] = [];
    const interceptor = createPasteInterceptor((text) => pastes.push(text));
    interceptor.install();

    // Verify that calling emit with a non-'data' event doesn't throw
    // and the interceptor doesn't interfere
    let threw = false;
    try {
      process.stdin.emit('close');
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(pastes).toEqual([]);

    interceptor.uninstall();
  });

  it('uninstall() restores original emit', () => {
    const pastes: string[] = [];
    const interceptor = createPasteInterceptor((text) => pastes.push(text));

    const emitRef = process.stdin.emit;
    interceptor.install();
    expect(process.stdin.emit).not.toBe(emitRef);

    interceptor.uninstall();
    expect(process.stdin.emit).toBe(emitRef);

    // After uninstall, paste sequences should pass through as raw data
    fake.simulateData(PASTE_START + 'raw' + PASTE_END);
    expect(pastes).toEqual([]);
    expect(fake.emitted.map((e) => e.data)).toEqual([PASTE_START + 'raw' + PASTE_END]);
  });

  it('handles Buffer data chunks', () => {
    const pastes: string[] = [];
    const interceptor = createPasteInterceptor((text) => pastes.push(text));
    interceptor.install();

    // Simulate Buffer input (as some terminal drivers do)
    process.stdin.emit('data', Buffer.from(PASTE_START + 'buf' + PASTE_END));

    expect(pastes).toEqual(['buf']);
    expect(fake.emitted).toEqual([]);

    interceptor.uninstall();
  });
});
