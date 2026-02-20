/**
 * ResourceBudgetTracker -- enforces configurable resource limits per session.
 *
 * Tracks token usage, step count, wall-clock time, and estimated cost.
 * Provides:
 * - isExhausted() pre-check for belt-and-suspenders enforcement
 * - recordStep() for accumulation after each AI SDK step
 * - createStopCondition() for AI SDK v6 stopWhen integration
 * - getRemainingWallClockMs() for AbortSignal timeout
 * - getActiveWarnings() for surfacing threshold warnings
 */

import type { ResolvedResourceBudgetConfig } from '../config/user-config.js';
import type { LanguageModelUsage, ToolSet, StopCondition } from 'ai';

export type BudgetDimension = 'tokens' | 'steps' | 'wall_clock' | 'cost';

export interface BudgetSnapshot {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly stepCount: number;
  readonly elapsedSeconds: number;
  readonly estimatedCostUsd: number;
}

export interface BudgetExhaustedVerdict {
  readonly exhausted: true;
  readonly dimension: BudgetDimension;
  readonly message: string;
  readonly snapshot: BudgetSnapshot;
}

export interface BudgetWarningVerdict {
  readonly warning: true;
  readonly dimension: BudgetDimension;
  readonly message: string;
  readonly percentUsed: number;
  readonly snapshot: BudgetSnapshot;
}

export type BudgetVerdict =
  | { readonly ok: true }
  | BudgetExhaustedVerdict;

/** Per-million-token pricing for cost estimation. */
interface ModelPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cacheReadPerMillion: number;
}

/**
 * Static pricing table keyed by model name substring.
 * Approximate by design — prevents $50 surprises, not audit-grade billing.
 */
const MODEL_PRICING: ReadonlyArray<{ readonly match: string; readonly pricing: ModelPricing }> = [
  { match: 'claude-opus', pricing: { inputPerMillion: 15, outputPerMillion: 75, cacheReadPerMillion: 1.5 } },
  { match: 'claude-sonnet', pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 } },
  { match: 'claude-haiku', pricing: { inputPerMillion: 0.8, outputPerMillion: 4, cacheReadPerMillion: 0.08 } },
  { match: 'gpt-4o', pricing: { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25 } },
  { match: 'gpt-4', pricing: { inputPerMillion: 10, outputPerMillion: 30, cacheReadPerMillion: 5 } },
  { match: 'gemini-2', pricing: { inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0 } },
  { match: 'gemini-1.5-pro', pricing: { inputPerMillion: 1.25, outputPerMillion: 5, cacheReadPerMillion: 0.3 } },
];

const FALLBACK_PRICING: ModelPricing = { inputPerMillion: 5, outputPerMillion: 15, cacheReadPerMillion: 1 };

function resolvePricing(modelId: string): ModelPricing {
  const lower = modelId.toLowerCase();
  for (const entry of MODEL_PRICING) {
    if (lower.includes(entry.match)) return entry.pricing;
  }
  return FALLBACK_PRICING;
}

export class ResourceBudgetTracker {
  private readonly config: ResolvedResourceBudgetConfig;
  private readonly pricing: ModelPricing;
  private readonly sessionStartMs: number;

  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheReadTokens = 0;
  private stepCount = 0;

  /** Once a dimension is exhausted, the verdict is latched. */
  private exhaustedVerdict: BudgetExhaustedVerdict | null = null;

  /** Track which dimensions have already fired a warning (emit each once). */
  private warnedDimensions = new Set<BudgetDimension>();

  /** Pending warnings accumulated by recordStep(), drained by getActiveWarnings(). */
  private pendingWarnings: BudgetWarningVerdict[] = [];

  constructor(config: ResolvedResourceBudgetConfig, modelId: string) {
    this.config = config;
    this.pricing = resolvePricing(modelId);
    this.sessionStartMs = Date.now();
  }

  /**
   * Pre-check: returns a verdict if any budget dimension is exhausted.
   * Also checks wall-clock time (which advances even between steps).
   */
  isExhausted(): BudgetExhaustedVerdict | null {
    if (this.exhaustedVerdict) return this.exhaustedVerdict;
    const exhausted = this.checkExhaustion(this.getSnapshot());
    if (exhausted) this.exhaustedVerdict = exhausted;
    return exhausted;
  }

  /**
   * Record token usage from a completed step. Accumulates totals and
   * evaluates all budget dimensions. Returns exhausted verdict or ok.
   */
  recordStep(usage: LanguageModelUsage): BudgetVerdict {
    if (this.exhaustedVerdict) return this.exhaustedVerdict;

    this.totalInputTokens += usage.inputTokens ?? 0;
    this.totalOutputTokens += usage.outputTokens ?? 0;
    this.totalCacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0;
    this.stepCount++;

    return this.evaluate();
  }

  /** Returns a read-only snapshot of current budget consumption. */
  getSnapshot(): BudgetSnapshot {
    return {
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalTokens: this.totalInputTokens + this.totalOutputTokens,
      stepCount: this.stepCount,
      elapsedSeconds: this.getElapsedSeconds(),
      estimatedCostUsd: this.estimateCost(),
    };
  }

  /**
   * Returns warnings that have been generated since the last call.
   * Each dimension warns at most once.
   */
  getActiveWarnings(): BudgetWarningVerdict[] {
    return this.pendingWarnings.splice(0);
  }

  /**
   * Creates a StopCondition for AI SDK v6 `stopWhen`.
   * The closure tracks how many steps it has already processed
   * so it only calls recordStep() for new steps (the steps array
   * passed to the callback is cumulative).
   */
  createStopCondition(): StopCondition<ToolSet> {
    let processedCount = 0;

    return ({ steps }) => {
      // Process only new steps since last invocation
      for (let i = processedCount; i < steps.length; i++) {
        const verdict = this.recordStep(steps[i].usage);
        if ('exhausted' in verdict) return true;
      }
      processedCount = steps.length;

      // Also check wall clock (advances between steps)
      return this.isExhausted() !== null;
    };
  }

  /**
   * Returns remaining wall-clock time in milliseconds, or null
   * if wall-clock budget is disabled.
   */
  getRemainingWallClockMs(): number | null {
    if (this.config.maxSessionSeconds === null) return null;
    const elapsedMs = Date.now() - this.sessionStartMs;
    const limitMs = this.config.maxSessionSeconds * 1000;
    return Math.max(0, limitMs - elapsedMs);
  }

  // --- Private helpers ---

  private getElapsedSeconds(): number {
    return (Date.now() - this.sessionStartMs) / 1000;
  }

  private estimateCost(): number {
    // Cache-read tokens are a subset of input tokens counted at a reduced rate.
    // Non-cached input tokens pay the full input rate.
    const nonCachedInput = this.totalInputTokens - this.totalCacheReadTokens;
    return (
      (nonCachedInput / 1_000_000) * this.pricing.inputPerMillion +
      (this.totalCacheReadTokens / 1_000_000) * this.pricing.cacheReadPerMillion +
      (this.totalOutputTokens / 1_000_000) * this.pricing.outputPerMillion
    );
  }

  private evaluate(): BudgetVerdict {
    const snapshot = this.getSnapshot();

    // Check exhaustion for each dimension
    const exhausted = this.checkExhaustion(snapshot);
    if (exhausted) {
      this.exhaustedVerdict = exhausted;
      return exhausted;
    }

    // Check warnings (only fires once per dimension)
    this.checkWarnings(snapshot);

    return { ok: true };
  }

  private checkExhaustion(snapshot: BudgetSnapshot): BudgetExhaustedVerdict | null {
    const { maxTotalTokens, maxSteps, maxSessionSeconds, maxEstimatedCostUsd } = this.config;

    if (maxTotalTokens !== null && snapshot.totalTokens >= maxTotalTokens) {
      return {
        exhausted: true,
        dimension: 'tokens',
        message: `Token budget exhausted: ${snapshot.totalTokens.toLocaleString()} / ${maxTotalTokens.toLocaleString()} tokens used`,
        snapshot,
      };
    }
    if (maxSteps !== null && snapshot.stepCount >= maxSteps) {
      return {
        exhausted: true,
        dimension: 'steps',
        message: `Step budget exhausted: ${snapshot.stepCount} / ${maxSteps} steps used`,
        snapshot,
      };
    }
    if (maxSessionSeconds !== null && snapshot.elapsedSeconds >= maxSessionSeconds) {
      return {
        exhausted: true,
        dimension: 'wall_clock',
        message: `Time budget exhausted: ${Math.round(snapshot.elapsedSeconds)}s / ${maxSessionSeconds}s elapsed`,
        snapshot,
      };
    }
    if (maxEstimatedCostUsd !== null && snapshot.estimatedCostUsd >= maxEstimatedCostUsd) {
      return {
        exhausted: true,
        dimension: 'cost',
        message: `Cost budget exhausted: $${snapshot.estimatedCostUsd.toFixed(2)} / $${maxEstimatedCostUsd.toFixed(2)} estimated`,
        snapshot,
      };
    }
    return null;
  }

  private checkWarnings(snapshot: BudgetSnapshot): void {
    this.maybeWarn('tokens', this.config.maxTotalTokens, snapshot.totalTokens, snapshot,
      (pct) => `Token usage at ${pct}%: ${snapshot.totalTokens.toLocaleString()} / ${this.config.maxTotalTokens!.toLocaleString()}`);

    this.maybeWarn('steps', this.config.maxSteps, snapshot.stepCount, snapshot,
      (pct) => `Step usage at ${pct}%: ${snapshot.stepCount} / ${this.config.maxSteps!}`);

    this.maybeWarn('wall_clock', this.config.maxSessionSeconds, snapshot.elapsedSeconds, snapshot,
      (pct) => `Time usage at ${pct}%: ${Math.round(snapshot.elapsedSeconds)}s / ${this.config.maxSessionSeconds!}s`);

    this.maybeWarn('cost', this.config.maxEstimatedCostUsd, snapshot.estimatedCostUsd, snapshot,
      (pct) => `Cost at ${pct}%: $${snapshot.estimatedCostUsd.toFixed(2)} / $${this.config.maxEstimatedCostUsd!.toFixed(2)}`);
  }

  private maybeWarn(
    dimension: BudgetDimension,
    limit: number | null,
    current: number,
    snapshot: BudgetSnapshot,
    messageFn: (percentUsed: number) => string,
  ): void {
    if (limit === null) return;
    if (this.warnedDimensions.has(dimension)) return;

    const ratio = current / limit;
    if (ratio >= this.config.warnThresholdPercent / 100 && ratio < 1) {
      const percentUsed = Math.round(ratio * 100);
      this.warnedDimensions.add(dimension);
      this.pendingWarnings.push({
        warning: true,
        dimension,
        message: messageFn(percentUsed),
        percentUsed,
        snapshot,
      });
    }
  }
}
