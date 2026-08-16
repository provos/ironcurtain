import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import type { LlmExchangeCompleted } from '../types.js';
import type {
  LlmDimensionCount,
  LlmExchangeScanQuery,
  LlmStatisticsDimension,
  StoredLlmExchange,
} from './repository.js';
import { LLM_METRICS_SCHEMA_VERSION, migrateLlmMetricsDatabase } from './migrations.js';
import { SQLITE_BUSY_TIMEOUT_MS, withSqliteBusyRetry } from './sqlite-busy-retry.js';
import {
  MAX_STATISTICS_FILTER_VALUES,
  STATISTICS_IDENTIFIER_MAX_LENGTH,
  STATISTICS_IDENTIFIER_PATTERN,
  STATISTICS_PROVIDER_IDENTIFIER_MAX_LENGTH,
  STATISTICS_PROVIDER_IDENTIFIER_PATTERN,
} from '../query-contract.js';

export interface SqliteWriterWorkerData {
  readonly role: 'writer';
  readonly databasePath: string;
  readonly processRunId: string;
  readonly startedAtMs: number;
}

export interface SqliteReaderWorkerData {
  readonly role: 'reader';
  readonly databasePath: string;
}

export type SqliteWorkerData = SqliteWriterWorkerData | SqliteReaderWorkerData;

export interface SqliteDeleteLeaseResult {
  readonly acquired: boolean;
  readonly snapshotMaxSequence: number | null;
}

export interface SqliteDeleteChunkResult {
  readonly deleted: number;
  readonly hasMore: boolean;
}

export type SqliteWorkerRequest =
  | { readonly id: number; readonly kind: 'insert'; readonly exchanges: readonly LlmExchangeCompleted[] }
  | { readonly id: number; readonly kind: 'snapshotMaxSequence' }
  | {
      readonly id: number;
      readonly kind: 'beginDeleteBefore';
      readonly leaseName: string;
      readonly cutoffMs: number;
      readonly snapshotMaxSequence?: number;
      readonly leaseDurationMs: number;
    }
  | {
      readonly id: number;
      readonly kind: 'deleteBeforeChunk';
      readonly leaseName: string;
      readonly cutoffMs: number;
      readonly snapshotMaxSequence: number;
      readonly chunkSize: number;
      readonly leaseDurationMs: number;
    }
  | { readonly id: number; readonly kind: 'releaseMaintenanceLease'; readonly leaseName: string }
  | { readonly id: number; readonly kind: 'scan'; readonly query: LlmExchangeScanQuery }
  | {
      readonly id: number;
      readonly kind: 'dimensionValues';
      readonly dimension: LlmStatisticsDimension;
      readonly query: Omit<LlmExchangeScanQuery, 'cursor'>;
    }
  | {
      readonly id: number;
      readonly kind: 'checkpoint';
      readonly observed: number;
      readonly finalized: number;
      readonly enqueued: number;
      readonly checkpointAtMs: number;
    }
  | {
      readonly id: number;
      readonly kind: 'close';
      readonly cleanEndedAtMs: number;
      readonly observed: number;
      readonly finalized: number;
      readonly enqueued: number;
    };

export type SqliteReaderWorkerRequest = Extract<
  SqliteWorkerRequest,
  { readonly kind: 'snapshotMaxSequence' | 'scan' | 'dimensionValues' }
>;

type SqliteWriterWorkerRequest = Exclude<SqliteWorkerRequest, SqliteReaderWorkerRequest>;

export type SqliteWorkerResponse =
  | { readonly kind: 'ready'; readonly schemaVersion: number }
  | {
      readonly kind: 'result';
      readonly id: number;
      readonly value:
        | { readonly inserted: number; readonly duplicates: number }
        | SqliteDeleteLeaseResult
        | SqliteDeleteChunkResult
        | number
        | readonly StoredLlmExchange[]
        | readonly LlmDimensionCount[]
        | null;
    }
  | {
      readonly kind: 'error';
      readonly id?: number;
      readonly message: string;
      /** Reader errors distinguish rejected queries from broken storage. */
      readonly category?: 'invalid_request' | 'unavailable';
    };

const MAX_QUALITY_FLAGS = 64;
/** Must match the bounded gateway-adapter contract. */
const MAX_ATTEMPTS = 64;
const MAX_SCAN_LIMIT = 10_001;
const MAX_DIMENSION_LIMIT = 500;
const MAX_DELETE_CHUNK_SIZE = 1_000;
const MIN_MAINTENANCE_LEASE_MS = 100;
const MAX_MAINTENANCE_LEASE_MS = 60_000;
const MAINTENANCE_BUSY_TIMEOUT_MS = 250;
const NORMAL_BUSY_TIMEOUT_MS = SQLITE_BUSY_TIMEOUT_MS;
const ATTRIBUTION_QUALITIES = ['exact', 'bundle_only', 'unattributed'] as const;
const GATEWAY_KINDS = ['direct', 'openrouter', 'ironcurtain', 'opaque'] as const;
const IDENTITY_SOURCES = [
  'request',
  'forwarded_request',
  'protocol_response',
  'protocol_response_direct',
  'router_metadata',
  'trusted_gateway_header',
  'configured_route',
  'not_exposed',
] as const;
const REASONING_MODES = ['disabled', 'enabled', 'adaptive', 'effort', 'unknown'] as const;
const TERMINATIONS = ['stop', 'length', 'tool', 'refusal', 'content_filter', 'error', 'aborted', 'unknown'] as const;
const STOP_REASONS = [
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'context_window',
  'tool_use',
  'pause_turn',
  'refusal',
  'content_filter',
  'completed',
  'incomplete',
  'failed',
  'cancelled',
  'other',
  'not_reported',
] as const;
const REFUSAL_SOURCES = [
  'stop_reason',
  'stop_details',
  'content_item',
  'content_filter',
  'prompt_feedback',
  'not_reported',
] as const;
const OUTPUT_TOKEN_SEMANTICS = ['includes_thinking', 'excludes_thinking', 'no_thinking_breakdown', 'unknown'] as const;
const USAGE_COMPLETENESS = ['complete', 'partial', 'missing', 'invalid'] as const;
const MEASUREMENT_ACCURACIES = [
  'reported_exact',
  'provider_estimate',
  'derived_exact',
  'derived_from_estimate',
  'unknown',
] as const;
const TRANSPORT_OUTCOMES = ['response', 'auth_retry', 'error', 'aborted'] as const;
const GATEWAY_ATTEMPT_SOURCES = ['router_metadata', 'trusted_gateway_header'] as const;

const FILTER_COLUMNS: Readonly<Record<keyof NonNullable<LlmExchangeScanQuery['filters']>, string>> = {
  agent: 'agent_name',
  logicalProvider: 'logical_provider',
  gateway: 'gateway_kind',
  protocol: 'protocol',
  providerProfile: 'provider_profile_id',
  requestedModel: 'requested_model',
  forwardedModel: 'forwarded_model',
  responseModel: 'response_model',
  servedModel: 'served_model',
  servedProvider: 'served_provider',
  reasoningMode: 'reasoning_mode',
  requestedServiceTier: 'requested_service_tier',
  actualServiceTier: 'actual_service_tier',
  inputMeasurementProvenance: 'input_measurement_provenance',
  outputMeasurementProvenance: 'output_measurement_provenance',
  thinkingMeasurementProvenance: 'thinking_measurement_provenance',
  nonThinkingMeasurementProvenance: 'non_thinking_measurement_provenance',
  speedMode: 'speed_mode',
  streaming: 'streaming',
  outcome: 'termination_category',
  refusal: 'refusal',
  usageCompleteness: 'usage_completeness',
  attributionQuality: 'attribution_quality',
  sessionId: 'session_id',
  workflowRunId: 'workflow_run_id',
  stateId: 'state_id',
  personaId: 'persona_id',
  bundleId: 'bundle_id',
};

const DIMENSION_COLUMNS: Readonly<Record<LlmStatisticsDimension, string>> = FILTER_COLUMNS;

const EXCHANGE_COLUMNS = `
  exchange_id AS exchangeId,
  schema_version AS schemaVersion,
  completed_at_ms AS completedAtMs,
  request_received_at_ms AS requestReceivedAtMs,
  session_id AS sessionId,
  turn_id AS turnId,
  agent_conversation_id AS agentConversationId,
  bundle_id AS bundleId,
  workflow_run_id AS workflowRunId,
  state_id AS stateId,
  persona_id AS personaId,
  attribution_quality AS attributionQuality,
  agent_name AS agent,
  logical_provider AS logicalProvider,
  provider_profile_id AS providerProfile,
  protocol,
  gateway_kind AS gateway,
  client_route_id AS clientRouteId,
  upstream_route_id AS upstreamRouteId,
  requested_model AS requestedModel,
  forwarded_model AS forwardedModel,
  response_model AS responseModel,
  served_model AS servedModel,
  served_provider AS servedProvider,
  provider_request_id AS providerRequestId,
  provider_response_id AS providerResponseId,
  gateway_generation_id AS gatewayGenerationId,
  streaming,
  requested_service_tier AS requestedServiceTier,
  actual_service_tier AS actualServiceTier,
  reasoning_mode AS reasoningMode,
  reasoning_effort AS reasoningEffort,
  thinking_budget_tokens AS thinkingBudgetTokens,
  speed_mode AS speedMode,
  response_status_code AS responseStatus,
  termination_category AS outcome,
  provider_stop_reason AS providerStopReason,
  refusal,
  refusal_category AS refusalCategory,
  input_tokens_total AS inputTokens,
  input_tokens_uncached AS uncachedInputTokens,
  cache_read_input_tokens AS cacheReadInputTokens,
  cache_write_input_tokens AS cacheWriteInputTokens,
  tool_use_input_tokens AS toolUseInputTokens,
  output_tokens_total AS outputTokens,
  thinking_tokens AS thinkingTokens,
  non_thinking_output_tokens AS nonThinkingOutputTokens,
  provider_total_tokens AS providerTotalTokens,
  canonical_total_tokens AS totalTokens,
  cost_usd AS costUsd,
  usage_completeness AS usageCompleteness,
  usage_semantics_version AS usageSemanticsVersion,
  input_measurement_provenance AS inputMeasurementProvenance,
  output_measurement_provenance AS outputMeasurementProvenance,
  thinking_measurement_provenance AS thinkingMeasurementProvenance,
  non_thinking_measurement_provenance AS nonThinkingMeasurementProvenance,
  request_body_complete_offset_ms AS requestBodyCompleteOffsetMs,
  response_headers_offset_ms AS responseHeadersOffsetMs,
  first_upstream_body_byte_offset_ms AS firstUpstreamBodyByteOffsetMs,
  first_protocol_event_offset_ms AS firstProtocolEventOffsetMs,
  first_reasoning_offset_ms AS firstReasoningOffsetMs,
  last_reasoning_offset_ms AS lastReasoningOffsetMs,
  first_output_offset_ms AS firstOutputOffsetMs,
  last_output_offset_ms AS lastOutputOffsetMs,
  protocol_terminal_offset_ms AS protocolTerminalOffsetMs,
  upstream_response_end_offset_ms AS upstreamResponseEndOffsetMs,
  client_delivery_end_offset_ms AS clientDeliveryEndOffsetMs,
  client_delivery_status AS clientDeliveryStatus,
  quality_flags_json AS qualityFlagsJson
`;

const INSERT_EXCHANGE_SQL = `
  INSERT INTO llm_exchanges (
    exchange_id, schema_version, completed_at_ms, request_received_at_ms,
    session_id, turn_id, agent_conversation_id, bundle_id, workflow_run_id, state_id, persona_id,
    attribution_quality, agent_name, logical_provider, provider_profile_id, protocol, gateway_kind,
    client_route_id, upstream_route_id,
    requested_model, requested_model_source, forwarded_model, forwarded_model_source,
    response_model, response_model_source, served_model, served_model_source,
    served_provider, served_provider_source,
    provider_request_id, provider_response_id, gateway_generation_id,
    streaming, requested_service_tier, actual_service_tier, reasoning_mode, reasoning_effort,
    thinking_budget_tokens, speed_mode,
    response_status_code, termination_category, provider_stop_reason, refusal, refusal_category, outcome_source,
    input_tokens_reported, input_tokens_total, input_tokens_uncached, cache_read_input_tokens,
    cache_write_input_tokens, tool_use_input_tokens, output_tokens_reported, output_token_semantics,
    output_tokens_total, thinking_tokens, non_thinking_output_tokens, provider_total_tokens,
    canonical_total_tokens, cost_usd, usage_source, usage_completeness, usage_semantics_version,
    input_measurement_provenance, output_measurement_provenance, thinking_measurement_provenance,
    non_thinking_measurement_provenance,
    request_body_complete_offset_ms, response_headers_offset_ms, first_upstream_body_byte_offset_ms,
    first_protocol_event_offset_ms, first_reasoning_offset_ms, last_reasoning_offset_ms,
    first_output_offset_ms, last_output_offset_ms, protocol_terminal_offset_ms,
    upstream_response_end_offset_ms, client_delivery_end_offset_ms, client_delivery_status,
    quality_flags_json, process_run_id
  ) VALUES (
    $exchangeId, $schemaVersion, $completedAtMs, $requestReceivedAtMs,
    $sessionId, $turnId, $agentConversationId, $bundleId, $workflowRunId, $stateId, $personaId,
    $attributionQuality, $agentName, $logicalProvider, $providerProfileId, $protocol, $gatewayKind,
    $clientRouteId, $upstreamRouteId,
    $requestedModel, $requestedModelSource, $forwardedModel, $forwardedModelSource,
    $responseModel, $responseModelSource, $servedModel, $servedModelSource,
    $servedProvider, $servedProviderSource,
    $providerRequestId, $providerResponseId, $gatewayGenerationId,
    $streaming, $requestedServiceTier, $actualServiceTier, $reasoningMode, $reasoningEffort,
    $thinkingBudgetTokens, $speedMode,
    $responseStatusCode, $terminationCategory, $providerStopReason, $refusal, $refusalCategory, $outcomeSource,
    $inputTokensReported, $inputTokensTotal, $inputTokensUncached, $cacheReadInputTokens,
    $cacheWriteInputTokens, $toolUseInputTokens, $outputTokensReported, $outputTokenSemantics,
    $outputTokensTotal, $thinkingTokens, $nonThinkingOutputTokens, $providerTotalTokens,
    $canonicalTotalTokens, $costUsd, $usageSource, $usageCompleteness, $usageSemanticsVersion,
    $inputMeasurementProvenance, $outputMeasurementProvenance, $thinkingMeasurementProvenance,
    $nonThinkingMeasurementProvenance,
    $requestBodyCompleteOffsetMs, $responseHeadersOffsetMs, $firstUpstreamBodyByteOffsetMs,
    $firstProtocolEventOffsetMs, $firstReasoningOffsetMs, $lastReasoningOffsetMs,
    $firstOutputOffsetMs, $lastOutputOffsetMs, $protocolTerminalOffsetMs,
    $upstreamResponseEndOffsetMs, $clientDeliveryEndOffsetMs, $clientDeliveryStatus,
    $qualityFlagsJson, $processRunId
  ) ON CONFLICT(exchange_id) DO NOTHING
`;

type SqlParameters = Record<string, SQLInputValue>;

function requiredIdentifier(value: string, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length > STATISTICS_IDENTIFIER_MAX_LENGTH ||
    !STATISTICS_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function enumValue<const Value extends string>(value: string, allowed: readonly Value[], field: string): Value {
  if (!allowed.includes(value as Value)) throw new Error(`Invalid ${field}`);
  return value as Value;
}

function optionalIdentifier(value: string | null, field: string): string | null {
  return value === null ? null : requiredIdentifier(value, field);
}

function optionalProviderIdentifier(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length > STATISTICS_PROVIDER_IDENTIFIER_MAX_LENGTH ||
    !STATISTICS_PROVIDER_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function optionalBoolean(value: boolean | null): number | null {
  if (value === null) return null;
  if (typeof value !== 'boolean') throw new Error('Invalid boolean');
  return value ? 1 : 0;
}

function optionalHttpStatus(value: number | null, field: string): number | null {
  const status = safeTokenCount(value, field);
  if (status !== null && (status < 100 || status > 599)) throw new Error(`Invalid ${field}`);
  return status;
}

function safeOffset(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${field}`);
  return value;
}

function safeTokenCount(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${field}`);
  return value;
}

function requestReceivedAtMs(exchange: LlmExchangeCompleted): number {
  const value = Date.parse(exchange.timing.requestReceivedAt);
  if (!Number.isFinite(value)) throw new Error('Invalid requestReceivedAt');
  return value;
}

function completedAtMs(exchange: LlmExchangeCompleted, startedAtMs: number): number {
  const endOffset =
    exchange.timing.clientDeliveryEndOffsetMs ??
    exchange.timing.upstreamResponseEndOffsetMs ??
    exchange.timing.protocolTerminalOffsetMs ??
    0;
  const checkedOffset = safeOffset(endOffset, 'completion offset');
  if (checkedOffset === null) throw new Error('Missing completion offset');
  // SQLite stores the wall-clock completion timestamp as an INTEGER. The
  // monotonic offsets retain sub-millisecond precision in their own REAL
  // columns; round only the display/index timestamp.
  return startedAtMs + Math.round(checkedOffset);
}

function qualityFlagsJson(exchange: LlmExchangeCompleted): string {
  if (exchange.qualityFlags.length > MAX_QUALITY_FLAGS) throw new Error('Too many quality flags');
  return JSON.stringify(exchange.qualityFlags.map((flag) => requiredIdentifier(flag, 'quality flag')));
}

function exchangeParameters(exchange: LlmExchangeCompleted, processRunId: string): SqlParameters {
  const schemaVersion: unknown = exchange.schemaVersion;
  if (schemaVersion !== 1) throw new Error('Unsupported exchange schemaVersion');
  const startedAtMs = requestReceivedAtMs(exchange);
  const { attribution, route, identity, responseMetadata, request, outcome, usage, timing } = exchange;
  if (usage.costUsd !== null && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
    throw new Error('Invalid costUsd');
  }
  const usageSemanticsVersion: unknown = usage.usageSemanticsVersion;
  if (usageSemanticsVersion !== 1) throw new Error('Unsupported usageSemanticsVersion');

  return {
    exchangeId: requiredIdentifier(exchange.exchangeId, 'exchangeId'),
    schemaVersion: exchange.schemaVersion,
    completedAtMs: completedAtMs(exchange, startedAtMs),
    requestReceivedAtMs: startedAtMs,
    sessionId: optionalIdentifier(attribution.sessionId, 'sessionId'),
    turnId: optionalIdentifier(attribution.turnId, 'turnId'),
    agentConversationId: optionalIdentifier(attribution.agentConversationId, 'agentConversationId'),
    bundleId: optionalIdentifier(attribution.bundleId, 'bundleId'),
    workflowRunId: optionalIdentifier(attribution.workflowRunId, 'workflowRunId'),
    stateId: optionalIdentifier(attribution.stateId, 'stateId'),
    personaId: optionalIdentifier(attribution.personaId, 'personaId'),
    attributionQuality: enumValue(attribution.quality, ATTRIBUTION_QUALITIES, 'attribution quality'),
    agentName: optionalIdentifier(attribution.agentId, 'agentId'),
    logicalProvider: requiredIdentifier(route.logicalProvider, 'logicalProvider'),
    providerProfileId: optionalIdentifier(route.providerProfileId, 'providerProfileId'),
    protocol: requiredIdentifier(route.protocol, 'protocol'),
    gatewayKind: enumValue(route.gatewayKind, GATEWAY_KINDS, 'gateway kind'),
    clientRouteId: optionalIdentifier(route.clientRouteId, 'clientRouteId'),
    upstreamRouteId: optionalIdentifier(route.upstreamRouteId, 'upstreamRouteId'),
    requestedModel: optionalIdentifier(identity.requestedModel.value, 'requestedModel'),
    requestedModelSource: enumValue(identity.requestedModel.source, IDENTITY_SOURCES, 'requested model source'),
    forwardedModel: optionalIdentifier(identity.forwardedModel.value, 'forwardedModel'),
    forwardedModelSource: enumValue(identity.forwardedModel.source, IDENTITY_SOURCES, 'forwarded model source'),
    responseModel: optionalIdentifier(identity.responseModel.value, 'responseModel'),
    responseModelSource: enumValue(identity.responseModel.source, IDENTITY_SOURCES, 'response model source'),
    servedModel: optionalIdentifier(identity.servedModel.value, 'servedModel'),
    servedModelSource: enumValue(identity.servedModel.source, IDENTITY_SOURCES, 'served model source'),
    servedProvider: optionalProviderIdentifier(identity.servedProvider.value, 'servedProvider'),
    servedProviderSource: enumValue(identity.servedProvider.source, IDENTITY_SOURCES, 'served provider source'),
    providerRequestId: optionalIdentifier(responseMetadata.providerRequestId, 'providerRequestId'),
    providerResponseId: optionalIdentifier(responseMetadata.providerResponseId, 'providerResponseId'),
    gatewayGenerationId: optionalIdentifier(responseMetadata.gatewayGenerationId, 'gatewayGenerationId'),
    streaming: optionalBoolean(request.streaming),
    requestedServiceTier: optionalIdentifier(request.requestedServiceTier, 'requestedServiceTier'),
    actualServiceTier: optionalIdentifier(responseMetadata.actualServiceTier, 'actualServiceTier'),
    reasoningMode: enumValue(request.reasoningMode, REASONING_MODES, 'reasoning mode'),
    reasoningEffort: optionalIdentifier(request.reasoningEffort, 'reasoningEffort'),
    thinkingBudgetTokens: safeTokenCount(request.thinkingBudgetTokens, 'thinkingBudgetTokens'),
    speedMode: optionalIdentifier(request.speedMode, 'speedMode'),
    responseStatusCode: optionalHttpStatus(outcome.responseStatus, 'responseStatus'),
    terminationCategory: enumValue(outcome.termination, TERMINATIONS, 'termination'),
    providerStopReason: enumValue(outcome.providerStopReason, STOP_REASONS, 'stop reason'),
    refusal: optionalBoolean(outcome.refusal),
    refusalCategory: optionalIdentifier(outcome.refusalCategory, 'refusalCategory'),
    outcomeSource: enumValue(outcome.refusalSource, REFUSAL_SOURCES, 'refusal source'),
    inputTokensReported: safeTokenCount(usage.inputTokensReported, 'inputTokensReported'),
    inputTokensTotal: safeTokenCount(usage.inputTokensTotal, 'inputTokensTotal'),
    inputTokensUncached: safeTokenCount(usage.inputTokensUncached, 'inputTokensUncached'),
    cacheReadInputTokens: safeTokenCount(usage.cacheReadInputTokens, 'cacheReadInputTokens'),
    cacheWriteInputTokens: safeTokenCount(usage.cacheWriteInputTokens, 'cacheWriteInputTokens'),
    toolUseInputTokens: safeTokenCount(usage.toolUseInputTokens, 'toolUseInputTokens'),
    outputTokensReported: safeTokenCount(usage.outputTokensReported, 'outputTokensReported'),
    outputTokenSemantics: enumValue(usage.outputTokenSemantics, OUTPUT_TOKEN_SEMANTICS, 'output token semantics'),
    outputTokensTotal: safeTokenCount(usage.outputTokensTotal, 'outputTokensTotal'),
    thinkingTokens: safeTokenCount(usage.thinkingTokens, 'thinkingTokens'),
    nonThinkingOutputTokens: safeTokenCount(usage.nonThinkingOutputTokens, 'nonThinkingOutputTokens'),
    providerTotalTokens: safeTokenCount(usage.providerTotalTokens, 'providerTotalTokens'),
    canonicalTotalTokens: safeTokenCount(usage.canonicalTotalTokens, 'canonicalTotalTokens'),
    costUsd: usage.costUsd,
    usageSource: optionalIdentifier(usage.usageSource, 'usageSource'),
    usageCompleteness: enumValue(usage.usageCompleteness, USAGE_COMPLETENESS, 'usage completeness'),
    usageSemanticsVersion: usage.usageSemanticsVersion,
    inputMeasurementProvenance: enumValue(
      usage.inputTokensAccuracy,
      MEASUREMENT_ACCURACIES,
      'input measurement accuracy',
    ),
    outputMeasurementProvenance: enumValue(
      usage.outputTokensAccuracy,
      MEASUREMENT_ACCURACIES,
      'output measurement accuracy',
    ),
    thinkingMeasurementProvenance: enumValue(
      usage.thinkingTokensAccuracy,
      MEASUREMENT_ACCURACIES,
      'thinking measurement accuracy',
    ),
    nonThinkingMeasurementProvenance: enumValue(
      usage.nonThinkingOutputTokensAccuracy,
      MEASUREMENT_ACCURACIES,
      'non-thinking measurement accuracy',
    ),
    requestBodyCompleteOffsetMs: safeOffset(timing.requestBodyCompleteOffsetMs, 'requestBodyCompleteOffsetMs'),
    responseHeadersOffsetMs: safeOffset(timing.responseHeadersOffsetMs, 'responseHeadersOffsetMs'),
    firstUpstreamBodyByteOffsetMs: safeOffset(timing.firstUpstreamBodyByteOffsetMs, 'firstUpstreamBodyByteOffsetMs'),
    firstProtocolEventOffsetMs: safeOffset(timing.firstProtocolEventOffsetMs, 'firstProtocolEventOffsetMs'),
    firstReasoningOffsetMs: safeOffset(timing.firstReasoningEventOffsetMs, 'firstReasoningEventOffsetMs'),
    lastReasoningOffsetMs: safeOffset(timing.lastReasoningEventOffsetMs, 'lastReasoningEventOffsetMs'),
    firstOutputOffsetMs: safeOffset(timing.firstOutputEventOffsetMs, 'firstOutputEventOffsetMs'),
    lastOutputOffsetMs: safeOffset(timing.lastOutputEventOffsetMs, 'lastOutputEventOffsetMs'),
    protocolTerminalOffsetMs: safeOffset(timing.protocolTerminalOffsetMs, 'protocolTerminalOffsetMs'),
    upstreamResponseEndOffsetMs: safeOffset(timing.upstreamResponseEndOffsetMs, 'upstreamResponseEndOffsetMs'),
    clientDeliveryEndOffsetMs: safeOffset(timing.clientDeliveryEndOffsetMs, 'clientDeliveryEndOffsetMs'),
    clientDeliveryStatus: timing.clientAborted ? 'aborted' : 'finished',
    qualityFlagsJson: qualityFlagsJson(exchange),
    processRunId,
  };
}

function asNumber(value: SQLOutputValue | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid stored ${field}`);
  return value;
}

function asNullableNumber(value: SQLOutputValue | undefined, field: string): number | null {
  return value === null ? null : asNumber(value, field);
}

function asString(value: SQLOutputValue | undefined, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid stored ${field}`);
  return value;
}

function asNullableString(value: SQLOutputValue | undefined, field: string): string | null {
  return value === null ? null : asString(value, field);
}

function parseQualityFlags(value: SQLOutputValue | undefined): readonly string[] {
  const parsed: unknown = JSON.parse(asString(value, 'qualityFlagsJson'));
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error('Invalid stored qualityFlagsJson');
  }
  return parsed;
}

function storedExchange(row: Record<string, SQLOutputValue>): StoredLlmExchange {
  return {
    exchangeId: asString(row.exchangeId, 'exchangeId'),
    schemaVersion: asNumber(row.schemaVersion, 'schemaVersion'),
    completedAtMs: asNumber(row.completedAtMs, 'completedAtMs'),
    requestReceivedAtMs: asNumber(row.requestReceivedAtMs, 'requestReceivedAtMs'),
    sessionId: asNullableString(row.sessionId, 'sessionId'),
    turnId: asNullableString(row.turnId, 'turnId'),
    agentConversationId: asNullableString(row.agentConversationId, 'agentConversationId'),
    bundleId: asNullableString(row.bundleId, 'bundleId'),
    workflowRunId: asNullableString(row.workflowRunId, 'workflowRunId'),
    stateId: asNullableString(row.stateId, 'stateId'),
    personaId: asNullableString(row.personaId, 'personaId'),
    attributionQuality: asString(row.attributionQuality, 'attributionQuality'),
    agent: asNullableString(row.agent, 'agent'),
    logicalProvider: asString(row.logicalProvider, 'logicalProvider'),
    providerProfile: asNullableString(row.providerProfile, 'providerProfile'),
    protocol: asString(row.protocol, 'protocol'),
    gateway: asString(row.gateway, 'gateway'),
    clientRouteId: asNullableString(row.clientRouteId, 'clientRouteId'),
    upstreamRouteId: asNullableString(row.upstreamRouteId, 'upstreamRouteId'),
    requestedModel: asNullableString(row.requestedModel, 'requestedModel'),
    forwardedModel: asNullableString(row.forwardedModel, 'forwardedModel'),
    responseModel: asNullableString(row.responseModel, 'responseModel'),
    servedModel: asNullableString(row.servedModel, 'servedModel'),
    servedProvider: asNullableString(row.servedProvider, 'servedProvider'),
    providerRequestId: asNullableString(row.providerRequestId, 'providerRequestId'),
    providerResponseId: asNullableString(row.providerResponseId, 'providerResponseId'),
    gatewayGenerationId: asNullableString(row.gatewayGenerationId, 'gatewayGenerationId'),
    streaming: row.streaming === null ? null : asNumber(row.streaming, 'streaming') === 1,
    requestedServiceTier: asNullableString(row.requestedServiceTier, 'requestedServiceTier'),
    actualServiceTier: asNullableString(row.actualServiceTier, 'actualServiceTier'),
    reasoningMode: asString(row.reasoningMode, 'reasoningMode'),
    reasoningEffort: asNullableString(row.reasoningEffort, 'reasoningEffort'),
    thinkingBudgetTokens: asNullableNumber(row.thinkingBudgetTokens, 'thinkingBudgetTokens'),
    speedMode: asNullableString(row.speedMode, 'speedMode'),
    responseStatus: asNullableNumber(row.responseStatus, 'responseStatus'),
    outcome: asString(row.outcome, 'outcome'),
    providerStopReason: asString(row.providerStopReason, 'providerStopReason'),
    refusal: row.refusal === null ? null : asNumber(row.refusal, 'refusal') === 1,
    refusalCategory: asNullableString(row.refusalCategory, 'refusalCategory'),
    inputTokens: asNullableNumber(row.inputTokens, 'inputTokens'),
    uncachedInputTokens: asNullableNumber(row.uncachedInputTokens, 'uncachedInputTokens'),
    cacheReadInputTokens: asNullableNumber(row.cacheReadInputTokens, 'cacheReadInputTokens'),
    cacheWriteInputTokens: asNullableNumber(row.cacheWriteInputTokens, 'cacheWriteInputTokens'),
    toolUseInputTokens: asNullableNumber(row.toolUseInputTokens, 'toolUseInputTokens'),
    outputTokens: asNullableNumber(row.outputTokens, 'outputTokens'),
    thinkingTokens: asNullableNumber(row.thinkingTokens, 'thinkingTokens'),
    nonThinkingOutputTokens: asNullableNumber(row.nonThinkingOutputTokens, 'nonThinkingOutputTokens'),
    providerTotalTokens: asNullableNumber(row.providerTotalTokens, 'providerTotalTokens'),
    totalTokens: asNullableNumber(row.totalTokens, 'totalTokens'),
    costUsd: asNullableNumber(row.costUsd, 'costUsd'),
    usageCompleteness: asString(row.usageCompleteness, 'usageCompleteness'),
    usageSemanticsVersion: asNumber(row.usageSemanticsVersion, 'usageSemanticsVersion'),
    inputMeasurementProvenance: asString(row.inputMeasurementProvenance, 'inputMeasurementProvenance'),
    outputMeasurementProvenance: asString(row.outputMeasurementProvenance, 'outputMeasurementProvenance'),
    thinkingMeasurementProvenance: asString(row.thinkingMeasurementProvenance, 'thinkingMeasurementProvenance'),
    nonThinkingMeasurementProvenance: asString(
      row.nonThinkingMeasurementProvenance,
      'nonThinkingMeasurementProvenance',
    ),
    requestBodyCompleteOffsetMs: asNullableNumber(row.requestBodyCompleteOffsetMs, 'requestBodyCompleteOffsetMs'),
    responseHeadersOffsetMs: asNullableNumber(row.responseHeadersOffsetMs, 'responseHeadersOffsetMs'),
    firstUpstreamBodyByteOffsetMs: asNullableNumber(row.firstUpstreamBodyByteOffsetMs, 'firstUpstreamBodyByteOffsetMs'),
    firstProtocolEventOffsetMs: asNullableNumber(row.firstProtocolEventOffsetMs, 'firstProtocolEventOffsetMs'),
    firstReasoningOffsetMs: asNullableNumber(row.firstReasoningOffsetMs, 'firstReasoningOffsetMs'),
    lastReasoningOffsetMs: asNullableNumber(row.lastReasoningOffsetMs, 'lastReasoningOffsetMs'),
    firstOutputOffsetMs: asNullableNumber(row.firstOutputOffsetMs, 'firstOutputOffsetMs'),
    lastOutputOffsetMs: asNullableNumber(row.lastOutputOffsetMs, 'lastOutputOffsetMs'),
    protocolTerminalOffsetMs: asNullableNumber(row.protocolTerminalOffsetMs, 'protocolTerminalOffsetMs'),
    upstreamResponseEndOffsetMs: asNullableNumber(row.upstreamResponseEndOffsetMs, 'upstreamResponseEndOffsetMs'),
    clientDeliveryEndOffsetMs: asNullableNumber(row.clientDeliveryEndOffsetMs, 'clientDeliveryEndOffsetMs'),
    clientAborted: asString(row.clientDeliveryStatus, 'clientDeliveryStatus') === 'aborted',
    qualityFlags: parseQualityFlags(row.qualityFlagsJson),
  };
}

class StatisticsQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatisticsQueryValidationError';
  }
}

function invalidQuery(message: string): never {
  throw new StatisticsQueryValidationError(message);
}

function queryIdentifier(value: string, field: string): string {
  try {
    return requiredIdentifier(value, field);
  } catch {
    return invalidQuery(`Invalid ${field}`);
  }
}

function queryProviderIdentifier(value: string, field: string): string {
  try {
    return optionalProviderIdentifier(value, field) ?? invalidQuery(`Invalid ${field}`);
  } catch (error) {
    if (error instanceof StatisticsQueryValidationError) throw error;
    return invalidQuery(`Invalid ${field}`);
  }
}

function appendFilters(
  query: Pick<LlmExchangeScanQuery, 'fromMs' | 'toMs' | 'filters'>,
  params: SQLInputValue[],
): string[] {
  if (!Number.isSafeInteger(query.fromMs) || !Number.isSafeInteger(query.toMs) || query.fromMs > query.toMs) {
    invalidQuery('Invalid query time range');
  }
  const clauses = ['completed_at_ms >= ?', 'completed_at_ms <= ?'];
  params.push(query.fromMs, query.toMs);

  for (const [filter, values] of Object.entries(query.filters ?? {}) as [
    keyof NonNullable<LlmExchangeScanQuery['filters']>,
    readonly (string | boolean)[],
  ][]) {
    const untrustedValues: unknown = values;
    if (!Array.isArray(untrustedValues)) invalidQuery(`Invalid ${filter} filter values`);
    const filterValues = untrustedValues as readonly unknown[];
    if (filterValues.length === 0) continue;
    if (filterValues.length > MAX_STATISTICS_FILTER_VALUES) invalidQuery(`Too many ${filter} filter values`);
    if (!Object.hasOwn(FILTER_COLUMNS, filter)) invalidQuery('Invalid statistics filter');
    const column = FILTER_COLUMNS[filter];
    clauses.push(`${column} IN (${filterValues.map(() => '?').join(', ')})`);
    for (const value of filterValues) {
      if (typeof value !== 'string' && typeof value !== 'boolean') {
        invalidQuery(`Invalid ${filter} filter value`);
      }
      params.push(
        typeof value === 'boolean'
          ? value
            ? 1
            : 0
          : filter === 'servedProvider'
            ? queryProviderIdentifier(value, `${filter} filter`)
            : queryIdentifier(value, `${filter} filter`),
      );
    }
  }
  return clauses;
}

function scan(database: DatabaseSync, query: LlmExchangeScanQuery): readonly StoredLlmExchange[] {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_SCAN_LIMIT) {
    invalidQuery('Invalid scan limit');
  }
  const params: SQLInputValue[] = [];
  const clauses = appendFilters(query, params);
  if (query.snapshotMaxSequence !== undefined) {
    if (!Number.isSafeInteger(query.snapshotMaxSequence) || query.snapshotMaxSequence < 0) {
      invalidQuery('Invalid snapshot sequence');
    }
    clauses.push('ingestion_sequence <= ?');
    params.push(query.snapshotMaxSequence);
  }
  if (query.cursor !== undefined) {
    if (!Number.isSafeInteger(query.cursor.completedAtMs)) invalidQuery('Invalid cursor timestamp');
    clauses.push('(completed_at_ms < ? OR (completed_at_ms = ? AND exchange_id < ?))');
    params.push(
      query.cursor.completedAtMs,
      query.cursor.completedAtMs,
      queryIdentifier(query.cursor.exchangeId, 'cursor exchangeId'),
    );
  }
  params.push(query.limit);
  const rows = database
    .prepare(
      `SELECT ${EXCHANGE_COLUMNS} FROM llm_exchanges WHERE ${clauses.join(
        ' AND ',
      )} ORDER BY completed_at_ms DESC, exchange_id DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map(storedExchange);
}

function dimensionValues(
  database: DatabaseSync,
  dimension: LlmStatisticsDimension,
  query: Omit<LlmExchangeScanQuery, 'cursor'>,
): readonly LlmDimensionCount[] {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_DIMENSION_LIMIT) {
    invalidQuery('Invalid dimension limit');
  }
  if (!Object.hasOwn(DIMENSION_COLUMNS, dimension)) invalidQuery('Invalid statistics dimension');
  const column = DIMENSION_COLUMNS[dimension];
  const params: SQLInputValue[] = [];
  const clauses = appendFilters(query, params);
  params.push(query.limit);
  const rows = database
    .prepare(
      `SELECT ${column} AS value, COUNT(*) AS count FROM llm_exchanges ` +
        `WHERE ${clauses.join(' AND ')} GROUP BY ${column} ORDER BY count DESC, ${column} ASC LIMIT ?`,
    )
    .all(...params);
  const booleanDimension = dimension === 'streaming' || dimension === 'refusal';
  return rows.map((row) => {
    let value: string | boolean | null;
    if (!booleanDimension) {
      value = asNullableString(row.value, 'dimension value');
    } else if (row.value === null) {
      value = null;
    } else if (row.value === 0 || row.value === 1) {
      value = row.value === 1;
    } else {
      throw new Error('Invalid boolean dimension value');
    }
    return { value, count: asNumber(row.count, 'dimension count') };
  });
}

function initializeWriter(data: SqliteWriterWorkerData): { database: DatabaseSync; schemaVersion: number } {
  mkdirSync(dirname(data.databasePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(data.databasePath), 0o700);
  const database = new DatabaseSync(data.databasePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    const schemaVersion = migrateLlmMetricsDatabase(database);
    withSqliteBusyRetry(() => database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;'));
    withSqliteBusyRetry(() =>
      database
        .prepare(
          `INSERT INTO llm_process_runs (
            process_run_id, started_at_ms, last_checkpoint_at_ms,
            observed_count, finalized_count, enqueued_count, clean_ended_at_ms
          ) VALUES (?, ?, ?, 0, 0, 0, NULL)`,
        )
        .run(requiredIdentifier(data.processRunId, 'processRunId'), data.startedAtMs, data.startedAtMs),
    );
    chmodSync(data.databasePath, 0o600);
    for (const suffix of ['-wal', '-shm']) {
      try {
        chmodSync(`${data.databasePath}${suffix}`, 0o600);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    return { database, schemaVersion };
  } catch (error) {
    database.close();
    throw error;
  }
}

function initializeReader(data: SqliteReaderWorkerData): { database: DatabaseSync; schemaVersion: number } {
  const database = new DatabaseSync(data.databasePath, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    assertCompatibleSchema(database);
    database.exec(`PRAGMA query_only = ON; PRAGMA busy_timeout = ${NORMAL_BUSY_TIMEOUT_MS};`);
    return { database, schemaVersion: LLM_METRICS_SCHEMA_VERSION };
  } catch (error) {
    database.close();
    throw error;
  }
}

function assertCompatibleSchema(database: DatabaseSync): void {
  const version = database.prepare('PRAGMA user_version').get()?.user_version;
  if (version !== LLM_METRICS_SCHEMA_VERSION) {
    throw new Error(
      `LLM metrics database schema ${String(version)} is not supported by writer schema ${LLM_METRICS_SCHEMA_VERSION}`,
    );
  }
}

function boundedSafeInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function withMaintenanceBusyTimeout<Value>(database: DatabaseSync, operation: () => Value): Value {
  database.exec(`PRAGMA busy_timeout = ${MAINTENANCE_BUSY_TIMEOUT_MS}`);
  try {
    return operation();
  } finally {
    database.exec(`PRAGMA busy_timeout = ${NORMAL_BUSY_TIMEOUT_MS}`);
  }
}

function immediateTransaction<Value>(database: DatabaseSync, operation: () => Value): Value {
  return withSqliteBusyRetry(() => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      database.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the operation error.
      }
      throw error;
    }
  });
}

function pruneOrphanedRetentionMetadata(database: DatabaseSync, cutoffMs: number, nowMs: number): void {
  database
    .prepare(
      `DELETE FROM llm_process_runs WHERE process_run_id IN (
         SELECT run.process_run_id FROM llm_process_runs AS run
         WHERE run.clean_ended_at_ms IS NOT NULL
           AND run.clean_ended_at_ms < ?
           AND NOT EXISTS (
             SELECT 1 FROM llm_exchanges AS exchange WHERE exchange.process_run_id = run.process_run_id
           )
         ORDER BY run.clean_ended_at_ms ASC
         LIMIT ?
       )`,
    )
    .run(cutoffMs, MAX_DELETE_CHUNK_SIZE);
  database
    .prepare(
      `DELETE FROM llm_maintenance_leases WHERE lease_name IN (
         SELECT lease_name FROM llm_maintenance_leases
         WHERE expires_at_ms <= ?
         ORDER BY expires_at_ms ASC
         LIMIT ?
       )`,
    )
    .run(nowMs, MAX_DELETE_CHUNK_SIZE);
}

function beginDeleteBefore(
  database: DatabaseSync,
  data: SqliteWriterWorkerData,
  request: Extract<SqliteWorkerRequest, { kind: 'beginDeleteBefore' }>,
): SqliteDeleteLeaseResult {
  assertCompatibleSchema(database);
  const leaseName = requiredIdentifier(request.leaseName, 'maintenance lease name');
  const cutoffMs = boundedSafeInteger(request.cutoffMs, 0, Number.MAX_SAFE_INTEGER, 'delete cutoff');
  const leaseDurationMs = boundedSafeInteger(
    request.leaseDurationMs,
    MIN_MAINTENANCE_LEASE_MS,
    MAX_MAINTENANCE_LEASE_MS,
    'maintenance lease duration',
  );
  const requestedSnapshot =
    request.snapshotMaxSequence === undefined
      ? undefined
      : boundedSafeInteger(request.snapshotMaxSequence, 0, Number.MAX_SAFE_INTEGER, 'delete snapshot sequence');

  // A live lease can be observed through WAL without joining the write-lock
  // queue. This keeps a losing process cheap and avoids delaying its writer.
  const activeLease = database
    .prepare(
      'SELECT owner_id AS ownerId, expires_at_ms AS expiresAtMs FROM llm_maintenance_leases WHERE lease_name = ?',
    )
    .get(leaseName);
  if (
    activeLease !== undefined &&
    activeLease.ownerId !== data.processRunId &&
    asNumber(activeLease.expiresAtMs, 'maintenance lease expiry') > Date.now()
  ) {
    return { acquired: false, snapshotMaxSequence: null };
  }

  return withMaintenanceBusyTimeout(database, () =>
    immediateTransaction(database, () => {
      const now = Date.now();
      const expiresAtMs = boundedSafeInteger(
        now + leaseDurationMs,
        now,
        Number.MAX_SAFE_INTEGER,
        'maintenance lease expiry',
      );
      database
        .prepare(
          `INSERT INTO llm_maintenance_leases (lease_name, owner_id, expires_at_ms)
           VALUES (?, ?, ?)
           ON CONFLICT (lease_name) DO UPDATE SET
             owner_id = excluded.owner_id,
             expires_at_ms = excluded.expires_at_ms
           WHERE llm_maintenance_leases.expires_at_ms <= ?
              OR llm_maintenance_leases.owner_id = excluded.owner_id`,
        )
        .run(leaseName, data.processRunId, expiresAtMs, now);
      const lease = database
        .prepare('SELECT owner_id AS ownerId FROM llm_maintenance_leases WHERE lease_name = ?')
        .get(leaseName);
      if (lease?.ownerId !== data.processRunId) return { acquired: false, snapshotMaxSequence: null };

      pruneOrphanedRetentionMetadata(database, cutoffMs, now);

      const snapshot =
        requestedSnapshot ??
        database
          .prepare('SELECT MAX(ingestion_sequence) AS value FROM llm_exchanges WHERE completed_at_ms < ?')
          .get(cutoffMs)?.value;
      if (snapshot === null || snapshot === undefined) return { acquired: true, snapshotMaxSequence: null };
      return {
        acquired: true,
        snapshotMaxSequence: boundedSafeInteger(
          asNumber(snapshot, 'delete snapshot sequence'),
          0,
          Number.MAX_SAFE_INTEGER,
          'delete snapshot sequence',
        ),
      };
    }),
  );
}

function deleteBeforeChunk(
  database: DatabaseSync,
  data: SqliteWriterWorkerData,
  request: Extract<SqliteWorkerRequest, { kind: 'deleteBeforeChunk' }>,
): SqliteDeleteChunkResult {
  assertCompatibleSchema(database);
  const leaseName = requiredIdentifier(request.leaseName, 'maintenance lease name');
  const cutoffMs = boundedSafeInteger(request.cutoffMs, 0, Number.MAX_SAFE_INTEGER, 'delete cutoff');
  const snapshotMaxSequence = boundedSafeInteger(
    request.snapshotMaxSequence,
    1,
    Number.MAX_SAFE_INTEGER,
    'delete snapshot sequence',
  );
  const chunkSize = boundedSafeInteger(request.chunkSize, 1, MAX_DELETE_CHUNK_SIZE, 'delete chunk size');
  const leaseDurationMs = boundedSafeInteger(
    request.leaseDurationMs,
    MIN_MAINTENANCE_LEASE_MS,
    MAX_MAINTENANCE_LEASE_MS,
    'maintenance lease duration',
  );

  return withMaintenanceBusyTimeout(database, () =>
    immediateTransaction(database, () => {
      const now = Date.now();
      const expiresAtMs = boundedSafeInteger(
        now + leaseDurationMs,
        now,
        Number.MAX_SAFE_INTEGER,
        'maintenance lease expiry',
      );
      const renewed = database
        .prepare(
          `UPDATE llm_maintenance_leases SET expires_at_ms = ?
           WHERE lease_name = ? AND owner_id = ?`,
        )
        .run(expiresAtMs, leaseName, data.processRunId);
      if (Number(renewed.changes) !== 1) throw new Error('LLM metrics maintenance lease was lost');

      const deletion = database
        .prepare(
          `DELETE FROM llm_exchanges WHERE ingestion_sequence IN (
             SELECT ingestion_sequence FROM llm_exchanges
             WHERE completed_at_ms < ? AND ingestion_sequence <= ?
             ORDER BY ingestion_sequence ASC
             LIMIT ?
           )`,
        )
        .run(cutoffMs, snapshotMaxSequence, chunkSize);
      const remaining = database
        .prepare(
          `SELECT EXISTS(
             SELECT 1 FROM llm_exchanges
             WHERE completed_at_ms < ? AND ingestion_sequence <= ?
           ) AS value`,
        )
        .get(cutoffMs, snapshotMaxSequence)?.value;
      return {
        deleted: boundedSafeInteger(Number(deletion.changes), 0, chunkSize, 'deleted row count'),
        hasMore: asNumber(remaining, 'delete remaining indicator') === 1,
      };
    }),
  );
}

function releaseMaintenanceLease(
  database: DatabaseSync,
  data: SqliteWriterWorkerData,
  request: Extract<SqliteWorkerRequest, { kind: 'releaseMaintenanceLease' }>,
): void {
  assertCompatibleSchema(database);
  const leaseName = requiredIdentifier(request.leaseName, 'maintenance lease name');
  withMaintenanceBusyTimeout(database, () => {
    withSqliteBusyRetry(() =>
      database
        .prepare('DELETE FROM llm_maintenance_leases WHERE lease_name = ? AND owner_id = ?')
        .run(leaseName, data.processRunId),
    );
  });
}

function insertBatch(
  database: DatabaseSync,
  processRunId: string,
  exchanges: readonly LlmExchangeCompleted[],
): { inserted: number; duplicates: number } {
  assertCompatibleSchema(database);
  const insertExchange = database.prepare(INSERT_EXCHANGE_SQL);
  const insertTransportAttempt = database.prepare(
    `INSERT INTO llm_transport_attempts
      (exchange_id, ordinal, started_offset_ms, ended_offset_ms, status_code, outcome)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertGatewayAttempt = database.prepare(
    `INSERT INTO llm_gateway_route_attempts
      (exchange_id, ordinal, provider, model, status_code, selected, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  return immediateTransaction(database, () => {
    let inserted = 0;
    let duplicates = 0;
    for (const exchange of exchanges) {
      const result = insertExchange.run(exchangeParameters(exchange, processRunId));
      const changes = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
      if (changes === 0) {
        duplicates++;
        continue;
      }
      inserted++;
      if (exchange.transportAttempts.length > MAX_ATTEMPTS) throw new Error('Too many transport attempts');
      for (const attempt of exchange.transportAttempts) {
        insertTransportAttempt.run(
          exchange.exchangeId,
          safeTokenCount(attempt.ordinal, 'transport attempt ordinal'),
          safeOffset(attempt.startedOffsetMs, 'transport attempt start'),
          safeOffset(attempt.endedOffsetMs, 'transport attempt end'),
          optionalHttpStatus(attempt.responseStatus, 'transport attempt status'),
          enumValue(attempt.outcome, TRANSPORT_OUTCOMES, 'transport attempt outcome'),
        );
      }
      if (exchange.gatewayRouteAttempts.length > MAX_ATTEMPTS) throw new Error('Too many gateway attempts');
      for (const attempt of exchange.gatewayRouteAttempts) {
        insertGatewayAttempt.run(
          exchange.exchangeId,
          safeTokenCount(attempt.ordinal, 'gateway attempt ordinal'),
          optionalProviderIdentifier(attempt.provider, 'gateway provider'),
          optionalIdentifier(attempt.model, 'gateway model'),
          optionalHttpStatus(attempt.status, 'gateway attempt status'),
          optionalBoolean(attempt.selected),
          enumValue(attempt.source, GATEWAY_ATTEMPT_SOURCES, 'gateway attempt source'),
        );
      }
    }
    return { inserted, duplicates };
  });
}

function checkpoint(
  database: DatabaseSync,
  data: SqliteWriterWorkerData,
  request: Extract<SqliteWorkerRequest, { kind: 'checkpoint' }>,
): void {
  withSqliteBusyRetry(() =>
    database
      .prepare(
        `UPDATE llm_process_runs SET
          last_checkpoint_at_ms = ?, observed_count = ?, finalized_count = ?, enqueued_count = ?
         WHERE process_run_id = ?`,
      )
      .run(request.checkpointAtMs, request.observed, request.finalized, request.enqueued, data.processRunId),
  );
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown SQLite worker error';
  return message.substring(0, 500);
}

function startWriterWorker(data: SqliteWriterWorkerData): void {
  if (parentPort === null) throw new Error('SQLite metrics worker has no parent port');
  const port = parentPort;
  let database: DatabaseSync;
  try {
    const initialized = initializeWriter(data);
    database = initialized.database;
    port.postMessage({ kind: 'ready', schemaVersion: initialized.schemaVersion } satisfies SqliteWorkerResponse);
  } catch (error) {
    port.postMessage({ kind: 'error', message: errorMessage(error) } satisfies SqliteWorkerResponse);
    return;
  }

  let chain = Promise.resolve();
  port.on('message', (request: SqliteWriterWorkerRequest) => {
    chain = chain.then(() => {
      try {
        let value: Extract<SqliteWorkerResponse, { kind: 'result' }>['value'];
        switch (request.kind) {
          case 'insert':
            value = insertBatch(database, data.processRunId, request.exchanges);
            break;
          case 'beginDeleteBefore':
            value = beginDeleteBefore(database, data, request);
            break;
          case 'deleteBeforeChunk':
            value = deleteBeforeChunk(database, data, request);
            break;
          case 'releaseMaintenanceLease':
            releaseMaintenanceLease(database, data, request);
            value = null;
            break;
          case 'checkpoint':
            checkpoint(database, data, request);
            value = null;
            break;
          case 'close':
            checkpoint(database, data, {
              id: request.id,
              kind: 'checkpoint',
              observed: request.observed,
              finalized: request.finalized,
              enqueued: request.enqueued,
              checkpointAtMs: request.cleanEndedAtMs,
            });
            withSqliteBusyRetry(() =>
              database
                .prepare('UPDATE llm_process_runs SET clean_ended_at_ms = ? WHERE process_run_id = ?')
                .run(request.cleanEndedAtMs, data.processRunId),
            );
            database.close();
            value = null;
            break;
          default:
            throw new Error('Invalid SQLite metrics writer request');
        }
        port.postMessage({ kind: 'result', id: request.id, value } satisfies SqliteWorkerResponse);
      } catch (error) {
        port.postMessage({
          kind: 'error',
          id: request.id,
          message: errorMessage(error),
        } satisfies SqliteWorkerResponse);
      }
    });
  });
}

function startReaderWorker(data: SqliteReaderWorkerData): void {
  if (parentPort === null) throw new Error('SQLite metrics worker has no parent port');
  const port = parentPort;
  let database: DatabaseSync;
  try {
    const initialized = initializeReader(data);
    database = initialized.database;
    port.postMessage({ kind: 'ready', schemaVersion: initialized.schemaVersion } satisfies SqliteWorkerResponse);
  } catch (error) {
    port.postMessage({ kind: 'error', message: errorMessage(error) } satisfies SqliteWorkerResponse);
    return;
  }

  let chain = Promise.resolve();
  port.on('message', (request: SqliteReaderWorkerRequest) => {
    chain = chain.then(() => {
      try {
        let value: Extract<SqliteWorkerResponse, { kind: 'result' }>['value'];
        switch (request.kind) {
          case 'snapshotMaxSequence': {
            const row = database
              .prepare('SELECT COALESCE(MAX(ingestion_sequence), 0) AS value FROM llm_exchanges')
              .get();
            value = asNumber(row?.value, 'snapshot sequence');
            break;
          }
          case 'scan':
            value = scan(database, request.query);
            break;
          case 'dimensionValues':
            value = dimensionValues(database, request.dimension, request.query);
            break;
          default:
            throw new Error('Invalid SQLite metrics reader request');
        }
        port.postMessage({ kind: 'result', id: request.id, value } satisfies SqliteWorkerResponse);
      } catch (error) {
        port.postMessage({
          kind: 'error',
          id: request.id,
          message: errorMessage(error),
          category: error instanceof StatisticsQueryValidationError ? 'invalid_request' : 'unavailable',
        } satisfies SqliteWorkerResponse);
      }
    });
  });
}

function startWorker(data: SqliteWorkerData): void {
  if (data.role === 'reader') startReaderWorker(data);
  else startWriterWorker(data);
}

if (!isMainThread) {
  startWorker(workerData as SqliteWorkerData);
}
