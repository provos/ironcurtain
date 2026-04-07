<script lang="ts">
  import type { PersonaListItem, PersonaDetailDto, PersonaCompileResultDto } from '$lib/types.js';
  import { listPersonas, getPersonaDetail, compilePersonaPolicy } from '$lib/stores.svelte.js';
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
  let compiling = $state(false);
  let compileResult = $state<PersonaCompileResultDto | null>(null);

  $effect(() => {
    loadPersonas();
  });

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
    compileResult = null;
    try {
      detail = await getPersonaDetail(name);
    } catch (err) {
      detailError = err instanceof Error ? err.message : String(err);
    }
    detailLoading = false;
  }

  function deselectPersona(): void {
    selectedName = null;
    detail = null;
    compileResult = null;
  }

  async function handleCompile(): Promise<void> {
    if (!selectedName) return;
    compiling = true;
    compileResult = null;
    try {
      compileResult = await compilePersonaPolicy(selectedName);
      // Refresh detail to update policy status
      if (compileResult.success) {
        detail = await getPersonaDetail(selectedName);
        // Also refresh the list to update the compiled badge
        personas = await listPersonas();
      }
    } catch (err) {
      compileResult = {
        success: false,
        ruleCount: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
    compiling = false;
  }
</script>

{#if selectedName}
  <!-- Detail view -->
  <div class="p-6 space-y-5 animate-fade-in overflow-y-auto h-full">
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

      <!-- Compile button -->
      <Card>
        <CardContent>
          <div class="flex items-center gap-3">
            <Button variant="default" onclick={handleCompile} loading={compiling} disabled={compiling}>
              {detail.hasPolicy ? 'Recompile Policy' : 'Compile Policy'}
            </Button>
            {#if compileResult}
              {#if compileResult.success}
                <span class="text-sm text-success">
                  Compiled successfully ({compileResult.ruleCount} rules)
                </span>
              {:else}
                <span class="text-sm text-destructive">
                  Compilation failed
                  {#if compileResult.errors}
                    : {compileResult.errors[0]}
                  {/if}
                </span>
              {/if}
            {/if}
          </div>
        </CardContent>
      </Card>

      <!-- Constitution -->
      {#if detail.constitution}
        <Card>
          <CardHeader>
            <CardTitle>Constitution</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="prose prose-sm max-w-none">
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
