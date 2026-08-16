<script lang="ts">
  import type { StatisticsMetricDistributionDto } from '$lib/types.js';
  import type { StatisticsTokenComposition, StatisticsTrendPoint } from './statistics-helpers.js';
  import { formatCompactNumber, formatCoverage } from './statistics-helpers.js';
  import StatisticsTokenCompositionView from './StatisticsTokenComposition.svelte';

  let {
    label,
    loading,
    error,
    points,
    composition,
    distribution,
    onclose,
  }: {
    label: string;
    loading: boolean;
    error: string;
    points: readonly StatisticsTrendPoint[];
    composition: StatisticsTokenComposition;
    distribution: StatisticsMetricDistributionDto | null;
    onclose: () => void;
  } = $props();

  const maxBinCount = $derived(Math.max(1, ...(distribution?.bins.map((bin) => bin.count) ?? [])));
</script>

<section class="drawer" aria-labelledby="day-detail-title">
  <header>
    <div>
      <p>Selected calendar day</p>
      <h2 id="day-detail-title">{label}</h2>
    </div>
    <button type="button" onclick={onclose} aria-label="Close selected day details">Close</button>
  </header>
  {#if loading}
    <p class="state" role="status">Loading hourly observations…</p>
  {:else if error}
    <p class="state error" role="alert">{error}</p>
  {:else}
    <StatisticsTokenCompositionView
      {composition}
      title="Selected-day token volume"
      description="Input and output totals for this local calendar day."
      titleId="selected-day-token-volume-title"
    />

    <div class="detail-grid">
      <section aria-labelledby="hourly-table-title">
        <h3 id="hourly-table-title">Hourly observed speed</h3>
        {#if points.length === 0}
          <p class="state">No hourly speed samples were available.</p>
        {:else}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div class="table-scroll" tabindex="0" role="region" aria-label="Hourly effective output speed">
            <table>
              <thead
                ><tr
                  ><th>Local hour</th><th>Provider · model</th><th>Median</th><th>Middle 50%</th><th>Coverage</th><th
                    >Signals</th
                  ></tr
                ></thead
              >
              <tbody>
                {#each points as point (point.key)}
                  <tr
                    ><th scope="row">{point.label}</th><td>{point.seriesLabel}</td><td
                      >{point.median.toFixed(1)} tok/s</td
                    ><td>{point.lowerQuartile.toFixed(1)}–{point.upperQuartile.toFixed(1)}</td><td
                      >{formatCoverage(point.sampleCount, point.eligibleCount, point.sampleSessionCount)}</td
                    ><td>{point.refusalCount} refusals · {point.errorCount} errors</td></tr
                  >
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>

      <section aria-labelledby="distribution-title">
        <h3 id="distribution-title">Speed distribution</h3>
        {#if distribution === null || distribution.bins.length === 0}
          <p class="state">No speed distribution was available.</p>
        {:else}
          <p class="distribution-note">
            {formatCoverage(distribution.sampleCount, distribution.eligibleCount)} · range {formatCompactNumber(
              distribution.minimum,
            )}–{formatCompactNumber(distribution.maximum)} tok/s
          </p>
          <ol class="histogram" aria-label="Effective output token speed histogram">
            {#each distribution.bins as bin (`${bin.lower}:${bin.upper}`)}
              <li>
                <span>{formatCompactNumber(bin.lower)}–{formatCompactNumber(bin.upper)}</span><i
                  style={`--bin-width:${(bin.count / maxBinCount) * 100}%`}
                ></i><b>{bin.count}</b>
              </li>
            {/each}
          </ol>
        {/if}
      </section>
    </div>
  {/if}
</section>

<style>
  .drawer {
    display: grid;
    gap: 1rem;
    padding: 1.25rem;
    border: 1px solid hsl(var(--primary) / 0.35);
    border-radius: var(--radius);
    background: hsl(var(--card));
    box-shadow: 0 18px 50px hsl(0 0% 0% / 0.12);
  }
  header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 1rem;
  }
  header p {
    margin: 0 0 0.2rem;
    color: hsl(var(--muted-foreground));
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  h2,
  h3 {
    margin: 0;
  }
  h2 {
    font-size: 1.2rem;
  }
  h3 {
    margin-bottom: 0.7rem;
    font-size: 0.86rem;
  }
  header button {
    padding: 0.35rem 0.65rem;
    border: 1px solid hsl(var(--border));
    border-radius: calc(var(--radius) - 3px);
    font-size: 0.72rem;
  }
  .detail-grid {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(16rem, 1fr);
    gap: 1.25rem;
  }
  .table-scroll {
    max-width: 100%;
    max-height: 24rem;
    overflow: auto;
  }
  table {
    width: 100%;
    min-width: 48rem;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 0.55rem 0.6rem;
    border-bottom: 1px solid hsl(var(--border));
    text-align: left;
    font-size: 0.7rem;
  }
  thead th {
    color: hsl(var(--muted-foreground));
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .distribution-note,
  .state {
    margin: 0.35rem 0;
    color: hsl(var(--muted-foreground));
    font-size: 0.72rem;
  }
  .error {
    color: hsl(var(--destructive));
  }
  .histogram {
    display: grid;
    gap: 0.45rem;
    margin: 0.8rem 0 0;
    padding: 0;
    list-style: none;
  }
  .histogram li {
    display: grid;
    grid-template-columns: 6.5rem minmax(3rem, 1fr) 2rem;
    gap: 0.45rem;
    align-items: center;
    font-size: 0.67rem;
    font-variant-numeric: tabular-nums;
  }
  .histogram i {
    height: 0.65rem;
    border-radius: 2px;
    background: linear-gradient(to right, hsl(38 92% 55%) var(--bin-width), hsl(var(--muted)) var(--bin-width));
  }
  .histogram b {
    text-align: right;
  }
  @media (max-width: 900px) {
    .detail-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
