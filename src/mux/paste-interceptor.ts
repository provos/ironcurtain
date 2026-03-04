/**
 * PasteInterceptor -- intercepts bracketed paste sequences from stdin.
 *
 * Terminal emulators that support bracketed paste mode wrap pasted text
 * between ESC[200~ (start) and ESC[201~ (end) markers. When the mux
 * enables bracketed paste mode, the interceptor captures these sequences
 * before terminal-kit sees them and delivers the pasted text via a
 * callback. All non-paste data passes through unchanged.
 *
 * The implementation monkey-patches `process.stdin.emit` to filter
 * 'data' events. A state machine handles markers split across chunks.
 *
 * install() also enables bracketed paste mode on stdout; uninstall()
 * disables it — keeping the terminal protocol in one place.
 */

import { StringDecoder } from 'node:string_decoder';

export interface PasteInterceptor {
  install(): void;
  uninstall(): void;
}

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

type State = 'normal' | 'pasting';

export function createPasteInterceptor(onPaste: (text: string) => void): PasteInterceptor {
  // StringDecoder safely handles multi-byte UTF-8 characters split
  // across stdin chunks (avoids replacement characters).
  let decoder: StringDecoder | null = null;
  let originalEmit: typeof process.stdin.emit | null = null;
  let state: State = 'normal';
  let pasteBuffer = '';
  // Holds a partial prefix of a marker when a chunk ends mid-marker
  let partial = '';

  function resetState(): void {
    state = 'normal';
    pasteBuffer = '';
    partial = '';
  }

  function processData(data: string): string[] {
    // Returns an array of strings that should be emitted as 'data' events
    // to the original handler. Empty array means nothing to emit.
    const output: string[] = [];
    let remaining = partial ? partial + data : data;
    partial = '';

    while (remaining.length > 0) {
      if (state === 'normal') {
        const startIdx = remaining.indexOf(PASTE_START);
        if (startIdx === -1) {
          // Pass through directly. Terminal emulators send \x1b[200~ as a
          // complete atomic write, so indexOf is sufficient — no need for
          // partial marker detection which would buffer lone \x1b bytes and
          // break all escape-sequence keystrokes (arrows, Escape, etc.).
          output.push(remaining);
          remaining = '';
        } else {
          // Emit everything before the marker
          if (startIdx > 0) {
            output.push(remaining.slice(0, startIdx));
          }
          state = 'pasting';
          pasteBuffer = '';
          remaining = remaining.slice(startIdx + PASTE_START.length);
        }
      } else {
        // state === 'pasting'
        const endIdx = remaining.indexOf(PASTE_END);
        if (endIdx === -1) {
          // Check for partial end marker at the tail
          const possiblePartial = findPartialMarker(remaining, PASTE_END);
          if (possiblePartial > 0) {
            pasteBuffer += remaining.slice(0, remaining.length - possiblePartial);
            partial = remaining.slice(remaining.length - possiblePartial);
            remaining = '';
          } else {
            pasteBuffer += remaining;
            remaining = '';
          }
        } else {
          pasteBuffer += remaining.slice(0, endIdx);
          onPaste(pasteBuffer);
          pasteBuffer = '';
          state = 'normal';
          remaining = remaining.slice(endIdx + PASTE_END.length);
        }
      }
    }

    return output;
  }

  /**
   * Returns the length of the longest suffix of `str` that is a prefix
   * of `marker`, or 0 if no such suffix exists.
   */
  function findPartialMarker(str: string, marker: string): number {
    const maxCheck = Math.min(str.length, marker.length - 1);
    for (let len = maxCheck; len >= 1; len--) {
      if (str.endsWith(marker.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  function patchedEmit(this: typeof process.stdin, event: string | symbol, ...args: unknown[]): boolean {
    if (!originalEmit) return false;
    if (event !== 'data') {
      return originalEmit.call(this, event, ...args);
    }

    const chunk = args[0];
    const str =
      typeof chunk === 'string' ? chunk : chunk instanceof Buffer && decoder ? decoder.write(chunk) : String(chunk);

    const outputs = processData(str);
    let result = false;
    for (const out of outputs) {
      if (out.length > 0) {
        // Re-emit as Buffer: terminal-kit's onStdin uses Buffer indexing
        // (chunk[i] returns a byte number) which breaks on strings.
        result = originalEmit.call(this, 'data', Buffer.from(out, 'utf-8')) || result;
      }
    }
    return result;
  }

  return {
    install(): void {
      if (originalEmit) return; // already installed
      decoder = new StringDecoder('utf-8');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      originalEmit = process.stdin.emit;
      process.stdin.emit = patchedEmit as typeof process.stdin.emit;
      resetState();
      process.stdout.write(ENABLE_BRACKETED_PASTE);
    },

    uninstall(): void {
      if (!originalEmit) return;
      process.stdin.emit = originalEmit;
      originalEmit = null;
      decoder = null;
      resetState();
      process.stdout.write(DISABLE_BRACKETED_PASTE);
    },
  };
}
