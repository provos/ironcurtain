import { describe, it, expect } from 'vitest';
import { encodeB64Utf8, decodeB64Utf8ToBytes } from '../pty-codec.js';

/** Decode helper: base64 -> string (via the bytes the component hands to xterm). */
function roundTrip(text: string): string {
  const bytes = decodeB64Utf8ToBytes(encodeB64Utf8(text));
  return new TextDecoder().decode(bytes);
}

describe('pty-codec base64 UTF-8', () => {
  it('round-trips plain ASCII', () => {
    expect(roundTrip('hello world')).toBe('hello world');
  });

  it('round-trips control characters (arrows, Ctrl-C, ESC sequences)', () => {
    const keystrokes = '\x1b[A\x1b[B\x03\x1b[200~pasted\x1b[201~';
    expect(roundTrip(keystrokes)).toBe(keystrokes);
  });

  it('round-trips multi-byte UTF-8: CJK, accents, emoji', () => {
    const s = 'café 日本語 — 🚀🔥 café';
    expect(roundTrip(s)).toBe(s);
  });

  it('encodes to the same base64 as UTF-8 bytes (matches the daemon framing)', () => {
    // "é" is UTF-8 0xC3 0xA9 -> base64 "w6k=". The naive btoa('é') would throw
    // or emit Latin-1 "6Q=="; this asserts we go through the UTF-8 bytes.
    expect(encodeB64Utf8('é')).toBe('w6k=');
  });

  it('decodes daemon-produced base64 to the exact UTF-8 bytes', () => {
    // base64("w6k=") -> 0xC3 0xA9
    expect(Array.from(decodeB64Utf8ToBytes('w6k='))).toEqual([0xc3, 0xa9]);
  });

  it('round-trips an empty string', () => {
    expect(roundTrip('')).toBe('');
    expect(encodeB64Utf8('')).toBe('');
  });
});
