import { describe, expect, it } from 'vitest';

import type {
  LlmExchangeFilters,
  LlmStatisticsDimension,
  StatisticsExchangeDto,
} from '../packages/web-ui/src/lib/types.js';

describe('statistics frontend DTO types', () => {
  it('mirror service-tier and measurement-provenance query fields', () => {
    const dimensions: readonly LlmStatisticsDimension[] = [
      'actualServiceTier',
      'inputMeasurementProvenance',
      'outputMeasurementProvenance',
      'thinkingMeasurementProvenance',
      'nonThinkingMeasurementProvenance',
    ];
    const filters: LlmExchangeFilters = {
      actualServiceTier: ['priority'],
      inputMeasurementProvenance: ['reported_exact'],
      outputMeasurementProvenance: ['reported_exact'],
      thinkingMeasurementProvenance: ['reported_exact'],
      nonThinkingMeasurementProvenance: ['derived_exact'],
    };

    expect(dimensions).toHaveLength(5);
    expect(filters.actualServiceTier).toEqual(['priority']);
  });

  it('mirrors correlation IDs and all measurement provenance on exchange DTOs', () => {
    const fields: Pick<
      StatisticsExchangeDto,
      | 'providerRequestId'
      | 'providerResponseId'
      | 'gatewayGenerationId'
      | 'firstUpstreamBodyByteOffsetMs'
      | 'inputMeasurementProvenance'
      | 'outputMeasurementProvenance'
      | 'thinkingMeasurementProvenance'
      | 'nonThinkingMeasurementProvenance'
    > = {
      providerRequestId: 'request-1',
      providerResponseId: 'response-1',
      gatewayGenerationId: 'generation-1',
      firstUpstreamBodyByteOffsetMs: 12.5,
      inputMeasurementProvenance: 'reported_exact',
      outputMeasurementProvenance: 'reported_exact',
      thinkingMeasurementProvenance: 'reported_exact',
      nonThinkingMeasurementProvenance: 'derived_exact',
    };

    expect(fields).toMatchObject({ gatewayGenerationId: 'generation-1', firstUpstreamBodyByteOffsetMs: 12.5 });
  });
});
