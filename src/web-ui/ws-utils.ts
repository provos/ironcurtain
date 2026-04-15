/**
 * Shared WebSocket utility functions.
 */

/** Convert a WebSocket message data payload to a UTF-8 string. */
export function wsDataToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Buffer.isBuffer(data)) return data.toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return Buffer.concat(data).toString();
}
