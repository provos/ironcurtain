/** Sanitize container output and retain a UTF-8 byte-bounded diagnostic tail. */
export function boundedLogTail(text: string, maxBytes: number): string {
  const marker = '(truncated)\n';
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= Buffer.byteLength(marker)) {
    throw new RangeError('Log tail limit must leave room for the truncation marker');
  }
  const bytes = Buffer.from(text.replace(/[^\P{Cc}\n\t]/gu, '').trim(), 'utf8');
  if (bytes.length <= maxBytes) return bytes.toString('utf8');
  return (
    marker +
    bytes
      .subarray(-(maxBytes - Buffer.byteLength(marker)))
      .toString('utf8')
      .replace(/^\uFFFD+/u, '')
  );
}
