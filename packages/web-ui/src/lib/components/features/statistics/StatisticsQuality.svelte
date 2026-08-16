<script lang="ts">
  import { Card } from '$lib/components/ui/card/index.js';
  import type { StatisticsMetricSummaryDto, StatisticsRepositoryHealthDto } from '$lib/types.js';
  import { formatCompactNumber, formatCoverage } from './statistics-helpers.js';

  let {
    requests,
    refusals,
    errors,
    health,
  }: {
    requests: StatisticsMetricSummaryDto | undefined;
    refusals: StatisticsMetricSummaryDto | undefined;
    errors: StatisticsMetricSummaryDto | undefined;
    health: StatisticsRepositoryHealthDto;
  } = $props();

  const qualityWarning = $derived(
    health.state === 'degraded' || health.readerState === 'unavailable' || health.dropped > 0,
  );
</script>

<Card class="p-5" role="region" aria-labelledby="quality-title">
  <header>
    <h2 id="quality-title">Refusals, errors, and data quality</h2>
    <p>
      Refusals include only explicit API refusal or content-filter signals. Unknown responses are not counted as
      non-refusals.
    </p>
  </header>
  <div class="cards">
    <article>
      <span>Observed requests</span><strong>{formatCompactNumber(requests?.value ?? null, 0)}</strong><small
        >{formatCoverage(
          requests?.sampleCount ?? 0,
          requests?.eligibleCount ?? 0,
          requests?.sampleSessionCount ?? 0,
        )}</small
      >
    </article>
    <article>
      <span>Explicit API refusals</span><strong>{formatCompactNumber(refusals?.value ?? null, 0)}</strong><small
        >{formatCoverage(
          refusals?.sampleCount ?? 0,
          refusals?.eligibleCount ?? 0,
          refusals?.sampleSessionCount ?? 0,
        )}</small
      >
    </article>
    <article>
      <span>Transport/provider errors</span><strong>{formatCompactNumber(errors?.value ?? null, 0)}</strong><small
        >{formatCoverage(errors?.sampleCount ?? 0, errors?.eligibleCount ?? 0, errors?.sampleSessionCount ?? 0)}</small
      >
    </article>
    <article class:warning={qualityWarning}>
      <span>Persistence</span><strong>{qualityWarning ? 'Partial' : 'Healthy'}</strong><small
        >{health.persisted.toLocaleString()} persisted · {health.dropped.toLocaleString()} dropped</small
      >
    </article>
  </div>
  {#if qualityWarning}
    <p class="notice" role="status">
      Some statistics may be missing. Reader: {health.readerState}; writer: {health.state}{health.lastError
        ? ` — ${health.lastError}`
        : ''}
    </p>
  {/if}
</Card>

<style>
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  header p {
    max-width: 52rem;
    margin: 0.35rem 0 0;
    color: hsl(var(--muted-foreground));
    font-size: 0.76rem;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
    margin-top: 1rem;
  }
  article {
    display: grid;
    gap: 0.2rem;
    padding: 0.85rem;
    border-radius: calc(var(--radius) - 2px);
    background: hsl(var(--muted) / 0.45);
  }
  article span,
  article small {
    color: hsl(var(--muted-foreground));
    font-size: 0.67rem;
  }
  article strong {
    font-size: 1.35rem;
    font-variant-numeric: tabular-nums;
  }
  article.warning strong {
    color: hsl(var(--destructive));
  }
  .notice {
    margin: 0.85rem 0 0;
    padding: 0.7rem 0.8rem;
    border: 1px solid hsl(var(--destructive) / 0.35);
    border-radius: calc(var(--radius) - 2px);
    color: hsl(var(--destructive));
    font-size: 0.74rem;
  }
  @media (max-width: 820px) {
    .cards {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 430px) {
    .cards {
      grid-template-columns: 1fr;
    }
  }
</style>
