<script lang="ts">
  import { appState, getWsClient } from '../lib/stores.svelte.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Card } from '$lib/components/ui/card/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';

  import CheckCircle from 'phosphor-svelte/lib/CheckCircle';

  let resolvingIds = $state<Set<string>>(new Set());
  let resolveError = $state('');

  async function resolveEscalation(escalationId: string, decision: 'approved' | 'denied'): Promise<void> {
    resolvingIds = new Set([...resolvingIds, escalationId]);
    resolveError = '';
    try {
      await getWsClient().request('escalations.resolve', { escalationId, decision });
    } catch (err) {
      resolveError = `Failed to ${decision === 'approved' ? 'approve' : 'deny'}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      const next = new Set(resolvingIds);
      next.delete(escalationId);
      resolvingIds = next;
    }
  }
</script>

<div class="p-6 space-y-5 animate-fade-in">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-semibold tracking-tight">Escalations</h2>
    {#if appState.pendingEscalations.size > 0}
      <Badge variant="destructive" class="font-mono font-semibold px-2.5 py-1 text-xs">
        {appState.pendingEscalations.size} pending
      </Badge>
    {/if}
  </div>

  {#if resolveError}
    <Alert variant="destructive" dismissible ondismiss={() => resolveError = ''}>
      {resolveError}
    </Alert>
  {/if}

  {#if appState.pendingEscalations.size === 0}
    <Card class="p-12 text-center">
      <CheckCircle size={40} class="mx-auto text-muted-foreground/30 mb-4" />
      <p class="text-muted-foreground">No pending escalations</p>
      <p class="text-sm text-muted-foreground/70 mt-1">Escalations appear here when a tool call requires approval.</p>
    </Card>
  {:else}
    <div class="space-y-3">
      {#each [...appState.pendingEscalations.values()] as esc (esc.escalationId)}
        {@const isResolving = resolvingIds.has(esc.escalationId)}
        <Card class="overflow-hidden transition-all animate-fade-in
          {isResolving ? 'opacity-50 border-border' : 'border-destructive/20 shadow-sm shadow-destructive/5'}">
          <div class="px-5 py-4 flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-mono font-semibold text-sm">{esc.serverName}<span class="text-muted-foreground">/</span>{esc.toolName}</span>
              </div>
              <div class="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                <Badge variant="secondary" class="font-mono">#{esc.sessionLabel}</Badge>
                <span>{esc.sessionSource.kind}</span>
                <span>&middot;</span>
                <span>{new Date(esc.receivedAt).toLocaleTimeString()}</span>
              </div>
            </div>
            <div class="flex gap-2 shrink-0">
              <Button
                variant="success"
                size="sm"
                loading={isResolving}
                onclick={() => resolveEscalation(esc.escalationId, 'approved')}
              >
                {#if !isResolving}Approve{/if}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                loading={isResolving}
                onclick={() => resolveEscalation(esc.escalationId, 'denied')}
              >
                {#if !isResolving}Deny{/if}
              </Button>
            </div>
          </div>

          <div class="px-5 pb-4 space-y-3">
            <div>
              <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Reason</div>
              <div class="text-sm bg-muted/40 rounded-lg px-3 py-2.5 text-foreground/90">{esc.reason}</div>
            </div>

            <div>
              <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Arguments</div>
              <pre class="text-xs font-mono bg-muted/40 rounded-lg px-3 py-2.5 overflow-auto max-h-48 text-foreground/80">{JSON.stringify(esc.arguments, null, 2)}</pre>
            </div>

            {#if esc.context && Object.keys(esc.context).length > 0}
              <div>
                <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Context</div>
                <pre class="text-xs font-mono bg-muted/40 rounded-lg px-3 py-2.5 overflow-auto max-h-32 text-foreground/80">{JSON.stringify(esc.context, null, 2)}</pre>
              </div>
            {/if}
          </div>
        </Card>
      {/each}
    </div>
  {/if}
</div>
