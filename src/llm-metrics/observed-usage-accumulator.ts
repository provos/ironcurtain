import type { LlmExchangeCompleted, UsageCompleteness } from './types.js';

export type TokenTrackingStatus = 'complete' | 'partial' | 'unavailable';

export interface ObservedUsageSnapshot {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Null when at least one included exchange lacked a thinking-token breakdown. */
  readonly thinkingTokens: number | null;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly observedExchanges: number;
  readonly incompleteExchanges: number;
  readonly status: TokenTrackingStatus;
}

interface MutableUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  missingThinkingTokenExchanges: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  observedExchanges: number;
  incompleteExchanges: number;
}

function emptyUsage(): MutableUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    missingThinkingTokenExchanges: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    observedExchanges: 0,
    incompleteExchanges: 0,
  };
}

function isIncomplete(value: UsageCompleteness): boolean {
  return value !== 'complete';
}

function add(target: MutableUsage, exchange: LlmExchangeCompleted): void {
  const usage = exchange.usage;
  target.inputTokens += usage.inputTokensTotal ?? 0;
  target.outputTokens += usage.outputTokensTotal ?? 0;
  if (usage.thinkingTokens === null) target.missingThinkingTokenExchanges += 1;
  else target.thinkingTokens += usage.thinkingTokens;
  target.totalTokens += usage.canonicalTotalTokens ?? 0;
  target.cacheReadTokens += usage.cacheReadInputTokens ?? 0;
  target.cacheWriteTokens += usage.cacheWriteInputTokens ?? 0;
  target.costUsd += usage.costUsd ?? 0;
  target.observedExchanges += 1;
  if (isIncomplete(usage.usageCompleteness)) target.incompleteExchanges += 1;
}

function snapshot(usage: MutableUsage, trackingPathActive: boolean): ObservedUsageSnapshot {
  const status: TokenTrackingStatus = !trackingPathActive
    ? 'unavailable'
    : usage.observedExchanges === 0 || usage.incompleteExchanges > 0
      ? 'partial'
      : 'complete';
  const { missingThinkingTokenExchanges, ...totals } = usage;
  return Object.freeze({
    ...totals,
    thinkingTokens: usage.observedExchanges > 0 && missingThinkingTokenExchanges === 0 ? usage.thinkingTokens : null,
    status,
  });
}

/** Per-session exact-attribution accumulator. Ambiguous rows are excluded. */
export class ObservedUsageAccumulator {
  private readonly seen = new Set<string>();
  private readonly turns = new Map<string, MutableUsage>();
  private readonly cumulative = emptyUsage();

  constructor(
    private readonly sessionId: string,
    private readonly trackingPathActive: boolean,
  ) {}

  observe(exchange: LlmExchangeCompleted): void {
    if (
      exchange.attribution.quality !== 'exact' ||
      exchange.attribution.sessionId !== this.sessionId ||
      this.seen.has(exchange.exchangeId)
    ) {
      return;
    }
    this.seen.add(exchange.exchangeId);
    add(this.cumulative, exchange);
    if (exchange.attribution.turnId) {
      const turn = this.turns.get(exchange.attribution.turnId) ?? emptyUsage();
      add(turn, exchange);
      this.turns.set(exchange.attribution.turnId, turn);
    }
  }

  takeTurnSnapshot(turnId: string): ObservedUsageSnapshot {
    const turn = this.turns.get(turnId) ?? emptyUsage();
    this.turns.delete(turnId);
    return snapshot(turn, this.trackingPathActive);
  }

  cumulativeSnapshot(): ObservedUsageSnapshot {
    return snapshot(this.cumulative, this.trackingPathActive);
  }
}
