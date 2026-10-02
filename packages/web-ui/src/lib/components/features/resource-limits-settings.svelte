<script lang="ts">
  import { untrack } from 'svelte';
  import type { ResourceBudgetConfigDto } from '$lib/types.js';
  import {
    getResourceBudget,
    setResourceBudget,
    appState,
    connectionGeneration,
    configChangedGeneration,
  } from '$lib/stores.svelte.js';
  import { BUDGET_LIMITS, parseResourceBudget, type LimitKey } from './resource-budget-helpers.js';
  import { Card, CardHeader, CardTitle, CardContent } from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import Gauge from 'phosphor-svelte/lib/Gauge';

  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let saved = $state(false);
  let baseline = $state<ResourceBudgetConfigDto | null>(null);
  let values = $state<Record<LimitKey, string>>({
    maxTotalTokens: '',
    maxSteps: '',
    maxSessionSeconds: '',
    maxEstimatedCostUsd: '',
  });
  let disabled = $state<Record<LimitKey, boolean>>({
    maxTotalTokens: false,
    maxSteps: false,
    maxSessionSeconds: false,
    maxEstimatedCostUsd: false,
  });
  let warning = $state('');
  const mutationAllowed = $derived(appState.daemonStatus?.allowPolicyMutation === true);
  const dirty = $derived(
    baseline !== null &&
      (BUDGET_LIMITS.some(
        ({ key }) =>
          disabled[key] !== (baseline![key] === null) || (!disabled[key] && Number(values[key]) !== baseline![key]),
      ) ||
        Number(warning) !== baseline.warnThresholdPercent),
  );
  const validation = $derived.by(() => {
    if (!baseline) return '';
    try {
      parseResourceBudget(values, disabled, warning);
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  });

  function apply(dto: ResourceBudgetConfigDto): void {
    baseline = dto;
    for (const { key } of BUDGET_LIMITS) {
      disabled[key] = dto[key] === null;
      values[key] = dto[key] === null ? '' : String(dto[key]);
    }
    warning = String(dto.warnThresholdPercent);
  }

  let requestVersion = 0;
  async function load(): Promise<void> {
    const version = ++requestVersion;
    loading = baseline === null;
    error = '';
    try {
      const dto = await getResourceBudget();
      if (version === requestVersion && (!baseline || (!dirty && !saving))) apply(dto);
    } catch (err) {
      if (version === requestVersion) error = err instanceof Error ? err.message : String(err);
    } finally {
      if (version === requestVersion) loading = false;
    }
  }

  $effect(() => {
    void connectionGeneration.value;
    void configChangedGeneration.value;
    // Only mount/reconnect/config events trigger a read; typing never does.
    untrack(() => {
      if (!dirty && !saving) void load();
    });
    return () => {
      requestVersion++;
    };
  });

  async function save(): Promise<void> {
    if (!mutationAllowed || !dirty || validation || saving) return;
    requestVersion++;
    saving = true;
    error = '';
    saved = false;
    try {
      apply(await setResourceBudget(parseResourceBudget(values, disabled, warning)));
      saved = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }
</script>

<Card data-testid="resource-limits-settings">
  <CardHeader class="flex-col items-start gap-2">
    <CardTitle
      ><span class="flex items-center gap-2"
        ><Gauge size={20} weight="duotone" class="text-primary" />Agent resource limits</span
      ></CardTitle
    >
    <p class="text-sm text-muted-foreground leading-relaxed">
      Defaults for standalone agent sessions and agents in workflows. Workflows can override each limit; scheduled jobs
      use separate budgets.
    </p>
  </CardHeader>
  <CardContent>
    {#if loading}
      <div class="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading resource limits…</div>
    {:else}
      <div class="space-y-4">
        {#if error}<Alert variant="destructive">{error}</Alert>{/if}
        {#if baseline}
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {#each BUDGET_LIMITS as item (item.key)}
              <div class="rounded-lg border border-border bg-muted/10 p-4 space-y-3">
                <div class="flex items-start justify-between gap-2">
                  <div>
                    <label for={`budget-input-${item.key}`} class="text-sm font-medium">{item.label}</label>
                    <p class="text-xs text-muted-foreground mt-1">{item.hint}</p>
                  </div>
                  <label class="flex items-center gap-1.5 text-xs shrink-0 pt-0.5"
                    ><input
                      type="checkbox"
                      aria-label={`Disable ${item.label.toLowerCase()} limit`}
                      data-testid={`budget-disable-${item.key}`}
                      bind:checked={disabled[item.key]}
                      disabled={!mutationAllowed || saving}
                      class="accent-primary"
                      onchange={() => (saved = false)}
                    /> Disabled</label
                  >
                </div>
                <div class="flex items-center gap-2">
                  <input
                    id={`budget-input-${item.key}`}
                    data-testid={`budget-input-${item.key}`}
                    type="text"
                    inputmode={item.integer ? 'numeric' : 'decimal'}
                    bind:value={values[item.key]}
                    disabled={disabled[item.key] || !mutationAllowed || saving}
                    placeholder={disabled[item.key] ? 'No limit' : 'Enter limit'}
                    aria-describedby={`budget-unit-${item.key}`}
                    class="w-full min-w-0 px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50 tabular-nums"
                    oninput={() => (saved = false)}
                  />
                  <span id={`budget-unit-${item.key}`} class="text-xs text-muted-foreground shrink-0">{item.unit}</span>
                </div>
              </div>
            {/each}
          </div>
          <div class="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
            <div class="flex-1 min-w-48">
              <label for="budget-warning-percent" class="text-sm font-medium">Warning threshold</label>
              <p class="text-xs text-muted-foreground mt-1">Highlight usage approaching an enabled limit.</p>
            </div>
            <div class="flex items-center gap-2">
              <input
                id="budget-warning-percent"
                data-testid="budget-warning-percent"
                type="text"
                inputmode="decimal"
                bind:value={warning}
                disabled={!mutationAllowed || saving}
                class="w-20 px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50 tabular-nums"
                oninput={() => (saved = false)}
              /><span class="text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <p class="text-xs text-muted-foreground leading-relaxed">
            Built-in agents enforce all limits per turn. Container batch agents enforce the timeout; workflows also
            check token, step, and cost usage before recovery turns. Interactive terminals are unaffected.
          </p>
          <p class="text-xs text-muted-foreground leading-relaxed">
            Changes apply to new sessions and workflow runs. Existing workflow runs keep their saved limits unless
            resumed with current settings. A completed turn can exceed a cost threshold.
          </p>
          {#if mutationAllowed}
            {#if validation && dirty}<p role="alert" class="text-xs text-destructive">{validation}</p>{/if}
            <div class="flex flex-wrap items-center gap-2">
              <Button data-testid="budget-save" onclick={save} disabled={!dirty || Boolean(validation)} loading={saving}
                >Save resource limits</Button
              >
              <Button
                data-testid="budget-reset"
                variant="outline"
                disabled={!dirty || saving}
                onclick={() => {
                  if (baseline) apply(baseline);
                  saved = false;
                  error = '';
                }}>Discard changes</Button
              >
              {#if saved && !dirty}<span role="status" class="text-xs text-green-600 dark:text-green-400"
                  >Resource limits saved</span
                >{/if}
            </div>
          {:else}
            <p class="text-xs text-muted-foreground">
              Resource limits are read-only. Configuration changes are disabled on this daemon.
            </p>
          {/if}
        {:else}
          <Button variant="outline" onclick={() => void load()}>Retry loading resource limits</Button>
        {/if}
      </div>
    {/if}
  </CardContent>
</Card>
