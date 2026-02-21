/**
 * Tool result truncation utility.
 *
 * Truncates oversized tool results before they reach the LLM to prevent
 * "prompt is too long" errors. The audit log (written at the trusted
 * process level) preserves full untruncated results for forensics.
 *
 * Strategy: serialize the value to JSON, measure that, and if it exceeds
 * the budget, truncate the JSON string with a head/tail split.
 */

/** 100 KB ≈ 25K tokens, matching Claude Code's cap. */
export const DEFAULT_RESULT_SIZE_LIMIT = 100_000;

/** Returns the configured result size limit (bytes). */
export function getResultSizeLimit(): number {
  const envVal = process.env['RESULT_SIZE_LIMIT'];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_RESULT_SIZE_LIMIT;
}

export interface TruncationResult {
  value: unknown;
  truncated: boolean;
  originalSize: number;
  finalSize: number;
}

/**
 * Truncates a single string to fit within `maxBytes`, keeping ~80% from
 * the head and ~20% from the tail with a marker in between.
 */
export function truncateString(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf-8');
  if (buf.length <= maxBytes) return s;

  const truncatedBytes = buf.length - maxBytes;
  const realMarker = `\n[... truncated ${truncatedBytes} bytes ...]\n`;
  const markerBytes = Buffer.byteLength(realMarker, 'utf-8');

  const available = maxBytes - markerBytes;
  if (available <= 0) return realMarker;

  const headBytes = Math.floor(available * 0.8);
  const tailBytes = available - headBytes;

  const head = buf.subarray(0, headBytes).toString('utf-8');
  const tail = tailBytes > 0 ? buf.subarray(buf.length - tailBytes).toString('utf-8') : '';

  return head + realMarker + tail;
}

/**
 * Truncates a tool result value to fit within `budget` bytes.
 *
 * Serializes the value to JSON, and if it exceeds the budget, replaces
 * it with a truncated string (head/tail with marker). When the value
 * fits, it's returned as-is (zero-copy).
 */
export function truncateResult(value: unknown, budget?: number): TruncationResult {
  const limit = budget ?? getResultSizeLimit();

  const json = JSON.stringify(value);
  // JSON.stringify returns undefined for undefined input
  if (json === undefined) {
    return { value, truncated: false, originalSize: 0, finalSize: 0 };
  }
  const originalSize = Buffer.byteLength(json, 'utf-8');

  if (originalSize <= limit) {
    return { value, truncated: false, originalSize, finalSize: originalSize };
  }

  const truncated = truncateString(json, limit);
  const finalSize = Buffer.byteLength(truncated, 'utf-8');
  return { value: truncated, truncated: true, originalSize, finalSize };
}

/** Formats bytes as a human-readable KB string. */
export function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}
