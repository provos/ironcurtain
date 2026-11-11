<script lang="ts">
  import { onMount } from 'svelte';
  import type { PersonaListItem, CreateSessionOptions } from '../../types.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Modal } from '$lib/components/ui/modal/index.js';
  import X from 'phosphor-svelte/lib/X';
  import LockSimple from 'phosphor-svelte/lib/LockSimple';
  import Eye from 'phosphor-svelte/lib/Eye';

  /** Mirrors MAX_READONLY_MOUNTS on the daemon (which re-validates). */
  const MAX_READONLY_MOUNTS = 8;

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
  const atReadonlyLimit = $derived(readonlyMounts.length >= MAX_READONLY_MOUNTS);

  onMount(() => {
    loadPersonasFn()
      .then((list) => (personas = list))
      .catch(() => (personas = []));
    loadProviderProfilesFn?.()
      .then((list) => (providerProfiles = list))
      .catch(() => (providerProfiles = []));
  });

  /** Last path segment, for compact chip labels (handles `/` and `\`). */
  function folderName(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, '');
    return trimmed.split(/[\\/]/).pop() || trimmed || path;
  }

  /** Adds `path` unless empty, duplicate, or over the limit. */
  function withReadonlyMount(list: string[], path: string): string[] {
    const trimmed = path.trim();
    if (!trimmed || list.includes(trimmed) || list.length >= MAX_READONLY_MOUNTS) return list;
    return [...list, trimmed];
  }

  function removeReadonlyMount(path: string): void {
    readonlyMounts = readonlyMounts.filter((p) => p !== path);
  }

  function handleReadonlyKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      // Enter turns the draft into a chip instead of submitting the form.
      event.preventDefault();
      readonlyMounts = withReadonlyMount(readonlyMounts, readonlyDraft);
      readonlyDraft = '';
    } else if (event.key === 'Backspace' && readonlyDraft === '' && readonlyMounts.length > 0) {
      readonlyMounts = readonlyMounts.slice(0, -1);
    }
  }

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
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

  const selectClass =
    'mt-1 w-full px-2 py-1.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring';
</script>

<Modal {open} {onclose} title="New session" class="max-w-xl">
  <form data-testid="session-launch-form" onsubmit={handleSubmit}>
    <div class="space-y-4 px-5 py-4">
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

      <div>
        <label for="launch-readonly-input" class="text-xs text-muted-foreground">
          Read-only folders · mounted at /mnt/ro
        </label>
        <div
          class="mt-1 flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40"
        >
          {#each readonlyMounts as mount (mount)}
            <span
              data-testid="launch-readonly-chip"
              title={mount}
              class="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs"
            >
              <LockSimple size={12} class="shrink-0 text-muted-foreground" />
              <span class="truncate">{folderName(mount)}</span>
              <button
                type="button"
                class="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Remove {mount}"
                disabled={creating}
                onclick={() => removeReadonlyMount(mount)}
              >
                <X size={12} />
              </button>
            </span>
          {/each}
          <input
            id="launch-readonly-input"
            data-testid="launch-readonly-input"
            bind:value={readonlyDraft}
            onkeydown={handleReadonlyKeydown}
            placeholder={atReadonlyLimit ? 'Folder limit reached' : '/mnt/d/Training or D:\\Training, then Enter'}
            class="min-w-40 flex-1 bg-transparent px-1 py-0.5 font-mono text-xs placeholder:font-sans placeholder:text-muted-foreground focus:outline-none"
            disabled={creating || atReadonlyLimit}
          />
        </div>
        {#if readonlyMounts.length > 0 || readonlyDraft.trim()}
          <p
            data-testid="launch-readonly-warning"
            class="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <Eye size={14} class="shrink-0 text-warning" />
            The agent can read these folders, and their contents may reach the model provider.
          </p>
        {/if}
      </div>

      {#if createError}
        <p data-testid="launch-error" class="text-sm text-destructive" role="alert">{createError}</p>
      {/if}
    </div>

    <div class="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
      <Button type="button" variant="ghost" size="sm" onclick={onclose}>Cancel</Button>
      <Button data-testid="launch-start" type="submit" size="sm" loading={creating}>
        {creating ? 'Starting...' : 'Start session'}
      </Button>
    </div>
  </form>
</Modal>
