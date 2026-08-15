import { describe, expect, it, vi } from 'vitest';

import { LlmStatisticsQueryService, type LlmStatisticsMeasure } from '../src/llm-metrics/query-service.js';
import type {
  LlmDimensionCount,
  LlmExchangeScanQuery,
  LlmMetricsRepository,
  StoredLlmExchange,
} from '../src/llm-metrics/persistence/repository.js';

const BASE_TIME = Date.parse('2026-08-15T12:00:00.000Z');
const ALL_MEASURES: readonly LlmStatisticsMeasure[] = [
  'requestCount',
  'refusalCount',
  'refusalRate',
  'errorCount',
  'errorRate',
  'inputTokens',
  'uncachedInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'toolUseInputTokens',
  'thinkingTokens',
  'nonThinkingOutputTokens',
  'outputTokens',
  'totalTokens',
  'costUsd',
  'ttftMs',
  'upstreamLatencyMs',
  'clientLatencyMs',
  'observableOutputTokensPerSecond',
  'effectiveOutputTokensPerSecond',
];

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
    scan: vi.fn().mockImplementation((query: LlmExchangeScanQuery) => Promise.resolve(rows.slice(0, query.limit))),
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
});
