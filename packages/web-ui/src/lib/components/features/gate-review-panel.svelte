<script lang="ts">
  import type { HumanGateRequestDto } from '$lib/types.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';

  let {
    gate,
    workflowName,
    onResolve,
  }: {
    gate: HumanGateRequestDto;
    workflowName: string;
    onResolve: (event: string, prompt?: string) => void | Promise<void>;
  } = $props();

  let feedbackText = $state('');
  let showFeedback = $state(false);
  let confirmAbort = $state(false);
  let resolving = $state(false);

  function hasEvent(event: string): boolean {
    return gate.acceptedEvents.includes(event);
  }

  async function handleApprove(): Promise<void> {
    resolving = true;
    try {
      await onResolve('APPROVE');
    } finally {
      resolving = false;
    }
  }

  async function handleForceRevision(): Promise<void> {
    if (!showFeedback) {
      showFeedback = true;
      return;
    }
    if (!feedbackText.trim()) return;
    resolving = true;
    try {
      await onResolve('FORCE_REVISION', feedbackText.trim());
    } finally {
      resolving = false;
      feedbackText = '';
      showFeedback = false;
    }
  }

  async function handleReplan(): Promise<void> {
    resolving = true;
    try {
      await onResolve('REPLAN');
    } finally {
      resolving = false;
    }
  }

  async function handleAbort(): Promise<void> {
    if (!confirmAbort) {
      confirmAbort = true;
      return;
    }
    resolving = true;
    try {
      await onResolve('ABORT');
    } finally {
      resolving = false;
      confirmAbort = false;
    }
  }

  function cancelAbort(): void {
    confirmAbort = false;
  }

  function cancelFeedback(): void {
    showFeedback = false;
    feedbackText = '';
  }
</script>

<div class="border border-warning/30 bg-warning/5 rounded-lg p-5 space-y-4">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h3 class="text-lg font-semibold">Review Required: {gate.stateName}</h3>
      <p class="text-sm text-muted-foreground mt-0.5">{workflowName}</p>
    </div>
    <Badge variant="warning">Waiting for Review</Badge>
  </div>

  <!-- Summary -->
  {#if gate.summary}
    <p class="text-sm text-foreground/80">{gate.summary}</p>
  {/if}

  <!-- Presented artifacts -->
  {#if gate.presentedArtifacts.length > 0}
    <div>
      <p class="text-xs text-muted-foreground mb-1.5 font-medium uppercase tracking-wider">Artifacts</p>
      <div class="flex flex-wrap gap-2">
        {#each gate.presentedArtifacts as artifact (artifact)}
          <Badge variant="outline">{artifact}</Badge>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Feedback area (shown when Force Revision is selected) -->
  {#if showFeedback}
    <div class="space-y-2">
      <label for="gate-feedback" class="block text-sm font-medium">Revision feedback</label>
      <textarea
        id="gate-feedback"
        bind:value={feedbackText}
        placeholder="Describe what should be changed..."
        rows={3}
        class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm
          placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50
          resize-y"
      ></textarea>
      <div class="flex gap-2">
        <Button
          variant="default"
          size="sm"
          onclick={handleForceRevision}
          disabled={!feedbackText.trim() || resolving}
          loading={resolving}
        >
          Submit Revision
        </Button>
        <Button variant="ghost" size="sm" onclick={cancelFeedback}>Cancel</Button>
      </div>
    </div>
  {/if}

  <!-- Abort confirmation -->
  {#if confirmAbort}
    <div class="border border-destructive/30 bg-destructive/5 rounded-md p-3">
      <p class="text-sm font-medium text-destructive mb-2">
        Are you sure you want to abort this workflow? This action cannot be undone.
      </p>
      <div class="flex gap-2">
        <Button variant="destructive" size="sm" onclick={handleAbort} loading={resolving}>Confirm Abort</Button>
        <Button variant="ghost" size="sm" onclick={cancelAbort}>Cancel</Button>
      </div>
    </div>
  {/if}

  <!-- Action buttons -->
  {#if !showFeedback && !confirmAbort}
    <div class="flex flex-wrap gap-2 pt-1">
      {#if hasEvent('APPROVE')}
        <Button variant="success" onclick={handleApprove} disabled={resolving} loading={resolving}>Approve</Button>
      {/if}
      {#if hasEvent('FORCE_REVISION')}
        <Button variant="default" onclick={handleForceRevision} disabled={resolving}>Request Revision</Button>
      {/if}
      {#if hasEvent('REPLAN')}
        <Button variant="outline" onclick={handleReplan} disabled={resolving} loading={resolving}>Replan</Button>
      {/if}
      {#if hasEvent('ABORT')}
        <Button variant="destructive" onclick={handleAbort} disabled={resolving}>Abort Workflow</Button>
      {/if}
    </div>
  {/if}
</div>
