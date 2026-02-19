import { describe, it, expect } from 'vitest';
import { StepLoopDetector } from '../src/session/step-loop-detector.js';
import { computeHash, stableStringify } from '../src/hash.js';

// --- Hash utility tests ---

describe('stableStringify', () => {
  it('sorts object keys deterministically', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
  });

  it('handles nested objects', () => {
    const a = { x: { b: 2, a: 1 }, y: [3, 1] };
    const b = { y: [3, 1], x: { a: 1, b: 2 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('handles primitives', () => {
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(true)).toBe('true');
  });

  it('handles arrays', () => {
    expect(stableStringify([1, 2, 3])).toBe('[1,2,3]');
  });

  it('handles undefined', () => {
    expect(stableStringify(undefined)).toBe(undefined);
  });
});

describe('computeHash', () => {
  it('returns consistent hashes for equivalent objects', () => {
    expect(computeHash({ b: 2, a: 1 })).toBe(computeHash({ a: 1, b: 2 }));
  });

  it('returns different hashes for different values', () => {
    expect(computeHash({ a: 1 })).not.toBe(computeHash({ a: 2 }));
  });

  it('returns a 64-character hex string', () => {
    const hash = computeHash('test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// --- StepLoopDetector tests ---

describe('StepLoopDetector', () => {
  describe('2x2 matrix classification', () => {
    it('classifies full progress: new code + new result', () => {
      const detector = new StepLoopDetector();
      const verdict = detector.analyzeStep('code1', 'result1');
      expect(verdict.action).toBe('allow');
    });

    it('classifies world changed: repeated code + new result', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1');
      // Same code, different result
      const verdict = detector.analyzeStep('code1', 'result2');
      expect(verdict.action).toBe('allow');
    });

    it('classifies stuck: new code + repeated result', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1');
      // Different code, same result
      const verdict = detector.analyzeStep('code2', 'result1');
      expect(verdict.action).toBe('allow'); // First stuck step, below threshold
    });

    it('classifies full stagnation: repeated code + repeated result', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1');
      // Same code, same result
      const verdict = detector.analyzeStep('code1', 'result1');
      expect(verdict.action).toBe('allow'); // First stagnation, below threshold
    });
  });

  describe('stagnation streak', () => {
    function buildStagnationDetector(n: number): StepLoopDetector {
      const detector = new StepLoopDetector();
      // First step is always full_progress
      detector.analyzeStep('code1', 'result1');
      // Subsequent identical steps are full_stagnation
      for (let i = 1; i < n; i++) {
        detector.analyzeStep('code1', 'result1');
      }
      return detector;
    }

    it('allows below warn threshold', () => {
      const detector = buildStagnationDetector(3); // 2 stagnation steps
      const verdict = detector.analyzeStep('code1', 'result1');
      expect(verdict.action).toBe('warn'); // 3rd stagnation = warn threshold
    });

    it('warns at stagnation threshold (3)', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code1', 'result1'); // stagnation 1
      detector.analyzeStep('code1', 'result1'); // stagnation 2
      const verdict = detector.analyzeStep('code1', 'result1'); // stagnation 3
      expect(verdict.action).toBe('warn');
      expect(verdict).toHaveProperty('category', 'full_stagnation');
    });

    it('blocks at stagnation threshold (5)', () => {
      const detector = buildStagnationDetector(6); // 5 stagnation steps
      const verdict = detector.analyzeStep('code1', 'result1'); // 6th stagnation
      expect(verdict.action).toBe('block');
      expect(verdict).toHaveProperty('category', 'full_stagnation');
    });

    it('resets on full progress', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code1', 'result1'); // stagnation 1
      detector.analyzeStep('code1', 'result1'); // stagnation 2
      // Full progress resets the streak
      detector.analyzeStep('code2', 'result2');
      // Start stagnation again — should be fresh
      detector.analyzeStep('code2', 'result2'); // stagnation 1
      detector.analyzeStep('code2', 'result2'); // stagnation 2
      const verdict = detector.analyzeStep('code2', 'result2'); // stagnation 3
      expect(verdict.action).toBe('warn'); // Only at 3, not accumulated from before
    });

    it('resets on world changed', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code1', 'result1'); // stagnation 1
      detector.analyzeStep('code1', 'result1'); // stagnation 2
      // World changed (same code, new result) resets streak
      detector.analyzeStep('code1', 'result3');
      const verdict = detector.analyzeStep('code1', 'result3'); // stagnation 1 (fresh)
      expect(verdict.action).toBe('allow');
    });
  });

  describe('stuck streak', () => {
    function buildStuckDetector(n: number): StepLoopDetector {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1'); // full_progress
      // Each new code with same result is "stuck"
      for (let i = 1; i <= n; i++) {
        detector.analyzeStep(`different_code_${i}`, 'result1');
      }
      return detector;
    }

    it('allows below warn threshold', () => {
      const detector = buildStuckDetector(4); // 4 stuck steps
      const verdict = detector.analyzeStep('yet_another_code', 'result1');
      expect(verdict.action).toBe('warn'); // 5th stuck = warn
    });

    it('warns at stuck threshold (5)', () => {
      const detector = buildStuckDetector(5); // 5 stuck steps
      // 5th stuck step should have warned
      const verdict = detector.analyzeStep('more_code', 'result1'); // 6th stuck
      expect(verdict.action).toBe('warn');
      expect(verdict).toHaveProperty('category', 'stuck');
    });

    it('blocks at stuck threshold (8)', () => {
      const detector = buildStuckDetector(8); // 8 stuck steps
      const verdict = detector.analyzeStep('final_code', 'result1');
      expect(verdict.action).toBe('block');
      expect(verdict).toHaveProperty('category', 'stuck');
    });

    it('resets on progress', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code2', 'result1'); // stuck 1
      detector.analyzeStep('code3', 'result1'); // stuck 2
      detector.analyzeStep('code4', 'result1'); // stuck 3
      detector.analyzeStep('code5', 'result1'); // stuck 4
      // New result → world_changed → resets stuck streak
      detector.analyzeStep('code5', 'result_new');
      // Start new stuck streak
      const verdict = detector.analyzeStep('code6', 'result_new'); // stuck 1
      expect(verdict.action).toBe('allow');
    });
  });

  describe('blocking behavior', () => {
    it('isBlocked returns null before block', () => {
      const detector = new StepLoopDetector();
      expect(detector.isBlocked()).toBeNull();
    });

    it('isBlocked returns verdict after block', () => {
      const detector = new StepLoopDetector({ stagnation: { warn: 1, block: 2 } });
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code1', 'result1'); // stagnation 1
      detector.analyzeStep('code1', 'result1'); // stagnation 2 = block

      const blocked = detector.isBlocked();
      expect(blocked).not.toBeNull();
      expect(blocked!.action).toBe('block');
    });

    it('block persists until reset', () => {
      const detector = new StepLoopDetector({ stagnation: { warn: 1, block: 2 } });
      detector.analyzeStep('code1', 'result1');
      detector.analyzeStep('code1', 'result1');
      detector.analyzeStep('code1', 'result1'); // triggers block

      expect(detector.isBlocked()).not.toBeNull();
      expect(detector.isBlocked()).not.toBeNull(); // still blocked

      detector.reset();
      expect(detector.isBlocked()).toBeNull();
    });
  });

  describe('custom thresholds', () => {
    it('uses custom stagnation thresholds', () => {
      const detector = new StepLoopDetector({ stagnation: { warn: 2, block: 3 } });
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code1', 'result1'); // stagnation 1
      const warn = detector.analyzeStep('code1', 'result1'); // stagnation 2 = warn
      expect(warn.action).toBe('warn');

      const block = detector.analyzeStep('code1', 'result1'); // stagnation 3 = block
      expect(block.action).toBe('block');
    });

    it('uses custom stuck thresholds', () => {
      const detector = new StepLoopDetector({ stuck: { warn: 2, block: 3 } });
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code2', 'result1'); // stuck 1
      const warn = detector.analyzeStep('code3', 'result1'); // stuck 2 = warn
      expect(warn.action).toBe('warn');

      const block = detector.analyzeStep('code4', 'result1'); // stuck 3 = block
      expect(block.action).toBe('block');
    });
  });

  describe('streak interaction', () => {
    it('stuck resets stagnation streak and vice versa', () => {
      const detector = new StepLoopDetector({ stagnation: { warn: 3, block: 5 }, stuck: { warn: 3, block: 5 } });
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code1', 'result1'); // stagnation 1
      detector.analyzeStep('code1', 'result1'); // stagnation 2
      // Switch to stuck (new code, same result1)
      detector.analyzeStep('code2', 'result1'); // stuck 1 — resets stagnation
      // Back to stagnation
      detector.analyzeStep('code2', 'result1'); // stagnation 1 — resets stuck
      const verdict = detector.analyzeStep('code2', 'result1'); // stagnation 2
      expect(verdict.action).toBe('allow'); // not at warn (3) because resets happened
    });
  });
});
