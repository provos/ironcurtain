import { describe, expect, it } from 'vitest';
import { boundedLogTail } from '../../src/docker/bounded-log-tail.js';

describe('bounded log tail', () => {
  it('rejects budgets that cannot fit the truncation marker', () => {
    expect(() => boundedLogTail('message', 0)).toThrow(RangeError);
  });

  it('sanitizes control characters while preserving diagnostic lines', () => {
    expect(boundedLogTail(' first\u0000\n\tlast\u001b ', 100)).toBe('first\n\tlast');
    expect(boundedLogTail('', 100)).toBe('');
  });

  it('bounds UTF-8 bytes, retains the tail, and marks truncation without splitting characters', () => {
    const tail = boundedLogTail('😀'.repeat(100) + 'end', 64);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(64);
    expect(tail).toMatch(/^\(truncated\)\n/u);
    expect(tail.endsWith('end')).toBe(true);
    expect(tail).not.toContain('\uFFFD');
  });
});
