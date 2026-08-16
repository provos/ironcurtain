import { describe, expect, it } from 'vitest';

import {
  createStatisticsFixtureEngine,
  STATISTICS_FIXTURE_MIXED_ROW_COUNT,
  STATISTICS_FIXTURE_NOW_MS,
} from '../../../scripts/statistics-fixtures.js';
import { STATISTICS_BUCKET_SIZES_MS } from '../../../../../src/llm-metrics/query-contract.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const RANGE = {
  fromMs: STATISTICS_FIXTURE_NOW_MS - 30 * DAY_MS,
  toMs: STATISTICS_FIXTURE_NOW_MS,
};
const TREND_RANGE = {
  fromMs: Date.UTC(2026, 6, 17, 7),
  toMs: Date.UTC(2026, 7, 16, 7) - 1,
};

describe('statistics fixture engine', () => {
  it('provides deterministic mixed identities, modes, and incomplete records', () => {
    const fixture = createStatisticsFixtureEngine('mixed');

    expect(fixture.rows).toHaveLength(STATISTICS_FIXTURE_MIXED_ROW_COUNT);
    expect(fixture.dimensions({ ...RANGE, dimension: 'servedProvider' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'Anthropic' }),
        expect.objectContaining({ value: 'Google AI Studio' }),
        expect.objectContaining({ value: 'OpenAI' }),
        expect.objectContaining({ value: null }),
      ]),
    );
    expect(fixture.dimensions({ ...RANGE, dimension: 'reasoningMode' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'enabled' }),
        expect.objectContaining({ value: 'disabled' }),
        expect.objectContaining({ value: 'unknown' }),
      ]),
    );
    expect(fixture.dimensions({ ...RANGE, dimension: 'usageCompleteness' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'complete' }),
        expect.objectContaining({ value: 'partial' }),
        expect.objectContaining({ value: 'missing' }),
        expect.objectContaining({ value: 'invalid' }),
      ]),
    );
  });

  it('groups, filters, and reports coverage like the production query service', () => {
    const fixture = createStatisticsFixtureEngine('mixed');
    const summaries = fixture.summary({
      ...RANGE,
      measures: ['requestCount', 'refusalRate', 'thinkingTokens', 'observableOutputTokensPerSecond'],
      groupBy: ['logicalProvider'],
    });

    const requests = summaries.filter((summary) => summary.measure === 'requestCount');
    expect(requests.reduce((total, summary) => total + (summary.value ?? 0), 0)).toBe(
      STATISTICS_FIXTURE_MIXED_ROW_COUNT,
    );
    expect(summaries.some((summary) => summary.measure === 'refusalRate' && summary.value !== null)).toBe(true);
    expect(
      summaries.some(
        (summary) =>
          summary.measure === 'thinkingTokens' && summary.sampleCount < summary.eligibleCount && summary.coverage < 1,
      ),
    ).toBe(true);
    expect(
      summaries.some(
        (summary) => summary.measure === 'observableOutputTokensPerSecond' && summary.sampleSessionCount > 0,
      ),
    ).toBe(true);

    const filtered = fixture.summary({
      ...RANGE,
      filters: { servedProvider: ['Google AI Studio'], reasoningMode: ['enabled'] },
      measures: ['requestCount'],
    });
    expect(filtered[0]?.value).toBeGreaterThan(0);
    expect(filtered[0]?.value).toBeLessThan(STATISTICS_FIXTURE_MIXED_ROW_COUNT);
    expect(fixture.summary({ ...RANGE, measures: ['requestCount'] })[0]).toMatchObject({
      value: STATISTICS_FIXTURE_MIXED_ROW_COUNT,
      sampleCount: STATISTICS_FIXTURE_MIXED_ROW_COUNT,
      eligibleCount: STATISTICS_FIXTURE_MIXED_ROW_COUNT,
    });
    expect(fixture.summary({ ...RANGE, filters: { servedProvider: [] }, measures: ['requestCount'] })[0]).toMatchObject(
      {
        value: STATISTICS_FIXTURE_MIXED_ROW_COUNT,
        sampleCount: STATISTICS_FIXTURE_MIXED_ROW_COUNT,
        eligibleCount: STATISTICS_FIXTURE_MIXED_ROW_COUNT,
      },
    );
  });

  it('retains top groups globally and leaves tail-group signals to an ungrouped series', () => {
    const fixture = createStatisticsFixtureEngine('mixed');
    const groupBy = ['logicalProvider', 'forwardedModel'] as const;
    const allGroups = fixture
      .summary({ ...RANGE, measures: ['requestCount'], groupBy })
      .filter((summary) => summary.measure === 'requestCount');
    const topGroups = fixture
      .summary({ ...RANGE, measures: ['requestCount'], groupBy, topGroups: 8 })
      .filter((summary) => summary.measure === 'requestCount');

    expect(allGroups).toHaveLength(9);
    expect(topGroups).toHaveLength(8);
    expect(topGroups).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimensions: { logicalProvider: 'openrouter', forwardedModel: null } }),
      ]),
    );

    const grouped = fixture.series({
      ...TREND_RANGE,
      calendarBucket: { unit: 'day', timeZone: 'America/Los_Angeles' },
      groupBy,
      topGroups: 8,
      measures: ['refusalCount'],
    });
    const ungrouped = fixture.series({
      ...TREND_RANGE,
      calendarBucket: { unit: 'day', timeZone: 'America/Los_Angeles' },
      measures: ['refusalCount'],
    });
    const tailSignalDay = Date.UTC(2026, 7, 14, 7);
    const groupedRefusals =
      grouped
        .find((bucket) => bucket.fromMs === tailSignalDay)
        ?.summaries.reduce((total, summary) => total + (summary.value ?? 0), 0) ?? 0;
    const ungroupedRefusals = ungrouped.find((bucket) => bucket.fromMs === tailSignalDay)?.summaries[0]?.value;

    expect(groupedRefusals).toBe(0);
    expect(ungroupedRefusals).toBe(1);
    expect(() => fixture.summary({ ...RANGE, measures: ['requestCount'], topGroups: 8 })).toThrow(
      'topGroups requires at least one grouping dimension',
    );
  });

  it('drives dense ribbons, real line segments, sparse gaps, and signal-only buckets', () => {
    const fixture = createStatisticsFixtureEngine('mixed');
    const buckets = fixture.series({
      ...TREND_RANGE,
      calendarBucket: { unit: 'day', timeZone: 'America/Los_Angeles' },
      groupBy: ['logicalProvider', 'forwardedModel'],
      measures: ['effectiveOutputTokensPerSecond', 'refusalCount', 'errorCount'],
    });
    const speedPoints = (logicalProvider: string, forwardedModel: string) =>
      buckets.flatMap((bucket) =>
        bucket.summaries
          .filter(
            (summary) =>
              summary.measure === 'effectiveOutputTokensPerSecond' &&
              summary.dimensions.logicalProvider === logicalProvider &&
              summary.dimensions.forwardedModel === forwardedModel &&
              summary.median !== null,
          )
          .map((summary) => ({ fromMs: bucket.fromMs, summary })),
      );

    const anthropic = speedPoints('anthropic', 'claude-sonnet-4-6');
    const google = speedPoints('openrouter', 'google/gemini-2.5-pro');
    for (const dense of [anthropic, google]) {
      expect(dense).toHaveLength(28);
      expect(dense.every(({ summary }) => summary.sampleCount >= 4)).toBe(true);
      expect(
        dense.every(
          ({ summary }) =>
            summary.lowerQuartile !== null &&
            summary.median !== null &&
            summary.upperQuartile !== null &&
            summary.lowerQuartile < summary.median &&
            summary.median < summary.upperQuartile,
        ),
      ).toBe(true);
      const medians = dense.map(({ summary }) => summary.median ?? 0);
      const deltas = medians.slice(1).map((median, index) => median - medians[index]!);
      expect(deltas.some((delta) => delta > 0)).toBe(true);
      expect(deltas.some((delta) => delta < 0)).toBe(true);
    }

    const sparse = speedPoints('openrouter', 'meta/llama-4-sparse');
    expect(sparse.map(({ fromMs }) => fromMs)).toEqual([
      Date.UTC(2026, 7, 9, 7),
      Date.UTC(2026, 7, 10, 7),
      Date.UTC(2026, 7, 14, 7),
      Date.UTC(2026, 7, 15, 7),
    ]);

    const refusalOnly = buckets
      .find((bucket) => bucket.fromMs === Date.UTC(2026, 7, 12, 7))
      ?.summaries.filter(
        (summary) =>
          summary.dimensions.logicalProvider === 'openrouter' &&
          summary.dimensions.forwardedModel === 'meta/llama-4-sparse',
      );
    expect(refusalOnly?.find((summary) => summary.measure === 'effectiveOutputTokensPerSecond')).toMatchObject({
      value: null,
      sampleCount: 0,
    });
    expect(refusalOnly?.find((summary) => summary.measure === 'refusalCount')).toMatchObject({ value: 1 });

    const errorOnly = buckets
      .find((bucket) => bucket.fromMs === Date.UTC(2026, 7, 15, 7))
      ?.summaries.filter(
        (summary) =>
          summary.dimensions.logicalProvider === 'openai' && summary.dimensions.forwardedModel === 'gpt-5.2-codex',
      );
    expect(errorOnly?.find((summary) => summary.measure === 'effectiveOutputTokensPerSecond')).toMatchObject({
      value: null,
      sampleCount: 0,
    });
    expect(errorOnly?.find((summary) => summary.measure === 'errorCount')).toMatchObject({ value: 1 });
    const signalDays = buckets
      .map((bucket) => ({
        fromMs: bucket.fromMs,
        refusalCount:
          bucket.summaries
            .filter((summary) => summary.measure === 'refusalCount')
            .reduce((total, summary) => total + (summary.value ?? 0), 0) ?? 0,
        errorCount:
          bucket.summaries
            .filter((summary) => summary.measure === 'errorCount')
            .reduce((total, summary) => total + (summary.value ?? 0), 0) ?? 0,
      }))
      .filter((bucket) => bucket.refusalCount > 0 || bucket.errorCount > 0);
    expect(signalDays).toEqual([
      { fromMs: Date.UTC(2026, 7, 12, 7), refusalCount: 1, errorCount: 0 },
      { fromMs: Date.UTC(2026, 7, 14, 7), refusalCount: 1, errorCount: 0 },
      { fromMs: Date.UTC(2026, 7, 15, 7), refusalCount: 0, errorCount: 1 },
    ]);
    expect(buckets.at(-1)?.fromMs).toBe(Date.UTC(2026, 7, 15, 7));
  });

  it('advertises exactly the production fixed-bucket contract', () => {
    const fixture = createStatisticsFixtureEngine('mixed');
    expect(fixture.capabilities().allowedBucketSizesMs).toEqual([...STATISTICS_BUCKET_SIZES_MS]);
    expect(() => fixture.series({ ...RANGE, bucketMs: 6 * 60 * 60 * 1_000, measures: ['outputTokens'] })).toThrow(
      'Unsupported statistics bucket size',
    );
  });

  it('supports fixed and America/Los_Angeles calendar-day series', () => {
    const fixture = createStatisticsFixtureEngine('mixed');
    const fixed = fixture.series({ ...RANGE, bucketMs: DAY_MS, measures: ['outputTokens'] });
    const calendar = fixture.series({
      ...RANGE,
      calendarBucket: { unit: 'day', timeZone: 'America/Los_Angeles' },
      measures: ['outputTokens'],
    });

    expect(fixed).toHaveLength(28);
    expect(calendar).toHaveLength(28);
    expect(new Date(calendar[0]!.fromMs).getUTCHours()).toBe(7);
    expect(calendar.every((bucket) => bucket.toMs > bucket.fromMs)).toBe(true);
  });

  it('paginates a stable snapshot and builds bounded distributions', () => {
    const fixture = createStatisticsFixtureEngine('mixed');
    const first = fixture.exchanges({ ...RANGE, limit: 7 });
    const second = fixture.exchanges({ ...RANGE, limit: 7, cursor: first.nextCursor ?? undefined });
    const distribution = fixture.distribution({ ...RANGE, measure: 'effectiveOutputTokensPerSecond', maxBins: 5 });

    expect(first.items).toHaveLength(7);
    expect(second.items).toHaveLength(7);
    expect(second.snapshotMaxSequence).toBe(first.snapshotMaxSequence);
    expect(new Set([...first.items, ...second.items].map((row) => row.exchangeId))).toHaveLength(14);
    expect(distribution.bins.length).toBeLessThanOrEqual(5);
    expect(distribution.bins.reduce((total, bin) => total + bin.count, 0)).toBe(distribution.sampleCount);
    expect(distribution.coverage).toBeLessThan(1);
  });

  it('models empty, disabled, degraded, and unavailable-reader states independently', () => {
    expect(createStatisticsFixtureEngine('empty').capabilities()).toMatchObject({
      available: true,
      health: { state: 'ready', readerState: 'ready' },
    });
    expect(createStatisticsFixtureEngine('disabled').capabilities()).toMatchObject({
      available: false,
      health: { state: 'disabled', readerState: 'closed' },
    });
    expect(createStatisticsFixtureEngine('degraded').capabilities()).toMatchObject({
      available: true,
      health: { state: 'degraded', dropped: 4 },
    });
    expect(createStatisticsFixtureEngine('reader-unavailable').capabilities()).toMatchObject({
      available: false,
      health: { state: 'ready', readerState: 'unavailable' },
    });
  });
});
