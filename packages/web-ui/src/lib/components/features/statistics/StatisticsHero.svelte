<script lang="ts">
  import type { StatisticsMetricSummaryDto } from '$lib/types.js';
  import { formatCoverage } from './statistics-helpers.js';

  let {
    speed,
    rangeLabel,
  }: {
    speed: StatisticsMetricSummaryDto | undefined;
    rangeLabel: string;
  } = $props();
</script>

<section class="hero" aria-labelledby="statistics-hero-title">
  <div>
    <p class="eyebrow">{rangeLabel}</p>
    <h1 id="statistics-hero-title">LLM statistics</h1>
    <p class="lede">
      Observed performance and usage from proxied model traffic. No prompt or response content is stored.
    </p>
  </div>
  <div class="speed" aria-label="Effective output speed">
    <span class="speed-label">Median effective speed</span>
    <strong>{speed?.median === null || speed?.median === undefined ? 'Unavailable' : speed.median.toFixed(1)}</strong>
    <span class="unit">effective output tokens/s</span>
    {#if speed?.lowerQuartile !== null && speed?.lowerQuartile !== undefined && speed.upperQuartile !== null}
      <span class="spread">Middle 50%: {speed.lowerQuartile.toFixed(1)}–{speed.upperQuartile.toFixed(1)}</span>
    {/if}
    <span class="coverage"
      >{formatCoverage(speed?.sampleCount ?? 0, speed?.eligibleCount ?? 0, speed?.sampleSessionCount ?? 0)}</span
    >
  </div>
</section>

<style>
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(15rem, 22rem);
    gap: 2rem;
    align-items: end;
    padding: clamp(1.5rem, 4vw, 3rem);
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    background: radial-gradient(circle at 90% 10%, hsl(38 92% 55% / 0.13), transparent 45%), hsl(var(--card));
  }
  .eyebrow {
    margin: 0 0 0.5rem;
    color: hsl(var(--muted-foreground));
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  h1 {
    margin: 0;
    font-size: clamp(2rem, 5vw, 4.4rem);
    line-height: 0.95;
    letter-spacing: -0.055em;
  }
  .lede {
    max-width: 42rem;
    margin: 1rem 0 0;
    color: hsl(var(--muted-foreground));
    font-size: 0.95rem;
  }
  .speed {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    text-align: right;
  }
  .speed-label,
  .spread,
  .coverage {
    color: hsl(var(--muted-foreground));
    font-size: 0.72rem;
  }
  strong {
    margin-top: 0.25rem;
    font-size: clamp(2.8rem, 7vw, 5.5rem);
    line-height: 0.85;
    letter-spacing: -0.07em;
    font-variant-numeric: tabular-nums;
  }
  .unit {
    margin-top: 0.4rem;
    font-size: 0.75rem;
    font-weight: 650;
  }
  .spread {
    margin-top: 0.7rem;
  }
  .coverage {
    margin-top: 0.15rem;
  }
  @media (max-width: 720px) {
    .hero {
      grid-template-columns: 1fr;
    }
    .speed {
      align-items: flex-start;
      text-align: left;
    }
  }
</style>
