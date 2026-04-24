<script lang="ts">
  import {
    appState,
    startWorkflow as rpcStartWorkflow,
    abortWorkflow as rpcAbortWorkflow,
    refreshWorkflows,
    listWorkflowDefinitions,
    listResumableWorkflows,
    resumeWorkflow as rpcResumeWorkflow,
    importWorkflow as rpcImportWorkflow,
  } from '../lib/stores.svelte.js';
  import type { WorkflowSummaryDto, WorkflowDefinitionDto, PastRunDto } from '$lib/types.js';
  import { phaseBadgeVariant } from '$lib/utils.js';
  import {
    mergePastRuns,
    terminalSummariesAsPastRuns,
    truncate,
    isResumablePhase,
    PAST_RUN_FILTERS,
    filterPastRuns,
    countByPhase,
    formatConfidence,
    formatDurationMs,
    buildSummaryPlaceholder,
    synthesizeSummaryFromPastRun,
    synthesizeSummaryFromId,
    type PastRunFilter,
  } from './workflows-helpers.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Card, CardHeader, CardTitle, CardContent } from '$lib/components/ui/card/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table/index.js';
  import WorkflowDetail from './WorkflowDetail.svelte';

  const CUSTOM_PATH_SENTINEL = '__custom__';

  let definitions: WorkflowDefinitionDto[] = $state([]);
  let selectedDefinition = $state('');
  let customPath = $state('');
  let taskDescription = $state('');
  let workspacePath = $state('');
  let starting = $state(false);
  let actionError = $state('');
  // Track the gate set that was visible when the user dismissed the detail view.
  // The auto-select effect will not re-select until the set of pending gates changes.
  let dismissedGateIds: Set<string> | null = $state(null);

  // Past-runs section state
  let resumableWorkflows: PastRunDto[] = $state([]);
  let resumingId: string | null = $state(null);
  let importDirExpanded = $state(false);
  let importDir = $state('');
  let importing = $state(false);
  let resumeMessage = $state('');
  let pastRunFilter: PastRunFilter = $state('all');
  // Per-row expansion of the truncated taskDescription cell. Keyed by
  // workflowId so selections survive re-renders. Toggles between the 40-char
  // truncation and the full text in the same cell.
  let expandedTasks = $state<Set<string>>(new Set());

  function toggleTaskExpansion(id: string): void {
    const next = new Set(expandedTasks);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    expandedTasks = next;
  }

  const isCustomPath = $derived(selectedDefinition === CUSTOM_PATH_SENTINEL);
  const effectivePath = $derived(isCustomPath ? customPath.trim() : selectedDefinition);

  $effect(() => {
    refreshWorkflows();
    loadDefinitions();
    loadResumable();
  });

  async function loadDefinitions(): Promise<void> {
    try {
      definitions = await listWorkflowDefinitions();
    } catch {
      // Best-effort; the dropdown will be empty
    }
  }

  async function loadResumable(): Promise<void> {
    try {
      resumableWorkflows = await listResumableWorkflows();
    } catch {
      // Best-effort
    }
  }

  async function handleStart(): Promise<void> {
    if (!effectivePath || !taskDescription.trim()) return;
    starting = true;
    actionError = '';
    try {
      const result = await rpcStartWorkflow(effectivePath, taskDescription.trim(), workspacePath.trim() || undefined);
      // Ensure the workflow exists in the Map so events arriving before
      // refreshWorkflows() completes are not silently dropped.
      if (!appState.workflows.has(result.workflowId)) {
        appState.workflows = new Map(appState.workflows).set(
          result.workflowId,
          buildSummaryPlaceholder({ workflowId: result.workflowId, currentState: 'starting...' }),
        );
      }
      selectedDefinition = '';
      customPath = '';
      taskDescription = '';
      workspacePath = '';
      await refreshWorkflows();
    } catch (err) {
      actionError = `Failed to start workflow: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      starting = false;
    }
  }

  async function handleResume(workflowId: string): Promise<void> {
    resumingId = workflowId;
    actionError = '';
    resumeMessage = '';
    // Insert a placeholder so events arriving before the RPC returns are not dropped.
    if (!appState.workflows.has(workflowId)) {
      appState.workflows = new Map(appState.workflows).set(
        workflowId,
        buildSummaryPlaceholder({ workflowId: workflowId, currentState: 'resuming...' }),
      );
    }
    try {
      await rpcResumeWorkflow(workflowId);
      resumeMessage = `Workflow ${workflowId.slice(0, 8)}... resumed`;
      await Promise.all([refreshWorkflows(), loadResumable()]);
    } catch (err) {
      // Remove the placeholder on failure
      const next = new Map(appState.workflows);
      next.delete(workflowId);
      appState.workflows = next;
      actionError = `Failed to resume workflow: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      resumingId = null;
    }
  }

  async function handleImportAndResume(): Promise<void> {
    if (!importDir.trim()) return;
    importing = true;
    actionError = '';
    resumeMessage = '';
    try {
      // Two-step: import first to get the workflowId, insert placeholder, then resume.
      // This ensures the placeholder is in place before resume emits lifecycle events.
      const { workflowId } = await rpcImportWorkflow(importDir.trim());
      if (!appState.workflows.has(workflowId)) {
        appState.workflows = new Map(appState.workflows).set(
          workflowId,
          buildSummaryPlaceholder({ workflowId: workflowId, currentState: 'resuming...' }),
        );
      }
      await rpcResumeWorkflow(workflowId);
      resumeMessage = `Imported and resumed workflow ${workflowId.slice(0, 8)}...`;
      importDir = '';
      importDirExpanded = false;
      await Promise.all([refreshWorkflows(), loadResumable()]);
    } catch (err) {
      actionError = `Failed to import workflow: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      importing = false;
    }
  }

  async function handleAbort(workflowId: string): Promise<void> {
    if (!confirm('Abort this workflow?')) return;
    actionError = '';
    try {
      await rpcAbortWorkflow(workflowId);
      await refreshWorkflows();
    } catch (err) {
      actionError = `Failed to abort workflow: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  function setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) {
      if (!b.has(v)) return false;
    }
    return true;
  }

  function selectWorkflow(id: string): void {
    dismissedGateIds = null;
    appState.selectedWorkflowId = id;
  }

  function deselectWorkflow(): void {
    // Snapshot current gate IDs so the auto-select effect won't immediately re-select.
    dismissedGateIds = new Set(appState.pendingGates.keys());
    appState.selectedWorkflowId = null;
  }

  const allWorkflows = $derived([...appState.workflows.values()]);
  // Active section: only running / waiting_human entries.
  const activeWorkflows = $derived(allWorkflows.filter((w) => w.phase === 'running' || w.phase === 'waiting_human'));
  // In-memory terminal entries projected onto the past-run shape.
  const inMemoryTerminal = $derived(terminalSummariesAsPastRuns(allWorkflows));
  // Merged + dedup'd past runs (in-memory wins on conflict).
  const pastRuns = $derived(mergePastRuns(resumableWorkflows, inMemoryTerminal));
  const filteredPastRuns = $derived(filterPastRuns(pastRuns, pastRunFilter));
  const pastRunCounts = $derived(countByPhase(pastRuns));

  const selectedWorkflow = $derived(
    appState.selectedWorkflowId ? (appState.workflows.get(appState.selectedWorkflowId) ?? null) : null,
  );

  /**
   * Resolved summary for the detail view. Falls back through:
   *   1. Live in-memory entry (`appState.workflows`).
   *   2. Past-run row from the merged `pastRuns` list.
   *   3. Synthesized placeholder from just the workflowId (for deep links).
   * `WorkflowDetail` calls `getWorkflowDetail(id)` on mount, which populates
   * the rest of the fields from disk.
   */
  const detailSummary = $derived.by((): WorkflowSummaryDto | null => {
    if (!appState.selectedWorkflowId) return null;
    if (selectedWorkflow) return selectedWorkflow;
    const pastRow = pastRuns.find((r) => r.workflowId === appState.selectedWorkflowId);
    if (pastRow) return synthesizeSummaryFromPastRun(pastRow);
    return synthesizeSummaryFromId(appState.selectedWorkflowId);
  });

  const selectedGate = $derived.by(() => {
    if (!appState.selectedWorkflowId) return undefined;
    for (const gate of appState.pendingGates.values()) {
      if (gate.workflowId === appState.selectedWorkflowId) return gate;
    }
    return undefined;
  });

  // Auto-select a workflow when a gate is raised (if no workflow currently selected).
  // Skip if the user just dismissed the detail view and the gate set hasn't changed.
  $effect(() => {
    if (appState.selectedWorkflowId) return;
    if (appState.pendingGates.size === 0) return;

    const currentGateIds = new Set(appState.pendingGates.keys());
    if (dismissedGateIds && setsEqual(dismissedGateIds, currentGateIds)) return;
    // Gate set changed (new gate arrived or one was resolved) -- clear the dismissal.
    dismissedGateIds = null;

    for (const [, gate] of appState.pendingGates) {
      if (appState.workflows.has(gate.workflowId)) {
        appState.selectedWorkflowId = gate.workflowId;
        return;
      }
    }
  });

  // Group definitions by source for the dropdown
  const bundledDefs = $derived(definitions.filter((d) => d.source === 'bundled'));
  const userDefs = $derived(definitions.filter((d) => d.source === 'user'));
</script>

{#if appState.selectedWorkflowId && detailSummary}
  <WorkflowDetail
    workflowId={appState.selectedWorkflowId}
    summary={detailSummary}
    gate={selectedGate}
    onback={deselectWorkflow}
  />
{:else}
  <div class="p-6 space-y-5 animate-fade-in">
    <div class="flex items-center justify-between">
      <h2 class="text-xl font-semibold tracking-tight">Workflows</h2>
      <div class="flex gap-2">
        {#if appState.pendingGates.size > 0}
          <Badge variant="warning"
            >{appState.pendingGates.size} gate{appState.pendingGates.size > 1 ? 's' : ''} pending</Badge
          >
        {/if}
        <Badge variant="outline">{activeWorkflows.length} active</Badge>
      </div>
    </div>

    {#if actionError}
      <!--
        Sticky so the alert stays visible while the user scrolls past it. The
        outer scroll container is <main> from App.svelte; z-10 keeps the alert
        above sibling cards but below the drawer (z-50 from Fix-pack A).
        bg-background prevents body content showing through as it scrolls under.
      -->
      <div class="sticky top-0 z-10 -mx-6 px-6 py-2 bg-background/95 backdrop-blur" data-testid="action-error-sticky">
        <Alert variant="destructive" dismissible ondismiss={() => (actionError = '')}>{actionError}</Alert>
      </div>
    {/if}

    <Card>
      <CardHeader>
        <CardTitle>Start Workflow</CardTitle>
      </CardHeader>
      <CardContent>
        <div class="space-y-3">
          <div>
            <label for="def-select" class="block text-sm text-muted-foreground mb-1">Workflow definition</label>
            <select
              id="def-select"
              bind:value={selectedDefinition}
              class="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring transition-all"
            >
              <option value="">Select a workflow...</option>
              {#if bundledDefs.length > 0}
                <optgroup label="Bundled">
                  {#each bundledDefs as def (def.path)}
                    <option value={def.path}>{def.name} -- {def.description}</option>
                  {/each}
                </optgroup>
              {/if}
              {#if userDefs.length > 0}
                <optgroup label="User">
                  {#each userDefs as def (def.path)}
                    <option value={def.path}>{def.name} -- {def.description}</option>
                  {/each}
                </optgroup>
              {/if}
              <option value={CUSTOM_PATH_SENTINEL}>Other (custom path)...</option>
            </select>
          </div>
          {#if isCustomPath}
            <div>
              <label for="custom-path" class="block text-sm text-muted-foreground mb-1">Definition file path</label>
              <Input id="custom-path" bind:value={customPath} placeholder="/path/to/workflow.yaml" />
            </div>
          {/if}
          <div>
            <label for="task-desc" class="block text-sm text-muted-foreground mb-1">Task description</label>
            <textarea
              id="task-desc"
              bind:value={taskDescription}
              placeholder="Describe the task in detail..."
              rows="4"
              class="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring placeholder:text-muted-foreground/50 transition-all disabled:opacity-50 resize-y min-h-[80px]"
            ></textarea>
          </div>
          <div>
            <label for="ws-path" class="block text-sm text-muted-foreground mb-1">Workspace path (optional)</label>
            <Input id="ws-path" bind:value={workspacePath} placeholder="/path/to/workspace" />
          </div>
          <Button onclick={handleStart} loading={starting} disabled={!effectivePath || !taskDescription.trim()}>
            Start Workflow
          </Button>
        </div>
      </CardContent>
    </Card>

    {#if resumeMessage}
      <Alert variant="default" dismissible ondismiss={() => (resumeMessage = '')}>{resumeMessage}</Alert>
    {/if}

    {#snippet taskCell(workflowId: string, taskDescription: string | undefined, maxLen: number)}
      {@const isOpen = expandedTasks.has(workflowId)}
      {#if taskDescription}
        <button
          type="button"
          class="text-left text-inherit hover:text-foreground p-0 m-0 bg-transparent border-0 cursor-pointer {isOpen
            ? 'whitespace-normal break-words'
            : 'truncate block max-w-full'}"
          title={taskDescription}
          aria-expanded={isOpen}
          data-testid={`task-toggle-${workflowId}`}
          onclick={(e: MouseEvent) => {
            e.stopPropagation();
            toggleTaskExpansion(workflowId);
          }}
        >
          {isOpen ? taskDescription : truncate(taskDescription, maxLen)}
        </button>
      {:else}
        <span class="text-muted-foreground">--</span>
      {/if}
    {/snippet}

    {#snippet verdictBadge(latestVerdict: { verdict: string; confidence?: number } | undefined)}
      {#if latestVerdict}
        <Badge variant="outline" title={latestVerdict.verdict}>
          {truncate(latestVerdict.verdict, 30)}{#if latestVerdict.confidence !== undefined}
            &nbsp;({formatConfidence(latestVerdict.confidence)})
          {/if}
        </Badge>
      {:else}
        <span class="text-muted-foreground text-sm">--</span>
      {/if}
    {/snippet}

    <!-- Active Workflows section -->
    <section class="space-y-2" data-testid="active-workflows-section">
      <h3 class="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Active workflows</h3>
      {#if activeWorkflows.length === 0}
        <Card>
          <CardContent>
            <p class="text-center text-muted-foreground py-8">No active workflows. Start one above.</p>
          </CardContent>
        </Card>
      {:else}
        <Table>
          <TableHeader>
            <TableHead>Workflow</TableHead>
            <TableHead>Phase</TableHead>
            <TableHead>Current State</TableHead>
            <TableHead>Task</TableHead>
            <TableHead>Round</TableHead>
            <TableHead>Verdict</TableHead>
            <TableHead>Started</TableHead>
            <TableHead class="text-right">Actions</TableHead>
          </TableHeader>
          <TableBody>
            {#each activeWorkflows as wf (wf.workflowId)}
              <TableRow clickable onclick={() => selectWorkflow(wf.workflowId)}>
                <TableCell class="font-medium font-mono text-xs">{wf.name}</TableCell>
                <TableCell>
                  <span class="inline-flex items-center gap-1.5">
                    <Badge variant={phaseBadgeVariant(wf.phase)}>{wf.phase.replace('_', ' ')}</Badge>
                    {#if wf.phase === 'failed' && wf.error}
                      <Badge variant="destructive" class="cursor-help" title={wf.error}>!</Badge>
                    {/if}
                  </span>
                </TableCell>
                <TableCell class="font-mono text-xs">{wf.currentState}</TableCell>
                <TableCell class="text-sm max-w-[28ch]">
                  {@render taskCell(wf.workflowId, wf.taskDescription, 40)}
                </TableCell>
                <TableCell class="text-sm tabular-nums">
                  {wf.maxRounds > 0 ? `${wf.round}/${wf.maxRounds}` : '--'}
                </TableCell>
                <TableCell>{@render verdictBadge(wf.latestVerdict)}</TableCell>
                <TableCell class="text-muted-foreground text-sm">
                  {new Date(wf.startedAt).toLocaleTimeString()}
                </TableCell>
                <TableCell class="text-right">
                  {#if wf.phase === 'running' || wf.phase === 'waiting_human'}
                    <Button
                      variant="destructive"
                      size="sm"
                      onclick={(e: MouseEvent) => {
                        e.stopPropagation();
                        handleAbort(wf.workflowId);
                      }}>Abort</Button
                    >
                  {:else}
                    <span class="text-muted-foreground text-sm">--</span>
                  {/if}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </section>

    <!-- Past runs section (replaces the old "Resumable workflows" panel) -->
    <section class="space-y-2" data-testid="past-runs-section">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Past runs</h3>
      </div>

      <Card>
        <CardContent>
          <!-- Filter pills -->
          <div class="flex flex-wrap gap-2 mb-4" role="tablist" aria-label="Past runs filter">
            {#each PAST_RUN_FILTERS as f (f.id)}
              <Button
                size="sm"
                variant={pastRunFilter === f.id ? 'default' : 'outline'}
                aria-pressed={pastRunFilter === f.id}
                role="tab"
                data-testid={`past-run-filter-${f.id}`}
                onclick={() => (pastRunFilter = f.id)}
              >
                {f.label} ({pastRunCounts[f.id]})
              </Button>
            {/each}
          </div>

          {#if filteredPastRuns.length === 0}
            <p class="text-sm text-muted-foreground py-4 text-center">
              {pastRunFilter === 'all' ? 'No past runs found.' : `No ${pastRunFilter.replace('_', ' ')} runs.`}
            </p>
          {:else}
            <Table>
              <TableHeader>
                <TableHead>Phase</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Last State</TableHead>
                <TableHead>Round</TableHead>
                <TableHead>Verdict</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Timestamp</TableHead>
                <TableHead class="text-right">Actions</TableHead>
              </TableHeader>
              <TableBody>
                {#each filteredPastRuns as row (row.workflowId)}
                  <TableRow>
                    <TableCell>
                      <span class="inline-flex items-center gap-1.5">
                        <Badge variant={phaseBadgeVariant(row.phase)}>{row.phase.replace('_', ' ')}</Badge>
                        {#if row.phase === 'failed' && row.error}
                          <Badge variant="destructive" class="cursor-help" title={row.error}>!</Badge>
                        {/if}
                      </span>
                    </TableCell>
                    <TableCell class="text-sm max-w-[36ch]">
                      {@render taskCell(row.workflowId, row.taskDescription, 80)}
                    </TableCell>
                    <TableCell class="font-mono text-xs">{row.lastState || '--'}</TableCell>
                    <TableCell class="text-sm tabular-nums">
                      {row.maxRounds > 0 ? `${row.round}/${row.maxRounds}` : '--'}
                    </TableCell>
                    <TableCell>{@render verdictBadge(row.latestVerdict)}</TableCell>
                    <TableCell class="text-muted-foreground text-sm">
                      {formatDurationMs(row.durationMs) || '--'}
                    </TableCell>
                    <TableCell class="text-muted-foreground text-sm">
                      {new Date(row.timestamp).toLocaleString()}
                    </TableCell>
                    <TableCell class="text-right space-x-1.5 whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`investigate-${row.workflowId}`}
                        onclick={() => selectWorkflow(row.workflowId)}
                      >
                        Investigate
                      </Button>
                      {#if isResumablePhase(row.phase)}
                        <Button
                          size="sm"
                          loading={resumingId === row.workflowId}
                          disabled={resumingId !== null}
                          data-testid={`resume-${row.workflowId}`}
                          onclick={() => handleResume(row.workflowId)}
                        >
                          Resume
                        </Button>
                      {:else}
                        <Button
                          size="sm"
                          disabled
                          aria-disabled="true"
                          data-testid={`resume-${row.workflowId}`}
                          title="Workflow is completed/aborted -- use Investigate"
                        >
                          Resume
                        </Button>
                      {/if}
                    </TableCell>
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          {/if}

          <!-- Import & Resume from directory expander, preserved from the old layout -->
          <div class="mt-4 pt-4 border-t border-border">
            <button
              type="button"
              class="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
              onclick={() => (importDirExpanded = !importDirExpanded)}
            >
              <span class="inline-block transition-transform" class:rotate-90={importDirExpanded}>&#9654;</span>
              Import &amp; Resume from directory
            </button>
            {#if importDirExpanded}
              <div class="flex gap-2 mt-2">
                <Input bind:value={importDir} placeholder="/path/to/workflow-runs/" class="flex-1" />
                <Button size="sm" loading={importing} disabled={!importDir.trim()} onclick={handleImportAndResume}>
                  Import &amp; Resume
                </Button>
              </div>
            {/if}
          </div>
        </CardContent>
      </Card>
    </section>
  </div>
{/if}
