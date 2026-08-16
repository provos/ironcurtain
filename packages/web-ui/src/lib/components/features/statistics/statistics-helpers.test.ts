import { describe, expect, it } from 'vitest';
import type { LlmStatisticsMeasure, StatisticsMetricSummaryDto, StatisticsTimeBucketDto } from '$lib/types.js';
import {
  allocateSeriesStyles,
  buildModelRail,
  buildTokenComposition,
  buildTrendData,
  buildTrendSignalTotals,
  calendarDayDomain,
  calendarRange,
  collapseHiddenTrendSignals,
  createStatisticsRequestLimiter,
  seriesStyle,
  statisticsIdentityDimensions,
} from './statistics-helpers.js';

function summary(
  measure: LlmStatisticsMeasure,
  value: number | null,
  overrides: Partial<StatisticsMetricSummaryDto> = {},
): StatisticsMetricSummaryDto {
  return {
    dimensions: {},
    measure,
    value,
    sampleCount: value === null ? 0 : 2,
    sampleSessionCount: value === null ? 0 : 1,
    eligibleCount: 2,
    coverage: value === null ? 0 : 1,
    median: value,
    lowerQuartile: value,
    upperQuartile: value,
    formulaVersion: 1,
    ...overrides,
  };
}

describe('statistics helpers', () => {
  it('assigns a stable visual style without relying on series order', () => {
    expect(seriesStyle('openai\0gpt-5')).toEqual(seriesStyle('openai\0gpt-5'));
    expect(seriesStyle('openai\0gpt-5')).not.toBe(seriesStyle('openai\0gpt-5'));
  });

  it('allocates deterministic collision-free styles for the bounded chart population', () => {
    const keys = Array.from({ length: 8 }, (_, index) => `provider-${index}\0model-${index}`);
    const forward = allocateSeriesStyles(keys);
    const reverse = allocateSeriesStyles([...keys].reverse());
    const tuples = keys.map((key) => `${forward.get(key)?.color}\0${forward.get(key)?.dash ?? ''}`);

    expect(new Set(tuples).size).toBe(keys.length);
    expect([...forward]).toEqual([...reverse]);
  });

  it('keeps thinking and non-thinking tokens inside output when populations align', () => {
    const composition = buildTokenComposition([
      summary('inputTokens', 120),
      summary('outputTokens', 100),
      summary('thinkingTokens', 30),
      summary('nonThinkingOutputTokens', 60),
      summary('totalTokens', 220),
    ]);

    expect(composition).toMatchObject({
      inputTokens: 120,
      outputTokens: 100,
      thinkingTokens: 30,
      nonThinkingOutputTokens: 60,
      unclassifiedOutputTokens: 10,
      outputBreakdownAvailable: true,
    });
  });

  it('does not manufacture an output decomposition from mismatched samples', () => {
    const composition = buildTokenComposition([
      summary('outputTokens', 100, { sampleCount: 8 }),
      summary('thinkingTokens', 30, { sampleCount: 2 }),
      summary('nonThinkingOutputTokens', 70, { sampleCount: 2 }),
    ]);

    expect(composition.outputBreakdownAvailable).toBe(false);
    expect(composition.thinkingTokens).toBeNull();
    expect(composition.unclassifiedOutputTokens).toBe(100);
  });

  it('does not show an output decomposition from only partially observed components', () => {
    const composition = buildTokenComposition([
      summary('outputTokens', 100, { sampleCount: 8, eligibleCount: 10, coverage: 0.8 }),
      summary('thinkingTokens', 30, { sampleCount: 8, eligibleCount: 10, coverage: 0.8 }),
      summary('nonThinkingOutputTokens', 70, { sampleCount: 8, eligibleCount: 10, coverage: 0.8 }),
    ]);

    expect(composition.outputBreakdownAvailable).toBe(false);
    expect(composition.thinkingTokens).toBeNull();
  });

  it('labels unavailable served identity honestly instead of falling back to routed identity', () => {
    const grouped = [
      summary('requestCount', 3, {
        dimensions: {
          logicalProvider: 'openrouter',
          forwardedModel: 'openai/gpt-5',
          servedProvider: null,
          servedModel: null,
        },
      }),
    ];

    expect(buildModelRail(grouped, 'served')[0]).toMatchObject({
      provider: 'Provider not exposed',
      model: 'Model not exposed',
    });
  });

  it('preserves 23-hour and 25-hour local calendar days across DST', () => {
    const spring = calendarRange(Date.UTC(2026, 2, 8, 18), 1, 'America/New_York');
    const autumn = calendarRange(Date.UTC(2026, 10, 1, 18), 1, 'America/New_York');

    expect(spring.toMs - spring.fromMs + 1).toBe(23 * 60 * 60 * 1_000);
    expect(autumn.toMs - autumn.fromMs + 1).toBe(25 * 60 * 60 * 1_000);
  });

  it('builds every requested local calendar bucket across DST', () => {
    const domain = calendarDayDomain(Date.UTC(2026, 2, 8, 18), 3, 'America/New_York');

    expect(domain.buckets).toHaveLength(3);
    expect(domain.buckets.map((bucket) => bucket.toMs - bucket.fromMs + 1)).toEqual([
      24 * 60 * 60 * 1_000,
      24 * 60 * 60 * 1_000,
      23 * 60 * 60 * 1_000,
    ]);
    expect(domain.range).toEqual({
      fromMs: domain.buckets[0]?.fromMs,
      toMs: domain.buckets[2]?.toMs,
    });
    expect(domain.todayFromMs).toBe(domain.buckets[2]?.fromMs);
  });

  it('converts half-open calendar buckets to inclusive drilldown ranges across DST', () => {
    const fromMs = Date.parse('2026-03-08T08:00:00.000Z');
    const nextMidnightMs = Date.parse('2026-03-09T07:00:00.000Z');
    const dimensions = { logicalProvider: 'openai', forwardedModel: 'gpt-5' };
    const bucket: StatisticsTimeBucketDto = {
      fromMs,
      toMs: nextMidnightMs,
      summaries: [
        summary('effectiveOutputTokensPerSecond', 20, {
          dimensions,
          median: 20,
          lowerQuartile: 18,
          upperQuartile: 22,
        }),
        summary('refusalCount', 1, { dimensions }),
        summary('errorCount', 0, { dimensions }),
      ],
    };

    const trend = buildTrendData([bucket], 'routed', 'America/Los_Angeles');
    const totals = buildTrendSignalTotals([bucket], 'America/Los_Angeles');
    expect(trend.points[0]?.toMs).toBe(nextMidnightMs - 1);
    expect(trend.signals[0]?.toMs).toBe(nextMidnightMs - 1);
    expect(totals[0]?.toMs).toBe(nextMidnightMs - 1);
    expect(trend.points[0]!.toMs - fromMs + 1).toBe(23 * 60 * 60 * 1_000);

    expect(buildTrendData([bucket], 'routed', 'America/Los_Angeles', 'hour').points[0]?.toMs).toBe(nextMidnightMs);
  });

  it('finds local midnight in fractional-offset time zones', () => {
    const kathmandu = calendarRange(Date.UTC(2026, 7, 15, 12), 1, 'Asia/Kathmandu');
    const kolkata = calendarRange(Date.UTC(2026, 7, 15, 12), 1, 'Asia/Kolkata');

    expect(kathmandu).toEqual({
      fromMs: Date.UTC(2026, 7, 14, 18, 15),
      toMs: Date.UTC(2026, 7, 15, 18, 15) - 1,
    });
    expect(kolkata).toEqual({
      fromMs: Date.UTC(2026, 7, 14, 18, 30),
      toMs: Date.UTC(2026, 7, 15, 18, 30) - 1,
    });
  });

  it('centralizes the provider/model dimension pair for each identity mode', () => {
    expect(statisticsIdentityDimensions('routed')).toEqual(['logicalProvider', 'forwardedModel']);
    expect(statisticsIdentityDimensions('served')).toEqual(['servedProvider', 'servedModel']);
  });

  it('creates trend points with routed and served model semantics', () => {
    const speed = summary('effectiveOutputTokensPerSecond', 20, {
      dimensions: {
        logicalProvider: 'openrouter',
        forwardedModel: 'anthropic/claude-sonnet',
        servedProvider: 'anthropic',
        servedModel: 'claude-sonnet-4',
      },
      median: 21,
      lowerQuartile: 18,
      upperQuartile: 25,
    });
    const bucket: StatisticsTimeBucketDto = { fromMs: 1_700_000_000_000, toMs: 1_700_086_399_999, summaries: [speed] };

    expect(buildTrendData([bucket], 'routed', 'UTC').points[0]?.seriesLabel).toBe(
      'openrouter · anthropic/claude-sonnet',
    );
    expect(buildTrendData([bucket], 'served', 'UTC').points[0]?.seriesLabel).toBe('anthropic · claude-sonnet-4');
  });

  it('retains refusal markers when a bucket has no eligible speed sample', () => {
    const bucket: StatisticsTimeBucketDto = {
      fromMs: 1_700_000_000_000,
      toMs: 1_700_086_399_999,
      summaries: [
        summary('refusalCount', 1, {
          dimensions: { logicalProvider: 'anthropic', forwardedModel: 'claude-sonnet' },
        }),
      ],
    };

    const trend = buildTrendData([bucket], 'routed', 'UTC');
    expect(trend.points).toEqual([]);
    expect(trend.signals[0]).toMatchObject({
      seriesLabel: 'anthropic · claude-sonnet',
      refusalCount: 1,
    });
  });

  it('builds authoritative ungrouped day-level refusal and error totals', () => {
    const bucket: StatisticsTimeBucketDto = {
      fromMs: 1_700_000_000_000,
      toMs: 1_700_086_399_999,
      summaries: [summary('refusalCount', 7), summary('errorCount', 3)],
    };

    expect(buildTrendSignalTotals([bucket], 'UTC')).toEqual([
      expect.objectContaining({ refusalCount: 7, errorCount: 3, fromMs: bucket.fromMs, toMs: bucket.toMs }),
    ]);
  });

  it('collapses signals outside the rendered top series without losing counts', () => {
    const first = {
      ...buildTrendData(
        [
          {
            fromMs: 1,
            toMs: 2,
            summaries: [
              summary('refusalCount', 2, { dimensions: { logicalProvider: 'one', forwardedModel: 'a' } }),
              summary('errorCount', 1, { dimensions: { logicalProvider: 'one', forwardedModel: 'a' } }),
            ],
          },
        ],
        'routed',
        'UTC',
      ).signals[0]!,
    };
    const second = { ...first, key: 'second', seriesKey: 'two', refusalCount: 3, errorCount: 4 };

    expect(collapseHiddenTrendSignals([first, second], new Set())).toEqual([
      expect.objectContaining({
        seriesLabel: 'Hidden returned chart groups',
        refusalCount: 5,
        errorCount: 5,
      }),
    ]);
  });

  it('limits in-flight statistics requests to two', async () => {
    const limiter = createStatisticsRequestLimiter(2);
    let active = 0;
    let maximum = 0;
    const tasks = Array.from({ length: 7 }, (_, index) =>
      limiter.run(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return index;
      }),
    );

    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(maximum).toBe(2);
    expect(limiter.active).toBe(0);
  });
});
