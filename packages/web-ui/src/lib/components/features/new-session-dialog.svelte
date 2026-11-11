<script lang="ts">
  import { onMount } from 'svelte';
  import type { PersonaListItem, CreateSessionOptions } from '../../types.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Modal } from '$lib/components/ui/modal/index.js';
  import ReadonlyFoldersInput from './readonly-folders-input.svelte';
  import { withFolder } from '../../readonly-folders.js';

  let {
    open,
    onclose,
    oncreate,
    creating,
    createError,
    loadPersonasFn,
    loadProviderProfilesFn,
  }: {
    open: boolean;
    onclose: () => void;
    oncreate: (opts: CreateSessionOptions) => void;
    creating: boolean;
    createError: string;
    loadPersonasFn: () => Promise<PersonaListItem[]>;
    /** Loads selectable provider-profile names. */
    loadProviderProfilesFn?: () => Promise<string[]>;
  } = $props();

  let personas = $state<PersonaListItem[]>([]);
  let providerProfiles = $state<string[]>([]);

  // Launch options (mux `/new` parity). Kept across close/reopen so a failed
  // start can be retried without retyping.
  let selectedPersona = $state('');
  let workspacePath = $state('');
  let providerProfileName = $state('');
  let model = $state('');
  let readonlyMounts = $state<string[]>([]);
  let readonlyDraft = $state('');

  onMount(() => {
    loadPersonasFn()
      .then((list) => (personas = list))
      .catch(() => (personas = []));
    loadProviderProfilesFn?.()
      .then((list) => (providerProfiles = list))
      .catch(() => (providerProfiles = []));
  });

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    if (creating) return;
    const persona = selectedPersona || undefined;
    const workspace = workspacePath.trim();
    const selectedModel = model.trim();
    // A typed-but-not-added folder still counts.
    const mounts = withFolder(readonlyMounts, readonlyDraft);
    oncreate({
      ...(persona ? { persona } : {}),
      ...(workspace ? { workspacePath: workspace } : {}),
      ...(mounts.length > 0 ? { readonlyMounts: mounts } : {}),
      ...(providerProfileName ? { providerProfileName } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
    });
  }

  const selectClass =
    'mt-1 w-full px-2 py-1.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring';
</script>

<!-- Height-capped with a scrolling body so Start session stays reachable on
     small screens (e.g. 375x667 with many folder chips). -->
<Modal {open} {onclose} title="New session" class="flex max-h-[85dvh] max-w-xl flex-col">
  <form data-testid="session-launch-form" class="flex min-h-0 flex-1 flex-col" onsubmit={handleSubmit}>
    <div data-testid="launch-body" class="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label class="block min-w-0">
          <span class="text-xs text-muted-foreground">Persona</span>
          <select data-testid="launch-persona" bind:value={selectedPersona} class={selectClass} disabled={creating}>
            <option value="">Default</option>
            {#each personas as persona (persona.name)}
              <option value={persona.name} disabled={!persona.compiled}>
                {persona.name}{#if !persona.compiled}
                  (not compiled){/if}
              </option>
            {/each}
          </select>
        </label>
        <label class="block min-w-0">
          <span class="text-xs text-muted-foreground">Provider</span>
          <select
            data-testid="launch-provider"
            bind:value={providerProfileName}
            class={selectClass}
            disabled={creating}
          >
            <option value="">Default</option>
            {#each providerProfiles as profile (profile)}
              <option value={profile}>{profile}</option>
            {/each}
          </select>
        </label>
        <label class="block min-w-0">
          <span class="text-xs text-muted-foreground">Model</span>
          <Input
            data-testid="launch-model"
            bind:value={model}
            placeholder="Profile default"
            class="mt-1 px-2 py-1.5 text-sm"
            disabled={creating}
          />
        </label>
      </div>

      <label class="block">
        <span class="text-xs text-muted-foreground">Workspace</span>
        <Input
          data-testid="launch-workspace"
          bind:value={workspacePath}
          placeholder="New sandbox (or /path/to/existing/project)"
          class="mt-1 px-2 py-1.5 font-mono text-sm"
          disabled={creating}
        />
      </label>

      <ReadonlyFoldersInput
        bind:folders={readonlyMounts}
        bind:draft={readonlyDraft}
        disabled={creating}
        testIdPrefix="launch-readonly"
      />

      {#if createError}
        <p data-testid="launch-error" class="text-sm text-destructive" role="alert">{createError}</p>
      {/if}
    </div>

    <div class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
      <Button type="button" variant="ghost" size="sm" onclick={onclose}>Cancel</Button>
      <Button data-testid="launch-start" type="submit" size="sm" loading={creating}>
        {creating ? 'Starting...' : 'Start session'}
      </Button>
    </div>
  </form>
</Modal>
