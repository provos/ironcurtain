import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ResourceBudgetTracker,
  type BudgetExhaustedVerdict,
} from '../src/session/resource-budget-tracker.js';
import type { ResolvedResourceBudgetConfig } from '../src/config/user-config.js';
import type { LanguageModelUsage } from 'ai';

// --- Test helpers ---

function defaultConfig(overrides: Partial<ResolvedResourceBudgetConfig> = {}): ResolvedResourceBudgetConfig {
  return {
    maxTotalTokens: 10_000,
    maxSteps: 10,
    maxSessionSeconds: 60,
    maxEstimatedCostUsd: 1.00,
    warnThresholdPercent: 80,
    ...overrides,
  };
}

function makeUsage(overrides: Partial<LanguageModelUsage> = {}): LanguageModelUsage {
  return {
    inputTokens: 100,
    inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 50,
    outputTokenDetails: { textTokens: 50, reasoningTokens: 0 },
    totalTokens: 150,
    ...overrides,
  };
}

/** Minimal step result stub -- only `usage` is accessed by the stop condition at runtime. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStepResult(usage: LanguageModelUsage): any {
  return { usage };
}

// --- Tests ---

describe('ResourceBudgetTracker', () => {
  describe('token budget', () => {
    it('allows usage below limit', () => {
      const tracker = new ResourceBudgetTracker(defaultConfig({ maxTotalTokens: 1000 }), 'claude-sonnet');
      const verdict = tracker.recordStep(makeUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }));
      expect(verdict).toEqual({ ok: true });
    });

    it('warns at threshold', () => {
      const tracker = new ResourceBudgetTracker(defaultConfig({ maxTotalTokens: 1000 }), 'claude-sonnet');

      // Record steps to reach 80%+ of 1000 tokens
      for (let i = 0; i < 5; i++) {
        tracker.recordStep(makeUsage({ inputTokens: 100, outputTokens: 60, totalTokens: 160 }));
      }

      const warnings = tracker.getActiveWarnings();
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      const tokenWarning = warnings.find(w => w.dimension === 'tokens');
      expect(tokenWarning).toBeDefined();
      expect(tokenWarning!.percentUsed).toBeGreaterThanOrEqual(80);
    });

    it('exhausts at limit', () => {
      const tracker = new ResourceBudgetTracker(defaultConfig({ maxTotalTokens: 500 }), 'claude-sonnet');

      // First step: 300 tokens, ok
      const v1 = tracker.recordStep(makeUsage({ inputTokens: 200, outputTokens: 100, totalTokens: 300 }));
      expect(v1).toEqual({ ok: true });

      // Second step: 300 more = 600 total, exceeds 500
      const v2 = tracker.recordStep(makeUsage({ inputTokens: 200, outputTokens: 100, totalTokens: 300 }));
      expect('exhausted' in v2).toBe(true);
      expect((v2 as BudgetExhaustedVerdict).dimension).toBe('tokens');
    });
  });

  describe('step budget', () => {
    it('tracks step count and exhausts at limit', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxSteps: 3, maxTotalTokens: null, maxEstimatedCostUsd: null }),
        'claude-sonnet',
      );

      expect(tracker.recordStep(makeUsage())).toEqual({ ok: true });
      expect(tracker.recordStep(makeUsage())).toEqual({ ok: true });

      const v3 = tracker.recordStep(makeUsage());
      expect('exhausted' in v3).toBe(true);
      expect((v3 as BudgetExhaustedVerdict).dimension).toBe('steps');
    });

    it('warns at step threshold', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxSteps: 10, maxTotalTokens: null, maxEstimatedCostUsd: null }),
        'claude-sonnet',
      );

      // Reach 80%: 8 steps of 10
      for (let i = 0; i < 8; i++) {
        tracker.recordStep(makeUsage());
      }

      const warnings = tracker.getActiveWarnings();
      const stepWarning = warnings.find(w => w.dimension === 'steps');
      expect(stepWarning).toBeDefined();
      expect(stepWarning!.percentUsed).toBe(80);
    });
  });

  describe('wall-clock budget', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('exhausts at time limit', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxSessionSeconds: 10, maxTotalTokens: null, maxSteps: null, maxEstimatedCostUsd: null }),
        'claude-sonnet',
      );

      // Initially not exhausted
      expect(tracker.isExhausted()).toBeNull();

      // Advance time past the limit
      vi.advanceTimersByTime(11_000);

      const verdict = tracker.isExhausted();
      expect(verdict).not.toBeNull();
      expect(verdict!.dimension).toBe('wall_clock');
    });

    it('getRemainingWallClockMs returns correct value', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxSessionSeconds: 30 }),
        'claude-sonnet',
      );

      expect(tracker.getRemainingWallClockMs()).toBe(30_000);

      vi.advanceTimersByTime(10_000);
      expect(tracker.getRemainingWallClockMs()).toBe(20_000);

      vi.advanceTimersByTime(25_000);
      expect(tracker.getRemainingWallClockMs()).toBe(0);
    });

    it('getRemainingWallClockMs returns null when disabled', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxSessionSeconds: null }),
        'claude-sonnet',
      );

      expect(tracker.getRemainingWallClockMs()).toBeNull();
    });
  });

  describe('cost estimation', () => {
    it('estimates cost from token counts and pricing table', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxEstimatedCostUsd: 10, maxTotalTokens: null, maxSteps: null }),
        'claude-sonnet',
      );

      // claude-sonnet: input=$3/M, output=$15/M
      // 1M input + 100K output = $3 + $1.5 = $4.50
      tracker.recordStep(makeUsage({
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000,
        inputTokenDetails: { noCacheTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }));

      const snapshot = tracker.getSnapshot();
      expect(snapshot.estimatedCostUsd).toBeCloseTo(4.5, 1);
    });

    it('applies reduced rate for cache-read tokens', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxEstimatedCostUsd: 10, maxTotalTokens: null, maxSteps: null }),
        'claude-sonnet',
      );

      // claude-sonnet: input=$3/M, cacheRead=$0.3/M, output=$15/M
      // 500K cached + 500K non-cached input + 100K output
      // = (500K/1M * $3) + (500K/1M * $0.3) + (100K/1M * $15)
      // = $1.50 + $0.15 + $1.50 = $3.15
      tracker.recordStep(makeUsage({
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000,
        inputTokenDetails: { noCacheTokens: 500_000, cacheReadTokens: 500_000, cacheWriteTokens: 0 },
      }));

      const snapshot = tracker.getSnapshot();
      expect(snapshot.estimatedCostUsd).toBeCloseTo(3.15, 1);
    });

    it('exhausts when cost exceeds budget', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxEstimatedCostUsd: 1.00, maxTotalTokens: null, maxSteps: null }),
        'claude-sonnet',
      );

      // claude-sonnet: enough tokens to exceed $1
      const v = tracker.recordStep(makeUsage({
        inputTokens: 500_000,
        outputTokens: 100_000,
        totalTokens: 600_000,
      }));

      expect('exhausted' in v).toBe(true);
      expect((v as BudgetExhaustedVerdict).dimension).toBe('cost');
    });

    it('uses fallback pricing for unknown models', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxEstimatedCostUsd: 100, maxTotalTokens: null, maxSteps: null }),
        'unknown-model-xyz',
      );

      // Fallback: input=$3/M, output=$15/M
      tracker.recordStep(makeUsage({
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
      }));

      const snapshot = tracker.getSnapshot();
      expect(snapshot.estimatedCostUsd).toBeCloseTo(3.0, 1);
    });
  });

  describe('null dimensions', () => {
    it('skips disabled dimensions', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({
          maxTotalTokens: null,
          maxSteps: null,
          maxSessionSeconds: null,
          maxEstimatedCostUsd: null,
        }),
        'claude-sonnet',
      );

      // Should never exhaust with all limits disabled
      for (let i = 0; i < 100; i++) {
        const v = tracker.recordStep(makeUsage({
          inputTokens: 100_000,
          outputTokens: 50_000,
          totalTokens: 150_000,
        }));
        expect(v).toEqual({ ok: true });
      }

      expect(tracker.isExhausted()).toBeNull();
      expect(tracker.getActiveWarnings()).toEqual([]);
    });
  });

  describe('isExhausted persistence', () => {
    it('once exhausted, stays exhausted', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxSteps: 2, maxTotalTokens: null, maxEstimatedCostUsd: null }),
        'claude-sonnet',
      );

      tracker.recordStep(makeUsage());
      tracker.recordStep(makeUsage());

      const v1 = tracker.isExhausted();
      expect(v1).not.toBeNull();

      // Additional recordStep also returns exhausted
      const v2 = tracker.recordStep(makeUsage());
      expect('exhausted' in v2).toBe(true);

      // isExhausted remains true
      expect(tracker.isExhausted()).not.toBeNull();
    });
  });

  describe('createStopCondition', () => {
    it('returns false when within budget', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxSteps: 10, maxTotalTokens: null, maxEstimatedCostUsd: null }),
        'claude-sonnet',
      );

      const condition = tracker.createStopCondition();
      const steps = [makeStepResult(makeUsage())];
      expect(condition({ steps })).toBe(false);
    });

    it('returns true when budget exhausted', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxSteps: 2, maxTotalTokens: null, maxEstimatedCostUsd: null }),
        'claude-sonnet',
      );

      const condition = tracker.createStopCondition();

      // First call with 1 step: ok
      const steps = [makeStepResult(makeUsage())];
      expect(condition({ steps })).toBe(false);

      // Second call with 2 cumulative steps: step 2 triggers exhaustion
      steps.push(makeStepResult(makeUsage()));
      expect(condition({ steps })).toBe(true);
    });

    it('processes only new steps (no double-counting)', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxSteps: 5, maxTotalTokens: null, maxEstimatedCostUsd: null }),
        'claude-sonnet',
      );

      const condition = tracker.createStopCondition();

      // Call with 2 steps
      const steps = [makeStepResult(makeUsage()), makeStepResult(makeUsage())];
      condition({ steps });

      // Call again with same 2 steps + 1 new
      steps.push(makeStepResult(makeUsage()));
      condition({ steps });

      // Should have recorded 3 steps total, not 5
      expect(tracker.getSnapshot().stepCount).toBe(3);
    });
  });

  describe('cross-turn accumulation', () => {
    it('accumulates tokens across multiple recordStep calls', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxTotalTokens: null, maxSteps: null, maxEstimatedCostUsd: null }),
        'claude-sonnet',
      );

      tracker.recordStep(makeUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }));
      tracker.recordStep(makeUsage({ inputTokens: 200, outputTokens: 80, totalTokens: 280 }));
      tracker.recordStep(makeUsage({ inputTokens: 150, outputTokens: 70, totalTokens: 220 }));

      const snapshot = tracker.getSnapshot();
      expect(snapshot.totalInputTokens).toBe(450);
      expect(snapshot.totalOutputTokens).toBe(200);
      expect(snapshot.totalTokens).toBe(650);
      expect(snapshot.stepCount).toBe(3);
    });
  });

  describe('getSnapshot', () => {
    it('returns zero values initially', () => {
      const tracker = new ResourceBudgetTracker(defaultConfig(), 'claude-sonnet');
      const snapshot = tracker.getSnapshot();
      expect(snapshot.totalInputTokens).toBe(0);
      expect(snapshot.totalOutputTokens).toBe(0);
      expect(snapshot.totalTokens).toBe(0);
      expect(snapshot.stepCount).toBe(0);
      expect(snapshot.estimatedCostUsd).toBe(0);
    });
  });

  describe('warnings', () => {
    it('each dimension warns at most once', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxSteps: 10, maxTotalTokens: null, maxEstimatedCostUsd: null }),
        'claude-sonnet',
      );

      // Reach 80%: 8 steps
      for (let i = 0; i < 8; i++) {
        tracker.recordStep(makeUsage());
      }

      const first = tracker.getActiveWarnings();
      expect(first.filter(w => w.dimension === 'steps')).toHaveLength(1);

      // Record another step, no new warning
      tracker.recordStep(makeUsage());
      const second = tracker.getActiveWarnings();
      expect(second.filter(w => w.dimension === 'steps')).toHaveLength(0);
    });

    it('getActiveWarnings drains pending warnings', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxSteps: 10, maxTotalTokens: null, maxEstimatedCostUsd: null }),
        'claude-sonnet',
      );

      for (let i = 0; i < 8; i++) {
        tracker.recordStep(makeUsage());
      }

      const first = tracker.getActiveWarnings();
      expect(first.length).toBeGreaterThan(0);

      // Second call returns empty
      const second = tracker.getActiveWarnings();
      expect(second).toEqual([]);
    });
  });
});
