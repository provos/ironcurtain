<script lang="ts">
  import { appState } from '../lib/stores.svelte.js';
  import { Card } from '$lib/components/ui/card/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table/index.js';

  import ChatCircle from 'phosphor-svelte/lib/ChatCircle';
  import Warning from 'phosphor-svelte/lib/Warning';
  import Clock from 'phosphor-svelte/lib/Clock';
  import Lightning from 'phosphor-svelte/lib/Lightning';
  import ShieldCheck from 'phosphor-svelte/lib/ShieldCheck';

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
    <Card data-testid="stat-sessions" class="group p-4 hover:border-primary/30 transition-colors">
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Sessions</span>
        <ChatCircle size={16} class="text-muted-foreground/50" />
      </div>
      <div class="text-3xl font-bold font-mono tracking-tight">{appState.activeSessionCount}</div>
      <div class="text-[11px] text-muted-foreground mt-1">active</div>
    </Card>

    <Card
      data-testid="stat-escalations"
      class="group p-4 hover:border-destructive/30 transition-colors {appState.escalationCount > 0
        ? 'border-destructive/20'
        : ''}"
    >
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Escalations</span>
        <Warning size={16} class={appState.escalationCount > 0 ? 'text-destructive' : 'text-muted-foreground/50'} />
      </div>
      <div class="text-3xl font-bold font-mono tracking-tight {appState.escalationCount > 0 ? 'text-destructive' : ''}">
        {appState.escalationCount}
      </div>
      <div class="text-[11px] text-muted-foreground mt-1">pending</div>
    </Card>

    <Card data-testid="stat-scheduled" class="group p-4 hover:border-primary/30 transition-colors">
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Scheduled</span>
        <Clock size={16} class="text-muted-foreground/50" />
      </div>
      <div class="text-3xl font-bold font-mono tracking-tight">{appState.daemonStatus?.jobs.enabled ?? 0}</div>
      <div class="text-[11px] text-muted-foreground mt-1">enabled jobs</div>
    </Card>

    <Card data-testid="stat-running" class="group p-4 hover:border-warning/30 transition-colors">
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Running</span>
        {#if (appState.daemonStatus?.jobs.running ?? 0) > 0}
          <span class="w-2 h-2 rounded-full bg-warning animate-pulse"></span>
        {:else}
          <Lightning size={16} class="text-muted-foreground/50" />
        {/if}
      </div>
      <div class="text-3xl font-bold font-mono tracking-tight">{appState.daemonStatus?.jobs.running ?? 0}</div>
      <div class="text-[11px] text-muted-foreground mt-1">in progress</div>
    </Card>
  </div>

  {#if appState.sessions.size > 0}
    <div class="animate-fade-in">
      <h3 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Active Sessions</h3>
      <Table>
        <TableHeader>
          <TableHead>ID</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Turns</TableHead>
          <TableHead>Cost</TableHead>
          <TableHead>Started</TableHead>
        </TableHeader>
        <TableBody>
          {#each [...appState.sessions.values()] as session (session.label)}
            <TableRow
              clickable
              onclick={() => {
                appState.selectedSessionLabel = session.label;
                appState.currentView = 'sessions';
              }}
            >
              <TableCell class="font-mono font-medium text-primary">#{session.label}</TableCell>
              <TableCell>
                <Badge variant="secondary" class="font-mono">{session.source.kind}</Badge>
              </TableCell>
              <TableCell>
                <Badge
                  variant={session.status === 'processing'
                    ? 'warning'
                    : session.status === 'ready'
                      ? 'success'
                      : 'secondary'}
                >
                  {#if session.status === 'processing'}
                    <span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse"></span>
                  {:else if session.status === 'ready'}
                    <span class="w-1.5 h-1.5 rounded-full bg-success"></span>
                  {/if}
                  {session.status}
                </Badge>
              </TableCell>
              <TableCell class="font-mono text-muted-foreground">{session.turnCount}</TableCell>
              <TableCell class="font-mono">{formatCost(session.budget.estimatedCostUsd)}</TableCell>
              <TableCell class="text-muted-foreground">{formatTime(session.createdAt)}</TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {/if}

  {#if appState.jobs.length > 0}
    <div class="animate-fade-in">
      <h3 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Upcoming Jobs</h3>
      <Table>
        <TableHeader>
          <TableHead>Name</TableHead>
          <TableHead>Schedule</TableHead>
          <TableHead>Next Run</TableHead>
          <TableHead>Status</TableHead>
        </TableHeader>
        <TableBody>
          {#each appState.jobs.filter((j) => j.job.enabled).slice(0, 5) as entry (entry.job.id)}
            <TableRow>
              <TableCell class="font-medium">{entry.job.name}</TableCell>
              <TableCell class="font-mono text-xs text-muted-foreground">{entry.job.schedule}</TableCell>
              <TableCell class="text-muted-foreground text-xs">
                {entry.nextRun ? new Date(entry.nextRun).toLocaleString() : '--'}
              </TableCell>
              <TableCell>
                {#if entry.isRunning}
                  <Badge variant="warning">
                    <span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse"></span>
                    running
                  </Badge>
                {:else}
                  <Badge variant="success">idle</Badge>
                {/if}
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {/if}

  {#if appState.sessions.size === 0 && appState.jobs.length === 0}
    <Card class="p-12 text-center">
      <ShieldCheck size={40} class="mx-auto text-muted-foreground/30 mb-4" />
      <p class="text-muted-foreground">No active sessions or jobs</p>
      <p class="text-sm text-muted-foreground/70 mt-1">Start a session or configure jobs to see activity here.</p>
    </Card>
  {/if}
</div>
