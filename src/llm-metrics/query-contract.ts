/** Canonical statistics query vocabulary shared by transport, query, and persistence boundaries. */
export const STATISTICS_DIMENSIONS = [
  'agent',
  'logicalProvider',
  'gateway',
  'protocol',
  'providerProfile',
  'requestedModel',
  'forwardedModel',
  'responseModel',
  'servedModel',
  'servedProvider',
  'reasoningMode',
  'requestedServiceTier',
  'actualServiceTier',
  'inputMeasurementProvenance',
  'outputMeasurementProvenance',
  'thinkingMeasurementProvenance',
  'nonThinkingMeasurementProvenance',
  'speedMode',
  'streaming',
  'outcome',
  'refusal',
  'usageCompleteness',
  'attributionQuality',
  'sessionId',
  'workflowRunId',
  'stateId',
  'personaId',
  'bundleId',
] as const;

export type StatisticsDimension = (typeof STATISTICS_DIMENSIONS)[number];

export const STATISTICS_MEASURES = [
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
] as const;

export type StatisticsMeasure = (typeof STATISTICS_MEASURES)[number];

export const STATISTICS_DISTRIBUTION_MEASURES = [
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
] as const satisfies readonly StatisticsMeasure[];

export type StatisticsDistributionMeasure = (typeof STATISTICS_DISTRIBUTION_MEASURES)[number];

export const STATISTICS_BUCKET_SIZES_MS = [60_000, 300_000, 900_000, 3_600_000, 86_400_000] as const;
export const STATISTICS_CALENDAR_BUCKET_UNITS = ['day'] as const;

export const MAX_STATISTICS_FILTER_VALUES = 20;
export const MAX_STATISTICS_AGGREGATION_ROWS = 100_000;
export const MAX_STATISTICS_DISTRIBUTION_BINS = 40;
export const MAX_STATISTICS_TOP_GROUPS = 20;
export const STATISTICS_IDENTIFIER_MAX_LENGTH = 256;
export const STATISTICS_PROVIDER_IDENTIFIER_MAX_LENGTH = 128;
export const STATISTICS_TIME_ZONE_MAX_LENGTH = 128;

export const STATISTICS_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
export const STATISTICS_PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/@()+&-]*$/;
export const STATISTICS_TIME_ZONE_PATTERN = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;

export function isValidStatisticsTimeZone(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > STATISTICS_TIME_ZONE_MAX_LENGTH ||
    !STATISTICS_TIME_ZONE_PATTERN.test(value)
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
