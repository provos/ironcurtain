import type {
  LlmExchangeFilters,
  LlmStatisticsDistributionMeasure,
  LlmStatisticsDimension,
  LlmStatisticsMeasure,
  StatisticsCapabilitiesDto,
  StatisticsDimensionQuery,
  StatisticsDimensionValueDto,
  StatisticsDistributionQuery,
  StatisticsExchangeDto,
  StatisticsExchangePageDto,
  StatisticsExchangeQuery,
  StatisticsMetricDistributionDto,
  StatisticsMetricSummaryDto,
  StatisticsSeriesQuery,
  StatisticsSummaryQuery,
  StatisticsTimeBucketDto,
} from '../src/lib/types.js';

export const STATISTICS_FIXTURE_NOW_MS = Date.UTC(2026, 7, 15, 12, 0, 0);

export type StatisticsFixtureScenario = 'mixed' | 'empty' | 'disabled' | 'degraded' | 'reader-unavailable';

type DimensionValue = string | boolean | null;
type ScalarMeasure = LlmStatisticsDistributionMeasure;

export type FixtureSeriesQuery = StatisticsSeriesQuery;
export type FixtureMetricSummaryDto = StatisticsMetricSummaryDto;
export type FixtureTimeBucketDto = StatisticsTimeBucketDto;
export type FixtureCapabilitiesDto = StatisticsCapabilitiesDto;
export type FixtureExchangeDto = StatisticsExchangeDto;

const HOUR_MS = 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const FORMULA_VERSION = 1;
const ALLOWED_BUCKET_SIZES_MS = [60_000, 300_000, 900_000, HOUR_MS, DAY_MS] as const;

function exchange(index: number, completedAtMs: number, overrides: Partial<FixtureExchangeDto>): FixtureExchangeDto {
  const requestReceivedAtMs = completedAtMs - 2_800;
  return {
    exchangeId: `fixture-exchange-${String(index + 1).padStart(3, '0')}`,
    schemaVersion: 1,
    completedAtMs,
    requestReceivedAtMs,
    sessionId: `fixture-session-${(index % 8) + 1}`,
    turnId: `fixture-turn-${index + 1}`,
    agentConversationId: `fixture-conversation-${(index % 4) + 1}`,
    bundleId: index % 3 === 0 ? `fixture-bundle-${(index % 2) + 1}` : null,
    workflowRunId: index % 4 === 0 ? `fixture-workflow-${(index % 3) + 1}` : null,
    stateId: index % 4 === 0 ? ['plan', 'implement', 'review'][index % 3] : null,
    personaId: index % 4 === 0 ? ['architect', 'coder', 'reviewer'][index % 3] : null,
    attributionQuality: index % 4 === 0 ? 'exact' : 'session_only',
    agent: index % 2 === 0 ? 'claude-code' : 'codex',
    logicalProvider: 'anthropic',
    providerProfile: 'anthropic-main',
    protocol: 'anthropic-messages',
    gateway: 'direct',
    clientRouteId: null,
    upstreamRouteId: null,
    requestedModel: 'claude-sonnet-4-6',
    forwardedModel: 'claude-sonnet-4-6',
    responseModel: 'claude-sonnet-4-6',
    servedModel: 'claude-sonnet-4-6',
    servedModelSource: 'protocol_response_direct',
    servedProvider: 'Anthropic',
    servedProviderSource: 'configured_route',
    providerRequestId: `req_fixture_${index + 1}`,
    providerResponseId: `msg_fixture_${index + 1}`,
    gatewayGenerationId: null,
    streaming: true,
    requestedServiceTier: 'auto',
    actualServiceTier: 'standard',
    reasoningMode: 'enabled',
    reasoningEffort: 'high',
    thinkingBudgetTokens: 2_048,
    speedMode: 'standard',
    responseStatus: 200,
    outcome: 'stop',
    providerStopReason: 'end_turn',
    refusal: false,
    refusalCategory: null,
    inputTokens: 1_100 + index * 17,
    uncachedInputTokens: 900 + index * 13,
    cacheReadInputTokens: 200 + index * 4,
    cacheWriteInputTokens: 0,
    toolUseInputTokens: null,
    outputTokens: 420 + index * 7,
    thinkingTokens: 140 + index * 3,
    nonThinkingOutputTokens: 280 + index * 4,
    providerTotalTokens: 1_520 + index * 24,
    totalTokens: 1_520 + index * 24,
    costUsd: 0.006 + index * 0.00011,
    usageCompleteness: 'complete',
    usageSemanticsVersion: 1,
    inputMeasurementProvenance: 'reported_exact',
    outputMeasurementProvenance: 'reported_exact',
    thinkingMeasurementProvenance: 'reported_exact',
    nonThinkingMeasurementProvenance: 'derived_exact',
    requestBodyCompleteOffsetMs: 20,
    responseHeadersOffsetMs: 310,
    firstUpstreamBodyByteOffsetMs: 410,
    firstProtocolEventOffsetMs: 430,
    firstReasoningOffsetMs: 460,
    lastReasoningOffsetMs: 1_100,
    firstOutputOffsetMs: 1_140,
    lastOutputOffsetMs: 2_500,
    protocolTerminalOffsetMs: 2_650,
    upstreamResponseEndOffsetMs: 2_700,
    clientDeliveryEndOffsetMs: 2_780,
    clientAborted: false,
    qualityFlags: ['output_timing_population_exact'],
    ...overrides,
  };
}

const ARCHETYPES: readonly Partial<FixtureExchangeDto>[] = [
  {},
  {
    logicalProvider: 'openrouter',
    providerProfile: 'openrouter-main',
    protocol: 'openai-chat',
    gateway: 'openrouter',
    requestedModel: 'google/gemini-2.5-pro',
    forwardedModel: 'google/gemini-2.5-pro',
    responseModel: 'google/gemini-2.5-pro',
    servedModel: 'gemini-2.5-pro-001',
    servedModelSource: 'protocol_response',
    servedProvider: 'Google AI Studio',
    servedProviderSource: 'router_metadata',
    gatewayGenerationId: 'or-generation-fixture',
    requestedServiceTier: null,
    actualServiceTier: 'priority',
    reasoningEffort: null,
    thinkingBudgetTokens: null,
    inputTokens: 2_300,
    uncachedInputTokens: 2_050,
    cacheReadInputTokens: 250,
    outputTokens: 760,
    thinkingTokens: 310,
    nonThinkingOutputTokens: 450,
    providerTotalTokens: 3_060,
    totalTokens: 3_060,
    costUsd: 0.0112,
  },
  {
    logicalProvider: 'openai',
    providerProfile: 'openai-codex',
    protocol: 'openai-responses',
    requestedModel: 'gpt-5.2-codex',
    forwardedModel: 'gpt-5.2-codex',
    responseModel: 'gpt-5.2-codex-2026-07-01',
    servedModel: 'gpt-5.2-codex-2026-07-01',
    servedProvider: 'OpenAI',
    reasoningMode: 'enabled',
    reasoningEffort: 'medium',
    thinkingBudgetTokens: null,
    requestedServiceTier: 'flex',
    actualServiceTier: 'flex',
    inputTokens: 1_720,
    uncachedInputTokens: 1_720,
    cacheReadInputTokens: 0,
    outputTokens: 620,
    thinkingTokens: 220,
    nonThinkingOutputTokens: 400,
    providerTotalTokens: 2_340,
    totalTokens: 2_340,
    costUsd: 0.0084,
  },
  {
    agent: 'gemini-cli',
    logicalProvider: 'google',
    providerProfile: 'google-fast',
    protocol: 'google-generate-content',
    requestedModel: 'gemini-2.5-flash',
    forwardedModel: 'gemini-2.5-flash',
    responseModel: 'gemini-2.5-flash-001',
    servedModel: 'gemini-2.5-flash-001',
    servedProvider: 'Google AI Studio',
    reasoningMode: 'unknown',
    reasoningEffort: null,
    thinkingBudgetTokens: null,
    requestedServiceTier: null,
    actualServiceTier: null,
    inputTokens: 940,
    uncachedInputTokens: null,
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: 330,
    thinkingTokens: 0,
    nonThinkingOutputTokens: 330,
    providerTotalTokens: 1_270,
    totalTokens: 1_270,
    costUsd: null,
    usageCompleteness: 'partial',
    inputMeasurementProvenance: 'reported_exact',
    outputMeasurementProvenance: 'reported_exact',
    thinkingMeasurementProvenance: 'derived_exact',
    nonThinkingMeasurementProvenance: 'derived_exact',
  },
  {
    logicalProvider: 'acme-inference',
    providerProfile: 'acme-compatible',
    protocol: 'openai-chat',
    gateway: 'custom',
    requestedModel: 'acme-reasoner-v2',
    forwardedModel: 'acme-reasoner-v2-prod',
    responseModel: 'acme-reasoner-v2-prod',
    servedModel: 'acme-reasoner-v2-prod',
    servedProvider: 'Acme Inference',
    servedProviderSource: 'configured_route',
    reasoningMode: 'disabled',
    reasoningEffort: null,
    thinkingBudgetTokens: null,
    speedMode: 'fast',
    inputTokens: 600,
    uncachedInputTokens: 600,
    cacheReadInputTokens: 0,
    outputTokens: 190,
    thinkingTokens: 0,
    nonThinkingOutputTokens: 190,
    providerTotalTokens: null,
    totalTokens: 790,
    costUsd: 0.0017,
    usageCompleteness: 'partial',
    thinkingMeasurementProvenance: 'derived_exact',
  },
  {
    logicalProvider: 'openrouter',
    providerProfile: 'openrouter-fallback',
    protocol: 'openai-chat',
    gateway: 'openrouter',
    requestedModel: 'mistralai/mistral-large',
    forwardedModel: 'mistralai/mistral-large',
    responseModel: null,
    servedModel: null,
    servedModelSource: 'not_exposed',
    servedProvider: null,
    servedProviderSource: 'not_exposed',
    gatewayGenerationId: 'or-generation-identity-missing',
    reasoningMode: 'disabled',
    reasoningEffort: null,
    thinkingBudgetTokens: null,
    inputTokens: 1_280,
    uncachedInputTokens: null,
    cacheReadInputTokens: null,
    outputTokens: 510,
    thinkingTokens: 0,
    nonThinkingOutputTokens: 510,
    providerTotalTokens: null,
    totalTokens: 1_790,
    costUsd: null,
    usageCompleteness: 'partial',
    inputMeasurementProvenance: 'reported_exact',
    outputMeasurementProvenance: 'reported_exact',
    thinkingMeasurementProvenance: 'derived_exact',
    nonThinkingMeasurementProvenance: 'derived_exact',
  },
  {
    logicalProvider: 'anthropic',
    requestedModel: 'claude-haiku-4-5',
    forwardedModel: 'claude-haiku-4-5',
    responseModel: 'claude-haiku-4-5',
    servedModel: 'claude-haiku-4-5',
    reasoningMode: 'disabled',
    reasoningEffort: null,
    thinkingBudgetTokens: null,
    outcome: 'content_filter',
    providerStopReason: 'refusal',
    refusal: true,
    refusalCategory: 'safety',
    inputTokens: 480,
    uncachedInputTokens: 480,
    cacheReadInputTokens: 0,
    outputTokens: 18,
    thinkingTokens: 0,
    nonThinkingOutputTokens: 18,
    providerTotalTokens: 498,
    totalTokens: 498,
    costUsd: 0.0005,
    firstReasoningOffsetMs: null,
    lastReasoningOffsetMs: null,
    firstOutputOffsetMs: 620,
    lastOutputOffsetMs: 760,
  },
  {
    logicalProvider: 'openai',
    providerProfile: 'openai-codex',
    protocol: 'openai-responses',
    requestedModel: 'gpt-5.2-codex',
    forwardedModel: 'gpt-5.2-codex',
    responseModel: null,
    servedModel: null,
    servedModelSource: 'not_exposed',
    servedProvider: null,
    servedProviderSource: 'not_exposed',
    responseStatus: 429,
    outcome: 'error',
    providerStopReason: 'rate_limit',
    refusal: null,
    inputTokens: null,
    uncachedInputTokens: null,
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    nonThinkingOutputTokens: null,
    providerTotalTokens: null,
    totalTokens: null,
    costUsd: null,
    usageCompleteness: 'missing',
    inputMeasurementProvenance: 'unknown',
    outputMeasurementProvenance: 'unknown',
    thinkingMeasurementProvenance: 'unknown',
    nonThinkingMeasurementProvenance: 'unknown',
    firstReasoningOffsetMs: null,
    lastReasoningOffsetMs: null,
    firstOutputOffsetMs: null,
    lastOutputOffsetMs: null,
    protocolTerminalOffsetMs: null,
    clientDeliveryEndOffsetMs: 620,
    qualityFlags: [],
  },
  {
    agent: null,
    logicalProvider: 'openrouter',
    providerProfile: null,
    protocol: 'openai-chat',
    gateway: 'openrouter',
    requestedModel: null,
    forwardedModel: null,
    responseModel: null,
    servedModel: null,
    servedModelSource: 'not_exposed',
    servedProvider: null,
    servedProviderSource: 'not_exposed',
    sessionId: null,
    turnId: null,
    agentConversationId: null,
    bundleId: null,
    workflowRunId: null,
    stateId: null,
    personaId: null,
    attributionQuality: 'missing',
    reasoningMode: 'unknown',
    reasoningEffort: null,
    thinkingBudgetTokens: null,
    responseStatus: null,
    outcome: 'aborted',
    providerStopReason: 'client_abort',
    refusal: null,
    inputTokens: null,
    uncachedInputTokens: null,
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    nonThinkingOutputTokens: null,
    providerTotalTokens: null,
    totalTokens: null,
    costUsd: null,
    usageCompleteness: 'invalid',
    inputMeasurementProvenance: 'unknown',
    outputMeasurementProvenance: 'unknown',
    thinkingMeasurementProvenance: 'unknown',
    nonThinkingMeasurementProvenance: 'unknown',
    firstReasoningOffsetMs: null,
    lastReasoningOffsetMs: null,
    firstOutputOffsetMs: null,
    lastOutputOffsetMs: null,
    protocolTerminalOffsetMs: null,
    upstreamResponseEndOffsetMs: null,
    clientDeliveryEndOffsetMs: 540,
    clientAborted: true,
    qualityFlags: [],
  },
];

function buildMixedRows(): readonly FixtureExchangeDto[] {
  const rows: FixtureExchangeDto[] = [];
  let index = 0;
  for (let day = 0; day < 14; day++) {
    for (let slot = 0; slot < 4; slot++) {
      const archetypeIndex = (day * 4 + slot) % ARCHETYPES.length;
      const archetype = ARCHETYPES[archetypeIndex] ?? {};
      // The ninth routed identity has the same request count as the other tail
      // groups, but sorts after them. Give it the only refusal on this day so a
      // top-eight grouped series cannot stand in for the ungrouped signal query.
      const tailRefusal = day === 2 && slot === 0;
      const completedAtMs = tailRefusal
        ? STATISTICS_FIXTURE_NOW_MS - DAY_MS - HOUR_MS
        : STATISTICS_FIXTURE_NOW_MS - day * DAY_MS - (slot * 3 + 1) * HOUR_MS;
      rows.push(
        exchange(index, completedAtMs, {
          ...archetype,
          ...(archetypeIndex === 6
            ? {
                outcome: 'stop' as const,
                providerStopReason: 'end_turn',
                refusal: false,
                refusalCategory: null,
              }
            : archetypeIndex === 7
              ? {
                  outcome: 'stop' as const,
                  providerStopReason: 'end_turn',
                  refusal: false,
                  responseStatus: 200,
                }
              : {}),
          ...(tailRefusal
            ? {
                clientAborted: false,
                outcome: 'content_filter' as const,
                providerStopReason: 'refusal',
                refusal: true,
                refusalCategory: 'safety',
                responseStatus: 200,
              }
            : {}),
          costUsd:
            typeof archetype.costUsd === 'number'
              ? archetype.costUsd * (1 + ((day + slot) % 4) * 0.08)
              : archetype.costUsd,
        }),
      );
      index++;
    }
  }

  const addSpeedSeries = (
    archetype: Partial<FixtureExchangeDto>,
    dayOffsets: readonly number[],
    outputBase: number,
    outputStep: number,
    deliveryOffsetsMs: readonly number[],
  ): void => {
    const dailyVariation = [0, 3, -1, 2, -2, 4, 1] as const;
    for (const dayOffset of dayOffsets) {
      for (let slot = 0; slot < deliveryOffsetsMs.length; slot++) {
        const deliveryOffsetMs = deliveryOffsetsMs[slot]!;
        const completedAtMs = STATISTICS_FIXTURE_NOW_MS - dayOffset * DAY_MS - (15 + slot * 30) * MINUTE_MS;
        const variation = dailyVariation[dayOffset % dailyVariation.length] ?? 0;
        const outputTokens = outputBase + variation * outputStep + slot * 8;
        const inputTokens = archetype.inputTokens ?? 1_100;
        const thinkingTokens = archetype.reasoningMode === 'disabled' ? 0 : Math.floor(outputTokens * 0.35);
        const nonThinkingOutputTokens = outputTokens - thinkingTokens;
        const totalTokens = inputTokens + outputTokens;
        const hasReportedProviderTotal = archetype.providerTotalTokens !== null;
        const reasoningDisabled = archetype.reasoningMode === 'disabled';
        rows.push(
          exchange(index, completedAtMs, {
            ...archetype,
            requestReceivedAtMs: completedAtMs - deliveryOffsetMs,
            inputTokens,
            uncachedInputTokens: archetype.uncachedInputTokens === undefined ? 900 : archetype.uncachedInputTokens,
            cacheReadInputTokens: archetype.cacheReadInputTokens === undefined ? 200 : archetype.cacheReadInputTokens,
            cacheWriteInputTokens: archetype.cacheWriteInputTokens === undefined ? 0 : archetype.cacheWriteInputTokens,
            outputTokens,
            thinkingTokens,
            nonThinkingOutputTokens,
            providerTotalTokens: hasReportedProviderTotal ? totalTokens : null,
            totalTokens,
            firstReasoningOffsetMs: reasoningDisabled ? null : 520,
            lastReasoningOffsetMs: reasoningDisabled ? null : 780,
            firstOutputOffsetMs: 900,
            lastOutputOffsetMs: deliveryOffsetMs - 300,
            protocolTerminalOffsetMs: deliveryOffsetMs - 180,
            upstreamResponseEndOffsetMs: deliveryOffsetMs - 90,
            clientDeliveryEndOffsetMs: deliveryOffsetMs,
          }),
        );
        index++;
      }
    }
  };

  const consecutiveDays = Array.from({ length: 28 }, (_, day) => day);
  addSpeedSeries({}, consecutiveDays, 430, 18, [12_000, 9_600, 7_600, 6_000]);
  addSpeedSeries(ARCHETYPES[1] ?? {}, consecutiveDays, 690, 24, [13_000, 10_200, 8_100, 6_500]);

  const sparseMissingIdentity: Partial<FixtureExchangeDto> = {
    ...(ARCHETYPES[5] ?? {}),
    requestedModel: 'meta/llama-4-sparse',
    forwardedModel: 'meta/llama-4-sparse',
    responseModel: null,
    servedModel: null,
    servedModelSource: 'not_exposed',
    servedProvider: null,
    servedProviderSource: 'not_exposed',
    gatewayGenerationId: 'or-generation-sparse-identity-missing',
  };
  addSpeedSeries(sparseMissingIdentity, [0, 1, 5, 6], 510, 12, [11_000, 8_800, 7_200, 5_900]);

  const refusalAtMs = STATISTICS_FIXTURE_NOW_MS - 3 * DAY_MS - 10 * MINUTE_MS;
  rows.push(
    exchange(index, refusalAtMs, {
      ...sparseMissingIdentity,
      requestReceivedAtMs: refusalAtMs - 1_100,
      responseStatus: 200,
      outcome: 'content_filter',
      providerStopReason: 'refusal',
      refusal: true,
      refusalCategory: 'safety',
      outputTokens: null,
      thinkingTokens: null,
      nonThinkingOutputTokens: null,
      providerTotalTokens: null,
      totalTokens: null,
      usageCompleteness: 'partial',
      outputMeasurementProvenance: 'unknown',
      thinkingMeasurementProvenance: 'unknown',
      nonThinkingMeasurementProvenance: 'unknown',
      firstReasoningOffsetMs: null,
      lastReasoningOffsetMs: null,
      firstOutputOffsetMs: null,
      lastOutputOffsetMs: null,
      protocolTerminalOffsetMs: 980,
      upstreamResponseEndOffsetMs: 1_020,
      clientDeliveryEndOffsetMs: 1_100,
      qualityFlags: [],
    }),
  );
  index++;

  const errorAtMs = STATISTICS_FIXTURE_NOW_MS - 20 * MINUTE_MS;
  rows.push(
    exchange(index, errorAtMs, {
      ...(ARCHETYPES[7] ?? {}),
      requestReceivedAtMs: errorAtMs - 620,
    }),
  );

  return rows.sort(
    (left, right) => right.completedAtMs - left.completedAtMs || right.exchangeId.localeCompare(left.exchangeId),
  );
}

const MIXED_ROWS = buildMixedRows();
export const STATISTICS_FIXTURE_MIXED_ROW_COUNT = MIXED_ROWS.length;

const DIMENSION_VALUE: Readonly<Record<LlmStatisticsDimension, (row: FixtureExchangeDto) => DimensionValue>> = {
  agent: (row) => row.agent,
  logicalProvider: (row) => row.logicalProvider,
  gateway: (row) => row.gateway,
  protocol: (row) => row.protocol,
  providerProfile: (row) => row.providerProfile,
  requestedModel: (row) => row.requestedModel,
  forwardedModel: (row) => row.forwardedModel,
  responseModel: (row) => row.responseModel,
  servedModel: (row) => row.servedModel,
  servedProvider: (row) => row.servedProvider,
  reasoningMode: (row) => row.reasoningMode,
  requestedServiceTier: (row) => row.requestedServiceTier,
  actualServiceTier: (row) => row.actualServiceTier,
  inputMeasurementProvenance: (row) => row.inputMeasurementProvenance,
  outputMeasurementProvenance: (row) => row.outputMeasurementProvenance,
  thinkingMeasurementProvenance: (row) => row.thinkingMeasurementProvenance,
  nonThinkingMeasurementProvenance: (row) => row.nonThinkingMeasurementProvenance,
  speedMode: (row) => row.speedMode,
  streaming: (row) => row.streaming,
  outcome: (row) => row.outcome,
  refusal: (row) => row.refusal,
  usageCompleteness: (row) => row.usageCompleteness,
  attributionQuality: (row) => row.attributionQuality,
  sessionId: (row) => row.sessionId,
  workflowRunId: (row) => row.workflowRunId,
  stateId: (row) => row.stateId,
  personaId: (row) => row.personaId,
  bundleId: (row) => row.bundleId,
};

function inRange(row: FixtureExchangeDto, fromMs: number, toMs: number): boolean {
  return row.completedAtMs >= fromMs && row.completedAtMs <= toMs;
}

function matchesFilters(row: FixtureExchangeDto, filters: LlmExchangeFilters | undefined): boolean {
  if (filters === undefined) return true;
  for (const [name, accepted] of Object.entries(filters) as [LlmStatisticsDimension, readonly (string | boolean)[]][]) {
    if (accepted.length === 0) continue;
    if (!accepted.includes(DIMENSION_VALUE[name](row) as string & boolean)) return false;
  }
  return true;
}

function filteredRows(
  rows: readonly FixtureExchangeDto[],
  query: { readonly fromMs: number; readonly toMs: number; readonly filters?: LlmExchangeFilters },
): readonly FixtureExchangeDto[] {
  return rows.filter((row) => inRange(row, query.fromMs, query.toMs) && matchesFilters(row, query.filters));
}

function firstVisibleOffset(row: FixtureExchangeDto): number | null {
  const values = [row.firstReasoningOffsetMs, row.firstOutputOffsetMs].filter(
    (value): value is number => value !== null,
  );
  return values.length === 0 ? null : Math.min(...values);
}

function scalarMeasure(row: FixtureExchangeDto, measure: ScalarMeasure): number | null {
  switch (measure) {
    case 'inputTokens':
      return row.inputTokens;
    case 'uncachedInputTokens':
      return row.uncachedInputTokens;
    case 'cacheReadInputTokens':
      return row.cacheReadInputTokens;
    case 'cacheWriteInputTokens':
      return row.cacheWriteInputTokens;
    case 'toolUseInputTokens':
      return row.toolUseInputTokens;
    case 'thinkingTokens':
      return row.thinkingTokens;
    case 'nonThinkingOutputTokens':
      return row.nonThinkingOutputTokens;
    case 'outputTokens':
      return row.outputTokens;
    case 'totalTokens':
      return row.totalTokens;
    case 'costUsd':
      return row.costUsd;
    case 'ttftMs':
      return firstVisibleOffset(row);
    case 'upstreamLatencyMs':
      return row.upstreamResponseEndOffsetMs;
    case 'clientLatencyMs':
      return row.clientDeliveryEndOffsetMs;
    case 'observableOutputTokensPerSecond': {
      if (!row.qualityFlags.includes('output_timing_population_exact')) return null;
      if (row.firstOutputOffsetMs === null || row.lastOutputOffsetMs === null || row.nonThinkingOutputTokens === null) {
        return null;
      }
      const spanMs = row.lastOutputOffsetMs - row.firstOutputOffsetMs;
      return spanMs > 0 ? row.nonThinkingOutputTokens / (spanMs / 1_000) : null;
    }
    case 'effectiveOutputTokensPerSecond':
      return row.clientAborted ||
        row.outcome === 'error' ||
        row.outcome === 'aborted' ||
        row.outcome === 'unknown' ||
        row.clientDeliveryEndOffsetMs === null ||
        row.clientDeliveryEndOffsetMs <= 0 ||
        row.outputTokens === null
        ? null
        : row.outputTokens / (row.clientDeliveryEndOffsetMs / 1_000);
  }
}

function quantile(sorted: readonly number[], position: number): number | null {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const low = sorted[lower];
  const high = sorted[upper];
  if (low === undefined || high === undefined) return null;
  return low + (high - low) * (index - lower);
}

function distinctSessions(rows: readonly FixtureExchangeDto[]): number {
  return new Set(rows.map((row) => row.sessionId).filter((value): value is string => value !== null)).size;
}

function summarizeMeasure(
  rows: readonly FixtureExchangeDto[],
  dimensions: Readonly<Record<string, DimensionValue>>,
  measure: LlmStatisticsMeasure,
): FixtureMetricSummaryDto {
  let values: number[] = [];
  let sampleRows: readonly FixtureExchangeDto[] = rows;
  let value: number | null;
  let sampleCount: number;

  if (measure === 'requestCount') {
    value = rows.length;
    sampleCount = rows.length;
  } else if (measure === 'refusalCount' || measure === 'refusalRate') {
    sampleRows = rows.filter((row) => row.refusal !== null);
    const refused = sampleRows.filter((row) => row.refusal).length;
    sampleCount = sampleRows.length;
    value = measure === 'refusalCount' ? refused : sampleCount === 0 ? null : refused / sampleCount;
  } else if (measure === 'errorCount' || measure === 'errorRate') {
    const errors = rows.filter((row) => row.outcome === 'error').length;
    sampleCount = rows.length;
    value = measure === 'errorCount' ? errors : rows.length === 0 ? null : errors / rows.length;
  } else {
    const samples = rows
      .map((row) => ({ row, value: scalarMeasure(row, measure) }))
      .filter((sample): sample is { row: FixtureExchangeDto; value: number } => sample.value !== null);
    values = samples.map((sample) => sample.value);
    sampleRows = samples.map((sample) => sample.row);
    sampleCount = values.length;
    const averaged =
      measure === 'ttftMs' ||
      measure === 'upstreamLatencyMs' ||
      measure === 'clientLatencyMs' ||
      measure === 'observableOutputTokensPerSecond' ||
      measure === 'effectiveOutputTokensPerSecond';
    value = sampleCount === 0 ? null : values.reduce((total, entry) => total + entry, 0) / (averaged ? sampleCount : 1);
  }

  const sorted = [...values].sort((left, right) => left - right);
  return {
    dimensions,
    measure,
    value,
    sampleCount,
    eligibleCount: rows.length,
    coverage: rows.length === 0 ? 0 : sampleCount / rows.length,
    sampleSessionCount: distinctSessions(sampleRows),
    median: quantile(sorted, 0.5),
    lowerQuartile: quantile(sorted, 0.25),
    upperQuartile: quantile(sorted, 0.75),
    formulaVersion: FORMULA_VERSION,
  };
}

function summarizeRows(
  rows: readonly FixtureExchangeDto[],
  measures: readonly LlmStatisticsMeasure[],
  groupBy: readonly LlmStatisticsDimension[] = [],
): readonly FixtureMetricSummaryDto[] {
  if (groupBy.length === 0) return measures.map((measure) => summarizeMeasure(rows, {}, measure));
  const groups = new Map<string, { dimensions: Record<string, DimensionValue>; rows: FixtureExchangeDto[] }>();
  for (const row of rows) {
    const dimensions = Object.fromEntries(groupBy.map((dimension) => [dimension, DIMENSION_VALUE[dimension](row)]));
    const key = JSON.stringify(groupBy.map((dimension) => dimensions[dimension]));
    const group = groups.get(key) ?? { dimensions, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) =>
    measures.map((measure) => summarizeMeasure(group.rows, group.dimensions, measure)),
  );
}

function groupKey(row: FixtureExchangeDto, groupBy: readonly LlmStatisticsDimension[]): string {
  return JSON.stringify(groupBy.map((dimension) => DIMENSION_VALUE[dimension](row)));
}

function retainTopGroupRows(
  rows: readonly FixtureExchangeDto[],
  groupBy: readonly LlmStatisticsDimension[],
  topGroups: number | undefined,
): readonly FixtureExchangeDto[] {
  if (topGroups === undefined) return rows;
  if (groupBy.length === 0) throw new Error('topGroups requires at least one grouping dimension');

  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = groupKey(row, groupBy);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const retained = new Set(
    [...counts]
      .sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || leftKey.localeCompare(rightKey))
      .slice(0, topGroups)
      .map(([key]) => key),
  );
  return rows.filter((row) => retained.has(groupKey(row, groupBy)));
}

function localDateParts(timestampMs: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(timestampMs);
  const get = (name: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === name)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function timeZoneOffsetMs(timestampMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(timestampMs);
  const get = (name: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === name)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(timestampMs / 1_000) * 1_000;
}

function zonedMidnightMs(year: number, month: number, day: number, timeZone: string): number {
  const utcGuess = Date.UTC(year, month - 1, day);
  let result = utcGuess - timeZoneOffsetMs(utcGuess, timeZone);
  result = utcGuess - timeZoneOffsetMs(result, timeZone);
  return result;
}

function calendarDayRange(
  timestampMs: number,
  calendar: NonNullable<StatisticsSeriesQuery['calendarBucket']>,
): { fromMs: number; toMs: number } {
  const current = localDateParts(timestampMs, calendar.timeZone);
  const nextDate = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  const fromMs = zonedMidnightMs(current.year, current.month, current.day, calendar.timeZone);
  const nextMs = zonedMidnightMs(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(),
    calendar.timeZone,
  );
  return { fromMs, toMs: nextMs };
}

function compareDimensionValues(left: DimensionValue, right: DimensionValue): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return String(left).localeCompare(String(right));
}

interface CursorPayload {
  readonly offset: number;
  readonly snapshotMaxSequence: number;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): CursorPayload | null {
  if (cursor === undefined) return null;
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
  if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || !Number.isSafeInteger(parsed.snapshotMaxSequence)) {
    throw new Error('Invalid statistics fixture cursor');
  }
  return parsed;
}

function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const ceiling = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return ceiling * magnitude;
}

function distributionBins(
  sorted: readonly number[],
  maxBins: number,
): readonly { lower: number; upper: number; count: number }[] {
  if (sorted.length === 0) return [];
  const minimum = sorted[0]!;
  const maximum = sorted[sorted.length - 1]!;
  if (minimum === maximum) {
    const width = niceCeiling(Math.max(Math.abs(minimum) * 0.1, 1));
    return [{ lower: minimum, upper: minimum + width, count: sorted.length }];
  }

  const interquartileRange = (quantile(sorted, 0.75) ?? maximum) - (quantile(sorted, 0.25) ?? minimum);
  const rawWidth = interquartileRange > 0 ? (2 * interquartileRange) / Math.cbrt(sorted.length) : 0;
  const desiredBins = Math.max(
    1,
    Math.min(maxBins, rawWidth > 0 ? Math.ceil((maximum - minimum) / rawWidth) : Math.ceil(Math.sqrt(sorted.length))),
  );
  let width = niceCeiling((maximum - minimum) / desiredBins);
  let lower = Math.floor(minimum / width) * width;
  let binCount = Math.max(1, Math.ceil((maximum - lower) / width));
  while (binCount > maxBins) {
    width = niceCeiling(width * 1.01);
    lower = Math.floor(minimum / width) * width;
    binCount = Math.max(1, Math.ceil((maximum - lower) / width));
  }
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lower: lower + index * width,
    upper: lower + (index + 1) * width,
    count: 0,
  }));
  for (const value of sorted) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor((value - lower) / width)));
    const bin = bins[index]!;
    bins[index] = { ...bin, count: bin.count + 1 };
  }
  return bins;
}

function healthForScenario(scenario: StatisticsFixtureScenario, rowCount: number): FixtureCapabilitiesDto['health'] {
  return {
    state: scenario === 'disabled' ? 'disabled' : scenario === 'degraded' ? 'degraded' : 'ready',
    schemaVersion: scenario === 'disabled' ? null : 1,
    observed: rowCount + (scenario === 'degraded' ? 4 : 0),
    finalized: rowCount + (scenario === 'degraded' ? 4 : 0),
    enqueued: rowCount,
    persisted: rowCount,
    duplicates: 0,
    dropped: scenario === 'degraded' ? 4 : 0,
    queuedRecords: scenario === 'degraded' ? 2 : 0,
    queuedBytes: scenario === 'degraded' ? 8_192 : 0,
    lastError: scenario === 'degraded' ? 'Recent statistics records were dropped; forwarding was unaffected' : null,
    readerState: scenario === 'disabled' ? 'closed' : scenario === 'reader-unavailable' ? 'unavailable' : 'ready',
    readerLastError: scenario === 'reader-unavailable' ? 'Statistics reader could not open the local database' : null,
  };
}

export class StatisticsFixtureEngine {
  readonly rows: readonly FixtureExchangeDto[];

  constructor(readonly scenario: StatisticsFixtureScenario = 'mixed') {
    this.rows = scenario === 'mixed' || scenario === 'degraded' ? MIXED_ROWS : [];
  }

  capabilities(): FixtureCapabilitiesDto {
    const health = healthForScenario(this.scenario, this.rows.length);
    return {
      available:
        (health.state === 'ready' || health.state === 'degraded') &&
        health.readerState !== 'unavailable' &&
        health.readerState !== 'closed',
      dtoVersion: 2,
      formulaVersion: FORMULA_VERSION,
      schemaVersion: health.schemaVersion,
      maxPageSize: 500,
      maxScannedRows: 100_000,
      maxGroups: 500,
      allowedBucketSizesMs: [...ALLOWED_BUCKET_SIZES_MS],
      allowedCalendarBucketUnits: ['day'],
      health,
    };
  }

  summary(query: StatisticsSummaryQuery): readonly FixtureMetricSummaryDto[] {
    const groupBy = query.groupBy ?? [];
    const rows = retainTopGroupRows(filteredRows(this.rows, query), groupBy, query.topGroups);
    return summarizeRows(rows, query.measures, groupBy);
  }

  series(query: FixtureSeriesQuery): readonly FixtureTimeBucketDto[] {
    const hasFixedBucket = query.bucketMs !== undefined;
    const hasCalendarBucket = query.calendarBucket !== undefined;
    if (hasFixedBucket === hasCalendarBucket) throw new Error('Specify exactly one statistics bucket');
    if (query.bucketMs !== undefined && !(ALLOWED_BUCKET_SIZES_MS as readonly number[]).includes(query.bucketMs)) {
      throw new Error('Unsupported statistics bucket size');
    }

    const groupBy = query.groupBy ?? [];
    const retainedRows = retainTopGroupRows(filteredRows(this.rows, query), groupBy, query.topGroups);
    const buckets = new Map<string, { fromMs: number; toMs: number; rows: FixtureExchangeDto[] }>();
    for (const row of retainedRows) {
      const range = query.calendarBucket
        ? calendarDayRange(row.completedAtMs, query.calendarBucket)
        : {
            fromMs: query.fromMs + Math.floor((row.completedAtMs - query.fromMs) / query.bucketMs!) * query.bucketMs!,
            toMs: Math.min(
              query.fromMs + (Math.floor((row.completedAtMs - query.fromMs) / query.bucketMs!) + 1) * query.bucketMs!,
              query.toMs + 1,
            ),
          };
      range.fromMs = Math.max(range.fromMs, query.fromMs);
      range.toMs = Math.min(range.toMs, query.toMs + 1);
      const key = String(range.fromMs);
      const bucket = buckets.get(key) ?? { ...range, rows: [] };
      bucket.rows.push(row);
      buckets.set(key, bucket);
    }
    return [...buckets.values()]
      .sort((left, right) => left.fromMs - right.fromMs)
      .map((bucket) => ({
        fromMs: bucket.fromMs,
        toMs: bucket.toMs,
        summaries: summarizeRows(bucket.rows, query.measures, groupBy),
      }));
  }

  dimensions(query: StatisticsDimensionQuery): readonly StatisticsDimensionValueDto[] {
    const counts = new Map<DimensionValue, number>();
    for (const row of filteredRows(this.rows, query)) {
      const value = DIMENSION_VALUE[query.dimension](row);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count || compareDimensionValues(left.value, right.value))
      .slice(0, query.limit ?? 100);
  }

  exchanges(query: StatisticsExchangeQuery): StatisticsExchangePageDto {
    const cursor = decodeCursor(query.cursor);
    const snapshotMaxSequence = cursor?.snapshotMaxSequence ?? this.rows.length;
    const offset = cursor?.offset ?? 0;
    const limit = query.limit ?? 100;
    const rows = filteredRows(this.rows.slice(0, snapshotMaxSequence), query);
    const items = rows.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < rows.length ? encodeCursor({ offset: nextOffset, snapshotMaxSequence }) : null,
      snapshotMaxSequence,
    };
  }

  distribution(query: StatisticsDistributionQuery): StatisticsMetricDistributionDto {
    const rows = filteredRows(this.rows, query);
    const values = rows
      .map((row) => scalarMeasure(row, query.measure))
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right);
    const minimum = values.at(0) ?? null;
    const maximum = values.at(-1) ?? null;
    const maxBins = Math.max(1, Math.min(query.maxBins ?? 20, 40));
    const bins = distributionBins(values, maxBins);
    return {
      measure: query.measure,
      bins,
      sampleCount: values.length,
      eligibleCount: rows.length,
      coverage: rows.length === 0 ? 0 : values.length / rows.length,
      minimum,
      maximum,
      formulaVersion: FORMULA_VERSION,
    };
  }
}

export function createStatisticsFixtureEngine(scenario: StatisticsFixtureScenario = 'mixed'): StatisticsFixtureEngine {
  return new StatisticsFixtureEngine(scenario);
}
