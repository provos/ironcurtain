<script lang="ts">
  import {
    appState,
    startWorkflow as rpcStartWorkflow,
    abortWorkflow as rpcAbortWorkflow,
    refreshWorkflows,
    listWorkflowDefinitions,
  } from '../lib/stores.svelte.js';
  import type { WorkflowDefinitionDto } from '$lib/types.js';
  import { phaseBadgeVariant } from '$lib/utils.js';
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

  const isCustomPath = $derived(selectedDefinition === CUSTOM_PATH_SENTINEL);
  const effectivePath = $derived(isCustomPath ? customPath.trim() : selectedDefinition);

  $effect(() => {
    refreshWorkflows();
    loadDefinitions();
  });

  async function loadDefinitions(): Promise<void> {
    try {
      definitions = await listWorkflowDefinitions();
    } catch {
      // Best-effort; the dropdown will be empty
    }
  }

  async function handleStart(): Promise<void> {
    if (!effectivePath || !taskDescription.trim()) return;
    starting = true;
    actionError = '';
    try {
      await rpcStartWorkflow(effectivePath, taskDescription.trim(), workspacePath.trim() || undefined);
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

  const workflows = $derived([...appState.workflows.values()]);
  const selectedWorkflow = $derived(
    appState.selectedWorkflowId ? (appState.workflows.get(appState.selectedWorkflowId) ?? null) : null,
  );

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

{#if selectedWorkflow && appState.selectedWorkflowId}
  <WorkflowDetail
    workflowId={appState.selectedWorkflowId}
    summary={selectedWorkflow}
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
        <Badge variant="outline">{workflows.length} active</Badge>
      </div>
    </div>

    {#if actionError}
      <Alert variant="destructive" dismissible ondismiss={() => (actionError = '')}>{actionError}</Alert>
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
              <Input id="custom-path" bind:value={customPath} placeholder="/path/to/workflow.json" />
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

    {#if workflows.length === 0}
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
          <TableHead>Started</TableHead>
          <TableHead class="text-right">Actions</TableHead>
        </TableHeader>
        <TableBody>
          {#each workflows as wf (wf.workflowId)}
            <TableRow clickable onclick={() => selectWorkflow(wf.workflowId)}>
              <TableCell class="font-medium font-mono text-xs">{wf.name}</TableCell>
              <TableCell>
                <Badge variant={phaseBadgeVariant(wf.phase)}>{wf.phase.replace('_', ' ')}</Badge>
              </TableCell>
              <TableCell class="font-mono text-xs">{wf.currentState}</TableCell>
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
  </div>
{/if}
