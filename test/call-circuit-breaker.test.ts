import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CallCircuitBreaker } from '../src/trusted-process/call-circuit-breaker.js';

describe('CallCircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows calls below threshold', () => {
    const breaker = new CallCircuitBreaker({ threshold: 5, windowMs: 60_000 });
    for (let i = 0; i < 4; i++) {
      const result = breaker.check('read_file', { path: '/tmp/test.txt' });
      expect(result.allowed).toBe(true);
    }
  });

  it('denies at threshold', () => {
    const breaker = new CallCircuitBreaker({ threshold: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      breaker.check('read_file', { path: '/tmp/test.txt' });
    }
    const result = breaker.check('read_file', { path: '/tmp/test.txt' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('CIRCUIT BREAKER');
    expect(result.reason).toContain('read_file');
  });

  it('tracks independent windows per tool+args combination', () => {
    const breaker = new CallCircuitBreaker({ threshold: 3, windowMs: 60_000 });

    // Fill up read_file with path A
    for (let i = 0; i < 3; i++) {
      breaker.check('read_file', { path: '/tmp/a.txt' });
    }
    // read_file + path A is now at threshold
    expect(breaker.check('read_file', { path: '/tmp/a.txt' }).allowed).toBe(false);

    // read_file + path B should still be allowed
    expect(breaker.check('read_file', { path: '/tmp/b.txt' }).allowed).toBe(true);

    // write_file + path A should still be allowed
    expect(breaker.check('write_file', { path: '/tmp/a.txt' }).allowed).toBe(true);
  });

  it('sliding window expiry allows calls after window passes', () => {
    const breaker = new CallCircuitBreaker({ threshold: 3, windowMs: 10_000 });

    // Make 3 calls
    for (let i = 0; i < 3; i++) {
      breaker.check('read_file', { path: '/tmp/test.txt' });
    }
    // At threshold — denied
    expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(false);

    // Advance past window
    vi.advanceTimersByTime(11_000);

    // Should be allowed again (old entries expired)
    expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(true);
  });

  it('sliding window partially expires old entries', () => {
    const breaker = new CallCircuitBreaker({ threshold: 3, windowMs: 10_000 });

    // Make 2 calls at t=0
    breaker.check('read_file', { path: '/tmp/test.txt' });
    breaker.check('read_file', { path: '/tmp/test.txt' });

    // Advance 6s, make 1 more call at t=6s
    vi.advanceTimersByTime(6_000);
    breaker.check('read_file', { path: '/tmp/test.txt' });

    // At t=6s, we have 3 calls — denied
    expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(false);

    // Advance to t=11s — the first 2 calls expire, leaving 1 from t=6s
    vi.advanceTimersByTime(5_000);
    expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(true);
  });

  it('uses default config values', () => {
    const breaker = new CallCircuitBreaker();
    // Default threshold is 20 — should allow 19 calls
    for (let i = 0; i < 19; i++) {
      expect(breaker.check('tool', { x: 1 }).allowed).toBe(true);
    }
  });

  it('reset clears all state', () => {
    const breaker = new CallCircuitBreaker({ threshold: 2, windowMs: 60_000 });
    breaker.check('read_file', { path: '/tmp/test.txt' });
    breaker.check('read_file', { path: '/tmp/test.txt' });
    expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(false);

    breaker.reset();
    expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(true);
  });

  it('hash stability: key ordering does not matter', () => {
    const breaker = new CallCircuitBreaker({ threshold: 3, windowMs: 60_000 });
    breaker.check('tool', { b: 2, a: 1 });
    breaker.check('tool', { a: 1, b: 2 });
    breaker.check('tool', { b: 2, a: 1 });
    // All three should count as the same key
    expect(breaker.check('tool', { a: 1, b: 2 }).allowed).toBe(false);
  });
});
