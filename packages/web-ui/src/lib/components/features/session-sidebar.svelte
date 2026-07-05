<script lang="ts">
  import type { SessionDto, PersonaListItem, CreateSessionOptions } from '../../types.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { DropdownMenu, DropdownMenuItem } from '$lib/components/ui/dropdown-menu/index.js';

  import Plus from 'phosphor-svelte/lib/Plus';

  let {
    sessions,
    selectedLabel,
    onselect,
    oncreate,
    creating,
    createError,
    loadPersonasFn,
    launchOptionsEnabled = false,
    loadProviderProfilesFn,
  }: {
    sessions: Map<number, SessionDto>;
    selectedLabel: number | null;
    onselect: (label: number) => void;
    oncreate: (opts: CreateSessionOptions) => void;
    creating: boolean;
    createError: string;
    loadPersonasFn: () => Promise<PersonaListItem[]>;
    /** True in Docker Agent Mode: reveal the web-pty launch options (workspace / provider / model). */
    launchOptionsEnabled?: boolean;
    /** Loads selectable provider-profile names for the launch options; only used when enabled. */
    loadProviderProfilesFn?: () => Promise<string[]>;
  } = $props();

  let showPersonaPicker = $state(false);
  let personas = $state<PersonaListItem[]>([]);
  let loadingPersonas = $state(false);

  // Docker/web-pty launch options (mux `/new` parity). Ambient inputs carried
  // into `oncreate` alongside the chosen persona; ignored by the chatbox path.
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
    if (!loadProviderProfilesFn) return;
    try {
      providerProfiles = await loadProviderProfilesFn();
    } catch {
      providerProfiles = [];
    }
  }

  function openPersonaPicker(): void {
    showPersonaPicker = true;
    loadPersonas();
    if (launchOptionsEnabled) loadProviderProfiles();
  }

  function handleCreate(persona?: string): void {
    showPersonaPicker = false;
    oncreate({
      persona,
      ...(launchOptionsEnabled
        ? {
            workspacePath: workspacePath.trim() || undefined,
            providerProfileName: providerProfileName || undefined,
            model: model.trim() || undefined,
          }
        : {}),
    });
  }
</script>

<div data-testid="session-sidebar" class="w-64 border-r border-border bg-sidebar flex flex-col shrink-0 min-h-0">
  <div class="px-4 py-3 border-b border-border flex items-center justify-between">
    <h3 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Sessions</h3>
    <DropdownMenu bind:open={showPersonaPicker} align="bottom-right" contentClass="w-56">
      {#snippet trigger()}
        <Button variant="default" size="sm" loading={creating} onclick={openPersonaPicker}>
          {#if !creating}
            <Plus size={14} weight="bold" />
          {/if}
          {creating ? 'Starting...' : 'New'}
        </Button>
      {/snippet}
      {#if launchOptionsEnabled}
        <div class="px-3 py-3 border-b border-border space-y-2.5">
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
          <Button data-testid="launch-start" variant="default" size="sm" class="w-full" onclick={() => handleCreate()}>
            Start session
          </Button>
        </div>
      {/if}
      <DropdownMenuItem data-testid="persona-default" onclick={() => handleCreate()} class="border-b border-border">
        <div class="font-medium">Default</div>
        <div class="text-xs text-muted-foreground">No persona</div>
      </DropdownMenuItem>
      {#if loadingPersonas}
        <div class="px-3 py-3 text-xs text-muted-foreground text-center">Loading personas...</div>
      {:else if personas.length === 0}
        <div class="px-3 py-3 text-xs text-muted-foreground text-center">No personas available</div>
      {:else}
        {#each personas as persona (persona.name)}
          <DropdownMenuItem onclick={() => handleCreate(persona.name)} disabled={!persona.compiled}>
            <div class="font-medium flex items-center gap-1.5">
              {persona.name}
              {#if !persona.compiled}
                <span class="text-xs text-yellow-400">(not compiled)</span>
              {/if}
            </div>
            {#if persona.description}
              <div class="text-xs text-muted-foreground truncate">{persona.description}</div>
            {/if}
          </DropdownMenuItem>
        {/each}
      {/if}
    </DropdownMenu>
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
