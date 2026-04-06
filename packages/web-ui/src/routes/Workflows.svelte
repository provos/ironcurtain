<script lang="ts">
  import {
    appState,
    startWorkflow as rpcStartWorkflow,
    abortWorkflow as rpcAbortWorkflow,
    refreshWorkflows,
  } from '../lib/stores.svelte.js';
  import { phaseBadgeVariant } from '$lib/utils.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Card, CardHeader, CardTitle, CardContent } from '$lib/components/ui/card/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table/index.js';
  import WorkflowDetail from './WorkflowDetail.svelte';

  let definitionPath = $state('');
  let taskDescription = $state('');
  let workspacePath = $state('');
  let starting = $state(false);
  let actionError = $state('');

  $effect(() => {
    refreshWorkflows();
  });

  async function handleStart(): Promise<void> {
    if (!definitionPath.trim() || !taskDescription.trim()) return;
    starting = true;
    actionError = '';
    try {
      await rpcStartWorkflow(definitionPath.trim(), taskDescription.trim(), workspacePath.trim() || undefined);
      definitionPath = '';
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

  function selectWorkflow(id: string): void {
    appState.selectedWorkflowId = id;
  }

  function deselectWorkflow(): void {
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

  // Auto-select a workflow when a gate is raised (if no workflow currently selected)
  $effect(() => {
    if (appState.selectedWorkflowId) return;
    if (appState.pendingGates.size === 0) return;
    for (const [, gate] of appState.pendingGates) {
      if (appState.workflows.has(gate.workflowId)) {
        appState.selectedWorkflowId = gate.workflowId;
        return;
      }
    }
  });
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
            <label for="def-path" class="block text-sm text-muted-foreground mb-1">Definition file path</label>
            <Input id="def-path" bind:value={definitionPath} placeholder="/path/to/workflow.json" />
          </div>
          <div>
            <label for="task-desc" class="block text-sm text-muted-foreground mb-1">Task description</label>
            <Input id="task-desc" bind:value={taskDescription} placeholder="Describe the task..." />
          </div>
          <div>
            <label for="ws-path" class="block text-sm text-muted-foreground mb-1">Workspace path (optional)</label>
            <Input id="ws-path" bind:value={workspacePath} placeholder="/path/to/workspace" />
          </div>
          <Button onclick={handleStart} loading={starting} disabled={!definitionPath.trim() || !taskDescription.trim()}>
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
