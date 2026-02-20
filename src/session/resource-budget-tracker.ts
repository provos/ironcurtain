/**
 * ResourceBudgetTracker -- enforces configurable resource limits per turn.
 *
 * All four budget dimensions (tokens, steps, wall-clock time, cost) are
 * per-turn limits that reset when the agent returns control. Cumulative
 * session totals are tracked separately for display purposes.
 *
 * Turn lifecycle: call startTurn() before each agent turn, endTurn() after.
 * Idle time between turns does not count against the wall-clock budget.
 *
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

/** Cumulative session totals across all turns. */
export interface CumulativeBudgetSnapshot {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly stepCount: number;
  readonly activeSeconds: number;
  readonly estimatedCostUsd: number;
}

export interface BudgetSnapshot {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly stepCount: number;
  readonly elapsedSeconds: number;
  readonly estimatedCostUsd: number;
  readonly cumulative: CumulativeBudgetSnapshot;
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
 * Static pricing table keyed by model name substring (first match wins).
 * Approximate by design — prevents $50 surprises, not audit-grade billing.
 *
 * ORDERING MATTERS: more specific matches must come before broader ones
 * (e.g. 'claude-opus-4-5' before 'claude-opus', 'gpt-4.1-nano' before 'gpt-4.1').
 *
 * Last updated: 2026-02-19
 * Sources: platform.claude.com, openai.com/api/pricing, ai.google.dev/gemini-api/docs/pricing
 */
const MODEL_PRICING: ReadonlyArray<{ readonly match: string; readonly pricing: ModelPricing }> = [
  // --- Anthropic ---
  // Opus 4.5/4.6 ($5/$25/$0.50)
  { match: 'claude-opus-4-5', pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.50 } },
  { match: 'claude-opus-4-6', pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.50 } },
  // Opus 4/4.1 ($15/$75/$1.50) — also catches unversioned 'claude-opus'
  { match: 'claude-opus', pricing: { inputPerMillion: 15, outputPerMillion: 75, cacheReadPerMillion: 1.50 } },
  // Sonnet 4/4.5/4.6 (same pricing: $3/$15/$0.30)
  { match: 'claude-sonnet', pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.30 } },
  // Haiku 4.5 ($1/$5/$0.10)
  { match: 'claude-haiku-4-5', pricing: { inputPerMillion: 1, outputPerMillion: 5, cacheReadPerMillion: 0.10 } },
  // Haiku 3.5 ($0.80/$4/$0.08) — also catches unversioned 'claude-haiku'
  { match: 'claude-haiku', pricing: { inputPerMillion: 0.80, outputPerMillion: 4, cacheReadPerMillion: 0.08 } },

  // --- OpenAI ---
  // GPT-5.2 Pro ($21/$168)
  { match: 'gpt-5.2-pro', pricing: { inputPerMillion: 21, outputPerMillion: 168, cacheReadPerMillion: 21 } },
  // GPT-5.2 ($1.75/$14/$0.175)
  { match: 'gpt-5.2', pricing: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175 } },
  // GPT-5 mini ($0.25/$2/$0.025)
  { match: 'gpt-5-mini', pricing: { inputPerMillion: 0.25, outputPerMillion: 2, cacheReadPerMillion: 0.025 } },
  // GPT-4.1 nano ($0.20/$0.80/$0.05)
  { match: 'gpt-4.1-nano', pricing: { inputPerMillion: 0.20, outputPerMillion: 0.80, cacheReadPerMillion: 0.05 } },
  // GPT-4.1 mini ($0.80/$3.20/$0.20)
  { match: 'gpt-4.1-mini', pricing: { inputPerMillion: 0.80, outputPerMillion: 3.20, cacheReadPerMillion: 0.20 } },
  // GPT-4.1 ($3/$12/$0.75)
  { match: 'gpt-4.1', pricing: { inputPerMillion: 3, outputPerMillion: 12, cacheReadPerMillion: 0.75 } },
  // o4-mini ($4/$16/$1)
  { match: 'o4-mini', pricing: { inputPerMillion: 4, outputPerMillion: 16, cacheReadPerMillion: 1 } },
  // GPT-4o mini ($0.15/$0.60/$0.075)
  { match: 'gpt-4o-mini', pricing: { inputPerMillion: 0.15, outputPerMillion: 0.60, cacheReadPerMillion: 0.075 } },
  // GPT-4o ($2.50/$10/$1.25)
  { match: 'gpt-4o', pricing: { inputPerMillion: 2.50, outputPerMillion: 10, cacheReadPerMillion: 1.25 } },

  // --- Google Gemini ---
  // Gemini 3.1 Pro ($2/$12)
  { match: 'gemini-3.1-pro', pricing: { inputPerMillion: 2, outputPerMillion: 12, cacheReadPerMillion: 0.20 } },
  // Gemini 3 Flash ($0.50/$3)
  { match: 'gemini-3-flash', pricing: { inputPerMillion: 0.50, outputPerMillion: 3, cacheReadPerMillion: 0.05 } },
  // Gemini 3 Pro ($2/$12)
  { match: 'gemini-3-pro', pricing: { inputPerMillion: 2, outputPerMillion: 12, cacheReadPerMillion: 0.20 } },
  // Gemini 2.5 Pro ($1.25/$10/$0.125)
  { match: 'gemini-2.5-pro', pricing: { inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.125 } },
  // Gemini 2.5 Flash-Lite ($0.10/$0.40)
  { match: 'gemini-2.5-flash-lite', pricing: { inputPerMillion: 0.10, outputPerMillion: 0.40, cacheReadPerMillion: 0.01 } },
  // Gemini 2.5 Flash ($0.30/$2.50/$0.03)
  { match: 'gemini-2.5-flash', pricing: { inputPerMillion: 0.30, outputPerMillion: 2.50, cacheReadPerMillion: 0.03 } },
  // Gemini 2.0 Flash-Lite ($0.075/$0.30)
  { match: 'gemini-2.0-flash-lite', pricing: { inputPerMillion: 0.075, outputPerMillion: 0.30, cacheReadPerMillion: 0.0075 } },
  // Gemini 2.0 Flash ($0.10/$0.40/$0.01)
  { match: 'gemini-2.0-flash', pricing: { inputPerMillion: 0.10, outputPerMillion: 0.40, cacheReadPerMillion: 0.01 } },
  // Gemini 1.5 Pro ($1.25/$5/$0.125)
  { match: 'gemini-1.5-pro', pricing: { inputPerMillion: 1.25, outputPerMillion: 5, cacheReadPerMillion: 0.125 } },
];

const FALLBACK_PRICING: ModelPricing = { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.30 };

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

  // --- Per-turn state (reset on each startTurn) ---
  private turnStartMs: number | null = null;
  private turnInputTokens = 0;
  private turnOutputTokens = 0;
  private turnCacheReadTokens = 0;
  private turnStepCount = 0;

  // --- Cumulative session state (rolled up on each endTurn) ---
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;
  private cumulativeCacheReadTokens = 0;
  private cumulativeStepCount = 0;
  private cumulativeActiveMs = 0;

  /** Once a dimension is exhausted within a turn, the verdict is latched. */
  private exhaustedVerdict: BudgetExhaustedVerdict | null = null;

  /** Track which dimensions have already fired a warning (emit each once per turn). */
  private warnedDimensions = new Set<BudgetDimension>();

  /** Pending warnings accumulated by recordStep(), drained by getActiveWarnings(). */
  private pendingWarnings: BudgetWarningVerdict[] = [];

  constructor(config: ResolvedResourceBudgetConfig, modelId: string) {
    this.config = config;
    this.pricing = resolvePricing(modelId);
  }

  /**
   * Begin a new turn. Resets per-turn accumulators and starts the clock.
   * If a turn is already active, defensively ends it first.
   */
  startTurn(): void {
    if (this.turnStartMs !== null) {
      this.endTurn();
    }
    this.resetTurnCounters();
    this.exhaustedVerdict = null;
    this.warnedDimensions.clear();
    this.pendingWarnings = [];
    this.turnStartMs = Date.now();
  }

  /**
   * End the current turn. Rolls per-turn values into cumulative totals.
   * No-op if no turn is active.
   */
  endTurn(): void {
    if (this.turnStartMs === null) return;
    this.cumulativeActiveMs += Date.now() - this.turnStartMs;
    this.cumulativeInputTokens += this.turnInputTokens;
    this.cumulativeOutputTokens += this.turnOutputTokens;
    this.cumulativeCacheReadTokens += this.turnCacheReadTokens;
    this.cumulativeStepCount += this.turnStepCount;
    this.turnStartMs = null;
    this.resetTurnCounters();
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
   * Record token usage from a completed step. Accumulates per-turn totals
   * and evaluates all budget dimensions. Returns exhausted verdict or ok.
   */
  recordStep(usage: LanguageModelUsage): BudgetVerdict {
    if (this.exhaustedVerdict) return this.exhaustedVerdict;

    this.turnInputTokens += usage.inputTokens ?? 0;
    this.turnOutputTokens += usage.outputTokens ?? 0;
    this.turnCacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0;
    this.turnStepCount++;

    return this.evaluate();
  }

  /** Returns a read-only snapshot of current per-turn budget consumption. */
  getSnapshot(): BudgetSnapshot {
    return {
      totalInputTokens: this.turnInputTokens,
      totalOutputTokens: this.turnOutputTokens,
      totalTokens: this.turnInputTokens + this.turnOutputTokens,
      stepCount: this.turnStepCount,
      elapsedSeconds: this.getTurnElapsedSeconds(),
      estimatedCostUsd: this.estimateCost(this.turnInputTokens, this.turnOutputTokens, this.turnCacheReadTokens),
      cumulative: this.getCumulativeSnapshot(),
    };
  }

  /**
   * Returns warnings that have been generated since the last call.
   * Each dimension warns at most once per turn.
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
   * Returns remaining wall-clock time in milliseconds for the current turn,
   * or null if wall-clock budget is disabled.
   */
  getRemainingWallClockMs(): number | null {
    if (this.config.maxSessionSeconds === null) return null;
    const elapsedMs = this.getTurnElapsedMs();
    const limitMs = this.config.maxSessionSeconds * 1000;
    return Math.max(0, limitMs - elapsedMs);
  }

  // --- Private helpers ---

  private resetTurnCounters(): void {
    this.turnInputTokens = 0;
    this.turnOutputTokens = 0;
    this.turnCacheReadTokens = 0;
    this.turnStepCount = 0;
  }

  private getTurnElapsedMs(): number {
    if (this.turnStartMs === null) return 0;
    return Date.now() - this.turnStartMs;
  }

  private getTurnElapsedSeconds(): number {
    return this.getTurnElapsedMs() / 1000;
  }

  private estimateCost(inputTokens: number, outputTokens: number, cacheReadTokens: number): number {
    const nonCachedInput = inputTokens - cacheReadTokens;
    return (
      (nonCachedInput / 1_000_000) * this.pricing.inputPerMillion +
      (cacheReadTokens / 1_000_000) * this.pricing.cacheReadPerMillion +
      (outputTokens / 1_000_000) * this.pricing.outputPerMillion
    );
  }

  /** Returns cumulative snapshot including the current in-progress turn. */
  private getCumulativeSnapshot(): CumulativeBudgetSnapshot {
    const totalInput = this.cumulativeInputTokens + this.turnInputTokens;
    const totalOutput = this.cumulativeOutputTokens + this.turnOutputTokens;
    const totalCacheRead = this.cumulativeCacheReadTokens + this.turnCacheReadTokens;
    const totalActiveMs = this.cumulativeActiveMs + this.getTurnElapsedMs();
    return {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      stepCount: this.cumulativeStepCount + this.turnStepCount,
      activeSeconds: totalActiveMs / 1000,
      estimatedCostUsd: this.estimateCost(totalInput, totalOutput, totalCacheRead),
    };
  }

  private evaluate(): BudgetVerdict {
    const snapshot = this.getSnapshot();

    // Check exhaustion for each dimension
    const exhausted = this.checkExhaustion(snapshot);
    if (exhausted) {
      this.exhaustedVerdict = exhausted;
      return exhausted;
    }

    // Check warnings (only fires once per dimension per turn)
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
