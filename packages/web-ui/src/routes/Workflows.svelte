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
  import type { WorkflowSummaryDto, WorkflowDefinitionDto, ResumableWorkflowDto } from '$lib/types.js';
  import { phaseBadgeVariant } from '$lib/utils.js';

  function createWorkflowPlaceholder(workflowId: string, currentState: string): WorkflowSummaryDto {
    return { workflowId, name: workflowId, phase: 'running', currentState, startedAt: new Date().toISOString() };
  }
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

  // Resume section state
  let resumableWorkflows: ResumableWorkflowDto[] = $state([]);
  let resumingId: string | null = $state(null);
  let importDirExpanded = $state(false);
  let importDir = $state('');
  let importing = $state(false);
  let resumeMessage = $state('');

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
          createWorkflowPlaceholder(result.workflowId, 'starting...'),
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
        createWorkflowPlaceholder(workflowId, 'resuming...'),
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
          createWorkflowPlaceholder(workflowId, 'resuming...'),
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

    {#if resumeMessage}
      <Alert variant="default" dismissible ondismiss={() => (resumeMessage = '')}>{resumeMessage}</Alert>
    {/if}

    <Card>
      <CardHeader>
        <CardTitle>Resume Workflow</CardTitle>
      </CardHeader>
      <CardContent>
        {#if resumableWorkflows.length > 0}
          <div class="space-y-2 mb-4">
            {#each resumableWorkflows as rw (rw.workflowId)}
              <div class="flex items-center justify-between p-3 border border-border rounded-lg bg-background">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 text-sm">
                    <Badge variant="outline">{rw.lastState}</Badge>
                    <span class="text-muted-foreground">{new Date(rw.timestamp).toLocaleString()}</span>
                  </div>
                  <p class="text-sm mt-1 truncate" title={rw.taskDescription}>{rw.taskDescription}</p>
                </div>
                <Button
                  size="sm"
                  class="ml-3 shrink-0"
                  loading={resumingId === rw.workflowId}
                  disabled={resumingId !== null}
                  onclick={() => handleResume(rw.workflowId)}
                >
                  Resume
                </Button>
              </div>
            {/each}
          </div>
        {:else}
          <p class="text-sm text-muted-foreground mb-4">No resumable workflows found.</p>
        {/if}

        <div>
          <button
            type="button"
            class="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
            onclick={() => (importDirExpanded = !importDirExpanded)}
          >
            <span class="inline-block transition-transform" class:rotate-90={importDirExpanded}>&#9654;</span>
            Import from directory
          </button>
          {#if importDirExpanded}
            <div class="flex gap-2 mt-2">
              <Input bind:value={importDir} placeholder="/path/to/workflow-runs/" class="flex-1" />
              <Button size="sm" loading={importing} disabled={!importDir.trim()} onclick={handleImportAndResume}>
                Import & Resume
              </Button>
            </div>
          {/if}
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
