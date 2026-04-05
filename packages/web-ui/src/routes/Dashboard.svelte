<script lang="ts">
  import { appState } from '../lib/stores.svelte.js';

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString();
  }

  function formatCost(usd: number): string {
    return `$${usd.toFixed(2)}`;
  }
</script>

<div class="p-6 space-y-6 animate-fade-in">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-semibold tracking-tight">Dashboard</h2>
    {#if appState.daemonStatus}
      <span class="text-xs font-mono text-muted-foreground">
        uptime {Math.floor(appState.daemonStatus.uptimeSeconds / 60)}m
      </span>
    {/if}
  </div>

  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
    <div class="group bg-card border border-border rounded-xl p-4 hover:border-primary/30 transition-colors">
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Sessions</span>
        <svg viewBox="0 0 24 24" class="w-4 h-4 text-muted-foreground/50" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      </div>
      <div class="text-3xl font-bold font-mono tracking-tight">{appState.activeSessionCount}</div>
      <div class="text-[11px] text-muted-foreground mt-1">active</div>
    </div>

    <div class="group bg-card border border-border rounded-xl p-4 hover:border-destructive/30 transition-colors
      {appState.escalationCount > 0 ? 'border-destructive/20' : ''}">
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Escalations</span>
        <svg viewBox="0 0 24 24" class="w-4 h-4 {appState.escalationCount > 0 ? 'text-destructive' : 'text-muted-foreground/50'}" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </div>
      <div class="text-3xl font-bold font-mono tracking-tight {appState.escalationCount > 0 ? 'text-destructive' : ''}">{appState.escalationCount}</div>
      <div class="text-[11px] text-muted-foreground mt-1">pending</div>
    </div>

    <div class="group bg-card border border-border rounded-xl p-4 hover:border-primary/30 transition-colors">
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Scheduled</span>
        <svg viewBox="0 0 24 24" class="w-4 h-4 text-muted-foreground/50" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <div class="text-3xl font-bold font-mono tracking-tight">{appState.daemonStatus?.jobs.enabled ?? 0}</div>
      <div class="text-[11px] text-muted-foreground mt-1">enabled jobs</div>
    </div>

    <div class="group bg-card border border-border rounded-xl p-4 hover:border-warning/30 transition-colors">
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Running</span>
        {#if (appState.daemonStatus?.jobs.running ?? 0) > 0}
          <span class="w-2 h-2 rounded-full bg-warning animate-pulse"></span>
        {:else}
          <svg viewBox="0 0 24 24" class="w-4 h-4 text-muted-foreground/50" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        {/if}
      </div>
      <div class="text-3xl font-bold font-mono tracking-tight">{appState.daemonStatus?.jobs.running ?? 0}</div>
      <div class="text-[11px] text-muted-foreground mt-1">in progress</div>
    </div>
  </div>

  {#if appState.sessions.size > 0}
    <div class="animate-fade-in">
      <h3 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Active Sessions</h3>
      <div class="bg-card border border-border rounded-xl overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border bg-muted/30">
              <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">ID</th>
              <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Source</th>
              <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
              <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Turns</th>
              <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Cost</th>
              <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Started</th>
            </tr>
          </thead>
          <tbody>
            {#each [...appState.sessions.values()] as session (session.label)}
              <tr
                class="border-t border-border/50 hover:bg-accent/40 cursor-pointer transition-colors"
                onclick={() => { appState.selectedSessionLabel = session.label; appState.currentView = 'sessions'; }}
              >
                <td class="px-4 py-2.5 font-mono font-medium text-primary">#{session.label}</td>
                <td class="px-4 py-2.5">
                  <span class="px-2 py-0.5 text-[11px] font-mono rounded bg-secondary text-secondary-foreground">{session.source.kind}</span>
                </td>
                <td class="px-4 py-2.5">
                  <span class="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded-full
                    {session.status === 'processing' ? 'bg-warning/15 text-warning' :
                     session.status === 'ready' ? 'bg-success/15 text-success' :
                     'bg-muted text-muted-foreground'}">
                    {#if session.status === 'processing'}
                      <span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse"></span>
                    {:else if session.status === 'ready'}
                      <span class="w-1.5 h-1.5 rounded-full bg-success"></span>
                    {/if}
                    {session.status}
                  </span>
                </td>
                <td class="px-4 py-2.5 font-mono text-muted-foreground">{session.turnCount}</td>
                <td class="px-4 py-2.5 font-mono">{formatCost(session.budget.estimatedCostUsd)}</td>
                <td class="px-4 py-2.5 text-muted-foreground">{formatTime(session.createdAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}

  {#if appState.jobs.length > 0}
    <div class="animate-fade-in">
      <h3 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Upcoming Jobs</h3>
      <div class="bg-card border border-border rounded-xl overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border bg-muted/30">
              <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
              <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Schedule</th>
              <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Next Run</th>
              <th class="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
            </tr>
          </thead>
          <tbody>
            {#each appState.jobs.filter(j => j.job.enabled).slice(0, 5) as entry (entry.job.id)}
              <tr class="border-t border-border/50">
                <td class="px-4 py-2.5 font-medium">{entry.job.name}</td>
                <td class="px-4 py-2.5 font-mono text-xs text-muted-foreground">{entry.job.schedule}</td>
                <td class="px-4 py-2.5 text-muted-foreground text-xs">
                  {entry.nextRun ? new Date(entry.nextRun).toLocaleString() : '--'}
                </td>
                <td class="px-4 py-2.5">
                  {#if entry.isRunning}
                    <span class="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded-full bg-warning/15 text-warning">
                      <span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse"></span>
                      running
                    </span>
                  {:else}
                    <span class="px-2 py-0.5 text-[11px] font-medium rounded-full bg-success/15 text-success">idle</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}

  {#if appState.sessions.size === 0 && appState.jobs.length === 0}
    <div class="bg-card border border-border rounded-xl p-12 text-center">
      <svg viewBox="0 0 24 24" class="w-10 h-10 mx-auto text-muted-foreground/30 mb-4" fill="none" stroke="currentColor" stroke-width="1">
        <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
      <p class="text-muted-foreground">No active sessions or jobs</p>
      <p class="text-sm text-muted-foreground/70 mt-1">Start a session or configure jobs to see activity here.</p>
    </div>
  {/if}
</div>
