<script lang="ts">
  import type { WorkflowDetailDto, WorkflowSummaryDto, HumanGateRequestDto } from '$lib/types.js';
  import { appState, getWorkflowDetail, resolveWorkflowGate } from '$lib/stores.svelte.js';
  import { phaseBadgeVariant } from '$lib/utils.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Card, CardHeader, CardTitle, CardContent } from '$lib/components/ui/card/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import StateMachineGraph from '$lib/components/features/state-machine-graph.svelte';
  import GateReviewPanel from '$lib/components/features/gate-review-panel.svelte';

  let {
    workflowId,
    summary,
    gate,
    onback,
  }: {
    workflowId: string;
    summary: WorkflowSummaryDto;
    gate?: HumanGateRequestDto;
    onback: () => void;
  } = $props();

  let detail = $state<WorkflowDetailDto | null>(null);
  let loading = $state(true);
  let error = $state('');
  let resolveError = $state('');

  let fetchVersion = 0;

  $effect(() => {
    const id = workflowId;
    const version = ++fetchVersion;
    loading = true;
    error = '';
    detail = null;

    getWorkflowDetail(id)
      .then((d) => {
        if (version === fetchVersion) {
          detail = d;
          loading = false;

          // Seed gate into pendingGates so the parent's selectedGate derivation picks it up
          if (d.gate) {
            appState.pendingGates = new Map(appState.pendingGates).set(d.gate.gateId, d.gate);
          }
        }
      })
      .catch((err) => {
        if (version === fetchVersion) {
          error = err instanceof Error ? err.message : String(err);
          loading = false;
        }
      });
  });

  const completedStates = $derived(
    detail?.transitionHistory ? [...new Set(detail.transitionHistory.map((t) => t.from))] : [],
  );

  const failedState = $derived(summary.phase === 'failed' ? summary.currentState : null);

  const visitCounts = $derived(detail?.context?.visitCounts ?? {});

  async function handleGateResolve(event: string, prompt?: string): Promise<void> {
    resolveError = '';
    try {
      await resolveWorkflowGate(workflowId, event, prompt);
    } catch (err) {
      resolveError = `Failed to resolve gate: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString();
  }
</script>

<div class="p-6 space-y-5 animate-fade-in overflow-y-auto h-full">
  <div class="flex items-center gap-3">
    <Button variant="ghost" size="sm" onclick={onback}>&larr; Back</Button>
    <h2 class="text-xl font-semibold tracking-tight">{summary.name}</h2>
    <Badge variant={phaseBadgeVariant(summary.phase)}>{summary.phase.replace('_', ' ')}</Badge>
    <span class="text-sm text-muted-foreground ml-auto">
      State: <span class="font-mono">{summary.currentState}</span>
    </span>
  </div>

  {#if resolveError}
    <Alert variant="destructive" dismissible ondismiss={() => (resolveError = '')}>{resolveError}</Alert>
  {/if}

  {#if loading}
    <div class="flex items-center justify-center py-16">
      <Spinner size="md" />
    </div>
  {:else if error}
    <Alert variant="destructive">{error}</Alert>
  {:else if detail}
    {#if gate && summary.phase === 'waiting_human'}
      <GateReviewPanel {gate} workflowName={summary.name} onResolve={handleGateResolve} />
    {/if}

    <Card>
      <CardHeader>
        <CardTitle>State Machine</CardTitle>
      </CardHeader>
      <CardContent>
        <StateMachineGraph
          graph={detail.stateGraph}
          currentState={summary.currentState}
          {completedStates}
          {failedState}
          {visitCounts}
        />
      </CardContent>
    </Card>

    {#if detail.context}
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent>
            <p class="text-xs text-muted-foreground">Round</p>
            <p class="text-lg font-semibold">{detail.context.round}/{detail.context.maxRounds}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p class="text-xs text-muted-foreground">Total Tokens</p>
            <p class="text-lg font-semibold">{detail.context.totalTokens.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p class="text-xs text-muted-foreground">Workspace</p>
            <p class="text-sm font-mono truncate" title={detail.workspacePath}>{detail.workspacePath}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p class="text-xs text-muted-foreground">Description</p>
            <p class="text-sm truncate" title={detail.description}>{detail.description || '--'}</p>
          </CardContent>
        </Card>
      </div>
    {/if}

    {#if detail.transitionHistory.length > 0}
      <Card>
        <CardHeader>
          <CardTitle>Transition History</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="space-y-1.5">
            {#each detail.transitionHistory as t, i (i)}
              <div class="flex items-center gap-2 text-sm font-mono">
                <span class="text-muted-foreground text-xs w-16 shrink-0">{formatTime(t.timestamp)}</span>
                <span class="text-foreground/70">{t.from}</span>
                <span class="text-muted-foreground">&rarr;</span>
                <span class="text-foreground">{t.to}</span>
                {#if t.event}
                  <Badge variant="outline" class="ml-1">{t.event}</Badge>
                {/if}
                <span class="text-muted-foreground text-xs ml-auto">{formatDuration(t.durationMs)}</span>
              </div>
            {/each}
          </div>
        </CardContent>
      </Card>
    {/if}
  {/if}
</div>
