<script lang="ts">
  import { appState, getWsClient } from '../lib/stores.svelte.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Card } from '$lib/components/ui/card/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';

  import Clock from 'phosphor-svelte/lib/Clock';

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
    <Alert variant="destructive" dismissible ondismiss={() => actionError = ''}>
      {actionError}
    </Alert>
  {/if}

  {#if appState.jobs.length === 0}
    <Card class="p-12 text-center">
      <Clock size={40} class="mx-auto text-muted-foreground/30 mb-4" />
      <p class="text-muted-foreground">No jobs configured</p>
      <p class="text-sm text-muted-foreground/70 mt-1">
        Add jobs via <code class="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">ironcurtain daemon add-job</code>
      </p>
    </Card>
  {:else}
    <Table>
      <TableHeader>
        <TableHead>Name</TableHead>
        <TableHead>Schedule</TableHead>
        <TableHead>Next Run</TableHead>
        <TableHead>Last Run</TableHead>
        <TableHead>Status</TableHead>
        <TableHead align="right">Actions</TableHead>
      </TableHeader>
      <TableBody>
        {#each appState.jobs as entry (entry.job.id)}
          {@const busy = busyJobs.get(entry.job.id)}
          <TableRow muted={!!busy}>
            <TableCell>
              <div class="font-medium">{entry.job.name}</div>
              <div class="text-[11px] text-muted-foreground font-mono mt-0.5">{entry.job.id}</div>
            </TableCell>
            <TableCell>
              <code class="text-xs font-mono text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">{entry.job.schedule}</code>
            </TableCell>
            <TableCell class="text-xs text-muted-foreground">
              {entry.nextRun ? new Date(entry.nextRun).toLocaleString() : '--'}
            </TableCell>
            <TableCell>
              {#if entry.lastRun}
                <div class="flex items-center gap-1.5">
                  <Badge variant={entry.lastRun.outcome.kind === 'success' ? 'success'
                    : entry.lastRun.outcome.kind === 'error' ? 'destructive'
                    : 'warning'}>
                    {entry.lastRun.outcome.kind}
                  </Badge>
                  <span class="text-[11px] font-mono text-muted-foreground">
                    ${entry.lastRun.budget.estimatedCostUsd.toFixed(2)}
                  </span>
                </div>
              {:else}
                <span class="text-xs text-muted-foreground/50">--</span>
              {/if}
            </TableCell>
            <TableCell>
              {#if busy}
                <Badge variant="default">
                  <Spinner size="xs" />
                  {busy}...
                </Badge>
              {:else if entry.isRunning}
                <Badge variant="warning">
                  <span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse"></span>
                  running
                </Badge>
              {:else if entry.job.enabled}
                <Badge variant="success">enabled</Badge>
              {:else}
                <Badge variant="secondary">disabled</Badge>
              {/if}
            </TableCell>
            <TableCell>
              <div class="flex gap-1.5 justify-end">
                <Button
                  size="sm"
                  onclick={() => runJob(entry.job.id)}
                  disabled={entry.isRunning || !!busy}
                >Run</Button>
                {#if entry.job.enabled}
                  <Button
                    variant="secondary"
                    size="sm"
                    onclick={() => disableJob(entry.job.id)}
                    disabled={!!busy}
                  >Disable</Button>
                {:else}
                  <Button
                    variant="success"
                    size="sm"
                    onclick={() => enableJob(entry.job.id)}
                    disabled={!!busy}
                  >Enable</Button>
                {/if}
                <Button
                  variant="secondary"
                  size="sm"
                  onclick={() => recompileJob(entry.job.id)}
                  disabled={!!busy}
                  title="Recompile policy"
                >Recompile</Button>
                <Button
                  variant="ghost"
                  size="sm"
                  class="text-destructive hover:bg-destructive hover:text-destructive-foreground"
                  onclick={() => removeJob(entry.job.id)}
                  disabled={!!busy}
                >Remove</Button>
              </div>
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  {/if}
</div>
