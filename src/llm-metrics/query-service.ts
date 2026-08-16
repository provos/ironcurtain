import { createHash } from 'node:crypto';

import type {
  LlmExchangeFilters,
  LlmMetricsRepository,
  LlmMetricsRepositoryHealth,
  LlmStatisticsDimension,
  LlmStatisticsDimensionValue,
  StoredLlmExchange,
} from './persistence/repository.js';
import { STATISTICS_BUCKET_SIZES_MS } from './query-contract.js';

const DTO_VERSION = 1;
const FORMULA_VERSION = 1;
const MAX_PAGE_SIZE = 500;
const MAX_SCANNED_ROWS = 10_000;
const MAX_GROUPS = 500;
const MAX_DIMENSION_VALUES = 500;
const MAX_OUTPUT_ITEMS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TIME_SERIES_BUCKETS = 1_000;
const MAX_CURSOR_BYTES = 1_024;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;
const ALLOWED_BUCKETS_MS = new Set<number>(STATISTICS_BUCKET_SIZES_MS);
const OUTPUT_CARDINALITY_ERROR = 'Statistics response exceeds the output-cardinality limit';
const OUTPUT_BYTES_ERROR = 'Statistics response exceeds the output-byte limit';

function serializedBytes(value: unknown): number {
  if (value === undefined) throw new Error(OUTPUT_BYTES_ERROR);
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized, 'utf8');
}

/** Incremental approximation plus a final exact serialized-size check. */
class StatisticsOutputBudget {
  private itemCount = 0;
  private estimatedBytes = 0;

  ensureCardinality(additionalItems: number): void {
    if (
      !Number.isSafeInteger(additionalItems) ||
      additionalItems < 0 ||
      this.itemCount + additionalItems > MAX_OUTPUT_ITEMS
    ) {
      throw new Error(OUTPUT_CARDINALITY_ERROR);
    }
  }

  addItem(value: unknown): void {
    this.ensureCardinality(1);
    this.itemCount++;
    this.addBytes(value);
  }

  addOverhead(value: unknown): void {
    this.addBytes(value);
  }

  complete<Value>(value: Value): Value {
    if (serializedBytes(value) > MAX_RESPONSE_BYTES) throw new Error(OUTPUT_BYTES_ERROR);
    return value;
  }

  private addBytes(value: unknown): void {
    // One byte conservatively covers a comma or container delimiter between
    // independently measured DTO fragments.
    this.estimatedBytes += serializedBytes(value) + 1;
    if (this.estimatedBytes > MAX_RESPONSE_BYTES) throw new Error(OUTPUT_BYTES_ERROR);
  }
}

export type LlmStatisticsMeasure =
  | 'requestCount'
  | 'refusalCount'
  | 'refusalRate'
  | 'errorCount'
  | 'errorRate'
  | 'inputTokens'
  | 'uncachedInputTokens'
  | 'cacheReadInputTokens'
  | 'cacheWriteInputTokens'
  | 'toolUseInputTokens'
  | 'thinkingTokens'
  | 'nonThinkingOutputTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'costUsd'
  | 'ttftMs'
  | 'upstreamLatencyMs'
  | 'clientLatencyMs'
  | 'observableOutputTokensPerSecond'
  | 'effectiveOutputTokensPerSecond';

const ALLOWED_MEASURES: ReadonlySet<LlmStatisticsMeasure> = new Set<LlmStatisticsMeasure>([
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
]);

export interface StatisticsRangeQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly filters?: LlmExchangeFilters;
}

export interface ExchangeQuery extends StatisticsRangeQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly snapshotMaxSequence: number;
}

export interface SummaryQuery extends StatisticsRangeQuery {
  readonly measures: readonly LlmStatisticsMeasure[];
  readonly groupBy?: readonly LlmStatisticsDimension[];
}

export interface MetricSummary {
  readonly dimensions: Readonly<Record<string, string | boolean | null>>;
  readonly measure: LlmStatisticsMeasure;
  /** Sum/count/rate for additive measures; arithmetic mean for latency and rate-per-second samples. */
  readonly value: number | null;
  readonly sampleCount: number;
  readonly eligibleCount: number;
  readonly coverage: number;
  readonly median: number | null;
  readonly lowerQuartile: number | null;
  readonly upperQuartile: number | null;
  readonly formulaVersion: number;
}

export interface TimeSeriesQuery extends SummaryQuery {
  readonly bucketMs: number;
}

export interface TimeBucket {
  readonly fromMs: number;
  readonly toMs: number;
  readonly summaries: readonly MetricSummary[];
}

export interface DimensionQuery extends StatisticsRangeQuery {
  readonly dimension: LlmStatisticsDimension;
  readonly limit?: number;
}

export interface DimensionValue {
  readonly value: LlmStatisticsDimensionValue;
  readonly count: number;
}

export interface LlmUsageTotals {
  readonly sessionId: string;
  readonly exchanges: number;
  readonly inputTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly toolUseInputTokens: number | null;
  readonly thinkingTokens: number | null;
  readonly nonThinkingOutputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly completeUsageExchanges: number;
  readonly partialUsageExchanges: number;
  readonly missingOrInvalidUsageExchanges: number;
}

export interface StatisticsCapabilities {
  readonly available: boolean;
  readonly dtoVersion: number;
  readonly formulaVersion: number;
  readonly schemaVersion: number | null;
  readonly maxPageSize: number;
  readonly maxScannedRows: number;
  readonly maxGroups: number;
  readonly allowedBucketSizesMs: readonly number[];
  readonly health: LlmMetricsRepositoryHealth;
}

export interface LlmStatisticsReader {
  listExchanges(query: ExchangeQuery): Promise<CursorPage<StoredLlmExchange>>;
  summarize(query: SummaryQuery): Promise<readonly MetricSummary[]>;
  timeSeries(query: TimeSeriesQuery): Promise<readonly TimeBucket[]>;
  dimensions(query: DimensionQuery): Promise<readonly DimensionValue[]>;
  sessionTotals(sessionId: string): Promise<LlmUsageTotals>;
  capabilities(): Promise<StatisticsCapabilities>;
}

interface CursorPayload {
  readonly version: 1;
  readonly fromMs: number;
  readonly toMs: number;
  readonly snapshotMaxSequence: number;
  readonly filtersFingerprint: string;
  readonly completedAtMs: number;
  readonly exchangeId: string;
}

const DIMENSION_VALUE: Readonly<
  Record<LlmStatisticsDimension, (row: StoredLlmExchange) => LlmStatisticsDimensionValue>
> = {
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
  bundleId: (row) => row.bundleId,
};

function validateRange(query: StatisticsRangeQuery): void {
  if (
    !Number.isSafeInteger(query.fromMs) ||
    !Number.isSafeInteger(query.toMs) ||
    query.fromMs < 0 ||
    query.toMs < query.fromMs ||
    query.toMs - query.fromMs > MAX_RANGE_MS
  ) {
    throw new Error('Statistics time range is invalid or exceeds 366 days');
  }
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error(`Invalid ${name}`);
  return result;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function filtersFingerprint(filters: LlmExchangeFilters | undefined): string {
  const entries = Object.entries(filters ?? {}) as [string, readonly (string | boolean)[]][];
  const normalized = entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, [...values].map(String).sort()]);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function decodeCursor(value: string): CursorPayload {
  if (Buffer.byteLength(value, 'utf8') > MAX_CURSOR_BYTES) throw new Error('Statistics cursor is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid statistics cursor');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('fromMs' in parsed) ||
    !Number.isSafeInteger(parsed.fromMs) ||
    !('toMs' in parsed) ||
    !Number.isSafeInteger(parsed.toMs) ||
    !('snapshotMaxSequence' in parsed) ||
    !Number.isSafeInteger(parsed.snapshotMaxSequence) ||
    !('filtersFingerprint' in parsed) ||
    typeof parsed.filtersFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.filtersFingerprint) ||
    !('completedAtMs' in parsed) ||
    !Number.isSafeInteger(parsed.completedAtMs) ||
    !('exchangeId' in parsed) ||
    typeof parsed.exchangeId !== 'string'
  ) {
    throw new Error('Invalid statistics cursor');
  }
  return parsed as CursorPayload;
}

function quantile(sorted: readonly number[], position: number): number | null {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? null;
  const low = sorted[lower];
  const high = sorted[upper];
  return low + (high - low) * (index - lower);
}

function firstVisibleOffset(row: StoredLlmExchange): number | null {
  const values = [row.firstReasoningOffsetMs, row.firstOutputOffsetMs].filter(
    (value): value is number => value !== null,
  );
  return values.length === 0 ? null : Math.min(...values);
}

function rowMeasure(row: StoredLlmExchange, measure: LlmStatisticsMeasure): number | null {
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
      // Count and span must describe the same generated-token population.
      // The current generic observer cannot prove that (it also sees control
      // envelopes), so this remains unavailable until a protocol adapter emits
      // the explicit proof flag.
      if (!row.qualityFlags.includes('output_timing_population_exact')) return null;
      const span =
        row.firstOutputOffsetMs === null || row.lastOutputOffsetMs === null
          ? null
          : row.lastOutputOffsetMs - row.firstOutputOffsetMs;
      if (span === null || span <= 0 || row.nonThinkingOutputTokens === null) return null;
      return row.nonThinkingOutputTokens / (span / 1_000);
    }
    case 'effectiveOutputTokensPerSecond': {
      const duration = row.clientDeliveryEndOffsetMs;
      if (
        row.clientAborted ||
        row.outcome === 'error' ||
        row.outcome === 'aborted' ||
        row.outcome === 'unknown' ||
        duration === null ||
        duration <= 0 ||
        row.outputTokens === null
      ) {
        return null;
      }
      return row.outputTokens / (duration / 1_000);
    }
    case 'requestCount':
    case 'refusalCount':
    case 'refusalRate':
    case 'errorCount':
    case 'errorRate':
      return null;
  }
}

function summarizeMeasure(
  rows: readonly StoredLlmExchange[],
  dimensions: Readonly<Record<string, string | boolean | null>>,
  measure: LlmStatisticsMeasure,
): MetricSummary {
  let values: number[];
  let value: number | null;
  let eligibleCount: number;
  let sampleCount: number;

  switch (measure) {
    case 'requestCount':
      values = [];
      value = rows.length;
      eligibleCount = rows.length;
      sampleCount = rows.length;
      break;
    case 'refusalCount':
    case 'refusalRate': {
      const eligible = rows.filter((row) => row.refusal !== null);
      const refused = eligible.filter((row) => row.refusal === true).length;
      values = [];
      value = measure === 'refusalCount' ? refused : eligible.length === 0 ? null : refused / eligible.length;
      eligibleCount = rows.length;
      sampleCount = eligible.length;
      break;
    }
    case 'errorCount':
    case 'errorRate': {
      const errors = rows.filter((row) => row.outcome === 'error').length;
      values = [];
      value = measure === 'errorCount' ? errors : rows.length === 0 ? null : errors / rows.length;
      eligibleCount = rows.length;
      sampleCount = rows.length;
      break;
    }
    default:
      values = rows.map((row) => rowMeasure(row, measure)).filter((entry): entry is number => entry !== null);
      eligibleCount = rows.length;
      sampleCount = values.length;
      value =
        values.length === 0
          ? null
          : measure === 'ttftMs' ||
              measure === 'upstreamLatencyMs' ||
              measure === 'clientLatencyMs' ||
              measure === 'observableOutputTokensPerSecond' ||
              measure === 'effectiveOutputTokensPerSecond'
            ? values.reduce((total, entry) => total + entry, 0) / values.length
            : values.reduce((total, entry) => total + entry, 0);
      break;
  }

  const sorted = [...values].sort((left, right) => left - right);
  return {
    dimensions,
    measure,
    value,
    sampleCount,
    eligibleCount,
    coverage: eligibleCount === 0 ? 0 : sampleCount / eligibleCount,
    median: quantile(sorted, 0.5),
    lowerQuartile: quantile(sorted, 0.25),
    upperQuartile: quantile(sorted, 0.75),
    formulaVersion: FORMULA_VERSION,
  };
}

function groupRows(
  rows: readonly StoredLlmExchange[],
  groupBy: readonly LlmStatisticsDimension[],
): readonly { dimensions: Readonly<Record<string, string | boolean | null>>; rows: readonly StoredLlmExchange[] }[] {
  if (new Set(groupBy).size !== groupBy.length || groupBy.length > 3) throw new Error('Invalid statistics grouping');
  if (groupBy.some((dimension) => !(dimension in DIMENSION_VALUE))) {
    throw new Error('Unknown statistics dimension');
  }
  if (groupBy.length === 0) return [{ dimensions: {}, rows }];
  const groups = new Map<string, { dimensions: Record<string, string | boolean | null>; rows: StoredLlmExchange[] }>();
  for (const row of rows) {
    const dimensions: Record<string, string | boolean | null> = {};
    for (const dimension of groupBy) dimensions[dimension] = DIMENSION_VALUE[dimension](row);
    const key = JSON.stringify(groupBy.map((dimension) => dimensions[dimension]));
    let group = groups.get(key);
    if (group === undefined) {
      if (groups.size >= MAX_GROUPS) throw new Error('Statistics query exceeds the group cardinality limit');
      group = { dimensions, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

function validateSummaryQuery(query: SummaryQuery): void {
  if (
    query.measures.length === 0 ||
    query.measures.length > 20 ||
    new Set(query.measures).size !== query.measures.length ||
    query.measures.some((measure) => !ALLOWED_MEASURES.has(measure))
  ) {
    throw new Error('Invalid statistics measures');
  }
  const groupBy = query.groupBy ?? [];
  if (new Set(groupBy).size !== groupBy.length || groupBy.length > 3) {
    throw new Error('Invalid statistics grouping');
  }
  if (groupBy.some((dimension) => !(dimension in DIMENSION_VALUE))) {
    throw new Error('Unknown statistics dimension');
  }
}

function summarizeRows(
  rows: readonly StoredLlmExchange[],
  query: SummaryQuery,
  budget: StatisticsOutputBudget,
): readonly MetricSummary[] {
  const groups = groupRows(rows, query.groupBy ?? []);
  budget.ensureCardinality(groups.length * query.measures.length);
  const summaries: MetricSummary[] = [];
  for (const group of groups) {
    for (const measure of query.measures) {
      const summary = summarizeMeasure(group.rows, group.dimensions, measure);
      budget.addItem(summary);
      summaries.push(summary);
    }
  }
  return summaries;
}

function optionalSum(rows: readonly StoredLlmExchange[], field: keyof StoredLlmExchange): number | null {
  const values = rows
    .map((row) => row[field])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
}

export class LlmStatisticsQueryService implements LlmStatisticsReader {
  constructor(private readonly repository: LlmMetricsRepository) {}

  async listExchanges(query: ExchangeQuery): Promise<CursorPage<StoredLlmExchange>> {
    validateRange(query);
    const limit = boundedInteger(query.limit, 100, MAX_PAGE_SIZE, 'page size');
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const queryFiltersFingerprint = filtersFingerprint(query.filters);
    if (
      cursor !== null &&
      (cursor.fromMs !== query.fromMs ||
        cursor.toMs !== query.toMs ||
        cursor.filtersFingerprint !== queryFiltersFingerprint)
    ) {
      throw new Error('Statistics cursor does not match the requested query');
    }
    const snapshotMaxSequence = cursor?.snapshotMaxSequence ?? (await this.repository.snapshotMaxSequence());
    const rows = await this.repository.scan({
      fromMs: query.fromMs,
      toMs: query.toMs,
      filters: query.filters,
      limit: limit + 1,
      snapshotMaxSequence,
      cursor: cursor === null ? undefined : { completedAtMs: cursor.completedAtMs, exchangeId: cursor.exchangeId },
    });
    const budget = new StatisticsOutputBudget();
    const items: StoredLlmExchange[] = [];
    for (const row of rows.slice(0, limit)) {
      budget.addItem(row);
      items.push(row);
    }
    const last = items.at(-1);
    const page = {
      items,
      nextCursor:
        rows.length <= limit || last === undefined
          ? null
          : encodeCursor({
              version: 1,
              fromMs: query.fromMs,
              toMs: query.toMs,
              snapshotMaxSequence,
              filtersFingerprint: queryFiltersFingerprint,
              completedAtMs: last.completedAtMs,
              exchangeId: last.exchangeId,
            }),
      snapshotMaxSequence,
    };
    budget.addOverhead({ ...page, items: [] });
    return budget.complete(page);
  }

  async summarize(query: SummaryQuery): Promise<readonly MetricSummary[]> {
    validateRange(query);
    validateSummaryQuery(query);
    const rows = await this.loadBoundedRows(query);
    const budget = new StatisticsOutputBudget();
    const summaries = summarizeRows(rows, query, budget);
    budget.addOverhead([]);
    return budget.complete(summaries);
  }

  async timeSeries(query: TimeSeriesQuery): Promise<readonly TimeBucket[]> {
    validateRange(query);
    if (!Number.isSafeInteger(query.bucketMs) || !ALLOWED_BUCKETS_MS.has(query.bucketMs)) {
      throw new Error('Invalid statistics bucket size');
    }
    validateSummaryQuery(query);
    if (Math.ceil((query.toMs - query.fromMs + 1) / query.bucketMs) > MAX_TIME_SERIES_BUCKETS) {
      throw new Error('Statistics time series exceeds the bucket limit');
    }
    const rows = await this.loadBoundedRows(query);
    const buckets = new Map<number, StoredLlmExchange[]>();
    for (const row of rows) {
      const start = query.fromMs + Math.floor((row.completedAtMs - query.fromMs) / query.bucketMs) * query.bucketMs;
      const bucket = buckets.get(start) ?? [];
      bucket.push(row);
      buckets.set(start, bucket);
    }
    const budget = new StatisticsOutputBudget();
    const result: TimeBucket[] = [];
    for (const [fromMs, bucketRows] of [...buckets.entries()].sort(([left], [right]) => left - right)) {
      const bucket = {
        fromMs,
        toMs: Math.min(fromMs + query.bucketMs, query.toMs + 1),
        summaries: summarizeRows(bucketRows, query, budget),
      };
      budget.addOverhead({ ...bucket, summaries: [] });
      result.push(bucket);
    }
    budget.addOverhead([]);
    return budget.complete(result);
  }

  async dimensions(query: DimensionQuery): Promise<readonly DimensionValue[]> {
    validateRange(query);
    if (!(query.dimension in DIMENSION_VALUE)) throw new Error('Unknown statistics dimension');
    const limit = boundedInteger(query.limit, 100, MAX_DIMENSION_VALUES, 'dimension limit');
    const values = await this.repository.dimensionValues(query.dimension, {
      fromMs: query.fromMs,
      toMs: query.toMs,
      filters: query.filters,
      limit,
    });
    if (values.length > limit) throw new Error(OUTPUT_CARDINALITY_ERROR);
    const budget = new StatisticsOutputBudget();
    const result: DimensionValue[] = [];
    for (const value of values) {
      budget.addItem(value);
      result.push(value);
    }
    budget.addOverhead([]);
    return budget.complete(result);
  }

  async sessionTotals(sessionId: string): Promise<LlmUsageTotals> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(sessionId)) throw new Error('Invalid sessionId');
    const now = Date.now();
    const rows = await this.loadBoundedRows({
      fromMs: 0,
      toMs: now,
      filters: { sessionId: [sessionId] },
    });
    return {
      sessionId,
      exchanges: rows.length,
      inputTokens: optionalSum(rows, 'inputTokens'),
      uncachedInputTokens: optionalSum(rows, 'uncachedInputTokens'),
      cacheReadInputTokens: optionalSum(rows, 'cacheReadInputTokens'),
      cacheWriteInputTokens: optionalSum(rows, 'cacheWriteInputTokens'),
      toolUseInputTokens: optionalSum(rows, 'toolUseInputTokens'),
      thinkingTokens: optionalSum(rows, 'thinkingTokens'),
      nonThinkingOutputTokens: optionalSum(rows, 'nonThinkingOutputTokens'),
      outputTokens: optionalSum(rows, 'outputTokens'),
      totalTokens: optionalSum(rows, 'totalTokens'),
      costUsd: optionalSum(rows, 'costUsd'),
      completeUsageExchanges: rows.filter((row) => row.usageCompleteness === 'complete').length,
      partialUsageExchanges: rows.filter((row) => row.usageCompleteness === 'partial').length,
      missingOrInvalidUsageExchanges: rows.filter(
        (row) => row.usageCompleteness === 'missing' || row.usageCompleteness === 'invalid',
      ).length,
    };
  }

  capabilities(): Promise<StatisticsCapabilities> {
    const health = this.repository.health();
    return Promise.resolve({
      available:
        (health.state === 'ready' || health.state === 'degraded') &&
        health.readerState !== 'unavailable' &&
        health.readerState !== 'closed',
      dtoVersion: DTO_VERSION,
      formulaVersion: FORMULA_VERSION,
      schemaVersion: health.schemaVersion,
      maxPageSize: MAX_PAGE_SIZE,
      maxScannedRows: MAX_SCANNED_ROWS,
      maxGroups: MAX_GROUPS,
      allowedBucketSizesMs: [...ALLOWED_BUCKETS_MS],
      health,
    });
  }

  private async loadBoundedRows(query: StatisticsRangeQuery): Promise<readonly StoredLlmExchange[]> {
    const snapshotMaxSequence = await this.repository.snapshotMaxSequence();
    const rows = await this.repository.scan({
      fromMs: query.fromMs,
      toMs: query.toMs,
      filters: query.filters,
      limit: MAX_SCANNED_ROWS + 1,
      snapshotMaxSequence,
    });
    if (rows.length > MAX_SCANNED_ROWS) throw new Error('Statistics query exceeds the scanned-row limit');
    return rows;
  }
}
