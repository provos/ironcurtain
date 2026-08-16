import type {
  LlmStatisticsDimension,
  LlmStatisticsMeasure,
  StatisticsMetricSummaryDto,
  StatisticsTimeBucketDto,
} from '$lib/types.js';

export type StatisticsIdentityMode = 'routed' | 'served';

/** Resolved once per module load; calendar math is local-time by contract. */
export const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const IDENTITY_DIMENSIONS: Readonly<
  Record<StatisticsIdentityMode, readonly [LlmStatisticsDimension, LlmStatisticsDimension]>
> = {
  routed: ['logicalProvider', 'forwardedModel'],
  served: ['servedProvider', 'servedModel'],
};

export function statisticsIdentityDimensions(
  mode: StatisticsIdentityMode,
): readonly [LlmStatisticsDimension, LlmStatisticsDimension] {
  return IDENTITY_DIMENSIONS[mode];
}

export interface StatisticsTrendPoint {
  readonly key: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly label: string;
  readonly seriesKey: string;
  readonly seriesLabel: string;
  readonly color: string;
  readonly dash: string | null;
  readonly median: number;
  readonly lowerQuartile: number;
  readonly upperQuartile: number;
  readonly sampleCount: number;
  readonly sampleSessionCount: number;
  readonly eligibleCount: number;
  readonly coverage: number;
  readonly refusalCount: number;
  readonly refusalCoverage: number;
  readonly errorCount: number;
}

export interface StatisticsTrendSignal {
  readonly key: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly label: string;
  readonly seriesKey: string;
  readonly seriesLabel: string;
  readonly color: string;
  readonly refusalCount: number;
  readonly refusalCoverage: number;
  readonly errorCount: number;
}

export interface StatisticsTrendSignalTotal {
  readonly key: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly label: string;
  readonly refusalCount: number;
  readonly refusalCoverage: number;
  readonly errorCount: number;
}

export interface StatisticsCalendarBucket {
  readonly fromMs: number;
  readonly toMs: number;
  readonly label: string;
}

export interface StatisticsCalendarDomain {
  readonly range: { readonly fromMs: number; readonly toMs: number };
  readonly buckets: readonly StatisticsCalendarBucket[];
  readonly todayFromMs: number;
}

export interface StatisticsTrendData {
  readonly points: readonly StatisticsTrendPoint[];
  readonly signals: readonly StatisticsTrendSignal[];
}

export interface StatisticsModelRailItem {
  readonly key: string;
  readonly provider: string;
  readonly model: string;
  readonly color: string;
  readonly dash: string | null;
  readonly median: number | null;
  readonly lowerQuartile: number | null;
  readonly upperQuartile: number | null;
  readonly sampleCount: number;
  readonly sampleSessionCount: number;
  readonly eligibleCount: number;
  readonly coverage: number;
  readonly requestCount: number;
  readonly outputTokens: number | null;
}

export interface StatisticsTokenComposition {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly thinkingTokens: number | null;
  readonly nonThinkingOutputTokens: number | null;
  readonly unclassifiedOutputTokens: number | null;
  readonly outputBreakdownAvailable: boolean;
  readonly inputCoverage: number;
  readonly outputCoverage: number;
  readonly thinkingCoverage: number;
  readonly totalCoverage: number;
}

const SERIES_COLORS = [
  'hsl(38 92% 55%)',
  'hsl(198 82% 52%)',
  'hsl(151 62% 45%)',
  'hsl(281 72% 66%)',
  'hsl(8 78% 60%)',
  'hsl(221 83% 65%)',
  'hsl(52 82% 49%)',
  'hsl(329 68% 61%)',
] as const;

const SERIES_DASHES = [null, '8 4', '2 4', '10 3 2 3'] as const;

export interface StatisticsSeriesStyle {
  readonly color: string;
  readonly dash: string | null;
}

function hashLabel(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function seriesStyle(key: string): StatisticsSeriesStyle {
  const hash = hashLabel(key);
  return {
    color: SERIES_COLORS[hash % SERIES_COLORS.length] ?? SERIES_COLORS[0],
    dash: SERIES_DASHES[Math.floor(hash / SERIES_COLORS.length) % SERIES_DASHES.length] ?? null,
  };
}

/** Allocate stable, collision-free visual tuples for the bounded chart population. */
export function allocateSeriesStyles(keys: readonly string[]): ReadonlyMap<string, StatisticsSeriesStyle> {
  const styles = new Map<string, StatisticsSeriesStyle>();
  const used = new Set<number>();
  const slots = SERIES_COLORS.length * SERIES_DASHES.length;
  for (const key of [...new Set(keys)].sort()) {
    const hash = hashLabel(key);
    let slot = hash % slots;
    while (used.has(slot) && used.size < slots) slot = (slot + 1) % slots;
    used.add(slot);
    styles.set(key, {
      color: SERIES_COLORS[slot % SERIES_COLORS.length] ?? SERIES_COLORS[0],
      dash: SERIES_DASHES[Math.floor(slot / SERIES_COLORS.length)] ?? null,
    });
  }
  return styles;
}

/** Compact throughput display for the speed figures (median, quartiles). */
export function formatSpeed(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(value >= 100 ? 0 : 1);
}

export function formatCompactNumber(value: number | null, maximumFractionDigits = 1): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  return new Intl.NumberFormat(undefined, {
    notation: Math.abs(value) >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits,
  }).format(value);
}

export function formatCoverage(sampleCount: number, eligibleCount: number, sampleSessionCount?: number): string {
  if (eligibleCount === 0) return 'No eligible observations';
  const sessions = sampleSessionCount === undefined ? '' : ` · ${sampleSessionCount.toLocaleString()} sessions`;
  return `${sampleCount.toLocaleString()} of ${eligibleCount.toLocaleString()} observed exchanges${sessions}`;
}

export function findMeasure(
  summaries: readonly StatisticsMetricSummaryDto[],
  measure: LlmStatisticsMeasure,
): StatisticsMetricSummaryDto | undefined {
  return summaries.find((summary) => summary.measure === measure);
}

function identity(
  summary: StatisticsMetricSummaryDto,
  mode: StatisticsIdentityMode,
): {
  provider: string;
  model: string;
  key: string;
} {
  const [providerDimension, modelDimension] = statisticsIdentityDimensions(mode);
  const rawProvider = summary.dimensions[providerDimension];
  const rawModel = summary.dimensions[modelDimension];
  const provider =
    typeof rawProvider === 'string' ? rawProvider : mode === 'served' ? 'Provider not exposed' : 'Unknown provider';
  const model =
    typeof rawModel === 'string' ? rawModel : mode === 'served' ? 'Model not exposed' : 'Model not reported';
  return { provider, model, key: `${provider}\u0000${model}` };
}

function bucketLabel(fromMs: number, timeZone: string, granularity: 'day' | 'hour'): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(granularity === 'hour' ? { hour: 'numeric' } : {}),
  }).format(fromMs);
}

function groupedSummaries(
  summaries: readonly StatisticsMetricSummaryDto[],
): Map<string, readonly StatisticsMetricSummaryDto[]> {
  const groups = new Map<string, StatisticsMetricSummaryDto[]>();
  for (const summary of summaries) {
    const key = JSON.stringify(summary.dimensions);
    const group = groups.get(key) ?? [];
    group.push(summary);
    groups.set(key, group);
  }
  return groups;
}

function observationToMs(bucket: StatisticsTimeBucketDto, granularity: 'day' | 'hour', timeZone: string): number {
  // Calendar-series buckets are half-open in the statistics query contract, while
  // drilldown range queries use an inclusive upper bound. Only normalize an exact
  // next-local-midnight boundary so legacy inclusive and fixed-duration DTOs stay intact.
  if (granularity !== 'day') return bucket.toMs;
  const day = zonedParts(bucket.fromMs, timeZone);
  const nextDate = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
  const nextMidnightMs = zonedMidnight(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(),
    timeZone,
  );
  return bucket.toMs === nextMidnightMs ? Math.max(bucket.fromMs, bucket.toMs - 1) : bucket.toMs;
}

export function buildTrendData(
  buckets: readonly StatisticsTimeBucketDto[],
  mode: StatisticsIdentityMode,
  timeZone: string,
  granularity: 'day' | 'hour' = 'day',
): StatisticsTrendData {
  const points: StatisticsTrendPoint[] = [];
  const signals: StatisticsTrendSignal[] = [];
  for (const bucket of buckets) {
    const toMs = observationToMs(bucket, granularity, timeZone);
    for (const summaries of groupedSummaries(bucket.summaries).values()) {
      const speed = findMeasure(summaries, 'effectiveOutputTokensPerSecond');
      const refusal = findMeasure(summaries, 'refusalCount');
      const error = findMeasure(summaries, 'errorCount');
      const anchor = speed ?? refusal ?? error;
      if (!anchor) continue;
      const route = identity(anchor, mode);
      const style = seriesStyle(route.key);
      const label = bucketLabel(bucket.fromMs, timeZone, granularity);
      if ((refusal?.value ?? 0) > 0 || (error?.value ?? 0) > 0) {
        signals.push({
          key: `${bucket.fromMs}:${route.key}:signal`,
          fromMs: bucket.fromMs,
          toMs,
          label,
          seriesKey: route.key,
          seriesLabel: `${route.provider} · ${route.model}`,
          color: style.color,
          refusalCount: refusal?.value ?? 0,
          refusalCoverage: refusal?.coverage ?? 0,
          errorCount: error?.value ?? 0,
        });
      }
      if (
        speed?.median !== null &&
        speed?.median !== undefined &&
        speed.lowerQuartile !== null &&
        speed.upperQuartile !== null
      ) {
        points.push({
          key: `${bucket.fromMs}:${route.key}`,
          fromMs: bucket.fromMs,
          toMs,
          label,
          seriesKey: route.key,
          seriesLabel: `${route.provider} · ${route.model}`,
          color: style.color,
          dash: style.dash,
          median: speed.median,
          lowerQuartile: speed.lowerQuartile,
          upperQuartile: speed.upperQuartile,
          sampleCount: speed.sampleCount,
          sampleSessionCount: speed.sampleSessionCount,
          eligibleCount: speed.eligibleCount,
          coverage: speed.coverage,
          refusalCount: refusal?.value ?? 0,
          refusalCoverage: refusal?.coverage ?? 0,
          errorCount: error?.value ?? 0,
        });
      }
    }
  }
  const order = <Value extends { readonly fromMs: number; readonly seriesKey: string }>(left: Value, right: Value) =>
    left.fromMs - right.fromMs || left.seriesKey.localeCompare(right.seriesKey);
  return { points: points.sort(order), signals: signals.sort(order) };
}

export function buildTrendSignalTotals(
  buckets: readonly StatisticsTimeBucketDto[],
  timeZone: string,
  granularity: 'day' | 'hour' = 'day',
): StatisticsTrendSignalTotal[] {
  return buckets.map((bucket) => {
    const refusal = findMeasure(bucket.summaries, 'refusalCount');
    const error = findMeasure(bucket.summaries, 'errorCount');
    return {
      key: `${bucket.fromMs}:authoritative-signal-total`,
      fromMs: bucket.fromMs,
      toMs: observationToMs(bucket, granularity, timeZone),
      label: bucketLabel(bucket.fromMs, timeZone, granularity),
      refusalCount: refusal?.value ?? 0,
      refusalCoverage: refusal?.coverage ?? 0,
      errorCount: error?.value ?? 0,
    };
  });
}

export function collapseHiddenTrendSignals(
  signals: readonly StatisticsTrendSignal[],
  visibleSeries: ReadonlySet<string>,
): StatisticsTrendSignal[] {
  const visible = signals.filter((signal) => visibleSeries.has(signal.seriesKey));
  const hiddenByBucket = new Map<number, StatisticsTrendSignal>();
  for (const signal of signals) {
    if (visibleSeries.has(signal.seriesKey)) continue;
    const existing = hiddenByBucket.get(signal.fromMs);
    if (existing) {
      hiddenByBucket.set(signal.fromMs, {
        ...existing,
        refusalCount: existing.refusalCount + signal.refusalCount,
        errorCount: existing.errorCount + signal.errorCount,
      });
    } else {
      hiddenByBucket.set(signal.fromMs, {
        ...signal,
        key: `${signal.fromMs}:other:signal`,
        seriesKey: '__other__',
        seriesLabel: 'Hidden returned chart groups',
        color: seriesStyle('__other__').color,
        refusalCoverage: 0,
      });
    }
  }
  return [...visible, ...hiddenByBucket.values()].sort(
    (left, right) => left.fromMs - right.fromMs || left.seriesKey.localeCompare(right.seriesKey),
  );
}

export function buildModelRail(
  summaries: readonly StatisticsMetricSummaryDto[],
  mode: StatisticsIdentityMode,
): StatisticsModelRailItem[] {
  const items: StatisticsModelRailItem[] = [];
  for (const group of groupedSummaries(summaries).values()) {
    const anchor = group[0];
    if (!anchor) continue;
    const route = identity(anchor, mode);
    const speed = findMeasure(group, 'effectiveOutputTokensPerSecond');
    const requests = findMeasure(group, 'requestCount');
    const output = findMeasure(group, 'outputTokens');
    const style = seriesStyle(route.key);
    items.push({
      key: route.key,
      provider: route.provider,
      model: route.model,
      color: style.color,
      dash: style.dash,
      median: speed?.median ?? null,
      lowerQuartile: speed?.lowerQuartile ?? null,
      upperQuartile: speed?.upperQuartile ?? null,
      sampleCount: speed?.sampleCount ?? 0,
      sampleSessionCount: speed?.sampleSessionCount ?? 0,
      eligibleCount: speed?.eligibleCount ?? requests?.eligibleCount ?? 0,
      coverage: speed?.coverage ?? 0,
      requestCount: requests?.value ?? 0,
      outputTokens: output?.value ?? null,
    });
  }
  return items.sort((left, right) => right.requestCount - left.requestCount || left.key.localeCompare(right.key));
}

export function buildTokenComposition(summaries: readonly StatisticsMetricSummaryDto[]): StatisticsTokenComposition {
  const input = findMeasure(summaries, 'inputTokens');
  const output = findMeasure(summaries, 'outputTokens');
  const total = findMeasure(summaries, 'totalTokens');
  const thinking = findMeasure(summaries, 'thinkingTokens');
  const nonThinking = findMeasure(summaries, 'nonThinkingOutputTokens');
  const outputValue = output?.value ?? null;
  const thinkingValue = thinking?.value ?? null;
  const nonThinkingValue = nonThinking?.value ?? null;
  const aligned =
    outputValue !== null &&
    thinkingValue !== null &&
    nonThinkingValue !== null &&
    output !== undefined &&
    thinking !== undefined &&
    nonThinking !== undefined &&
    output.sampleCount === thinking.sampleCount &&
    output.sampleCount === nonThinking.sampleCount &&
    output.sampleSessionCount === thinking.sampleSessionCount &&
    output.sampleSessionCount === nonThinking.sampleSessionCount &&
    output.eligibleCount === thinking.eligibleCount &&
    output.eligibleCount === nonThinking.eligibleCount &&
    output.sampleCount === output.eligibleCount &&
    thinking.sampleCount === thinking.eligibleCount &&
    nonThinking.sampleCount === nonThinking.eligibleCount &&
    output.coverage === 1 &&
    thinking.coverage === 1 &&
    nonThinking.coverage === 1 &&
    thinkingValue + nonThinkingValue <= outputValue + Number.EPSILON * Math.max(1, outputValue);
  return {
    inputTokens: input?.value ?? null,
    outputTokens: outputValue,
    totalTokens: total?.value ?? null,
    thinkingTokens: aligned ? thinkingValue : null,
    nonThinkingOutputTokens: aligned ? nonThinkingValue : null,
    unclassifiedOutputTokens: aligned ? Math.max(0, outputValue - thinkingValue - nonThinkingValue) : outputValue,
    outputBreakdownAvailable: aligned,
    inputCoverage: input?.coverage ?? 0,
    outputCoverage: output?.coverage ?? 0,
    thinkingCoverage: thinking?.coverage ?? 0,
    totalCoverage: total?.coverage ?? 0,
  };
}

function zonedParts(timestampMs: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestampMs);
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day') };
}

function zonedMidnight(year: number, month: number, day: number, timeZone: string): number {
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(candidate);
    const read = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(local.find((part) => part.type === type)?.value);
    const represented = Date.UTC(
      read('year'),
      read('month') - 1,
      read('day'),
      read('hour'),
      read('minute'),
      read('second'),
    );
    const next = candidate + target - represented;
    if (next === candidate) return next;
    candidate = next;
  }
  return candidate;
}

export function calendarDayDomain(nowMs: number, days: number, timeZone: string): StatisticsCalendarDomain {
  const today = zonedParts(nowMs, timeZone);
  const buckets = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day - days + 1 + index));
    const nextDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
    const fromMs = zonedMidnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), timeZone);
    const nextFromMs = zonedMidnight(
      nextDate.getUTCFullYear(),
      nextDate.getUTCMonth() + 1,
      nextDate.getUTCDate(),
      timeZone,
    );
    return { fromMs, toMs: nextFromMs - 1, label: bucketLabel(fromMs, timeZone, 'day') };
  });
  const first = buckets[0];
  const last = buckets.at(-1);
  if (first === undefined || last === undefined) throw new Error('Statistics calendar domain must contain a day');
  return {
    range: { fromMs: first.fromMs, toMs: last.toMs },
    buckets,
    todayFromMs: last.fromMs,
  };
}

export function calendarRange(nowMs: number, days: number, timeZone: string): { fromMs: number; toMs: number } {
  return calendarDayDomain(nowMs, days, timeZone).range;
}

export interface StatisticsRequestLimiter {
  run<Value>(task: () => Promise<Value>): Promise<Value>;
  readonly active: number;
}

export function createStatisticsRequestLimiter(maximum = 2): StatisticsRequestLimiter {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid statistics concurrency limit');
  let active = 0;
  const waiters: Array<() => void> = [];
  const admit = async (): Promise<void> => {
    if (active < maximum) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active++;
  };
  const release = (): void => {
    active--;
    waiters.shift()?.();
  };
  return {
    get active() {
      return active;
    },
    async run<Value>(task: () => Promise<Value>): Promise<Value> {
      await admit();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}
