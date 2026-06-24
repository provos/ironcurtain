<script lang="ts">
  import { appState, connectionGeneration, listResumableWorkflows } from '../lib/stores.svelte.js';
  import { Card } from '$lib/components/ui/card/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table/index.js';
  import { phaseBadgeVariant } from '$lib/utils.js';
  import { mergePastRuns, terminalSummariesAsPastRuns, formatRelativeTime, phaseLabel } from './workflows-helpers.js';
  import { computeWorkflowKpis, buildPhaseDistribution, sumWorkflowTokens, formatTokens } from './dashboard-helpers.js';
  import type { PastRunDto, WorkflowPhase } from '$lib/types.js';

  import ChatCircle from 'phosphor-svelte/lib/ChatCircle';
  import Warning from 'phosphor-svelte/lib/Warning';
  import Clock from 'phosphor-svelte/lib/Clock';
  import Lightning from 'phosphor-svelte/lib/Lightning';
  import ShieldCheck from 'phosphor-svelte/lib/ShieldCheck';
  import TreeStructure from 'phosphor-svelte/lib/TreeStructure';
  import Gavel from 'phosphor-svelte/lib/Gavel';
  import CheckCircle from 'phosphor-svelte/lib/CheckCircle';
  import WarningOctagon from 'phosphor-svelte/lib/WarningOctagon';
  import CaretRight from 'phosphor-svelte/lib/CaretRight';

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString();
  }

  function formatCost(usd: number): string {
    return `$${usd.toFixed(2)}`;
  }

  // ── Workflow statistics ──────────────────────────────────────────────
  // Past runs aren't held in the store; fetch them here and re-fetch on
  // (re)connect. `connectionGeneration.value` is read so this effect re-runs
  // after the store's post-connect refresh bumps it.
  let pastRunsRaw = $state<PastRunDto[]>([]);

  $effect(() => {
    void connectionGeneration.value;
    if (!appState.connected) return;
    void loadPastRuns();
  });

  async function loadPastRuns(): Promise<void> {
    try {
      pastRunsRaw = await listResumableWorkflows();
    } catch {
      // Best-effort: the section degrades to live-only stats.
    }
  }

  const liveWorkflows = $derived([...appState.workflows.values()]);
  const activeWorkflows = $derived(
    liveWorkflows.filter((wf) => wf.phase === 'running' || wf.phase === 'waiting_human'),
  );
  // Merge on-disk past runs with any in-memory terminal entries (in-memory wins).
  const pastRuns = $derived(mergePastRuns(pastRunsRaw, terminalSummariesAsPastRuns(liveWorkflows)));

  const kpis = $derived(computeWorkflowKpis(liveWorkflows, pastRuns, appState.pendingGates.size));
  const distribution = $derived(buildPhaseDistribution(liveWorkflows, pastRuns));
  // Non-empty segments drive both the bar and the legend, so compute them once.
  const visibleSegments = $derived(distribution.segments.filter((seg) => seg.count > 0));
  const totalTokens = $derived(sumWorkflowTokens(liveWorkflows, pastRuns));
  const hasWorkflowData = $derived(liveWorkflows.length > 0 || pastRuns.length > 0 || appState.pendingGates.size > 0);

  // Phase → bar/legend swatch. Distinct, theme-driven colors so the six phases
  // stay legible in every theme. `waiting_human` is a lighter shade of the
  // warning hue so it separates from `running` in the Iron theme, where
  // --primary and --warning resolve to the same amber.
  const PHASE_BAR_CLASS: Record<WorkflowPhase, string> = {
    running: 'bg-primary',
    waiting_human: 'bg-warning/55',
    completed: 'bg-success',
    failed: 'bg-destructive',
    aborted: 'bg-muted-foreground/60',
    interrupted: 'bg-foreground/40',
  };

  function goToWorkflows(): void {
    appState.selectedWorkflowId = null;
    appState.currentView = 'workflows';
  }

  function openWorkflow(workflowId: string): void {
    appState.selectedWorkflowId = workflowId;
    appState.currentView = 'workflows';
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

  {#if hasWorkflowData}
    <section class="space-y-3 animate-fade-in" data-testid="workflow-activity">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Workflow Activity</h3>
        <button
          type="button"
          onclick={goToWorkflows}
          data-testid="wf-view-all"
          class="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          View all
          <CaretRight size={12} weight="bold" />
        </button>
      </div>

      <Card class="overflow-hidden">
        <!-- KPI band: gap-px over a border-colored backdrop draws crisp hairline
             dividers that survive the 2-col (mobile) -> 4-col (desktop) reflow. -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border">
          <div class="bg-card p-4" data-testid="wf-stat-active">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Active</span>
              <TreeStructure size={16} class="text-muted-foreground/50" weight="duotone" />
            </div>
            <div class="text-3xl font-bold font-mono tracking-tight">{kpis.active}</div>
            <div class="text-[11px] text-muted-foreground mt-1">running / gated</div>
          </div>

          <div class="bg-card p-4" data-testid="wf-stat-gates">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Awaiting</span>
              <Gavel
                size={16}
                class={kpis.awaitingGate > 0 ? 'text-warning' : 'text-muted-foreground/50'}
                weight="duotone"
              />
            </div>
            <div class="text-3xl font-bold font-mono tracking-tight {kpis.awaitingGate > 0 ? 'text-warning' : ''}">
              {kpis.awaitingGate}
            </div>
            <div class="text-[11px] text-muted-foreground mt-1">human gates</div>
          </div>

          <div class="bg-card p-4" data-testid="wf-stat-completed">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Completed</span>
              <CheckCircle size={16} class="text-success/60" weight="duotone" />
            </div>
            <div class="text-3xl font-bold font-mono tracking-tight">{kpis.completed}</div>
            <div class="text-[11px] text-muted-foreground mt-1">past runs</div>
          </div>

          <div class="bg-card p-4" data-testid="wf-stat-issues">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Issues</span>
              <WarningOctagon
                size={16}
                class={kpis.issues > 0 ? 'text-destructive' : 'text-muted-foreground/50'}
                weight="duotone"
              />
            </div>
            <div class="text-3xl font-bold font-mono tracking-tight {kpis.issues > 0 ? 'text-destructive' : ''}">
              {kpis.issues}
            </div>
            <div class="text-[11px] text-muted-foreground mt-1">problem runs</div>
          </div>
        </div>

        {#if distribution.total > 0}
          <div class="border-t border-border px-4 py-3.5 space-y-2.5">
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Phase distribution</span>
              <span class="text-[11px] font-mono text-muted-foreground">
                {distribution.total} run{distribution.total === 1 ? '' : 's'} · {formatTokens(totalTokens)} tokens
              </span>
            </div>
            <div class="flex h-2 w-full overflow-hidden rounded-full bg-muted" data-testid="wf-distribution">
              {#each visibleSegments as seg (seg.phase)}
                <div
                  class="h-full {PHASE_BAR_CLASS[seg.phase]}"
                  style="width: {seg.pct}%"
                  title="{phaseLabel(seg.phase)}: {seg.count}"
                ></div>
              {/each}
            </div>
            <div class="flex flex-wrap gap-x-4 gap-y-1.5">
              {#each visibleSegments as seg (seg.phase)}
                <div class="flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full shrink-0 {PHASE_BAR_CLASS[seg.phase]}"></span>
                  <span class="text-[11px] text-muted-foreground capitalize">{phaseLabel(seg.phase)}</span>
                  <span class="text-[11px] font-mono text-foreground/70">{seg.count}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </Card>

      {#if activeWorkflows.length > 0}
        <div data-testid="dashboard-active-workflows">
          <Table>
            <TableHeader>
              <TableHead>Workflow</TableHead>
              <TableHead>Phase</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Round</TableHead>
              <TableHead>Started</TableHead>
            </TableHeader>
            <TableBody>
              {#each activeWorkflows as wf (wf.workflowId)}
                <TableRow clickable onclick={() => openWorkflow(wf.workflowId)}>
                  <TableCell class="font-mono font-medium text-primary text-xs">{wf.name}</TableCell>
                  <TableCell>
                    <Badge variant={phaseBadgeVariant(wf.phase)}>
                      {#if wf.phase === 'running'}
                        <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>
                      {:else if wf.phase === 'waiting_human'}
                        <span class="w-1.5 h-1.5 rounded-full bg-warning"></span>
                      {/if}
                      {phaseLabel(wf.phase)}
                    </Badge>
                  </TableCell>
                  <TableCell class="font-mono text-xs text-muted-foreground">{wf.currentState}</TableCell>
                  <TableCell class="font-mono text-muted-foreground tabular-nums">
                    {wf.maxRounds > 0 ? `${wf.round}/${wf.maxRounds}` : '--'}
                  </TableCell>
                  <TableCell class="text-muted-foreground whitespace-nowrap">
                    <span title={new Date(wf.startedAt).toLocaleString()}>{formatRelativeTime(wf.startedAt)}</span>
                  </TableCell>
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        </div>
      {/if}
    </section>
  {/if}

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

  {#if appState.sessions.size === 0 && appState.jobs.length === 0 && !hasWorkflowData}
    <Card class="p-12 text-center">
      <ShieldCheck size={40} class="mx-auto text-muted-foreground/30 mb-4" />
      <p class="text-muted-foreground">No active sessions or jobs</p>
      <p class="text-sm text-muted-foreground/70 mt-1">Start a session or configure jobs to see activity here.</p>
    </Card>
  {/if}
</div>
