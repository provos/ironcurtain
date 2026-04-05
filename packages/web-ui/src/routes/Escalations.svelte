<script lang="ts">
  import { appState, getWsClient } from '../lib/stores.svelte.js';

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
      <span class="px-2.5 py-1 text-xs font-mono font-semibold bg-destructive/15 text-destructive rounded-full">
        {appState.pendingEscalations.size} pending
      </span>
    {/if}
  </div>

  {#if resolveError}
    <div class="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive flex items-center justify-between animate-fade-in">
      <span>{resolveError}</span>
      <button onclick={() => resolveError = ''} class="text-destructive/60 hover:text-destructive ml-4 text-xs font-medium">Dismiss</button>
    </div>
  {/if}

  {#if appState.pendingEscalations.size === 0}
    <div class="bg-card border border-border rounded-xl p-12 text-center">
      <svg viewBox="0 0 24 24" class="w-10 h-10 mx-auto text-muted-foreground/30 mb-4" fill="none" stroke="currentColor" stroke-width="1">
        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p class="text-muted-foreground">No pending escalations</p>
      <p class="text-sm text-muted-foreground/70 mt-1">Escalations appear here when a tool call requires approval.</p>
    </div>
  {:else}
    <div class="space-y-3">
      {#each [...appState.pendingEscalations.values()] as esc (esc.escalationId)}
        {@const isResolving = resolvingIds.has(esc.escalationId)}
        <div class="bg-card border rounded-xl overflow-hidden transition-all animate-fade-in
          {isResolving ? 'opacity-50 border-border' : 'border-destructive/20 shadow-sm shadow-destructive/5'}">
          <div class="px-5 py-4 flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-mono font-semibold text-sm">{esc.serverName}<span class="text-muted-foreground">/</span>{esc.toolName}</span>
              </div>
              <div class="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                <span class="px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground font-mono">#{esc.sessionLabel}</span>
                <span>{esc.sessionSource.kind}</span>
                <span>&middot;</span>
                <span>{new Date(esc.receivedAt).toLocaleTimeString()}</span>
              </div>
            </div>
            <div class="flex gap-2 shrink-0">
              <button
                onclick={() => resolveEscalation(esc.escalationId, 'approved')}
                disabled={isResolving}
                class="px-4 py-2 bg-success text-success-foreground rounded-lg text-sm font-medium
                       hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none"
              >
                {#if isResolving}
                  <span class="inline-flex items-center gap-1.5">
                    <span class="w-3 h-3 border-2 border-success-foreground/30 border-t-success-foreground rounded-full animate-spin"></span>
                  </span>
                {:else}
                  Approve
                {/if}
              </button>
              <button
                onclick={() => resolveEscalation(esc.escalationId, 'denied')}
                disabled={isResolving}
                class="px-4 py-2 bg-destructive text-destructive-foreground rounded-lg text-sm font-medium
                       hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none"
              >
                {#if isResolving}
                  <span class="inline-flex items-center gap-1.5">
                    <span class="w-3 h-3 border-2 border-destructive-foreground/30 border-t-destructive-foreground rounded-full animate-spin"></span>
                  </span>
                {:else}
                  Deny
                {/if}
              </button>
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
        </div>
      {/each}
    </div>
  {/if}
</div>
