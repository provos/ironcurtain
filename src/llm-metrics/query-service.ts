import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type {
  LlmExchangeFilters,
  LlmMetricsRepository,
  LlmMetricsRepositoryHealth,
  LlmStatisticsDimension,
  LlmStatisticsDimensionValue,
  StoredLlmExchange,
} from './persistence/repository.js';
import {
  isValidStatisticsTimeZone,
  MAX_STATISTICS_AGGREGATION_ROWS,
  MAX_STATISTICS_DISTRIBUTION_BINS,
  MAX_STATISTICS_TOP_GROUPS,
  STATISTICS_BUCKET_SIZES_MS,
  STATISTICS_CALENDAR_BUCKET_UNITS,
  STATISTICS_DISTRIBUTION_MEASURES,
  STATISTICS_MEASURES,
  type StatisticsDistributionMeasure,
  type StatisticsMeasure,
} from './query-contract.js';

const DTO_VERSION = 2;
const FORMULA_VERSION = 1;
const MAX_PAGE_SIZE = 500;
const MAX_SCANNED_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_DURATION_MS = 5_000;
const MAX_AGGREGATION_DURATION_MS = 5_000;
const MAX_AGGREGATION_WORK_UNITS = 1_000_000;
const AGGREGATION_YIELD_WORK_UNITS = 25_000;
const AGGREGATION_DEADLINE_CHECK_ROWS = 128;
const AGGREGATION_SCAN_PAGE_SIZE = 1_000;
const MAX_GROUPS = 500;
const MAX_DIMENSION_VALUES = 500;
const MAX_OUTPUT_ITEMS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TIME_SERIES_BUCKETS = 1_000;
const MAX_CURSOR_BYTES = 1_024;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;
const DEFAULT_DISTRIBUTION_BINS = 20;
const ALLOWED_BUCKETS_MS = new Set<number>(STATISTICS_BUCKET_SIZES_MS);
const ALLOWED_MEASURES: ReadonlySet<StatisticsMeasure> = new Set(STATISTICS_MEASURES);
const ALLOWED_DISTRIBUTION_MEASURES: ReadonlySet<StatisticsDistributionMeasure> = new Set(
  STATISTICS_DISTRIBUTION_MEASURES,
);
const OUTPUT_CARDINALITY_ERROR = 'Statistics response exceeds the output-cardinality limit';
const OUTPUT_BYTES_ERROR = 'Statistics response exceeds the output-byte limit';
const AGGREGATION_WORK_ERROR = 'Statistics query exceeds the aggregation-work limit';
const AGGREGATION_DURATION_ERROR = 'Statistics query exceeds the aggregation-duration limit';

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

class StatisticsAggregationGuard {
  private readonly deadlineAt = performance.now() + MAX_AGGREGATION_DURATION_MS;
  private workSinceYield = 0;

  ensureWork(rowCount: number, passes: number): void {
    const workUnits = rowCount * passes;
    if (!Number.isSafeInteger(workUnits) || workUnits > MAX_AGGREGATION_WORK_UNITS) {
      throw new Error(AGGREGATION_WORK_ERROR);
    }
  }

  checkDeadline(): void {
    if (performance.now() > this.deadlineAt) throw new Error(AGGREGATION_DURATION_ERROR);
  }

  async checkpoint(completedWorkUnits: number): Promise<void> {
    this.checkDeadline();
    this.workSinceYield += completedWorkUnits;
    if (this.workSinceYield < AGGREGATION_YIELD_WORK_UNITS) return;
    this.workSinceYield = 0;
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.checkDeadline();
  }
}

async function forEachAggregationItem<Item>(
  items: Iterable<Item>,
  guard: StatisticsAggregationGuard,
  workUnitsPerItem: number,
  visit: (item: Item) => void,
): Promise<void> {
  let completedItems = 0;
  let pendingWorkUnits = 0;
  for (const item of items) {
    visit(item);
    completedItems += 1;
    pendingWorkUnits += workUnitsPerItem;
    if (completedItems % AGGREGATION_DEADLINE_CHECK_ROWS === 0) {
      await guard.checkpoint(pendingWorkUnits);
      pendingWorkUnits = 0;
    }
  }
  if (pendingWorkUnits > 0) await guard.checkpoint(pendingWorkUnits);
}

export type LlmStatisticsMeasure = StatisticsMeasure;
export type LlmStatisticsDistributionMeasure = StatisticsDistributionMeasure;

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
  /** Keep the highest request-count groups over the query's stable snapshot. */
  readonly topGroups?: number;
}

export interface MetricSummary {
  readonly dimensions: Readonly<Record<string, string | boolean | null>>;
  readonly measure: LlmStatisticsMeasure;
  /** Sum/count/rate for additive measures; arithmetic mean for latency and rate-per-second samples. */
  readonly value: number | null;
  readonly sampleCount: number;
  /** Distinct non-null session IDs among observations sampled for this measure. */
  readonly sampleSessionCount: number;
  readonly eligibleCount: number;
  readonly coverage: number;
  readonly median: number | null;
  readonly lowerQuartile: number | null;
  readonly upperQuartile: number | null;
  readonly formulaVersion: number;
}

export interface TimeSeriesQuery extends SummaryQuery {
  /** Fixed-duration bucket retained for backwards compatibility. Exactly one bucket form is required. */
  readonly bucketMs?: number;
  /** Calendar day in an IANA time zone. Exactly one bucket form is required. */
  readonly calendarBucket?: {
    readonly unit: 'day';
    readonly timeZone: string;
  };
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

export interface DistributionQuery extends StatisticsRangeQuery {
  readonly measure: LlmStatisticsDistributionMeasure;
  readonly maxBins?: number;
}

export interface DistributionBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
}

export interface MetricDistribution {
  readonly measure: LlmStatisticsDistributionMeasure;
  readonly bins: readonly DistributionBin[];
  readonly sampleCount: number;
  readonly eligibleCount: number;
  readonly coverage: number;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly formulaVersion: number;
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
  readonly allowedCalendarBucketUnits: readonly (typeof STATISTICS_CALENDAR_BUCKET_UNITS)[number][];
  readonly health: LlmMetricsRepositoryHealth;
}

export interface LlmStatisticsReader {
  listExchanges(query: ExchangeQuery): Promise<CursorPage<StoredLlmExchange>>;
  summarize(query: SummaryQuery): Promise<readonly MetricSummary[]>;
  timeSeries(query: TimeSeriesQuery): Promise<readonly TimeBucket[]>;
  distribution(query: DistributionQuery): Promise<MetricDistribution>;
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
  stateId: (row) => row.stateId,
  personaId: (row) => row.personaId,
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

function distinctSessionCount(rows: readonly StoredLlmExchange[]): number {
  return new Set(rows.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId]))).size;
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
  let sampleRows: readonly StoredLlmExchange[];

  switch (measure) {
    case 'requestCount':
      values = [];
      value = rows.length;
      eligibleCount = rows.length;
      sampleCount = rows.length;
      sampleRows = rows;
      break;
    case 'refusalCount':
    case 'refusalRate': {
      const eligible = rows.filter((row) => row.refusal !== null);
      const refused = eligible.filter((row) => row.refusal === true).length;
      values = [];
      value = measure === 'refusalCount' ? refused : eligible.length === 0 ? null : refused / eligible.length;
      eligibleCount = rows.length;
      sampleCount = eligible.length;
      sampleRows = eligible;
      break;
    }
    case 'errorCount':
    case 'errorRate': {
      const errors = rows.filter((row) => row.outcome === 'error').length;
      values = [];
      value = measure === 'errorCount' ? errors : rows.length === 0 ? null : errors / rows.length;
      eligibleCount = rows.length;
      sampleCount = rows.length;
      sampleRows = rows;
      break;
    }
    default: {
      const samples = rows.flatMap((row) => {
        const measured = rowMeasure(row, measure);
        return measured === null ? [] : [{ row, measured }];
      });
      values = samples.map((sample) => sample.measured);
      eligibleCount = rows.length;
      sampleCount = values.length;
      sampleRows = samples.map((sample) => sample.row);
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
  }

  const sorted = [...values].sort((left, right) => left - right);
  return {
    dimensions,
    measure,
    value,
    sampleCount,
    sampleSessionCount: distinctSessionCount(sampleRows),
    eligibleCount,
    coverage: eligibleCount === 0 ? 0 : sampleCount / eligibleCount,
    median: quantile(sorted, 0.5),
    lowerQuartile: quantile(sorted, 0.25),
    upperQuartile: quantile(sorted, 0.75),
    formulaVersion: FORMULA_VERSION,
  };
}

interface StatisticsRowGroup {
  readonly dimensions: Readonly<Record<string, string | boolean | null>>;
  readonly rows: readonly StoredLlmExchange[];
}

function rowGroupIdentity(
  row: StoredLlmExchange,
  groupBy: readonly LlmStatisticsDimension[],
): { readonly key: string; readonly dimensions: Record<string, string | boolean | null> } {
  const dimensions: Record<string, string | boolean | null> = {};
  for (const dimension of groupBy) dimensions[dimension] = DIMENSION_VALUE[dimension](row);
  return { key: JSON.stringify(groupBy.map((dimension) => dimensions[dimension])), dimensions };
}

async function groupRows(
  rows: readonly StoredLlmExchange[],
  groupBy: readonly LlmStatisticsDimension[],
  guard: StatisticsAggregationGuard,
): Promise<StatisticsRowGroup[]> {
  if (groupBy.length === 0) return [{ dimensions: {}, rows }];
  const groups = new Map<string, { dimensions: Record<string, string | boolean | null>; rows: StoredLlmExchange[] }>();
  await forEachAggregationItem(rows, guard, groupBy.length, (row) => {
    const { key, dimensions } = rowGroupIdentity(row, groupBy);
    let group = groups.get(key);
    if (group === undefined) {
      if (groups.size >= MAX_GROUPS) throw new Error('Statistics query exceeds the group cardinality limit');
      group = { dimensions, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  });
  return [...groups.values()];
}

type RankedGroup = readonly [key: string, count: number];

function compareRankedGroups(left: RankedGroup, right: RankedGroup): number {
  return right[1] - left[1] || left[0].localeCompare(right[0]);
}

function insertRankedGroup(groups: RankedGroup[], candidate: RankedGroup, limit: number): void {
  let lower = 0;
  let upper = groups.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (compareRankedGroups(candidate, groups[middle]) < 0) upper = middle;
    else lower = middle + 1;
  }
  if (lower >= limit) return;
  groups.splice(lower, 0, candidate);
  if (groups.length > limit) groups.pop();
}

async function topGroupKeys(
  rows: readonly StoredLlmExchange[],
  groupBy: readonly LlmStatisticsDimension[],
  limit: number,
  guard: StatisticsAggregationGuard,
): Promise<ReadonlySet<string>> {
  const counts = new Map<string, number>();
  await forEachAggregationItem(rows, guard, groupBy.length, (row) => {
    const { key } = rowGroupIdentity(row, groupBy);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });

  const ranked: RankedGroup[] = [];
  await forEachAggregationItem(counts, guard, 1, (entry) => insertRankedGroup(ranked, entry, limit));
  return new Set(ranked.map(([key]) => key));
}

async function retainTopGroupRows(
  rows: readonly StoredLlmExchange[],
  groupBy: readonly LlmStatisticsDimension[],
  limit: number | undefined,
  guard: StatisticsAggregationGuard,
): Promise<readonly StoredLlmExchange[]> {
  if (limit === undefined) return rows;
  const retained = await topGroupKeys(rows, groupBy, limit, guard);
  const result: StoredLlmExchange[] = [];
  await forEachAggregationItem(rows, guard, groupBy.length, (row) => {
    if (retained.has(rowGroupIdentity(row, groupBy).key)) result.push(row);
  });
  return result;
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
  if (
    query.topGroups !== undefined &&
    (!Number.isSafeInteger(query.topGroups) ||
      query.topGroups < 1 ||
      query.topGroups > MAX_STATISTICS_TOP_GROUPS ||
      groupBy.length === 0)
  ) {
    throw new Error('Invalid statistics top-groups limit');
  }
}

function summaryAggregationPasses(query: SummaryQuery, additionalPasses = 0): number {
  const groupingDimensions = query.groupBy?.length ?? 0;
  const topGroupPasses = query.topGroups === undefined ? 0 : groupingDimensions * 2;
  return query.measures.length + groupingDimensions + topGroupPasses + additionalPasses;
}

async function summarizeGroups(
  groups: readonly StatisticsRowGroup[],
  measures: readonly LlmStatisticsMeasure[],
  budget: StatisticsOutputBudget,
  guard: StatisticsAggregationGuard,
): Promise<readonly MetricSummary[]> {
  budget.ensureCardinality(groups.length * measures.length);
  const summaries: MetricSummary[] = [];
  for (const group of groups) {
    for (const measure of measures) {
      const summary = summarizeMeasure(group.rows, group.dimensions, measure);
      budget.addItem(summary);
      summaries.push(summary);
      await guard.checkpoint(group.rows.length);
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

interface CalendarDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function calendarFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
    timeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function calendarDateParts(timestampMs: number, formatter: Intl.DateTimeFormat): CalendarDateParts {
  const parts = new Map(formatter.formatToParts(timestampMs).map((part) => [part.type, part.value]));
  const year = Number(parts.get('year'));
  const month = Number(parts.get('month'));
  const day = Number(parts.get('day'));
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || !Number.isSafeInteger(day)) {
    throw new Error('Unable to calculate statistics calendar bucket');
  }
  return { year, month, day };
}

function calendarDateKey(timestampMs: number, formatter: Intl.DateTimeFormat): string {
  const { year, month, day } = calendarDateParts(timestampMs, formatter);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseCalendarDateKey(key: string): CalendarDateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) throw new Error('Unable to calculate statistics calendar bucket');
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function nextCalendarDateKey(key: string): string {
  const { year, month, day } = parseCalendarDateKey(key);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(
    next.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** Find the first instant whose local ISO calendar date is `key`. */
function calendarDateStartMs(key: string, formatter: Intl.DateTimeFormat): number {
  const { year, month, day } = parseCalendarDateKey(key);
  const approximate = Date.UTC(year, month - 1, day);
  let lower = approximate - 36 * 60 * 60 * 1_000;
  let upper = approximate + 36 * 60 * 60 * 1_000;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (calendarDateKey(middle, formatter) < key) lower = middle + 1;
    else upper = middle;
  }
  if (calendarDateKey(lower, formatter) !== key) throw new Error('Unable to calculate statistics calendar bucket');
  return lower;
}

function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const ceiling = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return ceiling * magnitude;
}

function distributionBins(sorted: readonly number[], maxBins: number): readonly DistributionBin[] {
  if (sorted.length === 0) return [];
  const minimum = sorted[0];
  const maximum = sorted[sorted.length - 1];
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
    const bin = bins[index];
    bins[index] = { ...bin, count: bin.count + 1 };
  }
  return bins;
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
    const guard = new StatisticsAggregationGuard();
    guard.ensureWork(rows.length, summaryAggregationPasses(query));
    const groupBy = query.groupBy ?? [];
    const retainedRows = await retainTopGroupRows(rows, groupBy, query.topGroups, guard);
    const groups = await groupRows(retainedRows, groupBy, guard);
    const budget = new StatisticsOutputBudget();
    const summaries = await summarizeGroups(groups, query.measures, budget, guard);
    budget.addOverhead([]);
    return budget.complete(summaries);
  }

  async timeSeries(query: TimeSeriesQuery): Promise<readonly TimeBucket[]> {
    validateRange(query);
    const hasFixedBucket = query.bucketMs !== undefined;
    const hasCalendarBucket = query.calendarBucket !== undefined;
    if (hasFixedBucket === hasCalendarBucket) throw new Error('Exactly one statistics bucket form is required');
    if (hasFixedBucket && (!Number.isSafeInteger(query.bucketMs) || !ALLOWED_BUCKETS_MS.has(query.bucketMs ?? -1))) {
      throw new Error('Invalid statistics bucket size');
    }
    if (hasCalendarBucket) {
      const calendarBucket: unknown = query.calendarBucket;
      if (
        typeof calendarBucket !== 'object' ||
        calendarBucket === null ||
        !('unit' in calendarBucket) ||
        calendarBucket.unit !== 'day' ||
        !('timeZone' in calendarBucket) ||
        typeof calendarBucket.timeZone !== 'string' ||
        !isValidStatisticsTimeZone(calendarBucket.timeZone)
      ) {
        throw new Error('Invalid statistics calendar bucket');
      }
    }
    validateSummaryQuery(query);
    if (
      hasFixedBucket &&
      Math.ceil((query.toMs - query.fromMs + 1) / (query.bucketMs ?? 1)) > MAX_TIME_SERIES_BUCKETS
    ) {
      throw new Error('Statistics time series exceeds the bucket limit');
    }
    const rows = await this.loadBoundedRows(query);
    const guard = new StatisticsAggregationGuard();
    guard.ensureWork(rows.length, summaryAggregationPasses(query, 1));
    const groupBy = query.groupBy ?? [];
    const retainedRows = await retainTopGroupRows(rows, groupBy, query.topGroups, guard);
    const budget = new StatisticsOutputBudget();
    const result: TimeBucket[] = [];

    if (hasFixedBucket) {
      const bucketMs = query.bucketMs ?? 1;
      const buckets = new Map<number, StoredLlmExchange[]>();
      await forEachAggregationItem(retainedRows, guard, 1, (row) => {
        const start = query.fromMs + Math.floor((row.completedAtMs - query.fromMs) / bucketMs) * bucketMs;
        const bucket = buckets.get(start) ?? [];
        bucket.push(row);
        buckets.set(start, bucket);
      });
      const preparedBuckets: Array<{ readonly fromMs: number; readonly groups: StatisticsRowGroup[] }> = [];
      for (const [fromMs, bucketRows] of [...buckets.entries()].sort(([left], [right]) => left - right)) {
        preparedBuckets.push({ fromMs, groups: await groupRows(bucketRows, groupBy, guard) });
      }
      budget.ensureCardinality(
        preparedBuckets.reduce((total, bucket) => total + bucket.groups.length * query.measures.length, 0),
      );
      for (const { fromMs, groups } of preparedBuckets) {
        const bucket = {
          fromMs,
          toMs: Math.min(fromMs + bucketMs, query.toMs + 1),
          summaries: await summarizeGroups(groups, query.measures, budget, guard),
        };
        budget.addOverhead({ ...bucket, summaries: [] });
        result.push(bucket);
      }
    } else {
      const calendarBucket = query.calendarBucket;
      if (calendarBucket === undefined) throw new Error('Invalid statistics calendar bucket');
      const formatter = calendarFormatter(calendarBucket.timeZone);
      const buckets = new Map<string, StoredLlmExchange[]>();
      await forEachAggregationItem(retainedRows, guard, 1, (row) => {
        const key = calendarDateKey(row.completedAtMs, formatter);
        const bucket = buckets.get(key) ?? [];
        bucket.push(row);
        buckets.set(key, bucket);
      });
      if (buckets.size > MAX_TIME_SERIES_BUCKETS) throw new Error('Statistics time series exceeds the bucket limit');
      const preparedBuckets: Array<{ readonly key: string; readonly groups: StatisticsRowGroup[] }> = [];
      for (const [key, bucketRows] of [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        preparedBuckets.push({ key, groups: await groupRows(bucketRows, groupBy, guard) });
      }
      budget.ensureCardinality(
        preparedBuckets.reduce((total, bucket) => total + bucket.groups.length * query.measures.length, 0),
      );
      for (const { key, groups } of preparedBuckets) {
        const fromMs = Math.max(query.fromMs, calendarDateStartMs(key, formatter));
        const toMs = Math.min(query.toMs + 1, calendarDateStartMs(nextCalendarDateKey(key), formatter));
        const bucket = { fromMs, toMs, summaries: await summarizeGroups(groups, query.measures, budget, guard) };
        budget.addOverhead({ ...bucket, summaries: [] });
        result.push(bucket);
      }
    }
    budget.addOverhead([]);
    return budget.complete(result);
  }

  async distribution(query: DistributionQuery): Promise<MetricDistribution> {
    validateRange(query);
    if (!ALLOWED_DISTRIBUTION_MEASURES.has(query.measure)) throw new Error('Invalid statistics distribution measure');
    const maxBins = boundedInteger(
      query.maxBins,
      DEFAULT_DISTRIBUTION_BINS,
      MAX_STATISTICS_DISTRIBUTION_BINS,
      'distribution bins',
    );
    const rows = await this.loadBoundedRows(query);
    const guard = new StatisticsAggregationGuard();
    guard.ensureWork(rows.length, 1);
    const samples = rows.flatMap((row) => {
      const value = rowMeasure(row, query.measure);
      return value === null ? [] : [value];
    });
    await guard.checkpoint(rows.length);
    const sorted = samples.sort((left, right) => left - right);
    await guard.checkpoint(samples.length);
    const result: MetricDistribution = {
      measure: query.measure,
      bins: distributionBins(sorted, maxBins),
      sampleCount: sorted.length,
      eligibleCount: rows.length,
      coverage: rows.length === 0 ? 0 : sorted.length / rows.length,
      minimum: sorted[0] ?? null,
      maximum: sorted.at(-1) ?? null,
      formulaVersion: FORMULA_VERSION,
    };
    return new StatisticsOutputBudget().complete(result);
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
      available: health.readerState !== 'unavailable' && health.readerState !== 'closed',
      dtoVersion: DTO_VERSION,
      formulaVersion: FORMULA_VERSION,
      schemaVersion: health.schemaVersion,
      maxPageSize: MAX_PAGE_SIZE,
      maxScannedRows: MAX_STATISTICS_AGGREGATION_ROWS,
      maxGroups: MAX_GROUPS,
      allowedBucketSizesMs: [...ALLOWED_BUCKETS_MS],
      allowedCalendarBucketUnits: [...STATISTICS_CALENDAR_BUCKET_UNITS],
      health,
    });
  }

  private async loadBoundedRows(query: StatisticsRangeQuery): Promise<readonly StoredLlmExchange[]> {
    const snapshotMaxSequence = await this.repository.snapshotMaxSequence();
    const startedAt = performance.now();
    const rows: StoredLlmExchange[] = [];
    let scannedBytes = 0;
    let cursor: { readonly completedAtMs: number; readonly exchangeId: string } | undefined;
    while (rows.length <= MAX_STATISTICS_AGGREGATION_ROWS) {
      if (performance.now() - startedAt > MAX_SCAN_DURATION_MS) {
        throw new Error('Statistics query exceeds the scan-duration limit');
      }
      const page = await this.repository.scan({
        fromMs: query.fromMs,
        toMs: query.toMs,
        filters: query.filters,
        limit: Math.min(AGGREGATION_SCAN_PAGE_SIZE, MAX_STATISTICS_AGGREGATION_ROWS + 1 - rows.length),
        snapshotMaxSequence,
        cursor,
      });
      if (performance.now() - startedAt > MAX_SCAN_DURATION_MS) {
        throw new Error('Statistics query exceeds the scan-duration limit');
      }
      for (const row of page) {
        if (rows.length % 128 === 0 && performance.now() - startedAt > MAX_SCAN_DURATION_MS) {
          throw new Error('Statistics query exceeds the scan-duration limit');
        }
        scannedBytes += serializedBytes(row);
        if (scannedBytes > MAX_SCANNED_BYTES) throw new Error('Statistics query exceeds the scanned-byte limit');
        rows.push(row);
      }
      if (rows.length > MAX_STATISTICS_AGGREGATION_ROWS) {
        throw new Error('Statistics query exceeds the scanned-row limit');
      }
      if (page.length < AGGREGATION_SCAN_PAGE_SIZE) break;
      const last = page.at(-1);
      if (last === undefined) break;
      cursor = { completedAtMs: last.completedAtMs, exchangeId: last.exchangeId };
    }
    return rows;
  }
}
