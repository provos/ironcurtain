<script lang="ts">
  import type { GetModelProvidersDto, ProfileDto, OpenrouterProfileDto, ModelMapRuleDto } from '$lib/types.js';
  import {
    getModelProviders,
    setModelProviders,
    listOpenrouterModels,
    appState,
    connectionGeneration,
    configChangedGeneration,
  } from '$lib/stores.svelte.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Card, CardHeader, CardTitle, CardContent } from '$lib/components/ui/card/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Modal } from '$lib/components/ui/modal/index.js';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table/index.js';
  import ModelCombobox from '$lib/components/features/model-combobox.svelte';
  import Plus from 'phosphor-svelte/lib/Plus';
  import Trash from 'phosphor-svelte/lib/Trash';
  import ArrowsClockwise from 'phosphor-svelte/lib/ArrowsClockwise';
  import {
    NATIVE_NAME,
    DOCKER_AGENTS,
    type DockerAgent,
    type EditableProfile,
    blankOpenrouterProfile,
    toEditable,
    editableToDto,
    isDuplicateProfileName,
    validateSlugs,
    blockMessage,
    warningMessage,
    persistedSlugSet,
  } from './settings-helpers.js';

  // Whether the daemon permits config mutation. When false every mutation control
  // is hidden (the daemon rejects with POLICY_MUTATION_FORBIDDEN anyway).
  const mutationAllowed = $derived(appState.daemonStatus?.allowPolicyMutation === true);

  let loading = $state(true);
  let error = $state('');

  // The fetched, masked registry. `profileNames` preserves list order (native first).
  let registry = $state<GetModelProvidersDto | null>(null);
  let defaultName = $state(NATIVE_NAME);

  // Editable working copy of openrouter profiles keyed by name (native excluded —
  // it is implicit and non-editable). The masked apiKey is the placeholder; an
  // unedited field is sent back as-is (mask) so the backend preserves the key.
  let editing = $state<{ name: string; original: string | null; profile: EditableProfile } | null>(null);
  let saving = $state(false);
  let saveError = $state<{ code: string; message: string } | null>(null);

  // OpenRouter model catalog for slug autocomplete + save-time validation.
  // `modelsSource` defaults to 'bundled' (warn-only) until loadModels() resolves,
  // so an in-flight save can never spuriously hard-block.
  let models = $state<string[]>([]);
  let modelsSource = $state<'live' | 'cache' | 'bundled'>('bundled');
  let modelsLoading = $state(false);
  let modelsError = $state(false);
  let modelsLoaded = $state(false);

  // Fields the last blocked save flagged (drives each combobox's `invalid` ring).
  let invalidModelRows = $state<ReadonlySet<number>>(new Set());
  let invalidAgents = $state<ReadonlySet<DockerAgent>>(new Set());
  // Non-blocking note surfaced after a warn-degrade save (modal already closed).
  let savedWarning = $state('');

  // Delete confirmation.
  let deleteTarget = $state<string | null>(null);
  let deleting = $state(false);

  function rpcError(err: unknown): { code: string; message: string } {
    const e = err as { code?: string; message?: string };
    return {
      code: typeof e.code === 'string' ? e.code : 'ERROR',
      message: e.message ?? (err instanceof Error ? err.message : String(err)),
    };
  }

  $effect(() => {
    void load();
  });

  // Refresh on (re)connect and on every config.changed server-push event.
  $effect(() => {
    void connectionGeneration.value;
    void configChangedGeneration.value;
    void refreshOnChange();
  });

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      applyRegistry(await getModelProviders());
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    loading = false;
  }

  async function refreshOnChange(): Promise<void> {
    // Skip generation 0 so we don't double-load on mount (load() runs separately).
    if (connectionGeneration.value === 0 && configChangedGeneration.value === 0) return;
    // Don't clobber an in-progress edit dialog.
    if (editing) return;
    try {
      applyRegistry(await getModelProviders());
    } catch {
      // Best-effort.
    }
  }

  function applyRegistry(dto: GetModelProvidersDto): void {
    registry = dto;
    defaultName = dto.default;
  }

  // List of openrouter profile names (native rendered separately, non-editable).
  const openrouterNames = $derived<string[]>(
    registry ? Object.keys(registry.profiles).filter((n) => n !== NATIVE_NAME) : [],
  );
  const allNames = $derived<string[]>(registry ? [NATIVE_NAME, ...openrouterNames] : [NATIVE_NAME]);

  function profileSummary(name: string): string {
    const p = registry?.profiles[name];
    if (!p || p.type === 'native') return 'Native providers (Anthropic / OpenAI / ChatGPT)';
    const map = p.modelMap;
    const mapPart =
      map === undefined
        ? 'default map'
        : map.length === 0
          ? 'per-agent only'
          : map.length === 1
            ? `→ ${map[0].model}`
            : `${map.length} map rules`;
    return `${mapPart} · key: ${p.apiKey ?? 'none'}`;
  }

  // Fetch the OpenRouter catalog lazily when the editor opens. Best-effort: a
  // failure degrades to the bundled (warn-only) mode, never throws. Loads once
  // per page session (the daemon caches with a 6h TTL); a prior failure retries,
  // and the editor's Refresh button forces a re-fetch (`opts.force`).
  async function loadModels(opts?: { force?: boolean }): Promise<void> {
    const force = opts?.force ?? false;
    if (modelsLoading) return;
    if (modelsLoaded && !modelsError && !force) return;
    modelsLoading = true;
    modelsError = false;
    try {
      const dto = await listOpenrouterModels(force);
      models = [...dto.models];
      modelsSource = dto.source;
      modelsLoaded = true;
    } catch {
      modelsError = true;
    }
    modelsLoading = false;
  }

  // Clears per-edit UX state (blocked-field marks + the last warn note) so a
  // freshly opened editor starts clean.
  function resetEditFeedback(): void {
    saveError = null;
    invalidModelRows = new Set();
    invalidAgents = new Set();
    savedWarning = '';
  }

  // ── Add / edit dialog ────────────────────────────────────────────────────
  function openAdd(): void {
    editing = { name: '', original: null, profile: blankOpenrouterProfile() };
    resetEditFeedback();
    void loadModels();
  }

  function openEdit(name: string): void {
    const p = registry?.profiles[name];
    if (!p || p.type !== 'openrouter') return;
    editing = { name, original: name, profile: toEditable(p) };
    resetEditFeedback();
    void loadModels();
  }

  function closeEdit(): void {
    editing = null;
    saveError = null;
  }

  /** The originally-persisted openrouter DTO for `original` (undefined for add). */
  function registryProfileDto(original: string | null): OpenrouterProfileDto | undefined {
    if (!original) return undefined;
    const p = registry?.profiles[original];
    return p && p.type === 'openrouter' ? p : undefined;
  }

  function addMapRow(): void {
    if (!editing) return;
    editing.profile.modelMap = [...editing.profile.modelMap, { match: '', model: '' }];
  }

  function removeMapRow(index: number): void {
    if (!editing) return;
    editing.profile.modelMap = editing.profile.modelMap.filter((_, i) => i !== index);
  }

  // Fires after the "use default map" checkbox flips `usesDefaultMap`. Leaving
  // the default (unchecked) enters custom mode; seed a blank row so the editor is
  // immediately usable instead of silently meaning "per-agent only".
  function onToggleDefaultMap(): void {
    if (!editing) return;
    if (!editing.profile.usesDefaultMap && editing.profile.modelMap.length === 0) {
      editing.profile.modelMap = [{ match: '', model: '' }];
    }
  }

  /** Builds the whole profiles record for the write, replacing/adding the edited profile. */
  function buildProfilesForSave(edit: NonNullable<typeof editing>): Record<string, ProfileDto> {
    const out: Record<string, ProfileDto> = {};
    // Carry over all existing openrouter profiles untouched (whole-record send).
    for (const name of openrouterNames) {
      if (name === edit.original) continue; // replaced below
      const existing = registry?.profiles[name];
      if (existing && existing.type === 'openrouter') out[name] = existing;
    }
    // Add/replace the edited profile under its (possibly renamed) name.
    out[edit.name.trim()] = editableToDto(edit.profile);
    return out;
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) {
      saveError = { code: 'INVALID_PARAMS', message: 'Profile name is required.' };
      return;
    }
    if (name === NATIVE_NAME) {
      saveError = { code: 'INVALID_PARAMS', message: '"native" is a reserved profile name.' };
      return;
    }
    // Renaming onto (or adding with) an existing profile's name would silently
    // overwrite that profile's config — reject instead of clobbering it.
    if (isDuplicateProfileName(name, editing.original, openrouterNames)) {
      saveError = { code: 'INVALID_PARAMS', message: `A profile named "${name}" already exists.` };
      return;
    }

    // Client-side slug guardrail (a UX aid, not a security boundary — the backend
    // persists whatever it is given). Grandfather slugs already persisted for this
    // profile so a routine edit never traps an untouched, possibly-delisted slug.
    const grandfathered = persistedSlugSet(registryProfileDto(editing.original));
    const validation = validateSlugs(editing.profile, { slugs: new Set(models), source: modelsSource }, grandfathered);
    if (validation.blocked.length > 0) {
      saveError = { code: 'INVALID_PARAMS', message: blockMessage(validation.blocked) };
      const rows = new Set<number>();
      const agents = new Set<DockerAgent>();
      for (const issue of validation.blocked) {
        if (issue.field === 'model' && issue.index !== undefined) rows.add(issue.index);
        else if (issue.field === 'peragent' && issue.agent) agents.add(issue.agent);
      }
      invalidModelRows = rows;
      invalidAgents = agents;
      return;
    }
    // Under the bundled fallback, unknown slugs only warn — surface after saving.
    const pendingWarning = warningMessage(validation.warnings);
    invalidModelRows = new Set();
    invalidAgents = new Set();

    saving = true;
    saveError = null;
    try {
      const profiles = buildProfilesForSave(editing);
      // A rename that drops the current default is handled by the backend (F10);
      // keep the current default selection otherwise.
      const nextDefault = defaultName;
      applyRegistry(await setModelProviders({ default: nextDefault, profiles }));
      editing = null;
      savedWarning = pendingWarning;
    } catch (err) {
      saveError = rpcError(err);
    }
    saving = false;
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  function openDelete(name: string): void {
    deleteTarget = name;
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    deleting = true;
    try {
      const remaining: Record<string, ProfileDto> = {};
      for (const name of openrouterNames) {
        if (name === deleteTarget) continue;
        const existing = registry?.profiles[name];
        if (existing && existing.type === 'openrouter') remaining[name] = existing;
      }
      // Send the current default; the backend re-points to native if we just
      // deleted the profile it named (F10).
      applyRegistry(await setModelProviders({ default: defaultName, profiles: remaining }));
      deleteTarget = null;
    } catch (err) {
      saveError = rpcError(err);
    }
    deleting = false;
  }

  // ── Default selector ────────────────────────────────────────────────────
  async function setDefault(name: string): Promise<void> {
    if (!registry || name === defaultName) return;
    saving = true;
    saveError = null;
    try {
      // Resend the whole record (unchanged) with the new default.
      const profiles: Record<string, ProfileDto> = {};
      for (const n of openrouterNames) {
        const existing = registry.profiles[n];
        if (existing && existing.type === 'openrouter') profiles[n] = existing;
      }
      applyRegistry(await setModelProviders({ default: name, profiles }));
    } catch (err) {
      saveError = rpcError(err);
    }
    saving = false;
  }

  function errorAffordance(code: string): string {
    switch (code) {
      case 'POLICY_MUTATION_FORBIDDEN':
        return 'Config mutation is disabled on this daemon. Start the daemon with --allow-policy-mutation to manage provider profiles from the web UI.';
      case 'INVALID_PARAMS':
        return 'Some fields are invalid. Check the profile name and the default selection.';
      default:
        return 'The operation could not be completed.';
    }
  }
</script>

<div class="p-6 space-y-5 animate-fade-in">
  <div class="flex items-center justify-between flex-wrap gap-3">
    <h2 class="text-xl font-semibold tracking-tight">Model Providers</h2>
    <div class="flex items-center gap-3">
      <Badge variant="outline">{openrouterNames.length} profile{openrouterNames.length === 1 ? '' : 's'}</Badge>
      {#if mutationAllowed}
        <Button variant="default" size="sm" onclick={openAdd} data-testid="add-profile-button">
          <Plus size={16} class="mr-1" /> Add profile
        </Button>
      {/if}
    </div>
  </div>

  <p class="text-sm text-muted-foreground">
    Route Docker agents through a model-provider profile. <span class="font-mono">native</span> keeps today's canonical
    Anthropic / OpenAI / ChatGPT routing; an <span class="font-mono">openrouter</span> profile routes an agent through
    OpenRouter with a bound model map and key. Pick a default here, or select a profile per session at
    <span class="font-mono">/new</span> or with <span class="font-mono">--provider-profile</span>.
  </p>

  {#if error}
    <Alert variant="destructive">{error}</Alert>
  {/if}

  {#if saveError}
    <div data-testid="settings-error">
      <Alert variant="destructive">
        <span class="block">
          <span class="font-mono text-xs" data-testid="settings-error-code">{saveError.code}</span>
          <span class="block mt-1">{errorAffordance(saveError.code)}</span>
        </span>
      </Alert>
    </div>
  {/if}

  {#if savedWarning}
    <div data-testid="slug-warning">
      <Alert variant="default" dismissible ondismiss={() => (savedWarning = '')}>
        <span class="block text-sm">{savedWarning}</span>
      </Alert>
    </div>
  {/if}

  {#if loading}
    <div class="flex items-center justify-center py-16">
      <Spinner size="md" />
    </div>
  {:else if registry}
    <Table>
      <TableHeader>
        <TableHead>Profile</TableHead>
        <TableHead>Type</TableHead>
        <TableHead>Summary</TableHead>
        <TableHead>Default</TableHead>
        {#if mutationAllowed}<TableHead>Actions</TableHead>{/if}
      </TableHeader>
      <TableBody>
        {#each allNames as name (name)}
          {@const isNative = name === NATIVE_NAME}
          <TableRow data-testid={`profile-row-${name}`}>
            <TableCell class="font-medium font-mono text-xs">{name}</TableCell>
            <TableCell>
              <Badge variant={isNative ? 'secondary' : 'default'}>
                {registry.profiles[name]?.type ?? 'native'}
              </Badge>
            </TableCell>
            <TableCell class="text-sm text-muted-foreground max-w-xs truncate">{profileSummary(name)}</TableCell>
            <TableCell>
              {#if name === defaultName}
                <Badge variant="success" data-testid={`default-badge-${name}`}>Default</Badge>
              {:else if mutationAllowed}
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => setDefault(name)}
                  disabled={saving}
                  data-testid={`set-default-${name}`}
                >
                  Set default
                </Button>
              {/if}
            </TableCell>
            {#if mutationAllowed}
              <TableCell>
                {#if !isNative}
                  <div class="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={() => openEdit(name)}
                      data-testid={`edit-profile-${name}`}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onclick={() => openDelete(name)}
                      data-testid={`delete-profile-${name}`}
                    >
                      <Trash size={14} />
                    </Button>
                  </div>
                {:else}
                  <span class="text-xs text-muted-foreground">built-in</span>
                {/if}
              </TableCell>
            {/if}
          </TableRow>
        {/each}
      </TableBody>
    </Table>

    {#if openrouterNames.length === 0}
      <Card>
        <CardContent>
          <p class="text-center text-muted-foreground py-8">
            No OpenRouter profiles yet.
            {#if mutationAllowed}
              Add one with the “Add profile” button.
            {:else}
              Add one with <code class="text-xs">ironcurtain config</code> → Model Providers.
            {/if}
          </p>
        </CardContent>
      </Card>
    {/if}
  {/if}
</div>

<!-- Add / edit profile dialog -->
<Modal open={editing !== null} onclose={closeEdit} title={editing?.original ? 'Edit profile' : 'Add profile'}>
  {#if editing}
    <div class="space-y-4 max-h-[70vh] overflow-y-auto" data-testid="profile-editor">
      <div>
        <label class="text-xs text-muted-foreground" for="pf-name">Profile name</label>
        <Input id="pf-name" bind:value={editing.name} placeholder="e.g. glm-5.2" data-testid="profile-name" />
      </div>

      <div>
        <label class="text-xs text-muted-foreground" for="pf-key">API key</label>
        <Input
          id="pf-key"
          bind:value={editing.profile.apiKey}
          placeholder="sk-or-v1-..."
          data-testid="profile-apikey"
        />
        <p class="text-[11px] text-muted-foreground mt-1">
          Leave the masked value untouched to keep the stored key. Clear the field to remove it. Env
          <span class="font-mono">OPENROUTER_API_KEY</span> overrides this for every profile.
        </p>
      </div>

      <div>
        <div class="flex items-center justify-between mb-1">
          <p class="text-xs text-muted-foreground">Model map</p>
          <Button
            variant="ghost"
            size="sm"
            onclick={() => loadModels({ force: true })}
            disabled={modelsLoading}
            data-testid="model-refresh"
          >
            <ArrowsClockwise size={13} class="mr-1" />
            {modelsLoading ? 'Refreshing…' : 'Refresh models'}
          </Button>
        </div>
        <label class="flex items-start gap-2 text-sm mb-2">
          <input
            type="checkbox"
            class="mt-1"
            bind:checked={editing.profile.usesDefaultMap}
            onchange={onToggleDefaultMap}
            data-testid="map-use-default"
          />
          <span>
            Use IronCurtain’s default model map
            <span class="block text-[11px] text-muted-foreground">
              Every Claude model (Sonnet / Opus / Haiku) routes to the default GLM model, and stays in sync if the
              built-in defaults change. Uncheck to define your own glob rules.
            </span>
          </span>
        </label>

        {#if !editing.profile.usesDefaultMap}
          <p class="text-[11px] text-muted-foreground mb-1">Custom rules (glob → slug, first match wins)</p>
          {#each editing.profile.modelMap as _row, i (i)}
            <div class="flex items-start gap-2 mb-2">
              <div class="flex-1">
                <Input
                  bind:value={editing.profile.modelMap[i].match}
                  placeholder="*sonnet*"
                  data-testid={`map-match-${i}`}
                />
              </div>
              <span class="text-muted-foreground">→</span>
              <div class="flex-1">
                <ModelCombobox
                  bind:value={editing.profile.modelMap[i].model}
                  {models}
                  source={modelsSource}
                  loading={modelsLoading}
                  error={modelsError}
                  invalid={invalidModelRows.has(i)}
                  placeholder="z-ai/glm-5.2"
                  testid={`map-model-${i}`}
                />
              </div>
              <Button variant="ghost" size="sm" onclick={() => removeMapRow(i)} data-testid={`map-remove-${i}`}>
                <Trash size={14} />
              </Button>
            </div>
          {/each}
          <Button variant="outline" size="sm" onclick={addMapRow} data-testid="map-add">
            <Plus size={14} class="mr-1" /> Add rule
          </Button>
          <p class="text-[11px] text-muted-foreground mt-1">
            No rules means “per-agent only” — the glob map never matches, so only the per-agent overrides below apply.
          </p>
        {/if}
      </div>

      <div>
        <p class="text-xs text-muted-foreground mb-1">Per-agent model override (wins over the map)</p>
        <div class="space-y-2">
          {#each DOCKER_AGENTS as agent (agent)}
            <div class="flex items-start gap-2">
              <span class="text-xs font-mono w-24 shrink-0 mt-2.5">{agent}</span>
              <div class="flex-1">
                <ModelCombobox
                  bind:value={editing.profile.perAgent[agent]}
                  {models}
                  source={modelsSource}
                  loading={modelsLoading}
                  error={modelsError}
                  invalid={invalidAgents.has(agent)}
                  placeholder="(unset)"
                  testid={`peragent-${agent}`}
                />
              </div>
            </div>
          {/each}
        </div>
      </div>

      <div>
        <p class="text-xs text-muted-foreground mb-1">Provider preference (cache pinning)</p>
        <div class="space-y-2">
          <div class="flex items-center gap-2">
            <span class="text-xs w-16 shrink-0">order</span>
            <Input
              bind:value={editing.profile.providerOrder}
              placeholder="z-ai (comma-separated)"
              data-testid="provider-order"
            />
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs w-16 shrink-0">only</span>
            <Input
              bind:value={editing.profile.providerOnly}
              placeholder="z-ai (comma-separated)"
              data-testid="provider-only"
            />
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              bind:checked={editing.profile.allowFallbacks}
              data-testid="provider-allow-fallbacks"
            />
            <span>Allow fallbacks</span>
          </label>
        </div>
      </div>

      <label class="flex items-center gap-3 text-sm">
        <input type="checkbox" bind:checked={editing.profile.sessionAffinity} data-testid="session-affinity" />
        <span>Session affinity (inject session_id for GLM cache affinity)</span>
      </label>

      {#if saveError}
        <div data-testid="editor-error">
          <Alert variant="destructive">
            <span class="font-mono text-xs">{saveError.code}</span>
            <span class="block mt-1">
              {saveError.code === 'INVALID_PARAMS' ? saveError.message : errorAffordance(saveError.code)}
            </span>
          </Alert>
        </div>
      {/if}

      <div class="flex items-center justify-end gap-3">
        <Button variant="outline" size="sm" onclick={closeEdit} disabled={saving}>Cancel</Button>
        <Button
          variant="default"
          size="sm"
          onclick={saveEdit}
          loading={saving}
          disabled={saving || !editing.name.trim()}
          data-testid="save-profile-button"
        >
          Save profile
        </Button>
      </div>
    </div>
  {/if}
</Modal>

<!-- Delete confirmation -->
<Modal open={deleteTarget !== null} onclose={() => (deleteTarget = null)} title="Delete profile">
  <div class="space-y-4">
    <p class="text-sm">
      Delete provider profile <span class="font-mono">{deleteTarget}</span>? Sessions currently using it fall back to
      the default. If this profile is the default, the default re-points to <span class="font-mono">native</span>.
    </p>
    <div class="flex items-center justify-end gap-3">
      <Button variant="outline" size="sm" onclick={() => (deleteTarget = null)} disabled={deleting}>Cancel</Button>
      <Button
        variant="destructive"
        size="sm"
        onclick={confirmDelete}
        loading={deleting}
        disabled={deleting}
        data-testid="confirm-delete-profile"
      >
        Delete
      </Button>
    </div>
  </div>
</Modal>
