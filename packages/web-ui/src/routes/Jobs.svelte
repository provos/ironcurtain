<script lang="ts">
  import { appState, getWsClient } from '../lib/stores.svelte.js';

  async function runJob(jobId: string): Promise<void> {
    try {
      await getWsClient().request('jobs.run', { jobId });
    } catch (err) {
      console.error('Failed to run job:', err);
    }
  }

  async function enableJob(jobId: string): Promise<void> {
    try {
      await getWsClient().request('jobs.enable', { jobId });
    } catch (err) {
      console.error('Failed to enable job:', err);
    }
  }

  async function disableJob(jobId: string): Promise<void> {
    try {
      await getWsClient().request('jobs.disable', { jobId });
    } catch (err) {
      console.error('Failed to disable job:', err);
    }
  }

  async function removeJob(jobId: string): Promise<void> {
    if (!confirm(`Remove job "${jobId}"?`)) return;
    try {
      await getWsClient().request('jobs.remove', { jobId });
    } catch (err) {
      console.error('Failed to remove job:', err);
    }
  }

  async function recompileJob(jobId: string): Promise<void> {
    try {
      await getWsClient().request('jobs.recompile', { jobId });
    } catch (err) {
      console.error('Failed to recompile job:', err);
    }
  }
</script>

<div class="p-6 space-y-6">
  <h2 class="text-2xl font-semibold">Jobs</h2>

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
            <tr class="border-t border-border">
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
                {#if entry.isRunning}
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
                    disabled={entry.isRunning}
                    class="px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-50"
                  >
                    Run
                  </button>
                  {#if entry.job.enabled}
                    <button
                      onclick={() => disableJob(entry.job.id)}
                      class="px-2 py-1 text-xs bg-muted text-muted-foreground rounded hover:bg-accent"
                    >
                      Disable
                    </button>
                  {:else}
                    <button
                      onclick={() => enableJob(entry.job.id)}
                      class="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                    >
                      Enable
                    </button>
                  {/if}
                  <button
                    onclick={() => recompileJob(entry.job.id)}
                    class="px-2 py-1 text-xs bg-muted text-muted-foreground rounded hover:bg-accent"
                    title="Recompile policy"
                  >
                    Recompile
                  </button>
                  <button
                    onclick={() => removeJob(entry.job.id)}
                    class="px-2 py-1 text-xs bg-destructive text-destructive-foreground rounded hover:opacity-90"
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
