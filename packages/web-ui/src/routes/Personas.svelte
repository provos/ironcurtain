<script lang="ts">
  import type { PersonaListItem, PersonaDetailDto, PersonaCompileOperationDto, RuleDeltaDto } from '$lib/types.js';
  import {
    listPersonas,
    getPersonaDetail,
    startPersonaCompile,
    hydratePersonaCompiles,
    createPersona,
    editPersonaConstitution,
    setPersonaMemory,
    setPersonaBroadPolicyOptIn,
    deletePersona,
    appState,
    connectionGeneration,
    personasChangedGeneration,
  } from '$lib/stores.svelte.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Card, CardHeader, CardTitle, CardContent } from '$lib/components/ui/card/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Modal } from '$lib/components/ui/modal/index.js';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table/index.js';
  import { renderMarkdown } from '$lib/markdown.js';

  // Static set of MCP servers a new persona can be narrowed to. There is no
  // `servers.list` RPC; this mirrors the servers referenced by the canned
  // personas / the daemon's mcp-servers.json. "All servers (incl. future)" is
  // modeled as the empty selection (servers omitted from the create payload).
  const KNOWN_SERVERS = ['filesystem', 'git', 'github', 'web-search', 'google-workspace'];

  let personas = $state<PersonaListItem[]>([]);
  let loading = $state(true);
  let error = $state('');
  let selectedName = $state<string | null>(null);
  let detail = $state<PersonaDetailDto | null>(null);
  let detailLoading = $state(false);
  let detailError = $state('');

  // Whether the daemon permits persona policy-mutation. When false, every
  // mutation control is hidden (the daemon would reject with
  // POLICY_MUTATION_FORBIDDEN anyway). `undefined` is treated as false.
  const mutationAllowed = $derived(appState.daemonStatus?.allowPolicyMutation === true);

  // ── Streamed-compile state (Phase 1b) ──────────────────────────────────
  let activeOperationId = $state<string | null>(null);
  let interrupted = $state(false);
  let startError = $state<{ code: string; message: string } | null>(null);
  let starting = $state(false);
  let handledTerminal = $state<string | null>(null);

  const activeCompile = $derived<PersonaCompileOperationDto | null>(resolveActiveCompile());

  function resolveActiveCompile(): PersonaCompileOperationDto | null {
    if (activeOperationId) {
      return appState.personaCompiles.get(activeOperationId) ?? null;
    }
    if (!selectedName) return null;
    let inflight: PersonaCompileOperationDto | null = null;
    for (const op of appState.personaCompiles.values()) {
      if (op.name !== selectedName) continue;
      if (op.phase === 'started' || op.phase === 'running') {
        if (!inflight || op.startedAt > inflight.startedAt) inflight = op;
      }
    }
    return inflight;
  }

  const compiling = $derived(starting || activeCompile?.phase === 'started' || activeCompile?.phase === 'running');

  // ruleDelta surfaced from the most recent done card for the selected persona.
  const ruleDelta = $derived<RuleDeltaDto | null>(
    activeCompile?.phase === 'done' ? (activeCompile.result?.ruleDelta ?? null) : null,
  );

  const PHASE_LABELS: Record<string, string> = {
    cached: 'Cached',
    compiling: 'Compiling rules',
    lists: 'Resolving lists',
    scenarios: 'Generating scenarios',
    'repair-scenarios': 'Repairing scenarios',
    verifying: 'Verifying',
    'repair-compile': 'Repairing compilation',
    'repair-verify': 'Repairing verification',
    done: 'Done',
  };

  function phaseLabel(op: PersonaCompileOperationDto): string {
    const sp = op.serverProgress;
    if (!sp) return op.phase === 'started' ? 'Starting...' : 'Working...';
    const label = PHASE_LABELS[sp.compilationPhase] ?? sp.compilationPhase;
    return `${sp.server}: ${label}${sp.detail ? ` -- ${sp.detail}` : ''}`;
  }

  // ── Edit-constitution state ────────────────────────────────────────────
  let constitutionDraft = $state('');
  let constitutionDirty = $state(false);
  let savingConstitution = $state(false);
  // True when the last edit reported the compiled policy is now stale, OR the
  // local draft has unsaved/uncompiled changes.
  let constitutionStale = $state(false);
  let editError = $state<{ code: string; message: string } | null>(null);

  // ── Memory toggle / broad-policy state ─────────────────────────────────
  let memoryBusy = $state(false);
  let broadPolicyBusy = $state(false);
  let mutationError = $state<{ code: string; message: string } | null>(null);

  // ── Delete dialog state ────────────────────────────────────────────────
  let deleteOpen = $state(false);
  let deleteForce = $state(false);
  let deleting = $state(false);
  let deleteError = $state<{ code: string; message: string } | null>(null);

  // ── New-persona form state ─────────────────────────────────────────────
  let formOpen = $state(false);
  let formName = $state('');
  let formDescription = $state('');
  let formMemory = $state(true);
  let formConstitution = $state('');
  // false = "All servers (incl. future)"; true = manually narrow to a subset.
  let formNarrowServers = $state(false);
  let formSelectedServers = $state<Set<string>>(new Set());
  let creating = $state(false);
  let formError = $state<{ code: string; message: string } | null>(null);

  function rpcError(err: unknown): { code: string; message: string } {
    const e = err as { code?: string; message?: string };
    return {
      code: typeof e.code === 'string' ? e.code : 'ERROR',
      message: e.message ?? (err instanceof Error ? err.message : String(err)),
    };
  }

  $effect(() => {
    loadPersonas();
  });

  // Refresh on (re)connect + on every personas.changed event.
  $effect(() => {
    void connectionGeneration.value;
    void hydrateCompiles();
  });

  $effect(() => {
    void personasChangedGeneration.value;
    void refreshOnChange();
  });

  // Terminal compile reaction: refresh detail/list on success exactly once.
  $effect(() => {
    const op = activeCompile;
    if (!op || !selectedName) return;
    if (op.phase === 'done' && handledTerminal !== op.operationId) {
      handledTerminal = op.operationId;
      // A successful compile means the constitution is no longer stale.
      constitutionStale = false;
      void refreshAfterCompile(selectedName);
    } else if (op.phase === 'failed' && handledTerminal !== op.operationId) {
      handledTerminal = op.operationId;
    }
  });

  async function refreshOnChange(): Promise<void> {
    // Skip the very first run (generation 0) so we don't double-load on mount.
    if (personasChangedGeneration.value === 0) return;
    try {
      personas = await listPersonas();
      if (selectedName) {
        detail = await getPersonaDetail(selectedName);
      }
    } catch {
      // Best-effort.
    }
  }

  async function hydrateCompiles(): Promise<void> {
    try {
      const present = await hydratePersonaCompiles();
      if (activeOperationId && !present.has(activeOperationId)) {
        interrupted = true;
      }
    } catch {
      // Best-effort.
    }
  }

  async function loadPersonas(): Promise<void> {
    loading = true;
    error = '';
    try {
      personas = await listPersonas();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    loading = false;
  }

  async function selectPersona(name: string): Promise<void> {
    selectedName = name;
    detailLoading = true;
    detailError = '';
    detail = null;
    resetCompileState();
    resetDetailMutationState();
    try {
      detail = await getPersonaDetail(name);
      constitutionDraft = detail.constitution ?? '';
      constitutionDirty = false;
      constitutionStale = false;
    } catch (err) {
      detailError = err instanceof Error ? err.message : String(err);
    }
    detailLoading = false;
  }

  function resetCompileState(): void {
    activeOperationId = null;
    interrupted = false;
    startError = null;
    starting = false;
    handledTerminal = null;
  }

  function resetDetailMutationState(): void {
    editError = null;
    mutationError = null;
    deleteError = null;
    deleteOpen = false;
    deleteForce = false;
  }

  function deselectPersona(): void {
    selectedName = null;
    detail = null;
    resetCompileState();
    resetDetailMutationState();
  }

  async function refreshAfterCompile(name: string): Promise<void> {
    try {
      detail = await getPersonaDetail(name);
      personas = await listPersonas();
    } catch {
      // Best-effort refresh.
    }
  }

  async function handleCompile(): Promise<void> {
    if (!selectedName) return;
    starting = true;
    startError = null;
    interrupted = false;
    handledTerminal = null;
    try {
      const ack = await startPersonaCompile(selectedName);
      activeOperationId = ack.operationId;
    } catch (err) {
      startError = rpcError(err);
    }
    starting = false;
  }

  // ── Edit constitution ──────────────────────────────────────────────────
  function onConstitutionInput(): void {
    constitutionDirty = (detail?.constitution ?? '') !== constitutionDraft;
  }

  async function saveConstitution(): Promise<void> {
    if (!selectedName) return;
    savingConstitution = true;
    editError = null;
    try {
      const result = await editPersonaConstitution(selectedName, constitutionDraft);
      // Sync local detail so dirty tracking resets against the new baseline.
      if (detail) detail = { ...detail, constitution: constitutionDraft };
      constitutionDirty = false;
      constitutionStale = result.stale;
    } catch (err) {
      editError = rpcError(err);
    }
    savingConstitution = false;
  }

  // ── Memory toggle ──────────────────────────────────────────────────────
  async function toggleMemory(): Promise<void> {
    if (!selectedName || !detail) return;
    memoryBusy = true;
    mutationError = null;
    const next = !(detail.memory ?? true);
    try {
      detail = await setPersonaMemory(selectedName, next);
    } catch (err) {
      mutationError = rpcError(err);
    }
    memoryBusy = false;
  }

  // ── Broad-policy opt-in ────────────────────────────────────────────────
  async function toggleBroadPolicy(): Promise<void> {
    if (!selectedName || !detail) return;
    broadPolicyBusy = true;
    mutationError = null;
    const next = !(detail.allowBroadPolicy ?? false);
    try {
      detail = await setPersonaBroadPolicyOptIn(selectedName, next);
    } catch (err) {
      mutationError = rpcError(err);
    }
    broadPolicyBusy = false;
  }

  // ── Delete ─────────────────────────────────────────────────────────────
  function openDelete(): void {
    deleteOpen = true;
    deleteForce = false;
    deleteError = null;
  }

  async function confirmDelete(): Promise<void> {
    if (!selectedName) return;
    deleting = true;
    deleteError = null;
    try {
      await deletePersona(selectedName, deleteForce ? { force: true } : undefined);
      deleteOpen = false;
      deselectPersona();
      personas = await listPersonas();
    } catch (err) {
      deleteError = rpcError(err);
    }
    deleting = false;
  }

  // ── New persona form ───────────────────────────────────────────────────
  function openForm(): void {
    formOpen = true;
    formName = '';
    formDescription = '';
    formMemory = true;
    formConstitution = '';
    formNarrowServers = false;
    formSelectedServers = new Set();
    formError = null;
  }

  function toggleFormServer(server: string): void {
    const next = new Set(formSelectedServers);
    if (next.has(server)) next.delete(server);
    else next.add(server);
    formSelectedServers = next;
  }

  async function submitForm(): Promise<void> {
    creating = true;
    formError = null;
    try {
      const servers = formNarrowServers ? [...formSelectedServers] : undefined;
      await createPersona({
        name: formName.trim(),
        description: formDescription.trim(),
        servers,
        memoryEnabled: formMemory,
        ...(formConstitution.trim() ? { constitution: formConstitution } : {}),
      });
      formOpen = false;
      personas = await listPersonas();
      // Drill into the newly created persona.
      void selectPersona(formName.trim());
    } catch (err) {
      formError = rpcError(err);
    }
    creating = false;
  }

  function errorAffordance(code: string): string {
    switch (code) {
      case 'POLICY_MUTATION_FORBIDDEN':
        return 'Policy compilation is disabled on this daemon. Start the daemon with --allow-policy-mutation to manage personas from the web UI.';
      case 'COMPILE_IN_PROGRESS':
        return 'A compile is already running for this persona. Wait for it to finish, then try again.';
      case 'COMPILE_QUEUE_FULL':
        return 'The compile queue is full. Please try again shortly.';
      case 'CREDENTIALS_MISSING':
        return 'Required model credentials are missing. Configure the provider API key on the daemon host, then retry.';
      case 'LIST_REQUIRES_MCP':
        return 'This policy needs live MCP servers to resolve dynamic lists, which are unavailable in this context.';
      case 'BROAD_POLICY_REJECTED':
        return 'The compiled policy is broad (wildcard domains/lists or out-of-workspace paths). Enable "Allow broad policy" for this persona, then recompile.';
      case 'PERSONA_EXISTS':
        return 'A persona with that name already exists. Choose a different name.';
      case 'PERSONA_NOT_FOUND':
        return 'This persona no longer exists.';
      case 'INVALID_PARAMS':
        return 'Some fields are invalid. Check the name (lowercase slug) and description.';
      default:
        return 'The operation could not be completed.';
    }
  }
</script>

{#if selectedName}
  <!-- Detail view -->
  <div class="p-6 space-y-5 animate-fade-in">
    <div class="flex items-center gap-3 flex-wrap">
      <Button variant="ghost" size="sm" onclick={deselectPersona}>&larr; Back</Button>
      <h2 class="text-xl font-semibold tracking-tight">{selectedName}</h2>
      {#if detail}
        <Badge variant={detail.hasPolicy ? 'success' : 'secondary'}>
          {detail.hasPolicy ? 'Policy compiled' : 'No policy'}
        </Badge>
        {#if detail.policyRuleCount != null}
          <Badge variant="outline">{detail.policyRuleCount} rules</Badge>
        {/if}
        {#if (constitutionStale || constitutionDirty) && detail.hasPolicy}
          <Badge variant="warning" data-testid="stale-badge">Policy stale — recompile</Badge>
        {/if}
      {/if}
      <span class="flex-1"></span>
      {#if mutationAllowed && detail}
        <Button variant="destructive" size="sm" onclick={openDelete} data-testid="delete-button">Delete</Button>
      {/if}
    </div>

    {#if detailLoading}
      <div class="flex items-center justify-center py-16">
        <Spinner size="md" />
      </div>
    {:else if detailError}
      <Alert variant="destructive">{detailError}</Alert>
    {:else if detail}
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card>
          <CardContent>
            <p class="text-xs text-muted-foreground">Description</p>
            <p class="text-sm mt-1">{detail.description}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p class="text-xs text-muted-foreground">Created</p>
            <p class="text-sm mt-1">{new Date(detail.createdAt).toLocaleDateString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p class="text-xs text-muted-foreground">Servers</p>
            {#if detail.servers && detail.servers.length > 0}
              <div class="flex flex-wrap gap-1 mt-1">
                {#each detail.servers as server (server)}
                  <Badge variant="outline" class="text-xs">{server}</Badge>
                {/each}
              </div>
            {:else}
              <p class="text-sm mt-1 text-muted-foreground">All servers</p>
            {/if}
          </CardContent>
        </Card>
      </div>

      {#if mutationError}
        <div data-testid="mutation-error">
          <Alert variant="destructive">
            <span class="block">
              <span class="font-mono text-xs" data-testid="mutation-error-code">{mutationError.code}</span>
              <span class="block mt-1">{errorAffordance(mutationError.code)}</span>
            </span>
          </Alert>
        </div>
      {/if}

      <!-- Settings: memory + broad-policy (gated) -->
      {#if mutationAllowed}
        <Card>
          <CardContent>
            <div class="flex flex-col gap-3">
              <label class="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={detail.memory ?? true}
                  disabled={memoryBusy}
                  onchange={toggleMemory}
                  data-testid="memory-toggle"
                />
                <span>Persistent memory {(detail.memory ?? true) ? 'enabled' : 'disabled'}</span>
                {#if memoryBusy}<Spinner size="xs" />{/if}
              </label>
              <label class="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={detail.allowBroadPolicy ?? false}
                  disabled={broadPolicyBusy}
                  onchange={toggleBroadPolicy}
                  data-testid="broad-policy-toggle"
                />
                <span>
                  Allow broad policy
                  <span class="text-xs text-muted-foreground"> (wildcard domains/lists, out-of-workspace paths) </span>
                </span>
                {#if broadPolicyBusy}<Spinner size="xs" />{/if}
              </label>
            </div>
          </CardContent>
        </Card>
      {/if}

      <!-- Compile control + live indicator -->
      <Card>
        <CardContent>
          <div class="flex items-center gap-3 flex-wrap">
            {#if mutationAllowed}
              <Button
                variant="default"
                onclick={handleCompile}
                loading={compiling}
                disabled={compiling}
                data-testid="compile-button"
              >
                {detail.hasPolicy ? 'Recompile Policy' : 'Compile Policy'}
              </Button>
            {/if}

            {#if compiling && activeCompile}
              <span class="text-sm text-muted-foreground" data-testid="compile-progress">
                {phaseLabel(activeCompile)}
              </span>
            {:else if compiling}
              <span class="text-sm text-muted-foreground" data-testid="compile-progress"> Starting... </span>
            {/if}

            {#if activeCompile?.phase === 'done' && activeCompile.result}
              <span class="text-sm text-success" data-testid="compile-success">
                Compiled successfully ({activeCompile.result.ruleCount} rules)
              </span>
            {/if}
          </div>

          {#if ruleDelta}
            <div class="mt-3 text-sm" data-testid="rule-delta">
              <p class="text-xs text-muted-foreground mb-1">Policy changes vs previous compile</p>
              <div class="flex flex-wrap gap-2">
                <Badge variant="outline">+{ruleDelta.added} added</Badge>
                <Badge variant={ruleDelta.loosened > 0 ? 'warning' : 'outline'}>{ruleDelta.loosened} loosened</Badge>
                <Badge variant="outline">{ruleDelta.removed} removed</Badge>
              </div>
              {#if ruleDelta.broadenedDomains.length > 0}
                <p class="text-xs text-warning mt-2" data-testid="rule-delta-domains">
                  Broadened domains: {ruleDelta.broadenedDomains.join(', ')}
                </p>
              {/if}
              {#if ruleDelta.outOfWorkspacePaths.length > 0}
                <p class="text-xs text-warning mt-1" data-testid="rule-delta-paths">
                  Out-of-workspace paths: {ruleDelta.outOfWorkspacePaths.join(', ')}
                </p>
              {/if}
            </div>
          {/if}

          {#if interrupted}
            <div data-testid="compile-interrupted" class="mt-3">
              <Alert variant="destructive">
                Compilation was interrupted (the daemon may have restarted). You can recompile.
              </Alert>
            </div>
          {/if}

          {#if startError}
            <div data-testid="compile-error" class="mt-3">
              <Alert variant="destructive">
                <span class="block">
                  <span class="font-mono text-xs" data-testid="compile-error-code">{startError.code}</span>
                  <span class="block mt-1">{errorAffordance(startError.code)}</span>
                </span>
              </Alert>
            </div>
          {:else if activeCompile?.phase === 'failed' && activeCompile.error}
            <div data-testid="compile-error" class="mt-3">
              <Alert variant="destructive">
                <span class="block">
                  <span class="font-mono text-xs" data-testid="compile-error-code">{activeCompile.error.code}</span>
                  <span class="block mt-1">{errorAffordance(activeCompile.error.code)}</span>
                </span>
              </Alert>
            </div>
          {/if}
        </CardContent>
      </Card>

      <!-- Constitution: editable when mutation allowed, else read-only markdown -->
      <Card>
        <CardHeader>
          <CardTitle>Constitution</CardTitle>
        </CardHeader>
        <CardContent>
          {#if mutationAllowed}
            <textarea
              bind:value={constitutionDraft}
              oninput={onConstitutionInput}
              rows="12"
              data-testid="constitution-editor"
              class="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm font-mono
                     focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring transition-all"
              placeholder="# Persona constitution&#10;&#10;Describe the policy principles in markdown..."
            ></textarea>
            <div class="flex items-center gap-3 mt-3">
              <Button
                variant="default"
                size="sm"
                onclick={saveConstitution}
                loading={savingConstitution}
                disabled={!constitutionDirty || savingConstitution}
                data-testid="save-constitution-button"
              >
                Save constitution
              </Button>
              {#if constitutionDirty}
                <span class="text-xs text-warning" data-testid="constitution-dirty">Unsaved changes</span>
              {/if}
            </div>
            {#if editError}
              <div data-testid="edit-error" class="mt-3">
                <Alert variant="destructive">
                  <span class="block">
                    <span class="font-mono text-xs" data-testid="edit-error-code">{editError.code}</span>
                    <span class="block mt-1">{errorAffordance(editError.code)}</span>
                  </span>
                </Alert>
              </div>
            {/if}
          {:else if detail.constitution}
            <div class="prose-markdown text-sm">
              {@html renderMarkdown(detail.constitution)}
            </div>
          {:else}
            <p class="text-sm text-muted-foreground">No constitution defined yet.</p>
          {/if}
        </CardContent>
      </Card>
    {/if}
  </div>

  <!-- Delete confirmation dialog -->
  <Modal open={deleteOpen} onclose={() => (deleteOpen = false)} title="Delete persona">
    <div class="space-y-4">
      <p class="text-sm">
        Delete persona <span class="font-mono">{selectedName}</span>?
        {#if deleteForce}
          This permanently removes the persona and revokes its compiled policy.
        {:else}
          The persona is moved to trash; its policy is left inert and can be restored on disk.
        {/if}
      </p>
      <label class="flex items-center gap-3 text-sm">
        <input type="checkbox" bind:checked={deleteForce} data-testid="delete-force" />
        <span>Permanently delete (revoke policy)</span>
      </label>
      {#if deleteError}
        <div data-testid="delete-error">
          <Alert variant="destructive">
            <span class="block">
              <span class="font-mono text-xs" data-testid="delete-error-code">{deleteError.code}</span>
              <span class="block mt-1">{errorAffordance(deleteError.code)}</span>
            </span>
          </Alert>
        </div>
      {/if}
      <div class="flex items-center justify-end gap-3">
        <Button variant="outline" size="sm" onclick={() => (deleteOpen = false)} disabled={deleting}>Cancel</Button>
        <Button
          variant="destructive"
          size="sm"
          onclick={confirmDelete}
          loading={deleting}
          disabled={deleting}
          data-testid="confirm-delete-button"
        >
          {deleteForce ? 'Permanently delete' : 'Delete'}
        </Button>
      </div>
    </div>
  </Modal>
{:else}
  <!-- List view -->
  <div class="p-6 space-y-5 animate-fade-in">
    <div class="flex items-center justify-between">
      <h2 class="text-xl font-semibold tracking-tight">Personas</h2>
      <div class="flex items-center gap-3">
        <Badge variant="outline">{personas.length} total</Badge>
        {#if mutationAllowed}
          <Button variant="default" size="sm" onclick={openForm} data-testid="new-persona-button">New persona</Button>
        {/if}
      </div>
    </div>

    {#if error}
      <Alert variant="destructive">{error}</Alert>
    {/if}

    {#if loading}
      <div class="flex items-center justify-center py-16">
        <Spinner size="md" />
      </div>
    {:else if personas.length === 0}
      <Card>
        <CardContent>
          <p class="text-center text-muted-foreground py-8">
            No personas found.
            {#if mutationAllowed}
              Create one with the “New persona” button.
            {:else}
              Create one with <code class="text-xs">ironcurtain persona create</code>.
            {/if}
          </p>
        </CardContent>
      </Card>
    {:else}
      <Table>
        <TableHeader>
          <TableHead>Name</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Policy</TableHead>
        </TableHeader>
        <TableBody>
          {#each personas as persona (persona.name)}
            <TableRow clickable onclick={() => selectPersona(persona.name)}>
              <TableCell class="font-medium font-mono text-xs">{persona.name}</TableCell>
              <TableCell class="text-sm text-muted-foreground max-w-xs truncate">{persona.description}</TableCell>
              <TableCell>
                <Badge variant={persona.compiled ? 'success' : 'secondary'}>
                  {persona.compiled ? 'Compiled' : 'Not compiled'}
                </Badge>
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    {/if}
  </div>

  <!-- New-persona form dialog -->
  <Modal open={formOpen} onclose={() => (formOpen = false)} title="New persona">
    <div class="space-y-4">
      <div>
        <label class="text-xs text-muted-foreground" for="np-name">Name (lowercase slug)</label>
        <Input id="np-name" bind:value={formName} placeholder="e.g. researcher" data-testid="new-persona-name" />
        {#if formError?.code === 'INVALID_PARAMS' || formError?.code === 'PERSONA_EXISTS'}
          <p class="text-xs text-destructive mt-1" data-testid="new-persona-name-error">
            {errorAffordance(formError.code)}
          </p>
        {/if}
      </div>
      <div>
        <label class="text-xs text-muted-foreground" for="np-desc">Description</label>
        <Input
          id="np-desc"
          bind:value={formDescription}
          placeholder="What this persona is for"
          data-testid="new-persona-description"
        />
      </div>
      <div>
        <p class="text-xs text-muted-foreground mb-1">Servers</p>
        <label class="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="np-servers"
            checked={!formNarrowServers}
            onchange={() => (formNarrowServers = false)}
            data-testid="new-persona-all-servers"
          />
          <span>All servers (incl. future)</span>
        </label>
        <label class="flex items-center gap-2 text-sm mt-1">
          <input
            type="radio"
            name="np-servers"
            checked={formNarrowServers}
            onchange={() => (formNarrowServers = true)}
            data-testid="new-persona-narrow-servers"
          />
          <span>Narrow to specific servers</span>
        </label>
        {#if formNarrowServers}
          <div class="flex flex-wrap gap-2 mt-2 pl-6">
            {#each KNOWN_SERVERS as server (server)}
              <label class="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={formSelectedServers.has(server)}
                  onchange={() => toggleFormServer(server)}
                  data-testid={`new-persona-server-${server}`}
                />
                <span>{server}</span>
              </label>
            {/each}
          </div>
        {/if}
      </div>
      <label class="flex items-center gap-3 text-sm">
        <input type="checkbox" bind:checked={formMemory} data-testid="new-persona-memory" />
        <span>Enable persistent memory</span>
      </label>
      <div>
        <label class="text-xs text-muted-foreground" for="np-const">Constitution (optional)</label>
        <textarea
          id="np-const"
          bind:value={formConstitution}
          rows="6"
          data-testid="new-persona-constitution"
          class="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm font-mono
                 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring transition-all"
          placeholder="# Principles&#10;&#10;Leave blank to start with an empty persona."
        ></textarea>
      </div>
      {#if formError && formError.code !== 'INVALID_PARAMS' && formError.code !== 'PERSONA_EXISTS'}
        <div data-testid="new-persona-error">
          <Alert variant="destructive">
            <span class="block">
              <span class="font-mono text-xs" data-testid="new-persona-error-code">{formError.code}</span>
              <span class="block mt-1">{errorAffordance(formError.code)}</span>
            </span>
          </Alert>
        </div>
      {/if}
      <div class="flex items-center justify-end gap-3">
        <Button variant="outline" size="sm" onclick={() => (formOpen = false)} disabled={creating}>Cancel</Button>
        <Button
          variant="default"
          size="sm"
          onclick={submitForm}
          loading={creating}
          disabled={creating || !formName.trim() || !formDescription.trim()}
          data-testid="create-persona-button"
        >
          Create persona
        </Button>
      </div>
    </div>
  </Modal>
{/if}
