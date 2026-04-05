<script lang="ts">
  import { appState, getWsClient } from '../lib/stores.svelte.js';

  async function resolveEscalation(escalationId: string, decision: 'approved' | 'denied'): Promise<void> {
    try {
      await getWsClient().request('escalations.resolve', { escalationId, decision });
    } catch (err) {
      console.error('Failed to resolve escalation:', err);
    }
  }
</script>

<div class="p-6 space-y-6">
  <h2 class="text-2xl font-semibold">Escalations</h2>

  {#if appState.pendingEscalations.size === 0}
    <div class="bg-card border border-border rounded-lg p-8 text-center text-muted-foreground">
      <p class="text-lg">No pending escalations</p>
      <p class="text-sm mt-1">Escalations will appear here when a tool call requires approval.</p>
    </div>
  {:else}
    <div class="space-y-4">
      {#each [...appState.pendingEscalations.values()] as esc (esc.escalationId)}
        <div class="bg-card border border-border rounded-lg p-6">
          <div class="flex items-start justify-between mb-4">
            <div>
              <h3 class="font-semibold text-lg">
                {esc.serverName}/{esc.toolName}
              </h3>
              <div class="text-sm text-muted-foreground mt-1">
                Session #{esc.sessionLabel} &middot; {esc.sessionSource.kind} &middot;
                {new Date(esc.receivedAt).toLocaleTimeString()}
              </div>
            </div>
            <div class="flex gap-2">
              <button
                onclick={() => resolveEscalation(esc.escalationId, 'approved')}
                class="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 transition-colors"
              >
                Approve
              </button>
              <button
                onclick={() => resolveEscalation(esc.escalationId, 'denied')}
                class="px-4 py-2 bg-destructive text-destructive-foreground rounded-md text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Deny
              </button>
            </div>
          </div>

          <div class="mb-3">
            <div class="text-sm font-medium mb-1">Reason</div>
            <div class="text-sm text-muted-foreground bg-muted/50 rounded p-3">{esc.reason}</div>
          </div>

          <div>
            <div class="text-sm font-medium mb-1">Arguments</div>
            <pre class="text-xs bg-muted/50 rounded p-3 overflow-auto max-h-48">{JSON.stringify(esc.arguments, null, 2)}</pre>
          </div>

          {#if esc.context && Object.keys(esc.context).length > 0}
            <div class="mt-3">
              <div class="text-sm font-medium mb-1">Context</div>
              <pre class="text-xs bg-muted/50 rounded p-3 overflow-auto max-h-32">{JSON.stringify(esc.context, null, 2)}</pre>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
