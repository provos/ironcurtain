<script lang="ts">
  import { appState, getWsClient } from '../lib/stores.svelte.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Card } from '$lib/components/ui/card/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import EscalationCard from '$lib/components/escalation-card.svelte';

  import CheckCircle from 'phosphor-svelte/lib/CheckCircle';

  let resolvingIds = $state<Set<string>>(new Set());
  let resolveError = $state('');

  async function resolveEscalation(
    escalationId: string,
    decision: 'approved' | 'denied',
    whitelistSelection?: number,
  ): Promise<void> {
    resolvingIds = new Set([...resolvingIds, escalationId]);
    resolveError = '';
    try {
      const params: Record<string, unknown> = { escalationId, decision };
      if (decision === 'approved' && whitelistSelection != null) {
        params.whitelistSelection = whitelistSelection;
      }
      await getWsClient().request('escalations.resolve', params);
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
    <Alert variant="destructive" dismissible ondismiss={() => (resolveError = '')}>
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
        <EscalationCard
          escalation={esc}
          loading={resolvingIds.has(esc.escalationId)}
          onapprove={(whitelistSelection) => resolveEscalation(esc.escalationId, 'approved', whitelistSelection)}
          ondeny={() => resolveEscalation(esc.escalationId, 'denied')}
        />
      {/each}
    </div>
  {/if}
</div>
