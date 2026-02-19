import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_RESULT_SIZE_LIMIT,
  getResultSizeLimit,
  truncateString,
  truncateResult,
  formatKB,
} from '../src/session/truncate-result.js';

describe('truncateString', () => {
  it('returns the string unchanged if it fits', () => {
    expect(truncateString('hello', 100)).toBe('hello');
  });

  it('truncates a large string with head/tail and marker', () => {
    const s = 'a'.repeat(10_000);
    const result = truncateString(s, 2000);
    expect(result.length).toBeLessThan(s.length);
    expect(result).toContain('[... truncated');
    expect(result).toContain('bytes ...]');
  });

  it('preserves ~80% head and ~20% tail', () => {
    const s = 'a'.repeat(10_000);
    const result = truncateString(s, 2000);

    const markerIndex = result.indexOf('\n[... truncated');
    const afterMarker = result.indexOf('bytes ...]\n') + 'bytes ...]\n'.length;
    const headPart = result.substring(0, markerIndex);
    const tailPart = result.substring(afterMarker);

    // Head should be roughly 4x the tail size
    expect(headPart.length).toBeGreaterThan(tailPart.length * 2);
  });

  it('includes accurate byte count in marker', () => {
    const s = 'x'.repeat(5000);
    const result = truncateString(s, 1000);
    const match = result.match(/truncated (\d+) bytes/);
    expect(match).not.toBeNull();
    const truncatedBytes = parseInt(match![1], 10);
    expect(truncatedBytes).toBe(4000);
  });

  it('handles multi-byte characters without corruption', () => {
    const s = '€'.repeat(2000); // 3 bytes each = 6000 bytes
    const result = truncateString(s, 1000);

    expect(result).toContain('[... truncated');

    // The result should be valid UTF-8 (round-trips cleanly)
    const encoded = Buffer.from(result, 'utf-8');
    const decoded = encoded.toString('utf-8');
    expect(decoded).toBe(result);
  });
});

describe('truncateResult', () => {
  it('passes small result through unchanged (same reference)', () => {
    const value = { content: [{ type: 'text', text: 'hello' }] };
    const result = truncateResult(value, 1000);
    expect(result.truncated).toBe(false);
    expect(result.value).toBe(value); // same reference, zero-copy
    expect(result.originalSize).toBe(result.finalSize);
  });

  it('truncates a large object to a string with marker', () => {
    const bigText = 'x'.repeat(50_000);
    const value = { content: [{ type: 'text', text: bigText }] };
    const result = truncateResult(value, 5000);
    expect(result.truncated).toBe(true);
    expect(typeof result.value).toBe('string');
    expect((result.value as string)).toContain('[... truncated');
    expect(result.finalSize).toBeLessThanOrEqual(5000);
  });

  it('originalSize reflects the JSON serialization size', () => {
    const s = 'a'.repeat(10_000);
    const result = truncateResult(s, 2000);
    expect(result.truncated).toBe(true);
    // JSON.stringify wraps the string in quotes: "aaa..."
    expect(result.originalSize).toBe(Buffer.byteLength(JSON.stringify(s), 'utf-8'));
  });

  it('does not mutate the original value', () => {
    const original = { text: 'a'.repeat(10_000) };
    const originalText = original.text;
    truncateResult(original, 2000);
    expect(original.text).toBe(originalText);
  });

  it('handles null input', () => {
    const r = truncateResult(null, 1000);
    expect(r.value).toBeNull();
    expect(r.truncated).toBe(false);
    expect(r.originalSize).toBe(4); // "null"
  });

  it('handles undefined input', () => {
    const r = truncateResult(undefined, 1000);
    // JSON.stringify(undefined) returns undefined, not a string
    expect(r.truncated).toBe(false);
  });

  it('handles non-string primitives', () => {
    const r = truncateResult(42, 1000);
    expect(r.value).toBe(42);
    expect(r.truncated).toBe(false);
    expect(r.originalSize).toBe(2); // "42"
  });
});

describe('getResultSizeLimit', () => {
  const originalEnv = process.env['RESULT_SIZE_LIMIT'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['RESULT_SIZE_LIMIT'] = originalEnv;
    } else {
      delete process.env['RESULT_SIZE_LIMIT'];
    }
  });

  it('returns default when env var is not set', () => {
    delete process.env['RESULT_SIZE_LIMIT'];
    expect(getResultSizeLimit()).toBe(DEFAULT_RESULT_SIZE_LIMIT);
  });

  it('reads RESULT_SIZE_LIMIT from environment', () => {
    process.env['RESULT_SIZE_LIMIT'] = '50000';
    expect(getResultSizeLimit()).toBe(50_000);
  });

  it('falls back to default for invalid values', () => {
    process.env['RESULT_SIZE_LIMIT'] = 'not-a-number';
    expect(getResultSizeLimit()).toBe(DEFAULT_RESULT_SIZE_LIMIT);
  });

  it('falls back to default for negative values', () => {
    process.env['RESULT_SIZE_LIMIT'] = '-100';
    expect(getResultSizeLimit()).toBe(DEFAULT_RESULT_SIZE_LIMIT);
  });
});

describe('formatKB', () => {
  it('formats bytes as KB', () => {
    expect(formatKB(1024)).toBe('1.0KB');
    expect(formatKB(102400)).toBe('100.0KB');
    expect(formatKB(1536)).toBe('1.5KB');
  });
});
