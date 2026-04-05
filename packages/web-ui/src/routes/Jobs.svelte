<script lang="ts">
  import { appState, getWsClient } from '../lib/stores.svelte.js';

  // Track which jobs have in-flight operations
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

<div class="p-6 space-y-6">
  <h2 class="text-2xl font-semibold">Jobs</h2>

  {#if actionError}
    <div class="bg-destructive/10 border border-destructive/30 rounded-lg px-4 py-3 text-sm text-destructive flex items-center justify-between">
      <span>{actionError}</span>
      <button onclick={() => actionError = ''} class="text-destructive hover:opacity-70 ml-4 text-xs">Dismiss</button>
    </div>
  {/if}

  {#if appState.jobs.length === 0}
    <div class="bg-card border border-border rounded-lg p-8 text-center text-muted-foreground">
      <p class="text-lg">No jobs configured</p>
      <p class="text-sm mt-1">Add jobs via <code class="bg-muted px-1 rounded">ironcurtain daemon add-job</code></p>
    </div>
  {:else}
    <div class="bg-card border border-border rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-muted/50">
          <tr>
            <th class="text-left px-4 py-3 font-medium">Name</th>
            <th class="text-left px-4 py-3 font-medium">Schedule</th>
            <th class="text-left px-4 py-3 font-medium">Next Run</th>
            <th class="text-left px-4 py-3 font-medium">Last Run</th>
            <th class="text-left px-4 py-3 font-medium">Status</th>
            <th class="text-right px-4 py-3 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each appState.jobs as entry (entry.job.id)}
            {@const busy = busyJobs.get(entry.job.id)}
            <tr class="border-t border-border {busy ? 'opacity-60' : ''}">
              <td class="px-4 py-3">
                <div class="font-medium">{entry.job.name}</div>
                <div class="text-xs text-muted-foreground font-mono">{entry.job.id}</div>
              </td>
              <td class="px-4 py-3 font-mono text-muted-foreground">{entry.job.schedule}</td>
              <td class="px-4 py-3 text-muted-foreground">
                {entry.nextRun ? new Date(entry.nextRun).toLocaleString() : '--'}
              </td>
              <td class="px-4 py-3">
                {#if entry.lastRun}
                  <div class="text-xs">
                    <span class="px-1.5 py-0.5 rounded
                      {entry.lastRun.outcome.kind === 'success' ? 'bg-green-500/20 text-green-400' :
                       entry.lastRun.outcome.kind === 'error' ? 'bg-red-500/20 text-red-400' :
                       'bg-yellow-500/20 text-yellow-400'}">
                      {entry.lastRun.outcome.kind}
                    </span>
                    <span class="ml-1 text-muted-foreground">
                      ${entry.lastRun.budget.estimatedCostUsd.toFixed(2)}
                    </span>
                  </div>
                {:else}
                  <span class="text-muted-foreground">--</span>
                {/if}
              </td>
              <td class="px-4 py-3">
                {#if busy}
                  <span class="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400 inline-flex items-center gap-1">
                    <span class="w-2.5 h-2.5 border-[1.5px] border-blue-400/30 border-t-blue-400 rounded-full animate-spin"></span>
                    {busy}...
                  </span>
                {:else if entry.isRunning}
                  <span class="px-2 py-0.5 text-xs rounded-full bg-yellow-500/20 text-yellow-400">running</span>
                {:else if entry.job.enabled}
                  <span class="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400">enabled</span>
                {:else}
                  <span class="px-2 py-0.5 text-xs rounded-full bg-muted text-muted-foreground">disabled</span>
                {/if}
              </td>
              <td class="px-4 py-3">
                <div class="flex gap-1 justify-end">
                  <button
                    onclick={() => runJob(entry.job.id)}
                    disabled={entry.isRunning || !!busy}
                    class="px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-50"
                  >
                    Run
                  </button>
                  {#if entry.job.enabled}
                    <button
                      onclick={() => disableJob(entry.job.id)}
                      disabled={!!busy}
                      class="px-2 py-1 text-xs bg-muted text-muted-foreground rounded hover:bg-accent disabled:opacity-50"
                    >
                      Disable
                    </button>
                  {:else}
                    <button
                      onclick={() => enableJob(entry.job.id)}
                      disabled={!!busy}
                      class="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                    >
                      Enable
                    </button>
                  {/if}
                  <button
                    onclick={() => recompileJob(entry.job.id)}
                    disabled={!!busy}
                    class="px-2 py-1 text-xs bg-muted text-muted-foreground rounded hover:bg-accent disabled:opacity-50"
                    title="Recompile policy"
                  >
                    Recompile
                  </button>
                  <button
                    onclick={() => removeJob(entry.job.id)}
                    disabled={!!busy}
                    class="px-2 py-1 text-xs bg-destructive text-destructive-foreground rounded hover:opacity-90 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
