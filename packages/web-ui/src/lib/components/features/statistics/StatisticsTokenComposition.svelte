<script lang="ts">
  import { Card } from '$lib/components/ui/card/index.js';
  import type { StatisticsTokenComposition } from './statistics-helpers.js';
  import { formatCompactNumber } from './statistics-helpers.js';

  let {
    composition,
    title = 'Observed token volume',
    description = 'Input and output are disjoint provider-reported token categories.',
    titleId = 'token-composition-title',
  }: {
    composition: StatisticsTokenComposition;
    title?: string;
    description?: string;
    titleId?: string;
  } = $props();

  const ioTotal = $derived((composition.inputTokens ?? 0) + (composition.outputTokens ?? 0));
  const inputPercent = $derived(ioTotal > 0 ? ((composition.inputTokens ?? 0) / ioTotal) * 100 : 0);
  const outputPercent = $derived(ioTotal > 0 ? ((composition.outputTokens ?? 0) / ioTotal) * 100 : 0);
  const thinkingPercent = $derived(
    composition.outputBreakdownAvailable && (composition.outputTokens ?? 0) > 0
      ? ((composition.thinkingTokens ?? 0) / (composition.outputTokens ?? 1)) * 100
      : 0,
  );
  const visiblePercent = $derived(
    composition.outputBreakdownAvailable && (composition.outputTokens ?? 0) > 0
      ? ((composition.nonThinkingOutputTokens ?? 0) / (composition.outputTokens ?? 1)) * 100
      : 0,
  );
</script>

<Card class="p-5" role="region" aria-labelledby={titleId}>
  <header>
    <div>
      <h2 id={titleId}>{title}</h2>
      <p>{description}</p>
    </div>
    <div class="total">
      <span>Canonical total</span>
      <strong>{formatCompactNumber(composition.totalTokens, 0)}</strong>
      <small>{Math.round(composition.totalCoverage * 100)}% coverage</small>
    </div>
  </header>

  {#if ioTotal > 0}
    <div class="bar" aria-hidden="true">
      <div class="input" style={`width:${inputPercent}%`}></div>
      <div class="output" style={`width:${outputPercent}%`}>
        {#if composition.outputBreakdownAvailable}
          <div class="thinking" style={`width:${thinkingPercent}%`}></div>
          <div class="visible" style={`width:${visiblePercent}%`}></div>
        {/if}
      </div>
    </div>
  {:else}
    <p class="unavailable">No observed token values for this period.</p>
  {/if}

  <dl>
    <div>
      <dt><i class="swatch input-swatch"></i>Input</dt>
      <dd>{formatCompactNumber(composition.inputTokens, 0)}</dd>
      <small>{Math.round(composition.inputCoverage * 100)}% coverage</small>
    </div>
    <div>
      <dt><i class="swatch output-swatch"></i>Output</dt>
      <dd>{formatCompactNumber(composition.outputTokens, 0)}</dd>
      <small>{Math.round(composition.outputCoverage * 100)}% coverage</small>
    </div>
    {#if composition.outputBreakdownAvailable}
      <div>
        <dt><i class="swatch thinking-swatch"></i>Thinking within output</dt>
        <dd>{formatCompactNumber(composition.thinkingTokens, 0)}</dd>
        <small>{Math.round(composition.thinkingCoverage * 100)}% coverage</small>
      </div>
      <div>
        <dt><i class="swatch visible-swatch"></i>Non-thinking within output</dt>
        <dd>{formatCompactNumber(composition.nonThinkingOutputTokens, 0)}</dd>
      </div>
    {:else}
      <div class="wide">
        <dt>Thinking split</dt>
        <dd>Unavailable for a consistent observation population</dd>
      </div>
    {/if}
  </dl>
</Card>

<style>
  header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: start;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  p {
    margin: 0.35rem 0 0;
    color: hsl(var(--muted-foreground));
    font-size: 0.78rem;
  }
  .total {
    display: grid;
    justify-items: end;
    white-space: nowrap;
  }
  .total span,
  small {
    color: hsl(var(--muted-foreground));
    font-size: 0.67rem;
  }
  .total strong {
    font-size: 1.4rem;
    font-variant-numeric: tabular-nums;
  }
  .bar {
    display: flex;
    height: 1.1rem;
    margin-top: 1.25rem;
    overflow: hidden;
    border-radius: 999px;
    background: hsl(var(--muted));
  }
  .input {
    background: hsl(198 82% 52%);
  }
  .output {
    display: flex;
    background: hsl(38 92% 55%);
  }
  .thinking {
    background: hsl(281 72% 66%);
  }
  .visible {
    background: hsl(151 62% 45%);
  }
  .unavailable {
    padding: 1rem;
    border-radius: calc(var(--radius) - 2px);
    background: hsl(var(--muted) / 0.45);
  }
  dl {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.8rem;
    margin: 1.1rem 0 0;
  }
  dl div {
    display: grid;
    gap: 0.12rem;
  }
  dt {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    color: hsl(var(--muted-foreground));
    font-size: 0.7rem;
  }
  dd {
    margin: 0;
    font-size: 1rem;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }
  .swatch {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
  }
  .input-swatch {
    background: hsl(198 82% 52%);
  }
  .output-swatch {
    background: hsl(38 92% 55%);
  }
  .thinking-swatch {
    background: hsl(281 72% 66%);
  }
  .visible-swatch {
    background: hsl(151 62% 45%);
  }
  .wide {
    grid-column: span 2;
  }
  .wide dd {
    font-size: 0.78rem;
    font-weight: 500;
  }
  @media (max-width: 700px) {
    dl {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 440px) {
    header {
      display: block;
    }
    .total {
      justify-items: start;
      margin-top: 1rem;
    }
  }
</style>
