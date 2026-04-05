<script lang="ts">
  import { appState } from '../lib/stores.svelte.js';
  import type { SessionDto, JobListDto } from '../lib/types.js';

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString();
  }

  function formatCost(usd: number): string {
    return `$${usd.toFixed(2)}`;
  }
</script>

<div class="p-6 space-y-6">
  <h2 class="text-2xl font-semibold">Dashboard</h2>

  <!-- Status cards -->
  <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
    <div class="bg-card border border-border rounded-lg p-4">
      <div class="text-sm text-muted-foreground">Active Sessions</div>
      <div class="text-3xl font-bold mt-1">{appState.activeSessionCount}</div>
    </div>
    <div class="bg-card border border-border rounded-lg p-4">
      <div class="text-sm text-muted-foreground">Pending Escalations</div>
      <div class="text-3xl font-bold mt-1 {appState.escalationCount > 0 ? 'text-destructive' : ''}">
        {appState.escalationCount}
      </div>
    </div>
    <div class="bg-card border border-border rounded-lg p-4">
      <div class="text-sm text-muted-foreground">Scheduled Jobs</div>
      <div class="text-3xl font-bold mt-1">{appState.daemonStatus?.jobs.enabled ?? 0}</div>
    </div>
    <div class="bg-card border border-border rounded-lg p-4">
      <div class="text-sm text-muted-foreground">Running Jobs</div>
      <div class="text-3xl font-bold mt-1">{appState.daemonStatus?.jobs.running ?? 0}</div>
    </div>
  </div>

  <!-- Active sessions -->
  {#if appState.sessions.size > 0}
    <div>
      <h3 class="text-lg font-medium mb-3">Active Sessions</h3>
      <div class="bg-card border border-border rounded-lg overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-muted/50">
            <tr>
              <th class="text-left px-4 py-2 font-medium">Label</th>
              <th class="text-left px-4 py-2 font-medium">Source</th>
              <th class="text-left px-4 py-2 font-medium">Status</th>
              <th class="text-left px-4 py-2 font-medium">Turns</th>
              <th class="text-left px-4 py-2 font-medium">Cost</th>
              <th class="text-left px-4 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {#each [...appState.sessions.values()] as session (session.label)}
              <tr
                class="border-t border-border hover:bg-accent/30 cursor-pointer transition-colors"
                onclick={() => { appState.selectedSessionLabel = session.label; appState.currentView = 'sessions'; }}
              >
                <td class="px-4 py-2 font-mono">#{session.label}</td>
                <td class="px-4 py-2">{session.source.kind}</td>
                <td class="px-4 py-2">
                  <span class="px-2 py-0.5 text-xs rounded-full
                    {session.status === 'processing' ? 'bg-yellow-500/20 text-yellow-400' :
                     session.status === 'ready' ? 'bg-green-500/20 text-green-400' :
                     'bg-muted text-muted-foreground'}">
                    {session.status}
                  </span>
                </td>
                <td class="px-4 py-2">{session.turnCount}</td>
                <td class="px-4 py-2">{formatCost(session.budget.estimatedCostUsd)}</td>
                <td class="px-4 py-2 text-muted-foreground">{formatTime(session.createdAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}

  <!-- Upcoming jobs -->
  {#if appState.jobs.length > 0}
    <div>
      <h3 class="text-lg font-medium mb-3">Upcoming Jobs</h3>
      <div class="bg-card border border-border rounded-lg overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-muted/50">
            <tr>
              <th class="text-left px-4 py-2 font-medium">Name</th>
              <th class="text-left px-4 py-2 font-medium">Schedule</th>
              <th class="text-left px-4 py-2 font-medium">Next Run</th>
              <th class="text-left px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {#each appState.jobs.filter(j => j.job.enabled).slice(0, 5) as entry (entry.job.id)}
              <tr class="border-t border-border">
                <td class="px-4 py-2 font-medium">{entry.job.name}</td>
                <td class="px-4 py-2 font-mono text-muted-foreground">{entry.job.schedule}</td>
                <td class="px-4 py-2 text-muted-foreground">
                  {entry.nextRun ? new Date(entry.nextRun).toLocaleString() : '--'}
                </td>
                <td class="px-4 py-2">
                  {#if entry.isRunning}
                    <span class="px-2 py-0.5 text-xs rounded-full bg-yellow-500/20 text-yellow-400">running</span>
                  {:else}
                    <span class="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400">idle</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
