<script lang="ts">
  import ChartLineUp from 'phosphor-svelte/lib/ChartLineUp';

  import type { StatisticsMetricSummaryDto } from '$lib/types.js';
  import { findMeasure, formatCompactNumber, formatSpeed } from './statistics-helpers.js';

  let {
    available = false,
    summaries = [],
    active = false,
    onselect,
  }: {
    /** Whether a summary query succeeded; false keeps the card out of the sidebar. */
    available?: boolean;
    summaries?: readonly StatisticsMetricSummaryDto[];
    active?: boolean;
    onselect: () => void;
  } = $props();

  const speed = $derived(findMeasure(summaries, 'effectiveOutputTokensPerSecond'));
  const output = $derived(findMeasure(summaries, 'outputTokens'));
  const requests = $derived(findMeasure(summaries, 'requestCount'));
  const speedMedian = $derived(speed?.median ?? null);
  const speedLabel = $derived(formatSpeed(speedMedian));
  const speedAvailable = $derived(speedMedian !== null);
  const hasRequests = $derived((requests?.value ?? 0) > 0);
  const countLabel = $derived(speedAvailable ? 'Measured' : 'Requests');
  const countValue = $derived(speedAvailable ? (speed?.sampleCount ?? 0) : (requests?.value ?? null));
  const iqr = $derived(iqrPositions(speed));
  const description = $derived(
    speedAvailable
      ? `Today median effective output speed ${speedLabel} tokens per second based on ${formatCompactNumber(speed?.sampleCount ?? null, 0)} measured requests. ${formatCompactNumber(output?.value ?? null, 0)} output tokens observed.`
      : hasRequests
        ? `Today has ${formatCompactNumber(requests?.value ?? null, 0)} observed requests. Effective output speed is unavailable.`
        : 'No LLM observations today.',
  );

  function iqrPositions(summary: StatisticsMetricSummaryDto | undefined): {
    start: number;
    width: number;
    median: number;
  } | null {
    if (!summary || summary.median == null || summary.lowerQuartile == null || summary.upperQuartile == null) {
      return null;
    }
    const maximum = Math.max(summary.upperQuartile * 1.18, summary.median * 1.18, 1);
    const start = Math.max(0, Math.min(100, (summary.lowerQuartile / maximum) * 100));
    const end = Math.max(start, Math.min(100, (summary.upperQuartile / maximum) * 100));
    const median = Math.max(0, Math.min(100, (summary.median / maximum) * 100));
    return { start, width: Math.max(1.5, end - start), median };
  }
</script>

{#if available}
  <div class="px-2 pb-2">
    <button
      type="button"
      data-testid="statistics-nav-summary"
      onclick={onselect}
      aria-label={`Open Statistics. ${description}`}
      class="group relative w-full overflow-hidden rounded-xl border px-3 pb-3 pt-2.5 text-left shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar
        {active
        ? 'border-primary/45 bg-primary/10'
        : 'border-border/80 bg-card/70 hover:border-primary/40 hover:bg-accent/35'}"
    >
      <span
        class="pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-primary/10 to-transparent opacity-80"
        aria-hidden="true"
      ></span>

      <span class="relative flex items-center justify-between gap-2">
        <span class="text-[9px] font-semibold uppercase tracking-[0.15em] text-muted-foreground"
          >Today · effective speed</span
        >
        <ChartLineUp size={14} class="shrink-0 text-primary transition-transform group-hover:-translate-y-0.5" />
      </span>

      {#if speedAvailable}
        <span class="relative mt-1 flex items-baseline gap-1">
          <strong class="font-mono text-[2rem] leading-none tracking-[-0.06em] text-primary">{speedLabel}</strong>
          <span class="text-[10px] font-medium text-foreground/75">tok/s</span>
        </span>

        {#if iqr}
          <span class="relative mt-2 block h-2" aria-hidden="true">
            <span class="absolute inset-x-0 top-[3px] h-px bg-border"></span>
            <span
              class="absolute top-px h-[5px] rounded-full bg-primary/30"
              style={`left: ${iqr.start}%; width: ${iqr.width}%`}
            ></span>
            <span
              class="absolute top-0 h-[7px] w-[2px] -translate-x-1/2 rounded-full bg-primary"
              style={`left: ${iqr.median}%`}
            ></span>
          </span>
          <span class="relative mt-0.5 flex justify-between text-[9px] text-muted-foreground">
            <span>Middle 50%</span>
            <span class="font-mono"
              >{formatSpeed(speed?.lowerQuartile ?? null)}–{formatSpeed(speed?.upperQuartile ?? null)}</span
            >
          </span>
        {/if}
      {:else if hasRequests}
        <span class="relative mt-2 block text-sm font-semibold text-foreground">Speed unavailable</span>
      {:else}
        <span class="relative mt-2 block text-sm font-semibold text-foreground">No observations today</span>
      {/if}

      <span
        class="relative mt-2.5 grid grid-cols-2 gap-2 border-t border-border/70 pt-2 text-[9px] text-muted-foreground"
      >
        <span class="min-w-0">
          <span class="block truncate uppercase tracking-wide">Output</span>
          <strong class="mt-0.5 block truncate font-mono text-[11px] font-semibold text-foreground/85"
            >{formatCompactNumber(output?.value ?? null, 0)} tok</strong
          >
        </span>
        <span class="min-w-0 text-right">
          <span class="block truncate uppercase tracking-wide">{countLabel}</span>
          <strong class="mt-0.5 block truncate font-mono text-[11px] font-semibold text-foreground/85"
            >{formatCompactNumber(countValue, 0)}</strong
          >
        </span>
      </span>
    </button>
  </div>
{/if}
