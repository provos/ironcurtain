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
    listExchanges: vi.fn().mockResolvedValue({ items: [], nextCursor: null, snapshotMaxSequence: 0 }),
    dimensions: vi.fn().mockResolvedValue([]),
    sessionTotals: vi.fn().mockResolvedValue({}),
  };
}

describe('statistics WebSocket dispatch', () => {
  it('reports disabled capabilities without requiring a repository', async () => {
    await expect(dispatch(context(), 'statistics.capabilities', {})).resolves.toMatchObject({
      available: false,
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

  it('rejects unbounded or structurally invalid input before the reader', async () => {
    await expect(
      dispatch(context(reader()), 'statistics.exchanges', { fromMs: 0, toMs: 1, limit: 501 }),
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
