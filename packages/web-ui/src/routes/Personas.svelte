<script lang="ts">
  import type { PersonaListItem, PersonaDetailDto, PersonaCompileOperationDto } from '$lib/types.js';
  import {
    listPersonas,
    getPersonaDetail,
    startPersonaCompile,
    hydratePersonaCompiles,
    appState,
    connectionGeneration,
  } from '$lib/stores.svelte.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Card, CardHeader, CardTitle, CardContent } from '$lib/components/ui/card/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table/index.js';
  import { renderMarkdown } from '$lib/markdown.js';

  let personas = $state<PersonaListItem[]>([]);
  let loading = $state(true);
  let error = $state('');
  let selectedName = $state<string | null>(null);
  let detail = $state<PersonaDetailDto | null>(null);
  let detailLoading = $state(false);
  let detailError = $state('');

  // The operationId of the compile this view started/owns for the selected
  // persona. Drives the live indicator off appState.personaCompiles. Cleared
  // when navigating away or selecting another persona.
  let activeOperationId = $state<string | null>(null);
  // Set true when a locally-owned operation disappears from a listCompiles
  // hydration (e.g. the daemon restarted mid-compile) -- the card stays but
  // offers a recompile affordance.
  let interrupted = $state(false);
  // Last RPC error from compileStream itself (synchronous rejection, e.g.
  // POLICY_MUTATION_FORBIDDEN / COMPILE_IN_PROGRESS / CREDENTIALS_MISSING).
  let startError = $state<{ code: string; message: string } | null>(null);
  let starting = $state(false);
  // Track which operationIds we've already reacted to terminally so the
  // post-completion refresh fires exactly once per op.
  let handledTerminal = $state<string | null>(null);

  // The live record this view should display for the selected persona.
  //
  // Prefers the operation this view started (`activeOperationId`). Falls back to
  // any in-flight (started/running) operation for the selected persona found in
  // the hydrated map -- this is what lets a reconnect rehydrate an in-flight card
  // even though the locally-owned operationId was lost on reload.
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
        // Prefer the most recently started in-flight op.
        if (!inflight || op.startedAt > inflight.startedAt) inflight = op;
      }
    }
    return inflight;
  }

  const compiling = $derived(starting || activeCompile?.phase === 'started' || activeCompile?.phase === 'running');

  // Human-readable phase label for the live indicator.
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

  $effect(() => {
    loadPersonas();
  });

  // Hydrate in-flight compile cards on connect / reconnect. Reading
  // connectionGeneration.value makes this re-run after each (re)connection.
  $effect(() => {
    void connectionGeneration.value;
    void hydrateCompiles();
  });

  // React when the owned operation reaches a terminal phase: refresh detail +
  // list on success exactly once.
  $effect(() => {
    const op = activeCompile;
    if (!op || !selectedName) return;
    if (op.phase === 'done' && handledTerminal !== op.operationId) {
      handledTerminal = op.operationId;
      void refreshAfterCompile(selectedName);
    } else if (op.phase === 'failed' && handledTerminal !== op.operationId) {
      handledTerminal = op.operationId;
    }
  });

  async function hydrateCompiles(): Promise<void> {
    try {
      const present = await hydratePersonaCompiles();
      // A locally-owned op that the server no longer knows about is interrupted.
      if (activeOperationId && !present.has(activeOperationId)) {
        interrupted = true;
      }
    } catch {
      // Best-effort -- events will repopulate live records.
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
    try {
      detail = await getPersonaDetail(name);
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

  function deselectPersona(): void {
    selectedName = null;
    detail = null;
    resetCompileState();
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
      const e = err as { code?: string; message?: string };
      startError = {
        code: typeof e.code === 'string' ? e.code : 'COMPILE_FAILED',
        message: e.message ?? (err instanceof Error ? err.message : String(err)),
      };
    }
    starting = false;
  }

  function errorAffordance(code: string): string {
    switch (code) {
      case 'POLICY_MUTATION_FORBIDDEN':
        return 'Policy compilation is disabled on this daemon. Start the daemon with policy mutation enabled to compile from the web UI.';
      case 'COMPILE_IN_PROGRESS':
        return 'A compile is already running for this persona. Wait for it to finish, then try again.';
      case 'COMPILE_QUEUE_FULL':
        return 'The compile queue is full. Please try again shortly.';
      case 'CREDENTIALS_MISSING':
        return 'Required model credentials are missing. Configure the provider API key on the daemon host, then retry.';
      case 'LIST_REQUIRES_MCP':
        return 'This policy needs live MCP servers to resolve dynamic lists, which are unavailable in this context.';
      default:
        return 'Compilation could not be started.';
    }
  }
</script>

{#if selectedName}
  <!-- Detail view -->
  <div class="p-6 space-y-5 animate-fade-in">
    <div class="flex items-center gap-3">
      <Button variant="ghost" size="sm" onclick={deselectPersona}>&larr; Back</Button>
      <h2 class="text-xl font-semibold tracking-tight">{selectedName}</h2>
      {#if detail}
        <Badge variant={detail.hasPolicy ? 'success' : 'secondary'}>
          {detail.hasPolicy ? 'Policy compiled' : 'No policy'}
        </Badge>
        {#if detail.policyRuleCount != null}
          <Badge variant="outline">{detail.policyRuleCount} rules</Badge>
        {/if}
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

      <!-- Compile control + live indicator -->
      <Card>
        <CardContent>
          <div class="flex items-center gap-3 flex-wrap">
            <Button
              variant="default"
              onclick={handleCompile}
              loading={compiling}
              disabled={compiling}
              data-testid="compile-button"
            >
              {detail.hasPolicy ? 'Recompile Policy' : 'Compile Policy'}
            </Button>

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

      <!-- Constitution -->
      {#if detail.constitution}
        <Card>
          <CardHeader>
            <CardTitle>Constitution</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="prose-markdown text-sm">
              {@html renderMarkdown(detail.constitution)}
            </div>
          </CardContent>
        </Card>
      {:else}
        <Card>
          <CardContent>
            <p class="text-sm text-muted-foreground">No constitution defined yet.</p>
          </CardContent>
        </Card>
      {/if}
    {/if}
  </div>
{:else}
  <!-- List view -->
  <div class="p-6 space-y-5 animate-fade-in">
    <div class="flex items-center justify-between">
      <h2 class="text-xl font-semibold tracking-tight">Personas</h2>
      <Badge variant="outline">{personas.length} total</Badge>
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
            No personas found. Create one with <code class="text-xs">ironcurtain persona create</code>.
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
{/if}
