<script lang="ts">
  import { appState, getWsClient } from '../lib/stores.svelte.js';

  let busyJobs = $state<Map<string, string>>(new Map());
  let actionError = $state('');

  async function withJobAction(jobId: string, actionLabel: string, fn: () => Promise<void>): Promise<void> {
    busyJobs = new Map([...busyJobs, [jobId, actionLabel]]);
    actionError = '';
    try {
      await fn();
    } catch (err) {
      actionError = `Failed to ${actionLabel.toLowerCase()} "${jobId}": ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      const next = new Map(busyJobs);
      next.delete(jobId);
      busyJobs = next;
    }
  }

  function runJob(jobId: string): void {
    withJobAction(jobId, 'Run', async () => {
      await getWsClient().request('jobs.run', { jobId });
    });
  }

  function enableJob(jobId: string): void {
    withJobAction(jobId, 'Enable', async () => {
      await getWsClient().request('jobs.enable', { jobId });
    });
  }

  function disableJob(jobId: string): void {
    withJobAction(jobId, 'Disable', async () => {
      await getWsClient().request('jobs.disable', { jobId });
    });
  }

  function removeJob(jobId: string): void {
    if (!confirm(`Remove job "${jobId}"?`)) return;
    withJobAction(jobId, 'Remove', async () => {
      await getWsClient().request('jobs.remove', { jobId });
    });
  }

  function recompileJob(jobId: string): void {
    withJobAction(jobId, 'Recompile', async () => {
      await getWsClient().request('jobs.recompile', { jobId });
    });
  }
</script>

<div class="p-6 space-y-5 animate-fade-in">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-semibold tracking-tight">Jobs</h2>
    {#if appState.jobs.length > 0}
      <span class="text-xs font-mono text-muted-foreground">
        {appState.jobs.filter(j => j.job.enabled).length}/{appState.jobs.length} enabled
      </span>
    {/if}
  </div>

  {#if actionError}
    <div class="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive flex items-center justify-between animate-fade-in">
      <span>{actionError}</span>
      <button onclick={() => actionError = ''} class="text-destructive/60 hover:text-destructive ml-4 text-xs font-medium">Dismiss</button>
    </div>
  {/if}

  {#if appState.jobs.length === 0}
    <div class="bg-card border border-border rounded-xl p-12 text-center">
      <svg viewBox="0 0 24 24" class="w-10 h-10 mx-auto text-muted-foreground/30 mb-4" fill="none" stroke="currentColor" stroke-width="1">
        <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p class="text-muted-foreground">No jobs configured</p>
      <p class="text-sm text-muted-foreground/70 mt-1">
        Add jobs via <code class="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">ironcurtain daemon add-job</code>
      </p>
    </div>
  {:else}
    <div class="bg-card border border-border rounded-xl overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-muted/30">
            <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
            <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Schedule</th>
            <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Next Run</th>
            <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Last Run</th>
            <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
            <th class="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each appState.jobs as entry (entry.job.id)}
            {@const busy = busyJobs.get(entry.job.id)}
            <tr class="border-t border-border/50 transition-all {busy ? 'opacity-50' : 'hover:bg-accent/30'}">
              <td class="px-4 py-3">
                <div class="font-medium">{entry.job.name}</div>
                <div class="text-[11px] text-muted-foreground font-mono mt-0.5">{entry.job.id}</div>
              </td>
              <td class="px-4 py-3">
                <code class="text-xs font-mono text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">{entry.job.schedule}</code>
              </td>
              <td class="px-4 py-3 text-xs text-muted-foreground">
                {entry.nextRun ? new Date(entry.nextRun).toLocaleString() : '--'}
              </td>
              <td class="px-4 py-3">
                {#if entry.lastRun}
                  <div class="flex items-center gap-1.5">
                    <span class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium rounded-full
                      {entry.lastRun.outcome.kind === 'success' ? 'bg-success/15 text-success' :
                       entry.lastRun.outcome.kind === 'error' ? 'bg-destructive/15 text-destructive' :
                       'bg-warning/15 text-warning'}">
                      {entry.lastRun.outcome.kind}
                    </span>
                    <span class="text-[11px] font-mono text-muted-foreground">
                      ${entry.lastRun.budget.estimatedCostUsd.toFixed(2)}
                    </span>
                  </div>
                {:else}
                  <span class="text-xs text-muted-foreground/50">--</span>
                {/if}
              </td>
              <td class="px-4 py-3">
                {#if busy}
                  <span class="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded-full bg-primary/15 text-primary">
                    <span class="w-2 h-2 border-[1.5px] border-primary/30 border-t-primary rounded-full animate-spin"></span>
                    {busy}...
                  </span>
                {:else if entry.isRunning}
                  <span class="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded-full bg-warning/15 text-warning">
                    <span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse"></span>
                    running
                  </span>
                {:else if entry.job.enabled}
                  <span class="px-2 py-0.5 text-[11px] font-medium rounded-full bg-success/15 text-success">enabled</span>
                {:else}
                  <span class="px-2 py-0.5 text-[11px] font-medium rounded-full bg-muted text-muted-foreground">disabled</span>
                {/if}
              </td>
              <td class="px-4 py-3">
                <div class="flex gap-1.5 justify-end">
                  <button
                    onclick={() => runJob(entry.job.id)}
                    disabled={entry.isRunning || !!busy}
                    class="px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-md
                           hover:brightness-110 active:scale-[0.97] transition-all disabled:opacity-40 disabled:pointer-events-none"
                  >Run</button>
                  {#if entry.job.enabled}
                    <button
                      onclick={() => disableJob(entry.job.id)}
                      disabled={!!busy}
                      class="px-2.5 py-1 text-xs font-medium bg-secondary text-secondary-foreground rounded-md
                             hover:bg-accent transition-colors disabled:opacity-40 disabled:pointer-events-none"
                    >Disable</button>
                  {:else}
                    <button
                      onclick={() => enableJob(entry.job.id)}
                      disabled={!!busy}
                      class="px-2.5 py-1 text-xs font-medium bg-success text-success-foreground rounded-md
                             hover:brightness-110 transition-all disabled:opacity-40 disabled:pointer-events-none"
                    >Enable</button>
                  {/if}
                  <button
                    onclick={() => recompileJob(entry.job.id)}
                    disabled={!!busy}
                    class="px-2.5 py-1 text-xs font-medium bg-secondary text-secondary-foreground rounded-md
                           hover:bg-accent transition-colors disabled:opacity-40 disabled:pointer-events-none"
                    title="Recompile policy"
                  >Recompile</button>
                  <button
                    onclick={() => removeJob(entry.job.id)}
                    disabled={!!busy}
                    class="px-2.5 py-1 text-xs font-medium bg-destructive/10 text-destructive rounded-md
                           hover:bg-destructive hover:text-destructive-foreground transition-all disabled:opacity-40 disabled:pointer-events-none"
                  >Remove</button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
