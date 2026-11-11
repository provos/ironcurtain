<script lang="ts">
  import { MAX_READONLY_FOLDERS, folderName, withFolder } from '../../readonly-folders.js';
  import X from 'phosphor-svelte/lib/X';
  import LockSimple from 'phosphor-svelte/lib/LockSimple';
  import Eye from 'phosphor-svelte/lib/Eye';

  /**
   * Chip input for read-only folders: Enter adds the typed path as a chip,
   * Backspace on an empty input removes the last one. Shows a one-line
   * visibility note once any folder is listed or typed. Callers submit
   * `withFolder(folders, draft)` so a typed-but-not-added path still counts.
   */
  let {
    folders = $bindable([]),
    draft = $bindable(''),
    disabled = false,
    testIdPrefix,
    label = 'Read-only folders · mounted at /mnt/ro',
  }: {
    folders?: string[];
    draft?: string;
    disabled?: boolean;
    /** Prefix for test ids: `<prefix>-input`, `<prefix>-chip`, `<prefix>-warning`. */
    testIdPrefix: string;
    label?: string;
  } = $props();

  const inputId = $derived(`${testIdPrefix}-input`);
  const atLimit = $derived(folders.length >= MAX_READONLY_FOLDERS);

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      // Enter turns the draft into a chip instead of submitting the form.
      event.preventDefault();
      folders = withFolder(folders, draft);
      draft = '';
    } else if (event.key === 'Backspace' && draft === '' && folders.length > 0) {
      folders = folders.slice(0, -1);
    }
  }
</script>

<div>
  <label for={inputId} class="text-xs text-muted-foreground">{label}</label>
  <div
    class="mt-1 flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40"
  >
    {#each folders as folder (folder)}
      <span
        data-testid="{testIdPrefix}-chip"
        title={folder}
        class="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs"
      >
        <LockSimple size={12} class="shrink-0 text-muted-foreground" />
        <span class="truncate">{folderName(folder)}</span>
        <button
          type="button"
          class="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Remove {folder}"
          {disabled}
          onclick={() => (folders = folders.filter((f) => f !== folder))}
        >
          <X size={12} />
        </button>
      </span>
    {/each}
    <input
      id={inputId}
      data-testid="{testIdPrefix}-input"
      bind:value={draft}
      onkeydown={handleKeydown}
      placeholder={atLimit ? 'Folder limit reached' : '/mnt/d/Training or D:\\Training, then Enter'}
      class="min-w-40 flex-1 bg-transparent px-1 py-0.5 font-mono text-xs placeholder:font-sans placeholder:text-muted-foreground focus:outline-none"
      disabled={disabled || atLimit}
    />
  </div>
  {#if folders.length > 0 || draft.trim()}
    <p data-testid="{testIdPrefix}-warning" class="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
      <Eye size={14} class="shrink-0 text-warning" />
      The agent can read these folders, and their contents may reach the model provider.
    </p>
  {/if}
</div>
