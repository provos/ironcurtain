<script lang="ts">
  import { onMount } from 'svelte';
  import type { SessionDto, PersonaListItem, CreateSessionOptions } from '../../types.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import X from 'phosphor-svelte/lib/X';

  /** Mirrors MAX_READONLY_MOUNTS on the daemon (which re-validates). */
  const MAX_READONLY_MOUNTS = 8;

  let {
    sessions,
    selectedLabel,
    onselect,
    oncreate,
    creating,
    createError,
    loadPersonasFn,
    loadProviderProfilesFn,
    onresumeopen,
    resumeDisabledReason,
  }: {
    sessions: Map<number, SessionDto>;
    selectedLabel: number | null;
    onselect: (label: number) => void;
    oncreate: (opts: CreateSessionOptions) => void;
    creating: boolean;
    createError: string;
    loadPersonasFn: () => Promise<PersonaListItem[]>;
    /** Loads selectable provider-profile names for the launch options. */
    loadProviderProfilesFn?: () => Promise<string[]>;
    onresumeopen?: () => void;
    resumeDisabledReason?: string;
  } = $props();

  let personas = $state<PersonaListItem[]>([]);
  let loadingPersonas = $state(false);

  // Container/web-pty launch options (mux `/new` parity).
  let selectedPersona = $state('');
  let workspacePath = $state('');
  let readonlyMounts = $state<string[]>([]);
  let readonlyDraft = $state('');
  const atReadonlyLimit = $derived(readonlyMounts.length >= MAX_READONLY_MOUNTS);
  let providerProfileName = $state('');
  let model = $state('');
  let providerProfiles = $state<string[]>([]);

  async function loadPersonas(): Promise<void> {
    loadingPersonas = true;
    try {
      personas = await loadPersonasFn();
    } catch {
      personas = [];
    } finally {
      loadingPersonas = false;
    }
  }

  async function loadProviderProfiles(): Promise<void> {
    if (!loadProviderProfilesFn) {
      providerProfiles = [];
      return;
    }
    try {
      providerProfiles = await loadProviderProfilesFn();
    } catch {
      providerProfiles = [];
    }
  }

  onMount(() => {
    loadPersonas();
    loadProviderProfiles();
  });

  /** Adds `path` unless empty, duplicate, or over the limit. */
  function withReadonlyMount(list: string[], path: string): string[] {
    const trimmed = path.trim();
    if (!trimmed || list.includes(trimmed) || list.length >= MAX_READONLY_MOUNTS) return list;
    return [...list, trimmed];
  }

  function addReadonlyMount(): void {
    readonlyMounts = withReadonlyMount(readonlyMounts, readonlyDraft);
    readonlyDraft = '';
  }

  function removeReadonlyMount(path: string): void {
    readonlyMounts = readonlyMounts.filter((p) => p !== path);
  }

  function handleReadonlyKeydown(event: KeyboardEvent): void {
    // Enter adds the folder instead of submitting the launch form.
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addReadonlyMount();
  }

  function handleCreate(): void {
    if (creating) return;
    const persona = selectedPersona || undefined;
    const workspace = workspacePath.trim();
    const selectedModel = model.trim();
    // A typed-but-not-added folder still counts.
    const mounts = withReadonlyMount(readonlyMounts, readonlyDraft);
    oncreate({
      ...(persona ? { persona } : {}),
      ...(workspace ? { workspacePath: workspace } : {}),
      ...(mounts.length > 0 ? { readonlyMounts: mounts } : {}),
      ...(providerProfileName ? { providerProfileName } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
    });
  }

  function handleLaunchSubmit(event: SubmitEvent): void {
    event.preventDefault();
    if (creating) return;
    handleCreate();
  }
</script>

<div
  data-testid="session-sidebar"
  class="flex max-h-[46dvh] min-h-0 w-full shrink-0 flex-col overflow-y-auto border-b border-border bg-sidebar md:max-h-none md:w-64 md:overflow-hidden md:border-b-0 md:border-r"
>
  <div class="shrink-0 px-4 py-3 border-b border-border">
    <h3 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Sessions</h3>
  </div>

  <div class="shrink-0 px-3 py-3 border-b border-border bg-card/40">
    <form data-testid="session-launch-form" class="space-y-2.5" onsubmit={handleLaunchSubmit}>
      <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Launch options</div>
      <label class="block">
        <span class="text-xs text-muted-foreground">Workspace</span>
        <Input
          data-testid="launch-workspace"
          bind:value={workspacePath}
          placeholder="/path/to/workspace (optional)"
          class="mt-1 px-2 py-1.5 text-xs"
          disabled={creating}
        />
      </label>
      <div class="block">
        <label for="launch-readonly-input" class="text-xs text-muted-foreground">Read-only folders</label>
        <div class="mt-1 flex gap-1">
          <Input
            id="launch-readonly-input"
            data-testid="launch-readonly-input"
            bind:value={readonlyDraft}
            onkeydown={handleReadonlyKeydown}
            placeholder="/mnt/d/Training or D:\Training"
            class="px-2 py-1.5 text-xs"
            disabled={creating || atReadonlyLimit}
          />
          <Button
            data-testid="launch-readonly-add"
            type="button"
            variant="outline"
            size="sm"
            disabled={creating || !readonlyDraft.trim() || atReadonlyLimit}
            onclick={addReadonlyMount}
          >
            Add
          </Button>
        </div>
        {#if readonlyMounts.length > 0}
          <ul data-testid="launch-readonly-list" class="mt-1 space-y-1">
            {#each readonlyMounts as mount (mount)}
              <li class="flex items-center gap-1 rounded bg-background px-2 py-1 text-xs">
                <span class="min-w-0 flex-1 truncate font-mono" title={mount}>{mount}</span>
                <button
                  type="button"
                  class="shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label="Remove {mount}"
                  disabled={creating}
                  onclick={() => removeReadonlyMount(mount)}
                >
                  <X size={12} />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if readonlyMounts.length > 0 || readonlyDraft.trim()}
          <p data-testid="launch-readonly-warning" class="mt-1 text-xs text-warning">
            The agent can read everything in these folders (mounted read-only at /mnt/ro/&lt;name&gt;), and their
            contents may be sent to the model provider. Only add folders you are comfortable sharing.
          </p>
        {/if}
      </div>
      <label class="block">
        <span class="text-xs text-muted-foreground">Provider profile</span>
        <select
          data-testid="launch-provider"
          bind:value={providerProfileName}
          class="mt-1 w-full px-2 py-1.5 bg-background border border-border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
          disabled={creating}
        >
          <option value="">Default</option>
          {#each providerProfiles as profile (profile)}
            <option value={profile}>{profile}</option>
          {/each}
        </select>
      </label>
      <label class="block">
        <span class="text-xs text-muted-foreground">Model</span>
        <Input
          data-testid="launch-model"
          bind:value={model}
          placeholder="Profile default (optional)"
          class="mt-1 px-2 py-1.5 text-xs"
          disabled={creating}
        />
      </label>
      <label class="block">
        <span class="text-xs text-muted-foreground">Persona</span>
        <select
          data-testid="launch-persona"
          bind:value={selectedPersona}
          class="mt-1 w-full px-2 py-1.5 bg-background border border-border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
          disabled={creating}
        >
          <option value="">Default</option>
          {#each personas as persona (persona.name)}
            <option value={persona.name} disabled={!persona.compiled}>
              {persona.name}{#if !persona.compiled}
                (not compiled){/if}
            </option>
          {/each}
        </select>
        {#if loadingPersonas}
          <span class="mt-1 block text-xs text-muted-foreground">Loading personas...</span>
        {:else if personas.length === 0}
          <span class="mt-1 block text-xs text-muted-foreground">No personas available</span>
        {/if}
      </label>
      <Button data-testid="launch-start" type="submit" variant="default" size="sm" class="w-full" loading={creating}>
        {creating ? 'Starting...' : 'Start session'}
      </Button>
      {#if onresumeopen}
        <Button
          data-testid="resume-open"
          type="button"
          variant="outline"
          size="sm"
          class="w-full"
          disabled={creating || Boolean(resumeDisabledReason)}
          title={resumeDisabledReason}
          aria-describedby={resumeDisabledReason ? 'resume-disabled-reason' : undefined}
          onclick={onresumeopen}
        >
          Resume previous…
        </Button>
        {#if resumeDisabledReason}
          <p id="resume-disabled-reason" class="text-xs text-muted-foreground">{resumeDisabledReason}</p>
        {/if}
      {/if}
    </form>
  </div>

  {#if createError}
    <div class="px-4 py-2 text-xs text-destructive bg-destructive/10 border-b border-border">
      {createError}
    </div>
  {/if}

  <div class="flex-none overflow-visible md:flex-1 md:overflow-auto">
    {#if creating}
      <div class="w-full text-left px-4 py-3 border-b border-border text-sm bg-accent/20 animate-pulse">
        <div class="flex items-center justify-between">
          <span class="font-mono font-medium text-muted-foreground">Starting...</span>
          <span class="w-3 h-3 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin"
          ></span>
        </div>
        <div class="text-xs text-muted-foreground mt-1">New session</div>
      </div>
    {/if}
    {#each [...sessions.values()] as session (session.label)}
      <button
        data-testid="session-item-{session.label}"
        onclick={() => onselect(session.label)}
        class="w-full text-left px-4 py-3 border-b border-border text-sm transition-colors
          {selectedLabel === session.label ? 'bg-accent' : 'hover:bg-accent/30'}"
      >
        <div class="flex items-center justify-between">
          <span class="font-mono font-medium">#{session.label}</span>
          <span class="text-xs text-muted-foreground">
            {session.source.kind}{#if session.persona}&nbsp;&middot; {session.persona}{/if}
          </span>
        </div>
        {#if session.status === 'stopping'}
          <div
            data-testid="session-stopping-status"
            class="mt-1 inline-flex items-center gap-1.5 text-xs text-warning"
            aria-hidden={selectedLabel === session.label ? 'true' : undefined}
          >
            <span
              class="h-3 w-3 rounded-full border-2 border-warning/30 border-t-warning animate-spin"
              aria-hidden="true"
            ></span>
            Stopping…
          </div>
        {/if}
        <div class="text-xs text-muted-foreground mt-1">
          {session.turnCount} turns &middot; {session.budget.estimatedCostUsd.toFixed(2)}
        </div>
        {#if session.hasPendingEscalation}
          <Badge variant="destructive" class="mt-1">escalation</Badge>
        {/if}
      </button>
    {/each}
    {#if sessions.size === 0 && !creating}
      <div class="p-4 text-sm text-muted-foreground text-center">No active sessions</div>
    {/if}
  </div>
</div>
