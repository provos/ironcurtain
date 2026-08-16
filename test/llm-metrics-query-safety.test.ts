import { describe, expect, it, vi } from 'vitest';

import { LlmStatisticsQueryService } from '../src/llm-metrics/query-service.js';
import { STATISTICS_MEASURES } from '../src/llm-metrics/query-contract.js';
import type {
  LlmDimensionCount,
  LlmExchangeScanQuery,
  LlmMetricsRepository,
  StoredLlmExchange,
} from '../src/llm-metrics/persistence/repository.js';

const BASE_TIME = Date.parse('2026-08-15T12:00:00.000Z');
const ALL_MEASURES = STATISTICS_MEASURES;

function row(index: number, overrides: Partial<StoredLlmExchange> = {}): StoredLlmExchange {
  return {
    exchangeId: `exchange-${index}`,
    completedAtMs: BASE_TIME + index,
    servedModel: 'model-1',
    sessionId: 'session-1',
    providerProfile: 'profile-1',
    refusal: false,
    outcome: 'stop',
    inputTokens: 10,
    uncachedInputTokens: 8,
    cacheReadInputTokens: 2,
    cacheWriteInputTokens: 0,
    toolUseInputTokens: 0,
    thinkingTokens: 2,
    nonThinkingOutputTokens: 3,
    outputTokens: 5,
    totalTokens: 15,
    costUsd: 0.001,
    firstReasoningOffsetMs: 10,
    firstOutputOffsetMs: 20,
    lastOutputOffsetMs: 40,
    upstreamResponseEndOffsetMs: 50,
    clientDeliveryEndOffsetMs: 60,
    clientAborted: false,
    qualityFlags: ['output_timing_population_exact'],
    ...overrides,
  } as StoredLlmExchange;
}

function repository(
  rows: readonly StoredLlmExchange[],
  dimensionValues: readonly LlmDimensionCount[] = [],
): LlmMetricsRepository {
  return {
    enqueue: vi.fn().mockReturnValue(true),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockReturnValue({ state: 'ready', schemaVersion: 1 }),
    snapshotMaxSequence: vi.fn().mockResolvedValue(rows.length),
    scan: vi.fn().mockImplementation((query: LlmExchangeScanQuery) => {
      const start =
        query.cursor === undefined
          ? 0
          : Math.max(
              0,
              rows.findIndex(
                (candidate) =>
                  candidate.completedAtMs === query.cursor?.completedAtMs &&
                  candidate.exchangeId === query.cursor.exchangeId,
              ) + 1,
            );
      return Promise.resolve(rows.slice(start, start + query.limit));
    }),
    dimensionValues: vi.fn().mockResolvedValue(dimensionValues),
    deleteBefore: vi.fn().mockResolvedValue({
      status: 'complete',
      cutoffMs: 0,
      snapshotMaxSequence: null,
      deletedCount: 0,
      chunksProcessed: 0,
    }),
  };
}

describe('LLM statistics query output safety', () => {
  it('paginates a stable snapshot beyond the former 10,000-row aggregation limit', async () => {
    const rows = Array.from({ length: 10_001 }, (_, index) => row(index));
    const backing = repository(rows);
    const service = new LlmStatisticsQueryService(backing);
    await expect(
      service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 20_000,
        measures: ['requestCount'],
      }),
    ).resolves.toMatchObject([{ measure: 'requestCount', value: 10_001 }]);
    expect(backing.scan).toHaveBeenCalledTimes(11);
    expect(vi.mocked(backing.scan).mock.calls.every(([query]) => query.snapshotMaxSequence === rows.length)).toBe(true);
  });

  it('rejects a pathological 100,000-row by 20-measure query before measure sorting', async () => {
    const rows = Array.from(
      { length: 100_000 },
      (_, index) => ({ exchangeId: `minimal-${index}`, completedAtMs: BASE_TIME + index }) as StoredLlmExchange,
    );
    const service = new LlmStatisticsQueryService(repository(rows));

    await expect(
      service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + rows.length,
        measures: ALL_MEASURES,
      }),
    ).rejects.toThrow('Statistics query exceeds the aggregation-work limit');
  });

  it('yields to the event loop between expensive aggregation operations', async () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => row(index));
    const service = new LlmStatisticsQueryService(repository(rows));
    let heartbeats = 0;
    const heartbeat = setInterval(() => heartbeats++, 0);
    try {
      await service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + rows.length,
        measures: ALL_MEASURES,
      });
    } finally {
      clearInterval(heartbeat);
    }
    expect(heartbeats).toBeGreaterThan(0);
  });

  it('yields while assigning a large calendar series to local-day buckets', async () => {
    const rows = Array.from({ length: 30_000 }, (_, index) => row(index));
    const service = new LlmStatisticsQueryService(repository(rows));
    const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
    let formatCalls = 0;
    const formatSpy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (
      this: Intl.DateTimeFormat,
      value?: number | Date,
    ) {
      formatCalls += 1;
      return originalFormatToParts.call(this, value);
    });
    let active = true;
    let observedIntermediateProgress = false;
    const pulse = (): void => {
      setImmediate(() => {
        if (formatCalls > 0 && formatCalls < rows.length) observedIntermediateProgress = true;
        if (active) pulse();
      });
    };
    pulse();

    try {
      const result = await service.timeSeries({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + rows.length,
        measures: ['requestCount'],
        calendarBucket: { unit: 'day', timeZone: 'America/Los_Angeles' },
      });
      expect(result).toMatchObject([{ summaries: [{ measure: 'requestCount', value: rows.length }] }]);
    } finally {
      active = false;
      formatSpy.mockRestore();
    }
    expect(observedIntermediateProgress).toBe(true);
  });

  it('yields while ranking top groups over a large snapshot', async () => {
    let aggregationStarted = false;
    let dimensionReads = 0;
    const rows = Array.from({ length: 30_000 }, (_, index) => {
      const item = row(index);
      Object.defineProperty(item, 'servedModel', {
        configurable: true,
        enumerable: true,
        get() {
          if (aggregationStarted) dimensionReads += 1;
          return `model-${index % 10}`;
        },
      });
      return item;
    });
    const backing = repository(rows);
    vi.mocked(backing.scan).mockImplementation((query: LlmExchangeScanQuery) => {
      const start =
        query.cursor === undefined
          ? 0
          : Math.max(
              0,
              rows.findIndex(
                (candidate) =>
                  candidate.completedAtMs === query.cursor?.completedAtMs &&
                  candidate.exchangeId === query.cursor.exchangeId,
              ) + 1,
            );
      const page = rows.slice(start, start + query.limit);
      if (page.length === 0) aggregationStarted = true;
      return Promise.resolve(page);
    });
    const service = new LlmStatisticsQueryService(backing);
    let active = true;
    let observedIntermediateProgress = false;
    const pulse = (): void => {
      setImmediate(() => {
        if (dimensionReads > 0 && dimensionReads < rows.length) observedIntermediateProgress = true;
        if (active) pulse();
      });
    };
    pulse();

    try {
      const result = await service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + rows.length,
        measures: ['requestCount'],
        groupBy: ['servedModel'],
        topGroups: 8,
      });
      expect(result).toHaveLength(8);
      expect(result.every((summary) => summary.value === 3_000)).toBe(true);
      expect(result.map((summary) => summary.dimensions.servedModel)).toEqual(
        Array.from({ length: 8 }, (_, index) => `model-${index}`),
      );
    } finally {
      active = false;
    }
    expect(observedIntermediateProgress).toBe(true);
  });

  it('ranks top groups over the stable snapshot and retains a ranked null-identity group', async () => {
    const rows = [
      row(0, { completedAtMs: BASE_TIME, servedModel: null }),
      row(1, { completedAtMs: BASE_TIME + 1, servedModel: null }),
      row(2, { completedAtMs: BASE_TIME + 2, servedModel: 'model-a' }),
      row(3, { completedAtMs: BASE_TIME + 3, servedModel: 'model-b' }),
      row(4, { completedAtMs: BASE_TIME + 4, servedModel: 'model-b' }),
      row(5, { completedAtMs: BASE_TIME + 5, servedModel: 'model-b' }),
      row(6, { completedAtMs: BASE_TIME + 60_000, servedModel: null }),
      row(7, { completedAtMs: BASE_TIME + 60_001, servedModel: null }),
      row(8, { completedAtMs: BASE_TIME + 60_002, servedModel: 'model-a' }),
      row(9, { completedAtMs: BASE_TIME + 60_003, servedModel: 'model-a' }),
      row(10, { completedAtMs: BASE_TIME + 60_004, servedModel: 'model-a' }),
      row(11, { completedAtMs: BASE_TIME + 60_005, servedModel: 'model-a' }),
    ];
    const service = new LlmStatisticsQueryService(repository(rows));

    const summary = await service.summarize({
      fromMs: BASE_TIME,
      toMs: BASE_TIME + 120_000,
      measures: ['requestCount'],
      groupBy: ['servedModel'],
      topGroups: 2,
    });
    expect(summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimensions: { servedModel: 'model-a' }, value: 5 }),
        expect.objectContaining({ dimensions: { servedModel: null }, value: 4 }),
      ]),
    );
    expect(summary).toHaveLength(2);

    const series = await service.timeSeries({
      fromMs: BASE_TIME,
      toMs: BASE_TIME + 120_000,
      measures: ['requestCount'],
      groupBy: ['servedModel'],
      topGroups: 1,
      bucketMs: 60_000,
    });
    expect(series).toHaveLength(2);
    expect(series.flatMap((bucket) => bucket.summaries)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimensions: { servedModel: 'model-a' }, value: 1 }),
        expect.objectContaining({ dimensions: { servedModel: 'model-a' }, value: 4 }),
      ]),
    );
  });

  it('retains authoritative daily signals outside the grouped top-provider cutoff', async () => {
    const dayFromMs = Date.parse('2026-08-15T00:00:00.000Z');
    const dayToMs = Date.parse('2026-08-15T23:59:59.999Z');
    const rows = Array.from({ length: 9 }, (_, index) => {
      const rank = index + 1;
      const outsideTopGroups = rank === 9;
      return row(index, {
        completedAtMs: dayFromMs + rank,
        logicalProvider: `provider-${String(rank).padStart(2, '0')}`,
        forwardedModel: `model-${String(rank).padStart(2, '0')}`,
        refusal: outsideTopGroups,
        outcome: outsideTopGroups ? 'error' : 'stop',
      });
    });
    const service = new LlmStatisticsQueryService(repository(rows));

    const grouped = await service.timeSeries({
      fromMs: dayFromMs,
      toMs: dayToMs,
      measures: ['refusalCount', 'errorCount'],
      groupBy: ['logicalProvider', 'forwardedModel'],
      topGroups: 8,
      calendarBucket: { unit: 'day', timeZone: 'UTC' },
    });
    const groupedSummaries = grouped.flatMap((bucket) => bucket.summaries);
    expect(groupedSummaries).toHaveLength(16);
    expect(groupedSummaries.some((summary) => summary.dimensions.logicalProvider === 'provider-09')).toBe(false);
    expect(groupedSummaries.filter((summary) => summary.measure === 'refusalCount')).toSatisfy(
      (summaries: typeof groupedSummaries) => summaries.every((summary) => summary.value === 0),
    );
    expect(groupedSummaries.filter((summary) => summary.measure === 'errorCount')).toSatisfy(
      (summaries: typeof groupedSummaries) => summaries.every((summary) => summary.value === 0),
    );

    const authoritative = await service.timeSeries({
      fromMs: dayFromMs,
      toMs: dayToMs,
      measures: ['refusalCount', 'errorCount'],
      calendarBucket: { unit: 'day', timeZone: 'UTC' },
    });
    expect(authoritative).toHaveLength(1);
    expect(authoritative[0]?.summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimensions: {}, measure: 'refusalCount', value: 1 }),
        expect.objectContaining({ dimensions: {}, measure: 'errorCount', value: 1 }),
      ]),
    );
  });

  it('rejects a list page whose valid bounded rows exceed the byte budget', async () => {
    const longFlag = `flag-${'x'.repeat(251)}`;
    const rows = Array.from({ length: 300 }, (_, index) =>
      row(index, { qualityFlags: Array.from({ length: 64 }, () => longFlag) }),
    );
    const service = new LlmStatisticsQueryService(repository(rows));

    await expect(service.listExchanges({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 500 })).rejects.toThrow(
      'Statistics response exceeds the output-byte limit',
    );
  });

  it('rejects grouped summaries with high-cardinality maximum-length identifiers', async () => {
    const longSession = `session-${'s'.repeat(248)}`;
    const longProfile = `profile-${'p'.repeat(248)}`;
    const rows = Array.from({ length: 500 }, (_, index) => {
      const prefix = `model-${index}-`;
      return row(index, {
        servedModel: prefix + 'm'.repeat(256 - prefix.length),
        sessionId: longSession,
        providerProfile: longProfile,
      });
    });
    const service = new LlmStatisticsQueryService(repository(rows));

    await expect(
      service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 1_000,
        measures: ALL_MEASURES,
        groupBy: ['servedModel', 'sessionId', 'providerProfile'],
      }),
    ).rejects.toThrow('Statistics response exceeds the output-byte limit');
  });

  it('caps buckets multiplied by measures across an entire time series', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => row(index, { completedAtMs: BASE_TIME + index * 60_000 }));
    const service = new LlmStatisticsQueryService(repository(rows));

    await expect(
      service.timeSeries({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 500 * 60_000,
        bucketMs: 60_000,
        measures: ALL_MEASURES,
      }),
    ).rejects.toThrow('Statistics response exceeds the output-cardinality limit');
  });

  it('enforces the byte budget on dimension results', async () => {
    const values = Array.from({ length: 500 }, (_, index) => ({
      value: `dimension-${index}-${'x'.repeat(10_000)}`,
      count: 1,
    }));
    const service = new LlmStatisticsQueryService(repository([], values));

    await expect(
      service.dimensions({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, dimension: 'servedModel', limit: 500 }),
    ).rejects.toThrow('Statistics response exceeds the output-byte limit');
  });

  it('preserves normal list, summary, series, and dimension queries', async () => {
    const rows = [row(0), row(1, { completedAtMs: BASE_TIME + 60_000 })];
    const service = new LlmStatisticsQueryService(
      repository(rows, [
        { value: 'model-1', count: 2 },
        { value: null, count: 1 },
      ]),
    );

    await expect(
      service.listExchanges({ fromMs: BASE_TIME, toMs: BASE_TIME + 120_000, limit: 2 }),
    ).resolves.toMatchObject({ items: rows, nextCursor: null });
    await expect(
      service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 120_000,
        measures: ['requestCount', 'totalTokens'],
      }),
    ).resolves.toHaveLength(2);
    await expect(
      service.timeSeries({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 120_000,
        bucketMs: 60_000,
        measures: ['requestCount'],
      }),
    ).resolves.toHaveLength(2);
    await expect(
      service.dimensions({ fromMs: BASE_TIME, toMs: BASE_TIME + 120_000, dimension: 'servedModel' }),
    ).resolves.toHaveLength(2);
  });

  it('returns sample-session counts and a bounded coverage-aware distribution', async () => {
    const rows = [
      row(0, { sessionId: 'session-1', outputTokens: 20, clientDeliveryEndOffsetMs: 200 }),
      row(1, { sessionId: 'session-1', outputTokens: 40, clientDeliveryEndOffsetMs: 200 }),
      row(2, { sessionId: 'session-2', outputTokens: 30, clientDeliveryEndOffsetMs: 100 }),
      row(3, { sessionId: null, outputTokens: null, clientDeliveryEndOffsetMs: 100 }),
    ];
    const service = new LlmStatisticsQueryService(repository(rows));

    await expect(
      service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 1_000,
        measures: ['requestCount', 'effectiveOutputTokensPerSecond'],
      }),
    ).resolves.toMatchObject([
      { measure: 'requestCount', sampleCount: 4, sampleSessionCount: 2 },
      { measure: 'effectiveOutputTokensPerSecond', sampleCount: 3, sampleSessionCount: 2 },
    ]);

    const distribution = await service.distribution({
      fromMs: BASE_TIME,
      toMs: BASE_TIME + 1_000,
      measure: 'effectiveOutputTokensPerSecond',
      maxBins: 4,
    });
    expect(distribution).toMatchObject({
      measure: 'effectiveOutputTokensPerSecond',
      sampleCount: 3,
      eligibleCount: 4,
      coverage: 0.75,
      minimum: 100,
      maximum: 300,
    });
    expect(distribution.bins.length).toBeLessThanOrEqual(4);
    expect(distribution.bins.reduce((total, bin) => total + bin.count, 0)).toBe(3);
  });

  it('uses true IANA calendar-day boundaries across daylight-saving fallback', async () => {
    const rows = [
      row(0, { completedAtMs: Date.parse('2026-11-01T08:00:00.000Z') }),
      row(1, { completedAtMs: Date.parse('2026-11-02T09:00:00.000Z') }),
    ];
    const service = new LlmStatisticsQueryService(repository(rows));
    const buckets = await service.timeSeries({
      fromMs: Date.parse('2026-11-01T07:00:00.000Z'),
      toMs: Date.parse('2026-11-03T07:59:59.999Z'),
      measures: ['requestCount'],
      calendarBucket: { unit: 'day', timeZone: 'America/Los_Angeles' },
    });

    expect(buckets.map(({ fromMs, toMs }) => [fromMs, toMs])).toEqual([
      [Date.parse('2026-11-01T07:00:00.000Z'), Date.parse('2026-11-02T08:00:00.000Z')],
      [Date.parse('2026-11-02T08:00:00.000Z'), Date.parse('2026-11-03T08:00:00.000Z')],
    ]);
    expect(buckets[0].toMs - buckets[0].fromMs).toBe(25 * 60 * 60 * 1_000);
  });

  it('uses a 23-hour IANA calendar day across daylight-saving spring-forward', async () => {
    const service = new LlmStatisticsQueryService(
      repository([row(0, { completedAtMs: Date.parse('2026-03-08T12:00:00.000Z') })]),
    );
    const buckets = await service.timeSeries({
      fromMs: Date.parse('2026-03-08T08:00:00.000Z'),
      toMs: Date.parse('2026-03-09T06:59:59.999Z'),
      measures: ['requestCount'],
      calendarBucket: { unit: 'day', timeZone: 'America/Los_Angeles' },
    });

    expect(buckets).toMatchObject([
      {
        fromMs: Date.parse('2026-03-08T08:00:00.000Z'),
        toMs: Date.parse('2026-03-09T07:00:00.000Z'),
      },
    ]);
    expect(buckets[0].toMs - buckets[0].fromMs).toBe(23 * 60 * 60 * 1_000);
  });
});
