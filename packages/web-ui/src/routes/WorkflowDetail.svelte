<script lang="ts">
  import type { WorkflowDetailDto, WorkflowSummaryDto, HumanGateRequestDto, MessageLogEntry } from '$lib/types.js';
  import {
    appState,
    connectionGeneration,
    getWorkflowDetail,
    resolveWorkflowGate,
    getWorkflowFileTree,
    getWorkflowFileContent,
    getWorkflowArtifacts,
    getWorkflowMessageLog,
  } from '$lib/stores.svelte.js';
  import { RpcError } from '$lib/ws-client.js';
  import { phaseBadgeVariant } from '$lib/utils.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Card, CardHeader, CardTitle, CardContent } from '$lib/components/ui/card/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import StateMachineGraph from '$lib/components/features/state-machine-graph.svelte';
  import GateReviewPanel from '$lib/components/features/gate-review-panel.svelte';
  import WorkspaceBrowser from '$lib/components/features/workspace-browser.svelte';
  import MessageLogTimeline from '$lib/components/features/message-log-timeline.svelte';
  import { renderMarkdown } from '$lib/markdown.js';

  const MESSAGE_LOG_PAGE_SIZE = 200;

  let {
    workflowId,
    summary,
    gate,
    onback,
  }: {
    workflowId: string;
    summary: WorkflowSummaryDto;
    gate?: HumanGateRequestDto;
    onback: () => void;
  } = $props();

  let detail = $state<WorkflowDetailDto | null>(null);
  let loading = $state(true);
  let error = $state('');
  // When the daemon returns WORKFLOW_CORRUPTED we render a dedicated panel
  // instead of the generic destructive-banner so the operator can see the
  // exact corruption cause without parsing the message string.
  let corruptionMessage = $state('');
  let resolveError = $state('');
  let workspaceExpanded = $state(false);
  let expandedMessages = $state(new Set<number>());

  // Message-log section state. The list is collapsed initially and only
  // fetched once expanded (lazy load — D5 cursor pagination).
  let messageLogExpanded = $state(false);
  let messageLogEntries = $state<MessageLogEntry[]>([]);
  let messageLogLoading = $state(false);
  let messageLogHasMore = $state(false);
  let messageLogError = $state('');
  let messageLogFetched = $state(false);

  function toggleMessage(index: number): void {
    const next = new Set(expandedMessages);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    expandedMessages = next;
  }

  let fetchVersion = 0;

  $effect(() => {
    const id = workflowId;
    // Re-fetch detail whenever the workflow's state or phase changes.
    // These fields are updated by workflow.state_entered / workflow.completed / etc.
    // events via the event handler, which triggers a fresh getWorkflowDetail() call
    // so the transition history, context, and gate stay up-to-date.
    void summary.currentState;
    void summary.phase;
    // Force re-fetch on WebSocket reconnect so we pick up any missed events.
    void connectionGeneration.value;
    const version = ++fetchVersion;
    // Only show the loading spinner on the initial fetch, not on re-fetches.
    // Use the version counter instead of reading `detail` to avoid making it
    // a reactive dependency of this $effect (which would cause a re-fetch loop).
    if (version === 1) {
      loading = true;
    }
    error = '';
    corruptionMessage = '';

    getWorkflowDetail(id)
      .then((d) => {
        if (version === fetchVersion) {
          detail = d;
          loading = false;

          // Seed gate into pendingGates so the parent's selectedGate derivation picks it up
          if (d.gate) {
            appState.pendingGates = new Map(appState.pendingGates).set(d.gate.gateId, d.gate);
          }
        }
      })
      .catch((err) => {
        if (version !== fetchVersion) return;
        // Distinguish WORKFLOW_CORRUPTED from generic RPC failures: the former
        // gets a dedicated callout panel so the operator sees the corruption
        // cause without parsing message text.
        if (err instanceof RpcError && err.code === 'WORKFLOW_CORRUPTED') {
          corruptionMessage = err.message;
          error = '';
        } else {
          error = err instanceof Error ? err.message : String(err);
          corruptionMessage = '';
        }
        loading = false;
      });
  });

  async function loadMessageLogPage(before?: string): Promise<void> {
    messageLogLoading = true;
    messageLogError = '';
    try {
      const response = await getWorkflowMessageLog(workflowId, {
        limit: MESSAGE_LOG_PAGE_SIZE,
        ...(before !== undefined ? { before } : {}),
      });
      // Append for paginated loads; replace for the initial fetch. Either
      // way the timeline stays newest-first since the RPC returns entries
      // sorted newest-first.
      const next = before === undefined ? [...response.entries] : [...messageLogEntries, ...response.entries];
      messageLogEntries = next;
      messageLogHasMore = response.hasMore;
      messageLogFetched = true;
    } catch (err) {
      messageLogError = err instanceof Error ? err.message : String(err);
    } finally {
      messageLogLoading = false;
    }
  }

  function toggleMessageLog(): void {
    messageLogExpanded = !messageLogExpanded;
    if (messageLogExpanded && !messageLogFetched && !messageLogLoading) {
      void loadMessageLogPage();
    }
  }

  function loadOlderMessages(): void {
    if (messageLogLoading || !messageLogHasMore || messageLogEntries.length === 0) return;
    const oldest = messageLogEntries[messageLogEntries.length - 1];
    void loadMessageLogPage(oldest.ts);
  }

  // The error callout shows for hard failures and for interrupted runs that
  // carry an explanatory `error` field. Plain "interrupted" without text is
  // expected for daemon-restart cases, so suppress the callout in that case.
  const showErrorCallout = $derived(
    Boolean(detail) &&
      ((detail!.phase === 'failed' && Boolean(detail!.error)) ||
        (detail!.phase === 'interrupted' && Boolean(detail!.error))),
  );

  const errorCalloutTitle = $derived(detail?.phase === 'failed' ? 'Workflow failed' : 'Workflow interrupted');

  // Latest verdict appears as a row in the summary grid only when the DTO
  // actually carries one — every verdict has a stateId and verdict, the
  // confidence field is optional.
  const latestVerdict = $derived(detail?.latestVerdict);

  function formatConfidence(value: number | undefined): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (Number.isNaN(value)) return undefined;
    // Confidences are nominally 0..1 but tolerate already-percentage values.
    const pct = value <= 1 ? Math.round(value * 100) : Math.round(value);
    return `${pct}%`;
  }

  const completedStates = $derived(
    detail?.transitionHistory ? [...new Set(detail.transitionHistory.map((t) => t.from))] : [],
  );

  const failedState = $derived(summary.phase === 'failed' ? summary.currentState : null);

  const visitCounts = $derived(detail?.context?.visitCounts ?? {});

  const gateStateDescription = $derived(
    gate && detail?.stateGraph ? detail.stateGraph.states.find((s) => s.id === gate.stateName)?.description : undefined,
  );

  async function handleGateResolve(event: string, prompt?: string): Promise<void> {
    resolveError = '';
    try {
      await resolveWorkflowGate(workflowId, event, prompt);
    } catch (err) {
      resolveError = `Failed to resolve gate: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString();
  }
</script>

<div class="p-6 space-y-5 animate-fade-in">
  <div class="flex items-center gap-3">
    <Button variant="ghost" size="sm" onclick={onback}>&larr; Back</Button>
    <h2 class="text-xl font-semibold tracking-tight">{summary.name}</h2>
    <Badge variant={phaseBadgeVariant(summary.phase)}>{summary.phase.replace('_', ' ')}</Badge>
    <span class="text-sm text-muted-foreground ml-auto">
      State: <span class="font-mono">{summary.currentState}</span>
    </span>
  </div>

  {#if resolveError}
    <Alert variant="destructive" dismissible ondismiss={() => (resolveError = '')}>{resolveError}</Alert>
  {/if}

  {#if loading}
    <div class="flex items-center justify-center py-16">
      <Spinner size="md" />
    </div>
  {:else if corruptionMessage}
    <Card class="border-destructive/40">
      <CardHeader>
        <CardTitle class="text-destructive">Workflow checkpoint is corrupted</CardTitle>
      </CardHeader>
      <CardContent>
        <p class="text-sm text-muted-foreground mb-2">
          The daemon could not load this workflow's checkpoint or definition file. The run cannot be displayed or
          resumed until the underlying file is repaired.
        </p>
        <pre
          data-testid="corruption-message"
          class="text-xs font-mono whitespace-pre-wrap text-destructive bg-destructive/5 border border-destructive/20 rounded p-3 overflow-x-auto">{corruptionMessage}</pre>
      </CardContent>
    </Card>
  {:else if error}
    <Alert variant="destructive">{error}</Alert>
  {:else if detail}
    {#if gate && summary.phase === 'waiting_human'}
      <GateReviewPanel
        {gate}
        {workflowId}
        workflowName={summary.name}
        stateDescription={gateStateDescription}
        onResolve={handleGateResolve}
        fetchArtifacts={getWorkflowArtifacts}
        fetchFileTree={getWorkflowFileTree}
        fetchFileContent={getWorkflowFileContent}
      />
    {/if}

    {#if showErrorCallout}
      <Card data-testid="workflow-error-callout" class="border-destructive/40">
        <CardHeader>
          <CardTitle class="text-destructive">{errorCalloutTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <pre
            data-testid="workflow-error-text"
            class="text-xs font-mono whitespace-pre-wrap text-destructive bg-destructive/5 border border-destructive/20 rounded p-3 overflow-x-auto max-h-80 overflow-y-auto">{detail.error}</pre>
        </CardContent>
      </Card>
    {/if}

    <Card>
      <CardHeader>
        <CardTitle>State Machine</CardTitle>
      </CardHeader>
      <CardContent>
        <StateMachineGraph
          graph={detail.stateGraph}
          currentState={summary.currentState}
          {completedStates}
          {failedState}
          {visitCounts}
        />
      </CardContent>
    </Card>

    {#if detail.context}
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent>
            <p class="text-xs text-muted-foreground">Round</p>
            <p class="text-lg font-semibold">{detail.context.round}/{detail.context.maxRounds}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p class="text-xs text-muted-foreground">Total Tokens</p>
            <p class="text-lg font-semibold">{detail.context.totalTokens.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p class="text-xs text-muted-foreground">Workspace</p>
            <p class="text-sm font-mono truncate" title={detail.workspacePath}>{detail.workspacePath}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p class="text-xs text-muted-foreground">Description</p>
            <p class="text-sm truncate" title={detail.description}>{detail.description || '--'}</p>
          </CardContent>
        </Card>
        {#if latestVerdict}
          {@const confidenceText = formatConfidence(latestVerdict.confidence)}
          <Card data-testid="latest-verdict-card">
            <CardContent>
              <p class="text-xs text-muted-foreground">Latest verdict</p>
              <p class="text-sm font-semibold truncate" title={latestVerdict.verdict}>
                <span data-testid="latest-verdict-value">{latestVerdict.verdict}</span>
                {#if confidenceText}
                  <span class="text-muted-foreground font-normal" data-testid="latest-verdict-confidence">
                    — {confidenceText}
                  </span>
                {/if}
              </p>
              <p
                class="text-xs text-muted-foreground font-mono truncate"
                title={`State: ${latestVerdict.stateId}`}
                data-testid="latest-verdict-state"
              >
                {latestVerdict.stateId}
              </p>
            </CardContent>
          </Card>
        {/if}
      </div>
    {/if}

    <!-- Workspace Browser -->
    <Card>
      <CardHeader>
        <button
          onclick={() => (workspaceExpanded = !workspaceExpanded)}
          class="flex items-center gap-2 w-full text-left"
        >
          <span class="text-muted-foreground">{workspaceExpanded ? '\u25BE' : '\u25B8'}</span>
          <CardTitle>Workspace</CardTitle>
        </button>
      </CardHeader>
      {#if workspaceExpanded}
        <CardContent>
          <div class="h-[400px]">
            <WorkspaceBrowser
              {workflowId}
              fetchFileTree={getWorkflowFileTree}
              fetchFileContent={getWorkflowFileContent}
            />
          </div>
        </CardContent>
      {/if}
    </Card>

    {#if detail.transitionHistory.length > 0}
      <Card>
        <CardHeader>
          <CardTitle>Transition History</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="space-y-1.5">
            {#each detail.transitionHistory as t, i (i)}
              <div>
                <div class="flex items-center gap-2 text-sm font-mono">
                  <span class="text-muted-foreground text-xs w-16 shrink-0">{formatTime(t.timestamp)}</span>
                  <span class="text-foreground/70">{t.from}</span>
                  <span class="text-muted-foreground">&rarr;</span>
                  <span class="text-foreground">{t.to}</span>
                  {#if t.event}
                    <Badge variant="outline" class="ml-1">{t.event}</Badge>
                  {/if}
                  <span class="text-muted-foreground text-xs ml-auto">{formatDuration(t.durationMs)}</span>
                  {#if t.agentMessage}
                    <button class="text-xs text-primary hover:underline ml-2" onclick={() => toggleMessage(i)}>
                      {expandedMessages.has(i) ? 'hide' : 'show'} message
                    </button>
                  {/if}
                </div>
                {#if t.agentMessage && expandedMessages.has(i)}
                  <div class="ml-20 mt-1 mb-2 p-3 rounded bg-muted/50 text-sm prose-markdown">
                    {@html renderMarkdown(t.agentMessage)}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </CardContent>
      </Card>
    {/if}

    <Card>
      <CardHeader>
        <button
          type="button"
          onclick={toggleMessageLog}
          class="flex items-center gap-2 w-full text-left"
          data-testid="message-log-toggle"
          aria-expanded={messageLogExpanded}
        >
          <span class="text-muted-foreground">{messageLogExpanded ? '▾' : '▸'}</span>
          <CardTitle>Message log</CardTitle>
          {#if messageLogExpanded && messageLogEntries.length > 0}
            <span class="text-xs text-muted-foreground ml-auto">
              {messageLogEntries.length} entr{messageLogEntries.length === 1 ? 'y' : 'ies'}
            </span>
          {/if}
        </button>
      </CardHeader>
      {#if messageLogExpanded}
        <CardContent>
          {#if messageLogError}
            <Alert variant="destructive" dismissible ondismiss={() => (messageLogError = '')}>
              {messageLogError}
            </Alert>
          {:else if messageLogLoading && messageLogEntries.length === 0}
            <div class="flex items-center justify-center py-8">
              <Spinner size="sm" />
            </div>
          {:else}
            <MessageLogTimeline
              entries={messageLogEntries}
              loading={messageLogLoading}
              hasMore={messageLogHasMore}
              onLoadOlder={loadOlderMessages}
            />
          {/if}
        </CardContent>
      {/if}
    </Card>
  {/if}
</div>
