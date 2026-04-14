<script lang="ts">
  import type {
    HumanGateRequestDto,
    ArtifactContentDto,
    FileTreeResponseDto,
    FileContentResponseDto,
  } from '$lib/types.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import { renderMarkdown } from '$lib/markdown.js';
  import WorkspaceBrowser from './workspace-browser.svelte';

  let {
    gate,
    workflowName,
    workflowId,
    onResolve,
    fetchArtifacts,
    fetchFileTree,
    fetchFileContent,
  }: {
    gate: HumanGateRequestDto;
    workflowName: string;
    workflowId: string;
    onResolve: (event: string, prompt?: string) => void | Promise<void>;
    fetchArtifacts?: (workflowId: string, artifactName: string) => Promise<ArtifactContentDto>;
    fetchFileTree?: (workflowId: string, path?: string) => Promise<FileTreeResponseDto>;
    fetchFileContent?: (workflowId: string, path: string) => Promise<FileContentResponseDto>;
  } = $props();

  type TabId = 'summary' | 'artifacts' | 'files';

  let activeTab = $state<TabId>('summary');
  let feedbackText = $state('');
  let showFeedback = $state(false);
  let confirmAbort = $state(false);
  let resolving = $state(false);

  // Artifact loading
  let artifactContents = $state<Map<string, ArtifactContentDto>>(new Map());
  let artifactLoading = $state<Set<string>>(new Set());
  let artifactErrors = $state<Set<string>>(new Set());
  let selectedArtifact = $state<string | null>(null);

  const hasArtifactsTab = $derived(gate.presentedArtifacts.length > 0 && fetchArtifacts != null);
  const hasFilesTab = $derived(fetchFileTree != null && fetchFileContent != null);

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

  async function loadArtifact(name: string): Promise<void> {
    if (artifactContents.has(name) || artifactErrors.has(name) || !fetchArtifacts) return;
    const newLoading = new Set(artifactLoading);
    newLoading.add(name);
    artifactLoading = newLoading;
    try {
      const content = await fetchArtifacts(workflowId, name);
      artifactContents = new Map(artifactContents).set(name, content);
    } catch {
      const newErrors = new Set(artifactErrors);
      newErrors.add(name);
      artifactErrors = newErrors;
    }
    const done = new Set(artifactLoading);
    done.delete(name);
    artifactLoading = done;
  }

  function selectArtifact(name: string): void {
    selectedArtifact = name;
    loadArtifact(name);
  }

  // Auto-select first artifact when switching to artifacts tab
  $effect(() => {
    if (activeTab === 'artifacts' && !selectedArtifact && gate.presentedArtifacts.length > 0) {
      selectArtifact(gate.presentedArtifacts[0]);
    }
  });

  function tabClass(tab: TabId): string {
    return activeTab === tab
      ? 'border-primary text-primary font-medium'
      : 'border-transparent text-muted-foreground hover:text-foreground';
  }

  function isMarkdown(path: string): boolean {
    return path.endsWith('.md');
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

  <!-- Tabs -->
  <div class="flex gap-1 border-b border-border">
    <button
      onclick={() => (activeTab = 'summary')}
      class="px-3 py-1.5 text-sm transition-colors border-b-2 -mb-px {tabClass('summary')}"
    >
      Summary
    </button>
    {#if hasArtifactsTab}
      <button
        onclick={() => (activeTab = 'artifacts')}
        class="px-3 py-1.5 text-sm transition-colors border-b-2 -mb-px {tabClass('artifacts')}"
      >
        Artifacts
        <span class="text-xs text-muted-foreground ml-1">({gate.presentedArtifacts.length})</span>
      </button>
    {/if}
    {#if hasFilesTab}
      <button
        onclick={() => (activeTab = 'files')}
        class="px-3 py-1.5 text-sm transition-colors border-b-2 -mb-px {tabClass('files')}"
      >
        Files
      </button>
    {/if}
  </div>

  <!-- Tab content -->
  {#if activeTab === 'summary'}
    <!-- Summary -->
    {#if gate.summary}
      <p class="text-sm text-foreground/80">{gate.summary}</p>
    {/if}

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
  {:else if activeTab === 'artifacts'}
    <!-- Artifact viewer -->
    <div class="space-y-3">
      {#if gate.presentedArtifacts.length > 1}
        <div class="flex flex-wrap gap-2">
          {#each gate.presentedArtifacts as artifact (artifact)}
            <button
              onclick={() => selectArtifact(artifact)}
              class="px-2 py-1 text-xs rounded border transition-colors
                {selectedArtifact === artifact
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground'}"
            >
              {artifact}
            </button>
          {/each}
        </div>
      {/if}

      {#if selectedArtifact}
        {#if artifactLoading.has(selectedArtifact)}
          <div class="flex items-center justify-center py-4">
            <Spinner size="sm" />
          </div>
        {:else if artifactErrors.has(selectedArtifact)}
          <p class="text-sm text-destructive">Failed to load artifact.</p>
        {:else}
          {@const ac = artifactContents.get(selectedArtifact)}
          {#if ac && ac.files.length > 0}
            <div class="space-y-3">
              {#each ac.files as file (file.path)}
                <div class="border border-border rounded overflow-hidden">
                  <div class="px-3 py-1.5 bg-muted/30 border-b border-border text-xs font-mono text-muted-foreground">
                    {file.path}
                  </div>
                  {#if isMarkdown(file.path)}
                    <div class="p-3 prose-markdown text-sm">
                      {@html renderMarkdown(file.content)}
                    </div>
                  {:else}
                    <pre class="p-3 text-xs overflow-x-auto"><code>{file.content}</code></pre>
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <p class="text-sm text-muted-foreground">No files in this artifact.</p>
          {/if}
        {/if}
      {/if}
    </div>
  {:else if activeTab === 'files' && fetchFileTree && fetchFileContent}
    <!-- Workspace file browser -->
    <div class="h-[400px]">
      <WorkspaceBrowser {workflowId} {fetchFileTree} {fetchFileContent} />
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
