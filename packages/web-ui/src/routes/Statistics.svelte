<script lang="ts">
  import type {
    StatisticsCapabilitiesDto,
    StatisticsMetricDistributionDto,
    StatisticsMetricSummaryDto,
    StatisticsTimeBucketDto,
  } from '$lib/types.js';
  import {
    appState,
    connectionGeneration,
    getStatisticsCapabilities,
    getStatisticsDistribution,
    getStatisticsSeries,
    getStatisticsSummary,
  } from '$lib/stores.svelte.js';
  import StatisticsHero from '$lib/components/features/statistics/StatisticsHero.svelte';
  import StatisticsTrend from '$lib/components/features/statistics/StatisticsTrend.svelte';
  import StatisticsTokenCompositionView from '$lib/components/features/statistics/StatisticsTokenComposition.svelte';
  import StatisticsModelRail from '$lib/components/features/statistics/StatisticsModelRail.svelte';
  import StatisticsQuality from '$lib/components/features/statistics/StatisticsQuality.svelte';
  import StatisticsDayDrilldown from '$lib/components/features/statistics/StatisticsDayDrilldown.svelte';
  import TokenEnvyPromotion from '$lib/components/features/statistics/TokenEnvyPromotion.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Card } from '$lib/components/ui/card/index.js';
  import {
    allocateSeriesStyles,
    buildModelRail,
    buildTokenComposition,
    buildTrendData,
    buildTrendSignalTotals,
    calendarDayDomain,
    calendarRange,
    collapseHiddenTrendSignals,
    createStatisticsRequestLimiter,
    findMeasure,
    statisticsIdentityDimensions,
    type StatisticsIdentityMode,
  } from '$lib/components/features/statistics/statistics-helpers.js';

  const HOUR_MS = 60 * 60 * 1_000;
  const STALE = Symbol('stale statistics request');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const limiter = createStatisticsRequestLimiter(2);
  const MAX_VISIBLE_TREND_SERIES = 4;
  const MAX_RETURNED_TREND_SERIES = 8;
  const initialTrendDomain = calendarDayDomain(Date.now(), 30, timeZone);

  let rangeDays = $state<7 | 30 | 90>(30);
  let identityMode = $state<StatisticsIdentityMode>('routed');
  let loadedIdentityMode = $state<StatisticsIdentityMode>('routed');
  let capabilities = $state<StatisticsCapabilitiesDto | null>(null);
  let overall = $state<readonly StatisticsMetricSummaryDto[]>([]);
  let weekly = $state<readonly StatisticsMetricSummaryDto[]>([]);
  let grouped = $state<readonly StatisticsMetricSummaryDto[]>([]);
  let daily = $state<readonly StatisticsTimeBucketDto[]>([]);
  let dailySignalTotals = $state<readonly StatisticsTimeBucketDto[]>([]);
  let trendDomainBuckets = $state(initialTrendDomain.buckets);
  let todayFromMs = $state(initialTrendDomain.todayFromMs);
  let visibleTrendSeries = $state<Set<string>>(new Set());
  let loading = $state(true);
  let error = $state('');
  let loadGeneration = 0;
  let retryGeneration = $state(0);

  let selectedRange = $state<{ fromMs: number; toMs: number } | null>(null);
  let selectedSummary = $state<readonly StatisticsMetricSummaryDto[]>([]);
  let selectedHourly = $state<readonly StatisticsTimeBucketDto[]>([]);
  let selectedDistribution = $state<StatisticsMetricDistributionDto | null>(null);
  let selectedLoading = $state(false);
  let selectedError = $state('');
  let detailGeneration = 0;

  const requestCount = $derived(findMeasure(overall, 'requestCount'));
  const speed = $derived(findMeasure(overall, 'effectiveOutputTokensPerSecond'));
  const refusalCount = $derived(findMeasure(overall, 'refusalCount'));
  const errorCount = $derived(findMeasure(overall, 'errorCount'));
  const composition = $derived(buildTokenComposition(overall));
  const weeklyComposition = $derived(buildTokenComposition(weekly));
  function orderedObservedSeriesKeys(
    rail: readonly { readonly key: string }[],
    trend: {
      readonly points: readonly { readonly seriesKey: string }[];
      readonly signals: readonly { readonly seriesKey: string }[];
    },
  ): string[] {
    const observed = new Set([
      ...trend.points.map((point) => point.seriesKey),
      ...trend.signals.map((signal) => signal.seriesKey),
    ]);
    return [...new Set([...rail.map((item) => item.key).filter((key) => observed.has(key)), ...observed])].slice(
      0,
      MAX_RETURNED_TREND_SERIES,
    );
  }

  const rawTrendData = $derived(buildTrendData(daily, loadedIdentityMode, timeZone));
  const rawRailItems = $derived(buildModelRail(grouped, loadedIdentityMode));
  const availableSeriesKeys = $derived(orderedObservedSeriesKeys(rawRailItems, rawTrendData));
  const allocatedSeriesStyles = $derived(
    allocateSeriesStyles([...new Set([...availableSeriesKeys, ...rawRailItems.map((item) => item.key)])]),
  );
  const trendData = $derived({
    points: rawTrendData.points.map((point) => ({
      ...point,
      ...(allocatedSeriesStyles.get(point.seriesKey) ?? { color: point.color, dash: point.dash }),
    })),
    signals: rawTrendData.signals.map((signal) => ({
      ...signal,
      color: allocatedSeriesStyles.get(signal.seriesKey)?.color ?? signal.color,
    })),
  });
  const trendPoints = $derived(trendData.points);
  const trendSignals = $derived(trendData.signals);
  const authoritativeTrendSignalTotals = $derived(buildTrendSignalTotals(dailySignalTotals, timeZone));
  const hasAuthoritativeTrendSignals = $derived(
    authoritativeTrendSignalTotals.some((total) => total.refusalCount > 0 || total.errorCount > 0),
  );
  const railItems = $derived(
    rawRailItems.map((item) => ({
      ...item,
      ...(allocatedSeriesStyles.get(item.key) ?? { color: item.color, dash: item.dash }),
    })),
  );
  const trendSeriesOptions = $derived(
    availableSeriesKeys.flatMap((key) => {
      const point = trendPoints.find((item) => item.seriesKey === key);
      const signal = trendSignals.find((item) => item.seriesKey === key);
      const rail = railItems.find((item) => item.key === key);
      const label = point?.seriesLabel ?? signal?.seriesLabel ?? (rail ? `${rail.provider} · ${rail.model}` : null);
      const color = point?.color ?? signal?.color ?? rail?.color;
      if (label === null || color === undefined) return [];
      return [{ key, label, color, dash: point?.dash ?? rail?.dash ?? null }];
    }),
  );
  const activeSeriesKeys = $derived(
    new Set(availableSeriesKeys.filter((key) => visibleTrendSeries.has(key)).slice(0, MAX_VISIBLE_TREND_SERIES)),
  );
  const displayedTrendPoints = $derived(trendPoints.filter((point) => activeSeriesKeys.has(point.seriesKey)));
  const displayedTrendSignals = $derived(collapseHiddenTrendSignals(trendSignals, activeSeriesKeys));
  const detailPoints = $derived(
    buildTrendData(selectedHourly, loadedIdentityMode, timeZone, 'hour')
      .points.filter((point) => activeSeriesKeys.has(point.seriesKey))
      .map((point) => ({
        ...point,
        ...(allocatedSeriesStyles.get(point.seriesKey) ?? { color: point.color, dash: point.dash }),
      })),
  );
  const detailComposition = $derived(buildTokenComposition(selectedSummary));
  const rangeLabel = $derived(`Last ${rangeDays} local calendar days · ${timeZone}`);
  const isEmpty = $derived(!loading && !error && capabilities?.available === true && (requestCount?.value ?? 0) === 0);

  $effect(() => {
    void connectionGeneration.value;
    void retryGeneration;
    const connected = appState.connected;
    const requestedDays = rangeDays;
    const requestedIdentity = identityMode;
    if (!connected) {
      loadGeneration++;
      loading = false;
      error = 'Connect to the IronCurtain daemon to view statistics.';
      return;
    }
    const generation = ++loadGeneration;
    detailGeneration++;
    selectedRange = null;
    loading = true;
    error = '';
    const timer = setTimeout(() => void loadDashboard(generation, requestedDays, requestedIdentity), 100);
    return () => {
      clearTimeout(timer);
      loadGeneration++;
      detailGeneration++;
    };
  });

  function isCurrent(generation: number): boolean {
    return generation === loadGeneration && appState.connected;
  }

  async function runDashboardRequest<Value>(generation: number, request: () => Promise<Value>): Promise<Value> {
    return limiter.run(async () => {
      if (!isCurrent(generation)) throw STALE;
      return request();
    });
  }

  async function loadDashboard(generation: number, days: 7 | 30 | 90, mode: StatisticsIdentityMode): Promise<void> {
    try {
      const nextCapabilities = await runDashboardRequest(generation, getStatisticsCapabilities);
      if (!isCurrent(generation)) return;
      capabilities = nextCapabilities;
      if (!nextCapabilities.available) {
        overall = [];
        weekly = [];
        grouped = [];
        daily = [];
        dailySignalTotals = [];
        loading = false;
        return;
      }

      const nowMs = Date.now();
      const nextTrendDomain = calendarDayDomain(nowMs, days, timeZone);
      const range = nextTrendDomain.range;
      const weekRange = calendarRange(nowMs, 7, timeZone);
      const groupBy = statisticsIdentityDimensions(mode);
      const [nextOverall, nextDaily, nextSignalTotals, nextGrouped, nextWeekly] = await Promise.all([
        runDashboardRequest(generation, () =>
          getStatisticsSummary({
            ...range,
            measures: [
              'requestCount',
              'refusalCount',
              'errorCount',
              'inputTokens',
              'outputTokens',
              'thinkingTokens',
              'nonThinkingOutputTokens',
              'totalTokens',
              'effectiveOutputTokensPerSecond',
            ],
          }),
        ),
        runDashboardRequest(generation, () =>
          getStatisticsSeries({
            ...range,
            measures: ['effectiveOutputTokensPerSecond', 'refusalCount', 'errorCount'],
            groupBy,
            topGroups: MAX_RETURNED_TREND_SERIES,
            calendarBucket: { unit: 'day', timeZone },
          }),
        ),
        runDashboardRequest(generation, () =>
          getStatisticsSeries({
            ...range,
            measures: ['refusalCount', 'errorCount'],
            calendarBucket: { unit: 'day', timeZone },
          }),
        ),
        runDashboardRequest(generation, () =>
          getStatisticsSummary({
            ...range,
            measures: ['requestCount', 'outputTokens', 'effectiveOutputTokensPerSecond'],
            groupBy,
            topGroups: MAX_RETURNED_TREND_SERIES,
          }),
        ),
        runDashboardRequest(generation, () =>
          getStatisticsSummary({
            ...weekRange,
            measures: ['inputTokens', 'outputTokens', 'thinkingTokens', 'nonThinkingOutputTokens', 'totalTokens'],
          }),
        ),
      ]);
      if (!isCurrent(generation)) return;
      overall = nextOverall;
      daily = nextDaily;
      dailySignalTotals = nextSignalTotals;
      grouped = nextGrouped;
      weekly = nextWeekly;
      loadedIdentityMode = mode;
      trendDomainBuckets = nextTrendDomain.buckets;
      todayFromMs = nextTrendDomain.todayFromMs;
      const nextTrend = buildTrendData(nextDaily, mode, timeZone);
      const nextRail = buildModelRail(nextGrouped, mode);
      visibleTrendSeries = new Set(orderedObservedSeriesKeys(nextRail, nextTrend).slice(0, MAX_VISIBLE_TREND_SERIES));
    } catch (reason) {
      if (reason === STALE || !isCurrent(generation)) return;
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      if (isCurrent(generation)) loading = false;
    }
  }

  function selectDay(fromMs: number, toMs: number): void {
    selectedRange = { fromMs, toMs };
    void loadDay({ fromMs, toMs });
  }

  function toggleTrendSeries(key: string): void {
    const next = new Set(activeSeriesKeys);
    if (next.has(key)) {
      if (next.size === 1) return;
      next.delete(key);
    } else if (next.size < MAX_VISIBLE_TREND_SERIES) next.add(key);
    visibleTrendSeries = next;
  }

  function closeDay(): void {
    detailGeneration++;
    selectedRange = null;
    selectedLoading = false;
  }

  async function loadDay(range: { fromMs: number; toMs: number }): Promise<void> {
    const generation = ++detailGeneration;
    const dashboardAtStart = loadGeneration;
    selectedLoading = true;
    selectedError = '';
    selectedSummary = [];
    selectedHourly = [];
    selectedDistribution = null;
    const current = (): boolean =>
      generation === detailGeneration && dashboardAtStart === loadGeneration && selectedRange?.fromMs === range.fromMs;
    const run = <Value,>(request: () => Promise<Value>): Promise<Value> =>
      limiter.run(async () => {
        if (!current()) throw STALE;
        return request();
      });
    try {
      const hourlySupported = capabilities?.allowedBucketSizesMs.includes(HOUR_MS) === true;
      const [nextSummary, nextHourly, nextDistribution] = await Promise.all([
        run(() =>
          getStatisticsSummary({
            ...range,
            measures: ['inputTokens', 'outputTokens', 'thinkingTokens', 'nonThinkingOutputTokens', 'totalTokens'],
          }),
        ),
        hourlySupported
          ? run(() =>
              getStatisticsSeries({
                ...range,
                measures: ['effectiveOutputTokensPerSecond', 'refusalCount', 'errorCount'],
                groupBy: statisticsIdentityDimensions(loadedIdentityMode),
                topGroups: MAX_RETURNED_TREND_SERIES,
                bucketMs: HOUR_MS,
              }),
            )
          : Promise.resolve([]),
        run(() => getStatisticsDistribution({ ...range, measure: 'effectiveOutputTokensPerSecond', maxBins: 16 })),
      ]);
      if (!current()) return;
      selectedSummary = nextSummary;
      selectedHourly = nextHourly;
      selectedDistribution = nextDistribution;
    } catch (reason) {
      if (reason === STALE || !current()) return;
      selectedError = reason instanceof Error ? reason.message : String(reason);
    } finally {
      if (current()) selectedLoading = false;
    }
  }

  function selectedDayLabel(range: { fromMs: number; toMs: number }): string {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(range.fromMs);
  }

  function retry(): void {
    retryGeneration++;
  }
</script>

<div class="statistics-page">
  <nav class="controls" aria-label="Statistics controls">
    <fieldset>
      <legend>Time range</legend>
      {#each [7, 30, 90] as days (days)}
        <button
          type="button"
          class:active={rangeDays === days}
          aria-pressed={rangeDays === days}
          onclick={() => (rangeDays = days as 7 | 30 | 90)}>{days}d</button
        >
      {/each}
    </fieldset>
    <fieldset>
      <legend>Model identity</legend>
      <button
        type="button"
        class:active={identityMode === 'routed'}
        aria-pressed={identityMode === 'routed'}
        onclick={() => (identityMode = 'routed')}>Routed model</button
      >
      <button
        type="button"
        class:active={identityMode === 'served'}
        aria-pressed={identityMode === 'served'}
        onclick={() => (identityMode = 'served')}>Served model</button
      >
    </fieldset>
  </nav>

  {#if loading}
    <section class="page-state" role="status">
      <span class="loader"></span>
      <h1>Loading statistics</h1>
      <p>Reading persisted observations…</p>
    </section>
  {:else if error}
    <section class="page-state error" role="alert">
      <h1>Statistics unavailable</h1>
      <p>{error}</p>
    </section>
  {:else if capabilities && !capabilities.available && capabilities.health.state === 'disabled'}
    <section class="page-state">
      <h1>Statistics are disabled</h1>
      <p>Enable LLM statistics in Settings and send supported provider traffic to begin collecting observations.</p>
    </section>
  {:else if capabilities && !capabilities.available}
    <section class="page-state" role="status">
      <h1>Statistics temporarily unavailable</h1>
      <p>The statistics reader is unavailable. Captured observations can continue to reach the writer.</p>
      <dl class="health-facts" aria-label="Statistics repository health">
        <div>
          <dt>Reader</dt>
          <dd>{capabilities.health.readerState}</dd>
        </div>
        <div>
          <dt>Writer</dt>
          <dd>{capabilities.health.state}</dd>
        </div>
        <div>
          <dt>Persisted</dt>
          <dd>{capabilities.health.persisted.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Dropped</dt>
          <dd>{capabilities.health.dropped.toLocaleString()}</dd>
        </div>
      </dl>
      <Button variant="outline" onclick={retry}>Retry</Button>
    </section>
  {:else if isEmpty}
    <section class="page-state">
      <h1>No observed exchanges</h1>
      <p>No supported LLM requests completed in the selected local-calendar range.</p>
    </section>
  {:else if capabilities}
    <StatisticsHero {speed} {rangeLabel} />

    <Card class="min-w-0 overflow-hidden p-5" role="region" aria-labelledby="trend-heading">
      <header class="panel-heading">
        <div>
          <p class="eyebrow">Longitudinal view</p>
          <h2 id="trend-heading">Speed over time</h2>
          <p>
            Daily median with the middle 50% shaded for the busiest provider/model groups. Missing points mean no
            eligible effective-speed sample was observed.
          </p>
        </div>
        <span>{loadedIdentityMode === 'served' ? 'Served identity' : 'Routed identity'}</span>
      </header>
      {#if trendSeriesOptions.length > 0}
        <div class="series-filters" aria-label="Visible provider and model series">
          {#each trendSeriesOptions as option (option.key)}
            {@const active = activeSeriesKeys.has(option.key)}
            <button
              type="button"
              class:inactive={!active}
              aria-pressed={active}
              aria-label={`${active ? 'Hide' : 'Show'} ${option.label}`}
              data-series-key={encodeURIComponent(option.key)}
              disabled={active ? activeSeriesKeys.size === 1 : activeSeriesKeys.size >= MAX_VISIBLE_TREND_SERIES}
              onclick={() => toggleTrendSeries(option.key)}
            >
              <svg viewBox="0 0 24 8" aria-hidden="true">
                <line
                  x1="1"
                  x2="23"
                  y1="4"
                  y2="4"
                  stroke={option.color}
                  stroke-width="3"
                  stroke-linecap="round"
                  stroke-dasharray={option.dash ?? undefined}
                />
              </svg>
              <span>{option.label}</span>
            </button>
          {/each}
          <small>Choose up to four</small>
        </div>
      {/if}
      {#if displayedTrendPoints.length > 0 || displayedTrendSignals.length > 0 || hasAuthoritativeTrendSignals}
        <StatisticsTrend
          points={displayedTrendPoints}
          signals={displayedTrendSignals}
          signalTotals={authoritativeTrendSignalTotals}
          domainBuckets={trendDomainBuckets}
          selectedFromMs={selectedRange?.fromMs ?? null}
          {todayFromMs}
          onselect={selectDay}
        />
      {:else}
        <p class="inline-empty">No eligible effective-speed samples were observed in this period.</p>
      {/if}
    </Card>

    {#if selectedRange}
      <StatisticsDayDrilldown
        label={selectedDayLabel(selectedRange)}
        loading={selectedLoading}
        error={selectedError}
        points={detailPoints}
        composition={detailComposition}
        distribution={selectedDistribution}
        onclose={closeDay}
      />
    {/if}

    <div class="token-grid">
      <StatisticsTokenCompositionView
        {composition}
        title={`Observed token volume · ${rangeDays} days`}
        description="Input and output are shown once; thinking is a subset of output when providers expose a consistent split."
        titleId="range-token-volume-title"
      />
      <StatisticsTokenCompositionView
        composition={weeklyComposition}
        title="Weekly observed usage"
        description={`The last 7 local calendar days in ${timeZone}. This is observed proxy traffic, not provider billing.`}
        titleId="weekly-token-volume-title"
      />
    </div>

    <StatisticsModelRail items={railItems} mode={loadedIdentityMode} />
    <StatisticsQuality
      requests={requestCount}
      refusals={refusalCount}
      errors={errorCount}
      health={capabilities.health}
    />
    <TokenEnvyPromotion />
  {/if}
</div>

<style>
  .statistics-page {
    display: grid;
    gap: 1rem;
    width: 100%;
    min-width: 0;
    padding: clamp(1rem, 3vw, 1.75rem);
    max-width: 96rem;
    margin: 0 auto;
    animation: fade-in 0.2s ease-out;
  }
  .controls {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  fieldset {
    display: flex;
    gap: 0.25rem;
    margin: 0;
    padding: 0.2rem;
    border: 1px solid hsl(var(--border));
    border-radius: calc(var(--radius) - 1px);
    background: hsl(var(--muted) / 0.35);
  }
  legend {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  fieldset button {
    padding: 0.42rem 0.7rem;
    border-radius: calc(var(--radius) - 4px);
    color: hsl(var(--muted-foreground));
    font-size: 0.72rem;
    font-weight: 600;
  }
  fieldset button.active {
    color: hsl(var(--foreground));
    background: hsl(var(--card));
    box-shadow: 0 1px 3px hsl(0 0% 0% / 0.12);
  }
  fieldset button:focus-visible {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 2px;
  }
  .panel-heading {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: start;
    margin-bottom: 0.85rem;
  }
  .panel-heading h2 {
    margin: 0.12rem 0 0;
    font-size: 1.35rem;
    line-height: 1.2;
    letter-spacing: -0.035em;
  }
  .panel-heading p {
    max-width: 42rem;
    margin: 0.45rem 0 0;
    color: hsl(var(--muted-foreground));
    font-size: 0.8rem;
  }
  .panel-heading .eyebrow {
    margin: 0;
    font-size: 0.63rem;
    font-weight: 750;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .panel-heading span {
    padding: 0.25rem 0.45rem;
    border: 1px solid hsl(var(--border));
    border-radius: 999px;
    color: hsl(var(--muted-foreground));
    font-size: 0.65rem;
    white-space: nowrap;
  }
  .series-filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin: 0.9rem 0 0.15rem;
  }
  .series-filters button {
    display: inline-flex;
    align-items: center;
    gap: 0.42rem;
    max-width: min(100%, 24rem);
    padding: 0.42rem 0.68rem;
    border: 1px solid hsl(var(--border));
    border-radius: 999px;
    background: hsl(var(--muted) / 0.22);
    color: hsl(var(--foreground));
    font-size: 0.72rem;
    transition:
      opacity 120ms ease,
      background 120ms ease,
      border-color 120ms ease;
  }
  .series-filters button:hover:not(:disabled),
  .series-filters button:focus-visible {
    border-color: hsl(var(--ring) / 0.7);
    background: hsl(var(--muted) / 0.5);
  }
  .series-filters button:focus-visible {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 2px;
  }
  .series-filters button.inactive {
    opacity: 0.42;
  }
  .series-filters button:disabled {
    cursor: not-allowed;
  }
  .series-filters svg {
    width: 1.5rem;
    flex: 0 0 auto;
  }
  .series-filters span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .series-filters small {
    color: hsl(var(--muted-foreground));
    font-size: 0.66rem;
  }
  .token-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
  .inline-empty {
    padding: 1.25rem;
    border-radius: calc(var(--radius) - 2px);
    background: hsl(var(--muted) / 0.35);
    color: hsl(var(--muted-foreground));
    font-size: 0.8rem;
  }
  .page-state {
    display: grid;
    justify-items: center;
    align-content: center;
    min-height: 60vh;
    text-align: center;
  }
  .page-state h1 {
    margin: 0.7rem 0 0.3rem;
    font-size: 1.5rem;
  }
  .page-state p {
    max-width: 34rem;
    margin: 0;
    color: hsl(var(--muted-foreground));
    font-size: 0.85rem;
  }
  .health-facts {
    display: grid;
    grid-template-columns: repeat(4, minmax(5rem, 1fr));
    gap: 0.5rem;
    width: min(100%, 30rem);
    margin: 1rem 0;
  }
  .health-facts div {
    display: grid;
    gap: 0.15rem;
    padding: 0.65rem;
    border-radius: calc(var(--radius) - 2px);
    background: hsl(var(--muted) / 0.45);
  }
  .health-facts dt {
    color: hsl(var(--muted-foreground));
    font-size: 0.65rem;
    text-transform: uppercase;
  }
  .health-facts dd {
    margin: 0;
    font-size: 0.8rem;
    font-weight: 650;
  }
  .page-state.error h1 {
    color: hsl(var(--destructive));
  }
  .loader {
    width: 1.6rem;
    height: 1.6rem;
    border: 2px solid hsl(var(--border));
    border-top-color: hsl(var(--primary));
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .statistics-page {
      animation: none;
    }
    .loader {
      animation-duration: 1.5s;
    }
  }
  @media (max-width: 850px) {
    .token-grid {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 520px) {
    .controls {
      display: grid;
    }
    .panel-heading {
      display: block;
    }
    .panel-heading span {
      display: inline-block;
      margin-top: 0.7rem;
    }
    .health-facts {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
