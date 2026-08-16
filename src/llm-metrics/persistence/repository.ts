import type { LlmExchangeCompleted } from '../types.js';

export type LlmMetricsRepositoryState = 'starting' | 'ready' | 'degraded' | 'disabled' | 'closed';
export type LlmMetricsReaderState = 'idle' | 'starting' | 'ready' | 'unavailable' | 'closed';

export interface LlmMetricsRepositoryHealth {
  readonly state: LlmMetricsRepositoryState;
  readonly schemaVersion: number | null;
  readonly observed: number;
  readonly finalized: number;
  readonly enqueued: number;
  readonly persisted: number;
  readonly duplicates: number;
  readonly dropped: number;
  readonly queuedRecords: number;
  readonly queuedBytes: number;
  readonly lastError: string | null;
  readonly readerState: LlmMetricsReaderState;
  readonly readerLastError: string | null;
}

export type LlmStatisticsDimension =
  | 'agent'
  | 'logicalProvider'
  | 'gateway'
  | 'protocol'
  | 'providerProfile'
  | 'requestedModel'
  | 'forwardedModel'
  | 'responseModel'
  | 'servedModel'
  | 'servedProvider'
  | 'reasoningMode'
  | 'requestedServiceTier'
  | 'actualServiceTier'
  | 'inputMeasurementProvenance'
  | 'outputMeasurementProvenance'
  | 'thinkingMeasurementProvenance'
  | 'nonThinkingMeasurementProvenance'
  | 'speedMode'
  | 'streaming'
  | 'outcome'
  | 'refusal'
  | 'usageCompleteness'
  | 'attributionQuality'
  | 'sessionId'
  | 'workflowRunId'
  | 'stateId'
  | 'personaId'
  | 'bundleId';

export type LlmStatisticsDimensionValue = string | boolean | null;

export interface LlmExchangeFilters {
  readonly agent?: readonly string[];
  readonly logicalProvider?: readonly string[];
  readonly gateway?: readonly string[];
  readonly protocol?: readonly string[];
  readonly providerProfile?: readonly string[];
  readonly requestedModel?: readonly string[];
  readonly forwardedModel?: readonly string[];
  readonly responseModel?: readonly string[];
  readonly servedModel?: readonly string[];
  readonly servedProvider?: readonly string[];
  readonly reasoningMode?: readonly string[];
  readonly requestedServiceTier?: readonly string[];
  readonly actualServiceTier?: readonly string[];
  readonly inputMeasurementProvenance?: readonly string[];
  readonly outputMeasurementProvenance?: readonly string[];
  readonly thinkingMeasurementProvenance?: readonly string[];
  readonly nonThinkingMeasurementProvenance?: readonly string[];
  readonly speedMode?: readonly string[];
  readonly streaming?: readonly boolean[];
  readonly outcome?: readonly string[];
  readonly refusal?: readonly boolean[];
  readonly usageCompleteness?: readonly string[];
  readonly attributionQuality?: readonly string[];
  readonly sessionId?: readonly string[];
  readonly workflowRunId?: readonly string[];
  readonly stateId?: readonly string[];
  readonly personaId?: readonly string[];
  readonly bundleId?: readonly string[];
}

export interface LlmExchangeCursor {
  readonly completedAtMs: number;
  readonly exchangeId: string;
}

export interface LlmExchangeScanQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly limit: number;
  /** Stable high-water mark captured before cursor pagination starts. */
  readonly snapshotMaxSequence?: number;
  readonly cursor?: LlmExchangeCursor;
  readonly filters?: LlmExchangeFilters;
}

/** Flattened, content-free row returned by the storage boundary. */
export interface StoredLlmExchange {
  readonly exchangeId: string;
  readonly schemaVersion: number;
  readonly completedAtMs: number;
  readonly requestReceivedAtMs: number;
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly agentConversationId: string | null;
  readonly bundleId: string | null;
  readonly workflowRunId: string | null;
  readonly stateId: string | null;
  readonly personaId: string | null;
  readonly attributionQuality: string;
  readonly agent: string | null;
  readonly logicalProvider: string;
  readonly providerProfile: string | null;
  readonly protocol: string;
  readonly gateway: string;
  readonly clientRouteId: string | null;
  readonly upstreamRouteId: string | null;
  readonly requestedModel: string | null;
  readonly forwardedModel: string | null;
  readonly responseModel: string | null;
  readonly servedModel: string | null;
  readonly servedProvider: string | null;
  readonly providerRequestId: string | null;
  readonly providerResponseId: string | null;
  readonly gatewayGenerationId: string | null;
  readonly streaming: boolean | null;
  readonly requestedServiceTier: string | null;
  readonly actualServiceTier: string | null;
  readonly reasoningMode: string;
  readonly reasoningEffort: string | null;
  readonly thinkingBudgetTokens: number | null;
  readonly speedMode: string | null;
  readonly responseStatus: number | null;
  readonly outcome: string;
  readonly providerStopReason: string;
  readonly refusal: boolean | null;
  readonly refusalCategory: string | null;
  readonly inputTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly toolUseInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly thinkingTokens: number | null;
  readonly nonThinkingOutputTokens: number | null;
  readonly providerTotalTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly usageCompleteness: string;
  readonly usageSemanticsVersion: number;
  readonly inputMeasurementProvenance: string;
  readonly outputMeasurementProvenance: string;
  readonly thinkingMeasurementProvenance: string;
  readonly nonThinkingMeasurementProvenance: string;
  readonly requestBodyCompleteOffsetMs: number | null;
  readonly responseHeadersOffsetMs: number | null;
  readonly firstUpstreamBodyByteOffsetMs: number | null;
  readonly firstProtocolEventOffsetMs: number | null;
  readonly firstReasoningOffsetMs: number | null;
  readonly lastReasoningOffsetMs: number | null;
  readonly firstOutputOffsetMs: number | null;
  readonly lastOutputOffsetMs: number | null;
  readonly protocolTerminalOffsetMs: number | null;
  readonly upstreamResponseEndOffsetMs: number | null;
  readonly clientDeliveryEndOffsetMs: number | null;
  readonly clientAborted: boolean;
  readonly qualityFlags: readonly string[];
}

export interface LlmDimensionCount {
  readonly value: LlmStatisticsDimensionValue;
  readonly count: number;
}

export interface LlmDeleteBeforeOptions {
  /** Stable upper bound returned by an earlier partial call. */
  readonly snapshotMaxSequence?: number;
  /** Rows per short transaction. */
  readonly chunkSize?: number;
  /** Hard row bound for one management call. */
  readonly maxRows?: number;
  /** Wall-clock bound for issuing chunks, excluding a currently executing SQLite operation. */
  readonly maxDurationMs?: number;
  /** Crash-safe cross-process lease duration. Must cover maxDurationMs. */
  readonly leaseDurationMs?: number;
}

export interface LlmDeleteBeforeResult {
  readonly status: 'complete' | 'partial' | 'busy';
  readonly cutoffMs: number;
  readonly snapshotMaxSequence: number | null;
  readonly deletedCount: number;
  readonly chunksProcessed: number;
}

export interface LlmMetricsRepository {
  /** Non-blocking, fail-open enqueue. False means this observation was dropped. */
  enqueue(exchange: LlmExchangeCompleted): boolean;
  flush(): Promise<void>;
  close(): Promise<void>;
  health(): LlmMetricsRepositoryHealth;
  snapshotMaxSequence(): Promise<number>;
  scan(query: LlmExchangeScanQuery): Promise<readonly StoredLlmExchange[]>;
  dimensionValues(
    dimension: LlmStatisticsDimension,
    query: Omit<LlmExchangeScanQuery, 'cursor'>,
  ): Promise<readonly LlmDimensionCount[]>;
  deleteBefore(cutoffMs: number, options?: LlmDeleteBeforeOptions): Promise<LlmDeleteBeforeResult>;
}

export class LlmMetricsRepositoryUnavailableError extends Error {
  constructor(message = 'LLM metrics repository is unavailable') {
    super(message);
    this.name = 'LlmMetricsRepositoryUnavailableError';
  }
}
