/**
 * Shared hashing utilities for loop detection.
 *
 * Provides deterministic JSON serialization and SHA-256 hashing
 * used by both the StepLoopDetector (agent level) and the
 * CallCircuitBreaker (proxy level).
 */

import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization with sorted keys.
 * Ensures `{a:1, b:2}` and `{b:2, a:1}` produce identical strings.
 */
export function stableStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => JSON.stringify(k) + ':' + (stableStringify((value as Record<string, unknown>)[k]) ?? ''),
  );
  return '{' + pairs.join(',') + '}';
}

/**
 * SHA-256 hash of a deterministically serialized value.
 * Returns a hex-encoded digest.
 */
export function computeHash(value: unknown): string {
  return createHash('sha256')
    .update(stableStringify(value) ?? '')
    .digest('hex');
}
