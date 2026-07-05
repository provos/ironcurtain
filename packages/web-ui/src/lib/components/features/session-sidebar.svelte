<script lang="ts">
  import { onMount } from 'svelte';
  import type { SessionDto, PersonaListItem, CreateSessionOptions } from '../../types.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  let {
    sessions,
    selectedLabel,
    onselect,
    oncreate,
    creating,
    createError,
    loadPersonasFn,
    loadProviderProfilesFn,
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
  } = $props();

  let personas = $state<PersonaListItem[]>([]);
  let loadingPersonas = $state(false);

  // Container/web-pty launch options (mux `/new` parity).
  let selectedPersona = $state('');
  let workspacePath = $state('');
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

  function handleCreate(): void {
    const persona = selectedPersona || undefined;
    const workspace = workspacePath.trim();
    const selectedModel = model.trim();
    oncreate({
      ...(persona ? { persona } : {}),
      ...(workspace ? { workspacePath: workspace } : {}),
      ...(providerProfileName ? { providerProfileName } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
    });
  }
</script>

<div data-testid="session-sidebar" class="w-64 border-r border-border bg-sidebar flex flex-col shrink-0 min-h-0">
  <div class="px-4 py-3 border-b border-border">
    <h3 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Sessions</h3>
  </div>

  <div class="px-3 py-3 border-b border-border bg-card/40">
    <form
      class="space-y-2.5"
      onsubmit={(e) => {
        e.preventDefault();
        handleCreate();
      }}
    >
      <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Launch options</div>
      <label class="block">
        <span class="text-xs text-muted-foreground">Workspace</span>
        <Input
          data-testid="launch-workspace"
          bind:value={workspacePath}
          placeholder="/path/to/workspace (optional)"
          class="mt-1 px-2 py-1.5 text-xs"
        />
      </label>
      <label class="block">
        <span class="text-xs text-muted-foreground">Provider profile</span>
        <select
          data-testid="launch-provider"
          bind:value={providerProfileName}
          class="mt-1 w-full px-2 py-1.5 bg-background border border-border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
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
        />
      </label>
      <label class="block">
        <span class="text-xs text-muted-foreground">Persona</span>
        <select
          data-testid="launch-persona"
          bind:value={selectedPersona}
          class="mt-1 w-full px-2 py-1.5 bg-background border border-border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
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
    </form>
  </div>

  {#if createError}
    <div class="px-4 py-2 text-xs text-destructive bg-destructive/10 border-b border-border">
      {createError}
    </div>
  {/if}

  <div class="flex-1 overflow-auto">
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
