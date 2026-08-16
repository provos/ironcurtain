import { describe, expect, it } from 'vitest';

import type {
  LlmExchangeFilters,
  LlmStatisticsDimension,
  StatisticsExchangeDto,
  StatisticsDimensionValueDto,
  StatisticsDistributionQuery,
  StatisticsMetricDistributionDto,
  StatisticsSeriesQuery,
} from '../packages/web-ui/src/lib/types.js';

describe('statistics frontend DTO types', () => {
  it('mirror service-tier and measurement-provenance query fields', () => {
    const dimensions: readonly LlmStatisticsDimension[] = [
      'actualServiceTier',
      'inputMeasurementProvenance',
      'outputMeasurementProvenance',
      'thinkingMeasurementProvenance',
      'nonThinkingMeasurementProvenance',
      'stateId',
      'personaId',
    ];
    const filters: LlmExchangeFilters = {
      actualServiceTier: ['priority'],
      inputMeasurementProvenance: ['reported_exact'],
      outputMeasurementProvenance: ['reported_exact'],
      thinkingMeasurementProvenance: ['reported_exact'],
      nonThinkingMeasurementProvenance: ['derived_exact'],
      stateId: ['review'],
      personaId: ['security-reviewer'],
    };

    expect(dimensions).toHaveLength(7);
    expect(filters.actualServiceTier).toEqual(['priority']);
    expect(filters.stateId).toEqual(['review']);
  });

  it('mirrors correlation IDs and all measurement provenance on exchange DTOs', () => {
    const fields: Pick<
      StatisticsExchangeDto,
      | 'providerRequestId'
      | 'providerResponseId'
      | 'gatewayGenerationId'
      | 'servedModelSource'
      | 'servedProviderSource'
      | 'firstUpstreamBodyByteOffsetMs'
      | 'inputMeasurementProvenance'
      | 'outputMeasurementProvenance'
      | 'thinkingMeasurementProvenance'
      | 'nonThinkingMeasurementProvenance'
    > = {
      providerRequestId: 'request-1',
      providerResponseId: 'response-1',
      gatewayGenerationId: 'generation-1',
      servedModelSource: 'router_metadata',
      servedProviderSource: 'router_metadata',
      firstUpstreamBodyByteOffsetMs: 12.5,
      inputMeasurementProvenance: 'reported_exact',
      outputMeasurementProvenance: 'reported_exact',
      thinkingMeasurementProvenance: 'reported_exact',
      nonThinkingMeasurementProvenance: 'derived_exact',
    };

    expect(fields).toMatchObject({ gatewayGenerationId: 'generation-1', firstUpstreamBodyByteOffsetMs: 12.5 });
  });

  it('preserves boolean dimension values without string coercion', () => {
    const values: readonly StatisticsDimensionValueDto[] = [
      { value: true, count: 3 },
      { value: false, count: 2 },
      { value: null, count: 1 },
    ];
    expect(values.map((entry) => entry.value)).toEqual([true, false, null]);
  });

  it('mirrors calendar-series and distribution contracts', () => {
    const series: StatisticsSeriesQuery = {
      fromMs: 0,
      toMs: 1,
      measures: ['requestCount'],
      calendarBucket: { unit: 'day', timeZone: 'America/Los_Angeles' },
    };
    const query: StatisticsDistributionQuery = {
      fromMs: 0,
      toMs: 1,
      measure: 'effectiveOutputTokensPerSecond',
      maxBins: 20,
    };
    const result: StatisticsMetricDistributionDto = {
      measure: query.measure,
      bins: [{ lower: 0, upper: 1, count: 1 }],
      sampleCount: 1,
      eligibleCount: 2,
      coverage: 0.5,
      minimum: 0.5,
      maximum: 0.5,
      formulaVersion: 1,
    };

    expect(series.calendarBucket.timeZone).toBe('America/Los_Angeles');
    expect(result.bins).toHaveLength(1);
  });

  it('requires exactly one time-series bucket form at compile time', () => {
    // @ts-expect-error Statistics series require a fixed or calendar bucket.
    const missing: StatisticsSeriesQuery = { fromMs: 0, toMs: 1, measures: ['requestCount'] };
    // @ts-expect-error Statistics series cannot use both bucket forms.
    const duplicate: StatisticsSeriesQuery = {
      fromMs: 0,
      toMs: 1,
      measures: ['requestCount'],
      bucketMs: 60_000,
      calendarBucket: { unit: 'day', timeZone: 'UTC' },
    };

    expect([missing, duplicate]).toHaveLength(2);
  });
});
