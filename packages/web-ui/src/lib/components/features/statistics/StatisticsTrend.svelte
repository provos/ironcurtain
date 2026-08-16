<script lang="ts">
  import type {
    StatisticsCalendarBucket,
    StatisticsTrendPoint,
    StatisticsTrendSignal,
    StatisticsTrendSignalTotal,
  } from './statistics-helpers.js';
  import { formatCoverage } from './statistics-helpers.js';

  let {
    points,
    signals = [],
    signalTotals = [],
    domainBuckets = [],
    selectedFromMs = null,
    todayFromMs = null,
    onselect = () => {},
  }: {
    points: readonly StatisticsTrendPoint[];
    signals?: readonly StatisticsTrendSignal[];
    signalTotals?: readonly StatisticsTrendSignalTotal[];
    domainBuckets?: readonly StatisticsCalendarBucket[];
    selectedFromMs?: number | null;
    todayFromMs?: number | null;
    onselect?: (fromMs: number, toMs: number) => void;
  } = $props();

  const width = 820;
  const height = 286;
  const pad = { left: 52, right: 18, top: 40, bottom: 54 };
  let svg: SVGSVGElement | undefined = $state();
  let chartShell: HTMLDivElement | undefined = $state();
  let keyboardBucket = $state<number | null>(null);
  let autoScrolledDomain: string | null = null;

  function niceMaximum(peak: number): number {
    const magnitude = 10 ** Math.floor(Math.log10(peak));
    const normalized = peak / magnitude;
    const ceiling = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return ceiling * magnitude;
  }

  function formatAxisValue(value: number, maximum: number): string {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: maximum < 4 ? 2 : maximum < 10 ? 1 : 0,
    }).format(value);
  }

  function tickIndices(count: number, maximumLabels = 7): ReadonlySet<number> {
    if (count <= 0 || maximumLabels <= 0) return new Set();
    if (count === 1 || maximumLabels === 1) return new Set([count - 1]);
    const labelCount = Math.min(count, maximumLabels);
    const last = count - 1;
    return new Set(Array.from({ length: labelCount }, (_, index) => Math.round((index * last) / (labelCount - 1))));
  }

  const indexed = $derived.by(() => {
    const pointsByBucket = new Map<number, StatisticsTrendPoint[]>();
    const signalsByBucket = new Map<number, StatisticsTrendSignal[]>();
    const signalTotalsByBucket = new Map<number, StatisticsTrendSignalTotal>();
    const seriesByKey = new Map<
      string,
      {
        key: string;
        label: string;
        color: string;
        dash: string | null;
        points: StatisticsTrendPoint[];
      }
    >();
    const pointKeys = new Set<string>();
    const bucketKeys = new Set<number>();
    let peak = 0;

    for (const point of points) {
      peak = Math.max(peak, point.upperQuartile);
      bucketKeys.add(point.fromMs);
      pointKeys.add(`${point.fromMs}\u0000${point.seriesKey}`);
      const bucketPoints = pointsByBucket.get(point.fromMs) ?? [];
      bucketPoints.push(point);
      pointsByBucket.set(point.fromMs, bucketPoints);
      const item = seriesByKey.get(point.seriesKey) ?? {
        key: point.seriesKey,
        label: point.seriesLabel,
        color: point.color,
        dash: point.dash,
        points: [],
      };
      item.points.push(point);
      seriesByKey.set(point.seriesKey, item);
    }
    for (const signal of signals) {
      bucketKeys.add(signal.fromMs);
      const bucketSignals = signalsByBucket.get(signal.fromMs) ?? [];
      bucketSignals.push(signal);
      signalsByBucket.set(signal.fromMs, bucketSignals);
    }
    for (const total of signalTotals) {
      bucketKeys.add(total.fromMs);
      signalTotalsByBucket.set(total.fromMs, total);
    }

    const buckets = [...bucketKeys].sort((left, right) => left - right);
    const labels = new Map<number, string>();
    const refusalBuckets: number[] = [];
    const errorBuckets: number[] = [];
    for (const bucket of buckets) {
      const bucketPoints = pointsByBucket.get(bucket) ?? [];
      const bucketSignals = signalsByBucket.get(bucket) ?? [];
      const signalTotal = signalTotalsByBucket.get(bucket);
      const label =
        bucketPoints[0]?.label ??
        bucketSignals[0]?.label ??
        signalTotal?.label ??
        new Date(bucket).toLocaleDateString();
      const signalSource = bucketSignals.length > 0 ? bucketSignals : bucketPoints;
      const refusalTotal =
        signalTotal?.refusalCount ?? signalSource.reduce((total, item) => total + item.refusalCount, 0);
      const errorTotal = signalTotal?.errorCount ?? signalSource.reduce((total, item) => total + item.errorCount, 0);
      const seriesCount = bucketPoints.length;
      const accessibleDate = bucket === todayFromMs ? `Today, ${label}` : label;
      labels.set(
        bucket,
        `Select ${accessibleDate}. ${seriesCount} measured provider/model series. ${refusalTotal} explicit API refusal ${refusalTotal === 1 ? 'signal' : 'signals'}; ${errorTotal} ${errorTotal === 1 ? 'error' : 'errors'}`,
      );
      if (refusalTotal > 0) refusalBuckets.push(bucket);
      if (errorTotal > 0) errorBuckets.push(bucket);
    }

    const plottedDomain =
      domainBuckets.length > 0
        ? [...domainBuckets]
        : buckets.map((bucket) => {
            const observation =
              pointsByBucket.get(bucket)?.[0] ?? signalsByBucket.get(bucket)?.[0] ?? signalTotalsByBucket.get(bucket);
            return {
              fromMs: bucket,
              toMs: observation?.toMs ?? bucket,
              label: observation?.label ?? new Date(bucket).toLocaleDateString(),
            };
          });

    return {
      buckets,
      bucketSet: new Set(buckets),
      domain: plottedDomain,
      domainKey:
        plottedDomain.length === 0
          ? ''
          : `${plottedDomain[0]?.fromMs}:${plottedDomain.at(-1)?.fromMs}:${plottedDomain.length}`,
      errorBuckets,
      labels,
      maximum: points.length > 0 ? (peak > 0 ? niceMaximum(peak) : 1) : null,
      pointsByBucket,
      refusalBuckets,
      refusalBucketSet: new Set(refusalBuckets),
      reversedPoints: [...points].reverse(),
      series: [...seriesByKey.values()].map((item) => ({
        ...item,
        points: item.points.sort((left, right) => left.fromMs - right.fromMs),
      })),
      signalOnly: [...signals]
        .filter((signal) => !pointKeys.has(`${signal.fromMs}\u0000${signal.seriesKey}`))
        .reverse(),
      signalsByBucket,
      signalTotalsByBucket,
      tickIndices: tickIndices(plottedDomain.length),
    };
  });
  const buckets = $derived(indexed.buckets);
  const series = $derived(indexed.series);
  const maximum = $derived(indexed.maximum);

  $effect(() => {
    if (buckets.length === 0) keyboardBucket = null;
    else if (keyboardBucket === null || !buckets.includes(keyboardBucket)) {
      keyboardBucket =
        selectedFromMs !== null && buckets.includes(selectedFromMs) ? selectedFromMs : (buckets.at(-1) ?? null);
    }
  });

  $effect(() => {
    const domainKey = indexed.domainKey;
    if (domainKey === '' || domainKey === autoScrolledDomain) return;
    autoScrolledDomain = domainKey;
    const frame = requestAnimationFrame(() => {
      if (chartShell && chartShell.scrollWidth > chartShell.clientWidth) {
        chartShell.scrollLeft = chartShell.scrollWidth - chartShell.clientWidth;
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  function xFor(fromMs: number): number {
    if (indexed.domain.length <= 1) return width / 2;
    const first = indexed.domain[0]?.fromMs ?? fromMs;
    const last = indexed.domain.at(-1)?.fromMs ?? fromMs;
    return ((fromMs - first) / Math.max(1, last - first)) * width;
  }

  function yFor(value: number): number {
    return height - (value / (maximum ?? 1)) * height;
  }

  function targetWidth(): number {
    return Math.max(12, width / Math.max(2, indexed.domain.length));
  }

  function targetX(fromMs: number): number {
    const slotWidth = targetWidth();
    return Math.max(0, Math.min(width - slotWidth, xFor(fromMs) - slotWidth / 2));
  }

  function linePath(
    items: readonly StatisticsTrendPoint[],
    field: 'median' | 'lowerQuartile' | 'upperQuartile',
  ): string {
    let path = '';
    let previous: StatisticsTrendPoint | undefined;
    for (const point of items) {
      const command = previous && point.fromMs - previous.fromMs <= 36 * 60 * 60 * 1_000 ? 'L' : 'M';
      path += `${command} ${xFor(point.fromMs)} ${yFor(point[field])} `;
      previous = point;
    }
    return path.trim();
  }

  function areaPath(items: readonly StatisticsTrendPoint[]): string {
    const segments: StatisticsTrendPoint[][] = [];
    for (const point of items) {
      const segment = segments.at(-1);
      const previous = segment?.at(-1);
      if (!segment || (previous && point.fromMs - previous.fromMs > 36 * 60 * 60 * 1_000)) segments.push([point]);
      else segment.push(point);
    }
    return segments
      .map((segment) => {
        const upper = segment.map((point) => `${xFor(point.fromMs)} ${yFor(point.upperQuartile)}`).join(' L ');
        const lower = [...segment]
          .reverse()
          .map((point) => `${xFor(point.fromMs)} ${yFor(point.lowerQuartile)}`)
          .join(' L ');
        return `M ${upper} L ${lower} Z`;
      })
      .join(' ');
  }

  function singletonRanges(items: readonly StatisticsTrendPoint[]): readonly StatisticsTrendPoint[] {
    const singletons: StatisticsTrendPoint[] = [];
    let segment: StatisticsTrendPoint[] = [];
    for (const point of items) {
      const previous = segment.at(-1);
      if (previous && point.fromMs - previous.fromMs > 36 * 60 * 60 * 1_000) {
        if (segment.length === 1) singletons.push(segment[0]);
        segment = [];
      }
      segment.push(point);
    }
    if (segment.length === 1) singletons.push(segment[0]);
    return singletons;
  }

  function pointsAt(fromMs: number): StatisticsTrendPoint[] {
    return indexed.pointsByBucket.get(fromMs) ?? [];
  }

  function signalsAt(fromMs: number): StatisticsTrendSignal[] {
    return indexed.signalsByBucket.get(fromMs) ?? [];
  }

  function signalTotalAt(fromMs: number): StatisticsTrendSignalTotal | undefined {
    return indexed.signalTotalsByBucket.get(fromMs);
  }

  function accessibleBucketLabel(fromMs: number): string {
    return indexed.labels.get(fromMs) ?? `Select ${new Date(fromMs).toLocaleDateString()}`;
  }

  function selectBucket(fromMs: number): void {
    keyboardBucket = fromMs;
    const observation = pointsAt(fromMs)[0] ?? signalsAt(fromMs)[0] ?? signalTotalAt(fromMs);
    if (observation) onselect(observation.fromMs, observation.toMs);
  }

  function onBucketKeydown(event: KeyboardEvent, fromMs: number): void {
    const current = buckets.indexOf(fromMs);
    let target = current;
    if (event.key === 'ArrowLeft') target = Math.max(0, current - 1);
    else if (event.key === 'ArrowRight') target = Math.min(buckets.length - 1, current + 1);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = buckets.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectBucket(fromMs);
      return;
    } else return;
    event.preventDefault();
    const next = buckets[target];
    if (next === undefined) return;
    keyboardBucket = next;
    requestAnimationFrame(() => svg?.querySelector<SVGRectElement>(`[data-bucket="${next}"]`)?.focus());
  }
</script>

<div class="chart-shell" data-testid="statistics-trend" bind:this={chartShell}>
  <svg
    bind:this={svg}
    viewBox={`0 0 ${width + pad.left + pad.right} ${height + pad.top + pad.bottom}`}
    role="group"
    aria-roledescription="interactive chart"
    aria-labelledby="statistics-trend-title statistics-trend-description"
  >
    <title id="statistics-trend-title">Effective output speed by model and provider</title>
    <desc id="statistics-trend-description">
      Daily median effective output tokens per second. Shaded regions show the middle 50 percent of measured exchanges.
      Use Left and Right Arrow to move between observed days, then Enter to open a day.
    </desc>
    <g transform={`translate(${pad.left} ${pad.top})`}>
      {#if maximum !== null}
        {#each [0, 0.25, 0.5, 0.75, 1] as fraction (fraction)}
          {@const y = height - fraction * height}
          <line class="grid" x1="0" x2={width} y1={y} y2={y} />
          <text class="axis-label" x="-10" y={y + 4} text-anchor="end">
            {formatAxisValue(maximum * fraction, maximum)}
          </text>
        {/each}
      {/if}

      {#if todayFromMs !== null && indexed.domain.some((bucket) => bucket.fromMs === todayFromMs)}
        <rect
          class="today-column"
          class:no-observation={!indexed.bucketSet.has(todayFromMs)}
          x={targetX(todayFromMs)}
          y="0"
          width={targetWidth()}
          {height}
          aria-hidden="true"
        />
      {/if}

      <!-- Paint every uncertainty band first so later series lines remain legible. -->
      {#each series as item (item.key)}
        <path class="iqr" data-series-key={encodeURIComponent(item.key)} d={areaPath(item.points)} fill={item.color} />
        {#each singletonRanges(item.points) as point (point.key)}
          <line
            class="iqr-singleton"
            data-series-key={encodeURIComponent(item.key)}
            x1={xFor(point.fromMs)}
            x2={xFor(point.fromMs)}
            y1={yFor(point.upperQuartile)}
            y2={yFor(point.lowerQuartile)}
            stroke={item.color}
          />
        {/each}
      {/each}

      {#each series as item (item.key)}
        <path
          class="median"
          data-series-key={encodeURIComponent(item.key)}
          d={linePath(item.points, 'median')}
          stroke={item.color}
          stroke-dasharray={item.dash ?? undefined}
        />
      {/each}

      {#each indexed.refusalBuckets as bucket (bucket)}
        {@const paired = indexed.errorBuckets.includes(bucket)}
        {@const markerInset = paired ? 13 : 7}
        {@const markerX = Math.max(markerInset, Math.min(width - markerInset, xFor(bucket)))}
        <path class="refusal" d={`M ${markerX + (paired ? -5 : 0)} -25 l 7 12 h -14 Z`} aria-hidden="true" />
      {/each}
      {#each indexed.errorBuckets as bucket (bucket)}
        {@const paired = indexed.refusalBucketSet.has(bucket)}
        {@const markerInset = paired ? 13 : 4}
        {@const markerX = Math.max(markerInset, Math.min(width - markerInset, xFor(bucket)))}
        <rect
          class="error-marker"
          x={markerX + (paired ? 5 : 0) - 4}
          y="-24"
          width="8"
          height="8"
          rx="1"
          aria-hidden="true"
        />
      {/each}

      {#each buckets as bucket (bucket)}
        <rect
          class:selected={selectedFromMs === bucket}
          class:today={todayFromMs === bucket}
          class="bucket-target"
          x={targetX(bucket)}
          y="0"
          width={targetWidth()}
          {height}
          data-bucket={bucket}
          tabindex={keyboardBucket === bucket ? 0 : -1}
          role="button"
          aria-pressed={selectedFromMs === bucket}
          aria-label={accessibleBucketLabel(bucket)}
          onclick={() => selectBucket(bucket)}
          onkeydown={(event) => onBucketKeydown(event, bucket)}
        />
      {/each}

      {#each indexed.domain as bucket, index (bucket.fromMs)}
        {@const x = xFor(bucket.fromMs)}
        {#if indexed.tickIndices.has(index)}
          <text
            class="axis-label date"
            class:today={todayFromMs === bucket.fromMs}
            {x}
            y={height + 27}
            text-anchor={index === 0 ? 'start' : index === indexed.domain.length - 1 ? 'end' : 'middle'}
            aria-hidden="true"
          >
            {#if todayFromMs === bucket.fromMs}
              <tspan class="today-label" {x}>Today</tspan>
              <tspan {x} dy="12">{bucket.label}</tspan>
            {:else}
              {bucket.label}
            {/if}
          </text>
        {/if}
      {/each}

      {#each series as item (item.key)}
        {#each item.points as point (point.key)}
          <circle
            class="chart-point"
            class:selected={selectedFromMs === point.fromMs}
            class:today={todayFromMs === point.fromMs}
            cx={xFor(point.fromMs)}
            cy={yFor(point.median)}
            r={selectedFromMs === point.fromMs ? 5 : todayFromMs === point.fromMs ? 4 : 3.5}
            fill={point.color}
            aria-hidden="true"
          >
            <title
              >{point.seriesLabel}: median {point.median.toFixed(1)} effective output tokens/s on {point.label}; middle
              50% {point.lowerQuartile.toFixed(1)}–{point.upperQuartile.toFixed(1)}; {formatCoverage(
                point.sampleCount,
                point.eligibleCount,
                point.sampleSessionCount,
              )}</title
            >
          </circle>
        {/each}
      {/each}

      {#if maximum !== null}
        <text class="axis-title" transform={`translate(-40 ${height / 2}) rotate(-90)`} text-anchor="middle">
          Effective output tokens/s
        </text>
      {:else}
        <text class="no-speed-label" x={width / 2} y={height / 2} text-anchor="middle"> No eligible speed sample </text>
      {/if}
    </g>
  </svg>
</div>

<p class="chart-hint">Select a day for details. Use Left and Right Arrow to move between observed days.</p>

{#if indexed.refusalBuckets.length > 0 || indexed.errorBuckets.length > 0}
  <div class="legend" aria-label="Chart signals">
    {#if indexed.refusalBuckets.length > 0}
      <span><b class="refusal-key" aria-hidden="true">▲</b> Explicit API refusal or content filter</span>
    {/if}
    {#if indexed.errorBuckets.length > 0}
      <span><b class="error-key" aria-hidden="true">■</b> Transport/provider error</span>
    {/if}
  </div>
{/if}

<details class="table-alternative">
  <summary>View trend as accessible table</summary>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="table-scroll" tabindex="0" role="region" aria-label="Effective output speed table">
    <table>
      <thead>
        <tr
          ><th>Date</th><th>Provider and model</th><th>Median</th><th>Middle 50%</th><th>Coverage</th><th>Signals</th
          ></tr
        >
      </thead>
      <tbody>
        {#each indexed.reversedPoints as point (point.key)}
          <tr>
            <th scope="row"><button type="button" onclick={() => selectBucket(point.fromMs)}>{point.label}</button></th>
            <td>{point.seriesLabel}</td>
            <td>{point.median.toFixed(1)} tok/s</td>
            <td>{point.lowerQuartile.toFixed(1)}–{point.upperQuartile.toFixed(1)}</td>
            <td>{formatCoverage(point.sampleCount, point.eligibleCount, point.sampleSessionCount)}</td>
            <td>{point.refusalCount} refusals · {point.errorCount} errors</td>
          </tr>
        {/each}
        {#each indexed.signalOnly as signal (signal.key)}
          <tr>
            <th scope="row"
              ><button type="button" onclick={() => selectBucket(signal.fromMs)}>{signal.label}</button></th
            >
            <td>{signal.seriesLabel}</td>
            <td>Unavailable</td>
            <td>—</td>
            <td>No eligible speed sample</td>
            <td>{signal.refusalCount} refusals · {signal.errorCount} errors</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</details>

<style>
  .chart-shell {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
  }
  svg {
    display: block;
    width: 100%;
    min-width: 34rem;
  }
  .grid {
    stroke: hsl(var(--border));
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .today-column {
    fill: hsl(var(--foreground) / 0.025);
    pointer-events: none;
  }
  .today-column.no-observation {
    fill: hsl(var(--primary) / 0.06);
  }
  .axis-label,
  .axis-title {
    fill: hsl(var(--muted-foreground));
    font-size: 11px;
  }
  .date {
    font-size: 10px;
  }
  .iqr {
    opacity: 0.12;
  }
  .iqr-singleton {
    opacity: 0.2;
    stroke-linecap: round;
    stroke-width: 8;
    vector-effect: non-scaling-stroke;
  }
  .median {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .chart-point {
    cursor: help;
    pointer-events: auto;
    stroke: hsl(var(--card));
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }
  .chart-point.today {
    stroke: hsl(var(--primary));
  }
  .chart-point.selected {
    stroke: hsl(var(--foreground));
    stroke-width: 2;
  }
  .refusal {
    fill: hsl(var(--destructive));
    stroke: hsl(var(--card));
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }
  .error-marker {
    fill: hsl(38 92% 45%);
    stroke: hsl(var(--card));
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }
  .bucket-target {
    fill: transparent;
    cursor: pointer;
  }
  .bucket-target:hover,
  .bucket-target.today {
    fill: hsl(var(--foreground) / 0.035);
  }
  .bucket-target.selected {
    fill: hsl(var(--primary) / 0.1);
  }
  .bucket-target:focus {
    outline: none;
    stroke: hsl(var(--ring));
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    margin-top: 0.75rem;
    color: hsl(var(--muted-foreground));
    font-size: 0.75rem;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .legend .refusal-key {
    color: hsl(var(--destructive));
  }
  .legend .error-key {
    color: hsl(38 92% 45%);
  }
  .today-label {
    fill: hsl(var(--primary));
    font-weight: 700;
  }
  .no-speed-label {
    fill: hsl(var(--muted-foreground));
    font-size: 11px;
  }
  .chart-hint {
    margin: 0.15rem 0 0;
    color: hsl(var(--muted-foreground));
    font-size: 0.7rem;
    text-align: center;
  }
  .table-alternative {
    min-width: 0;
    margin-top: 1rem;
    color: hsl(var(--muted-foreground));
    font-size: 0.8rem;
  }
  .table-alternative summary {
    cursor: pointer;
    font-weight: 600;
  }
  .table-scroll {
    width: 100%;
    max-width: 100%;
    overflow-x: auto;
    margin-top: 0.65rem;
  }
  table {
    width: 100%;
    min-width: 48rem;
    border-collapse: collapse;
    color: hsl(var(--foreground));
  }
  th,
  td {
    border-bottom: 1px solid hsl(var(--border));
    padding: 0.55rem 0.65rem;
    text-align: left;
    white-space: nowrap;
  }
  thead th {
    color: hsl(var(--muted-foreground));
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  tbody button {
    color: hsl(var(--primary));
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  @media (max-width: 640px) {
    svg {
      min-width: 42rem;
    }
  }
</style>
