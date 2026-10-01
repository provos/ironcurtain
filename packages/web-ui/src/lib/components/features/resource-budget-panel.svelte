<script lang="ts">
  import type { WorkflowBudgetDto } from '$lib/types.js';
  import { BUDGET_LIMITS, budgetUsage, formatLimit, limitProgress } from './resource-budget-helpers.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import Gauge from 'phosphor-svelte/lib/Gauge';

  let { budget, preview = false }: { budget: WorkflowBudgetDto; preview?: boolean } = $props();
</script>

<section
  data-testid="resource-budget-panel"
  class="rounded-xl border border-border bg-muted/10 p-4 sm:p-5 space-y-4"
  aria-label="Resource limits"
>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="flex items-center gap-2 text-sm font-semibold">
      <Gauge size={18} weight="duotone" class="text-primary" /> Resource limits
    </h3>
    <span class="text-xs text-muted-foreground"
      >{preview
        ? 'Effective settings for this run'
        : (budget.activeSessionCount ?? 0) > 1
          ? `1 of ${budget.activeSessionCount} active agent sessions`
          : 'Active / last agent session'}</span
    >
  </div>
  {#if !preview && (budget.activeSessionCount ?? 0) > 1}
    <p class="text-xs text-muted-foreground" data-testid="budget-sampled-note">
      Usage samples one active agent session. Each session uses these limits independently; usage is not aggregated
      across parallel sessions.
    </p>
  {/if}
  {#if !budget.recorded && !preview}
    <p
      class="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400"
      data-testid="budget-legacy-note"
    >
      This run did not record its limits. The values below reflect current settings; historical limits and usage are
      unavailable.
    </p>
  {/if}
  <div class="grid grid-cols-1 min-[460px]:grid-cols-2 xl:grid-cols-4 gap-3">
    {#each BUDGET_LIMITS as item (item.key)}
      {@const limit = budget.limits[item.key]}
      {@const used = !preview && budget.recorded ? budgetUsage(budget, item.key) : undefined}
      {@const progress = limitProgress(used, limit)}
      {@const warning = progress !== undefined && progress >= budget.limits.warnThresholdPercent}
      <div
        class={`rounded-lg border p-3 space-y-2 ${warning ? 'border-amber-500/40 bg-amber-500/5' : 'border-border'}`}
        data-testid={`budget-${item.key}`}
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-muted-foreground">{item.label}</span>
          <Badge variant="outline" class="text-[10px] capitalize">{budget.sources[item.key]}</Badge>
        </div>
        <p class="text-lg font-semibold tabular-nums">{limit === null ? 'Disabled' : formatLimit(item.key, limit)}</p>
        <p class="text-[11px] text-muted-foreground">{item.hint}</p>
        {#if !preview && item.key !== 'maxSessionSeconds'}
          <div class="space-y-1.5 pt-1">
            <p class="text-xs tabular-nums" class:text-amber-600={warning}>
              {used === undefined ? 'Usage unavailable' : `${formatLimit(item.key, used)} used`}{warning
                ? progress! >= 100
                  ? ' · Limit reached'
                  : ' · Near limit'
                : ''}
            </p>
            {#if progress !== undefined}
              <div
                role="progressbar"
                aria-label={`${item.label} usage`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(100, Math.round(progress))}
                aria-valuetext={`${Math.round(progress)}% of limit`}
                class="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  class="h-full rounded-full transition-all"
                  class:bg-amber-500={warning}
                  class:bg-primary={!warning}
                  style={`width: ${Math.min(100, Math.max(0, progress))}%`}
                ></div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
  <p class="text-xs leading-relaxed text-muted-foreground">
    Configured limits apply to agent turns and cumulative recovery checks. The cost threshold gates recovery turns and
    can be exceeded by a completed turn. Usage reflects the active or last agent session; total workflow tokens cover
    all sessions. The timeout restarts for each turn.
  </p>
</section>
