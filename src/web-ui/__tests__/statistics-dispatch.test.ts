import { describe, expect, it, vi } from 'vitest';

import { dispatch } from '../json-rpc-dispatch.js';
import type { WorkflowDispatchContext } from '../dispatch/workflow-dispatch.js';
import type { LlmStatisticsReader } from '../../llm-metrics/query-service.js';
import { LlmMetricsRepositoryUnavailableError } from '../../llm-metrics/persistence/repository.js';

function context(reader?: LlmStatisticsReader): WorkflowDispatchContext {
  return { statisticsReader: reader } as unknown as WorkflowDispatchContext;
}

function reader(): LlmStatisticsReader {
  return {
    capabilities: vi.fn().mockResolvedValue({ available: true }),
    summarize: vi.fn().mockResolvedValue([{ measure: 'totalTokens', value: 42 }]),
    timeSeries: vi.fn().mockResolvedValue([]),
    distribution: vi.fn().mockResolvedValue({
      measure: 'effectiveOutputTokensPerSecond',
      bins: [],
      sampleCount: 0,
      eligibleCount: 0,
      coverage: 0,
      minimum: null,
      maximum: null,
      formulaVersion: 1,
    }),
    listExchanges: vi.fn().mockResolvedValue({ items: [], nextCursor: null, snapshotMaxSequence: 0 }),
    dimensions: vi.fn().mockResolvedValue([]),
    sessionTotals: vi.fn().mockResolvedValue({}),
  };
}

describe('statistics WebSocket dispatch', () => {
  it('reports disabled capabilities without requiring a repository', async () => {
    await expect(dispatch(context(), 'statistics.capabilities', {})).resolves.toMatchObject({
      available: false,
      dtoVersion: 2,
      maxScannedRows: 100_000,
      allowedCalendarBucketUnits: ['day'],
      health: { state: 'disabled' },
    });
  });

  it('delegates bounded summary queries to the daemon-owned reader', async () => {
    const statisticsReader = reader();
    const summarize = vi.spyOn(statisticsReader, 'summarize');
    const query = { fromMs: 1, toMs: 2, measures: ['totalTokens'] as const };
    await expect(dispatch(context(statisticsReader), 'statistics.summary', query)).resolves.toEqual([
      { measure: 'totalTokens', value: 42 },
    ]);
    expect(summarize).toHaveBeenCalledWith(query);
  });

  it('accepts the effective client-observed output throughput measure', async () => {
    const statisticsReader = reader();
    const summarize = vi.spyOn(statisticsReader, 'summarize');
    const query = { fromMs: 1, toMs: 2, measures: ['effectiveOutputTokensPerSecond'] as const };
    await dispatch(context(statisticsReader), 'statistics.summary', query);
    expect(summarize).toHaveBeenCalledWith(query);
  });

  it('dispatches an allowed time-series bucket to the daemon-owned reader', async () => {
    const statisticsReader = reader();
    const timeSeries = vi
      .spyOn(statisticsReader, 'timeSeries')
      .mockResolvedValue([{ fromMs: 0, toMs: 60_000, summaries: [] }]);
    const query = { fromMs: 0, toMs: 60_000, measures: ['requestCount'] as const, bucketMs: 60_000 as const };

    await expect(dispatch(context(statisticsReader), 'statistics.series', query)).resolves.toEqual([
      { fromMs: 0, toMs: 60_000, summaries: [] },
    ]);
    expect(timeSeries).toHaveBeenCalledWith(query);
  });

  it('dispatches calendar-day series and bounded distributions', async () => {
    const statisticsReader = reader();
    const timeSeries = vi.spyOn(statisticsReader, 'timeSeries');
    const distribution = vi.spyOn(statisticsReader, 'distribution');
    const calendarQuery = {
      fromMs: 0,
      toMs: 60_000,
      measures: ['requestCount'] as const,
      calendarBucket: { unit: 'day' as const, timeZone: 'America/Los_Angeles' },
    };
    const distributionQuery = {
      fromMs: 0,
      toMs: 60_000,
      measure: 'effectiveOutputTokensPerSecond' as const,
      maxBins: 20,
    };

    await dispatch(context(statisticsReader), 'statistics.series', calendarQuery);
    await dispatch(context(statisticsReader), 'statistics.distribution', distributionQuery);
    expect(timeSeries).toHaveBeenCalledWith(calendarQuery);
    expect(distribution).toHaveBeenCalledWith(distributionQuery);
  });

  it('accepts boolean filters and provider labels returned by dimensions', async () => {
    const statisticsReader = reader();
    const summarize = vi.spyOn(statisticsReader, 'summarize');
    const query = {
      fromMs: 1,
      toMs: 2,
      measures: ['requestCount'] as const,
      filters: { streaming: [true], refusal: [false], servedProvider: ['Google AI Studio (Direct)'] },
    };

    await dispatch(context(statisticsReader), 'statistics.summary', query);
    expect(summarize).toHaveBeenCalledWith(query);
  });

  it('accepts service-tier and measurement-provenance dimensions and filters', async () => {
    const statisticsReader = reader();
    const summarize = vi.spyOn(statisticsReader, 'summarize');
    const query = {
      fromMs: 1,
      toMs: 2,
      measures: ['requestCount'] as const,
      groupBy: ['actualServiceTier', 'inputMeasurementProvenance', 'thinkingMeasurementProvenance'] as const,
      filters: {
        actualServiceTier: ['priority'],
        inputMeasurementProvenance: ['reported_exact'],
        outputMeasurementProvenance: ['reported_exact'],
        thinkingMeasurementProvenance: ['reported_exact'],
        nonThinkingMeasurementProvenance: ['derived_exact'],
      },
    };

    await dispatch(context(statisticsReader), 'statistics.summary', query);
    expect(summarize).toHaveBeenCalledWith(query);
  });

  it('accepts workflow state and persona dimensions and filters', async () => {
    const statisticsReader = reader();
    const summarize = vi.spyOn(statisticsReader, 'summarize');
    const query = {
      fromMs: 1,
      toMs: 2,
      measures: ['requestCount'] as const,
      groupBy: ['stateId', 'personaId'] as const,
      filters: { stateId: ['review'], personaId: ['security-reviewer'] },
    };

    await dispatch(context(statisticsReader), 'statistics.summary', query);
    expect(summarize).toHaveBeenCalledWith(query);
  });

  it('accepts bounded top-group selection only for grouped queries', async () => {
    const statisticsReader = reader();
    const summarize = vi.spyOn(statisticsReader, 'summarize');
    const timeSeries = vi.spyOn(statisticsReader, 'timeSeries');
    const query = {
      fromMs: 1,
      toMs: 2,
      measures: ['requestCount'] as const,
      groupBy: ['servedProvider', 'servedModel'] as const,
      topGroups: 8,
    };

    await dispatch(context(statisticsReader), 'statistics.summary', query);
    expect(summarize).toHaveBeenCalledWith(query);
    await dispatch(context(statisticsReader), 'statistics.series', { ...query, bucketMs: 60_000 });
    expect(timeSeries).toHaveBeenCalledWith({ ...query, bucketMs: 60_000 });
    await expect(
      dispatch(context(statisticsReader), 'statistics.summary', {
        fromMs: 1,
        toMs: 2,
        measures: ['requestCount'],
        topGroups: 8,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      dispatch(context(statisticsReader), 'statistics.summary', {
        ...query,
        topGroups: 21,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('rejects unbounded or structurally invalid input before the reader', async () => {
    await expect(
      dispatch(context(reader()), 'statistics.exchanges', { fromMs: 0, toMs: 1, limit: 501 }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      dispatch(context(reader()), 'statistics.summary', {
        fromMs: 0,
        toMs: 1,
        measures: ['requestCount'],
        filters: { protocol: Array.from({ length: 21 }, (_, index) => `protocol-${index}`) },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      dispatch(context(reader()), 'statistics.series', {
        fromMs: 0,
        toMs: 1,
        measures: ['requestCount'],
        bucketMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      dispatch(context(reader()), 'statistics.series', {
        fromMs: 0,
        toMs: 1,
        measures: ['requestCount'],
        bucketMs: 60_000,
        calendarBucket: { unit: 'day', timeZone: 'UTC' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      dispatch(context(reader()), 'statistics.series', {
        fromMs: 0,
        toMs: 1,
        measures: ['requestCount'],
        calendarBucket: { unit: 'day', timeZone: 'not/a-real-zone' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      dispatch(context(reader()), 'statistics.distribution', {
        fromMs: 0,
        toMs: 1,
        measure: 'requestCount',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      dispatch(context(reader()), 'statistics.summary', {
        fromMs: 0,
        toMs: 1,
        measures: ['requestCount'],
        typo: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('keeps data methods unavailable when statistics are disabled', async () => {
    await expect(
      dispatch(context(), 'statistics.dimensions', { fromMs: 0, toMs: 1, dimension: 'protocol' }),
    ).rejects.toMatchObject({ code: 'STATISTICS_UNAVAILABLE' });
  });

  it('reports repository failures as temporarily unavailable', async () => {
    const statisticsReader = reader();
    vi.spyOn(statisticsReader, 'summarize').mockRejectedValue(
      new LlmMetricsRepositoryUnavailableError('LLM metrics repository is closing'),
    );

    await expect(
      dispatch(context(statisticsReader), 'statistics.summary', {
        fromMs: 0,
        toMs: 1,
        measures: ['requestCount'],
      }),
    ).rejects.toMatchObject({ code: 'STATISTICS_UNAVAILABLE' });
  });
});
