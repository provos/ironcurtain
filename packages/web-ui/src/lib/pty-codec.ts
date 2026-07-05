/**
 * Base64 <-> UTF-8 codec for the PTY terminal stream.
 *
 * The daemon frames every terminal string as base64 of its UTF-8 bytes
 * (`session.pty_output.data`, `session.pty_replay.snapshot`, and the reverse
 * `sessions.ptyInput.data`). Browsers' native `btoa`/`atob` are Latin-1 only,
 * so the classic `btoa(unicodeString)` throws/corrupts on multi-byte input.
 * These helpers go through `TextEncoder` and byte<->binary-string conversion so
 * every codepoint (CJK, emoji, control chars) round-trips exactly.
 *
 * Pure and framework-free so it is unit-testable and importable from both the
 * presentational terminal component and the event handler.
 */

/** Encode a terminal string as base64 of its UTF-8 bytes. */
export function encodeB64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // Build the binary string in chunks. Per-byte `binary += ...` is O(n^2) for
  // large payloads (e.g. a big paste), while `String.fromCharCode(...allBytes)`
  // overflows the call-stack argument limit. 8 KiB chunks keep it linear + safe.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Decode base64-of-UTF-8-bytes back to the raw byte array. Returns bytes (not a
 * string) so callers can hand them straight to `xterm.write()`, which owns UTF-8
 * decoding and correctly buffers any multi-byte sequence split across frames.
 */
export function decodeB64Utf8ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
