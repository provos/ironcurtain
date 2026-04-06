<script lang="ts">
  import {
    appState,
    startWorkflow as rpcStartWorkflow,
    abortWorkflow as rpcAbortWorkflow,
    refreshWorkflows,
  } from '../lib/stores.svelte.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Card, CardHeader, CardTitle, CardContent } from '$lib/components/ui/card/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';

  let definitionPath = $state('');
  let taskDescription = $state('');
  let workspacePath = $state('');
  let starting = $state(false);
  let actionError = $state('');

  // Refresh workflows on mount
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

  function phaseBadgeVariant(
    phase: string,
  ): 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' {
    switch (phase) {
      case 'running':
        return 'default';
      case 'waiting_human':
        return 'warning';
      case 'completed':
        return 'success';
      case 'failed':
        return 'destructive';
      case 'aborted':
        return 'secondary';
      default:
        return 'outline';
    }
  }

  const workflows = $derived([...appState.workflows.values()]);
</script>

<div class="p-6 space-y-5 animate-fade-in">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-semibold tracking-tight">Workflows</h2>
    <Badge variant="outline">{workflows.length} active</Badge>
  </div>

  {#if actionError}
    <Alert variant="destructive" dismissible ondismiss={() => (actionError = '')}>{actionError}</Alert>
  {/if}

  <!-- Start workflow form -->
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

  <!-- Active workflows table -->
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
          <TableRow>
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
                <Button variant="destructive" size="sm" onclick={() => handleAbort(wf.workflowId)}>Abort</Button>
              {:else}
                <span class="text-muted-foreground text-sm">--</span>
              {/if}
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  {/if}

  <!-- Pending gates -->
  {#if appState.pendingGates.size > 0}
    <Card>
      <CardHeader>
        <CardTitle>Pending Gates</CardTitle>
      </CardHeader>
      <CardContent>
        <div class="space-y-3">
          {#each [...appState.pendingGates.values()] as gate (gate.gateId)}
            <div class="border border-warning/30 bg-warning/5 rounded-lg p-4">
              <div class="flex items-center justify-between mb-2">
                <span class="font-medium">{gate.stateName}</span>
                <Badge variant="warning">Waiting</Badge>
              </div>
              <p class="text-sm text-muted-foreground">{gate.summary}</p>
              {#if gate.presentedArtifacts.length > 0}
                <div class="mt-2 flex gap-2">
                  {#each gate.presentedArtifacts as artifact (artifact)}
                    <Badge variant="outline">{artifact}</Badge>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </CardContent>
    </Card>
  {/if}
</div>
