<script lang="ts">
  import { appState, getWsClient } from '../lib/stores.svelte.js';
  import type { ConversationTurn } from '../lib/types.js';

  let messageInput = $state('');
  let sending = $state(false);
  let sessionHistory = $state<ConversationTurn[]>([]);

  async function createSession(): Promise<void> {
    try {
      const result = await getWsClient().request<{ label: number }>('sessions.create');
      appState.selectedSessionLabel = result.label;
    } catch (err) {
      console.error('Failed to create session:', err);
    }
  }

  async function endSession(label: number): Promise<void> {
    try {
      await getWsClient().request('sessions.end', { label });
    } catch (err) {
      console.error('Failed to end session:', err);
    }
  }

  async function sendMessage(e: Event): Promise<void> {
    e.preventDefault();
    if (!messageInput.trim() || !appState.selectedSessionLabel || sending) return;

    const text = messageInput.trim();
    messageInput = '';
    sending = true;

    // Add user message to output immediately
    appState.addOutput(appState.selectedSessionLabel, {
      kind: 'user',
      text,
      timestamp: new Date().toISOString(),
    });

    try {
      await getWsClient().request('sessions.send', {
        label: appState.selectedSessionLabel,
        text,
      });
    } catch (err) {
      appState.addOutput(appState.selectedSessionLabel!, {
        kind: 'error',
        text: `Failed to send: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      });
    } finally {
      sending = false;
    }
  }

  async function loadHistory(label: number): Promise<void> {
    try {
      sessionHistory = await getWsClient().request<ConversationTurn[]>('sessions.history', { label });
    } catch {
      sessionHistory = [];
    }
  }

  // Load history when session is selected
  $effect(() => {
    if (appState.selectedSessionLabel !== null) {
      loadHistory(appState.selectedSessionLabel);
    }
  });
</script>

<div class="flex h-full">
  <!-- Session list sidebar -->
  <div class="w-64 border-r border-border bg-card/50 flex flex-col">
    <div class="p-4 border-b border-border flex items-center justify-between">
      <h3 class="font-medium">Sessions</h3>
      <button
        onclick={createSession}
        class="px-3 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity"
      >
        New
      </button>
    </div>
    <div class="flex-1 overflow-auto">
      {#each [...appState.sessions.values()] as session (session.label)}
        <button
          onclick={() => appState.selectedSessionLabel = session.label}
          class="w-full text-left px-4 py-3 border-b border-border text-sm transition-colors
            {appState.selectedSessionLabel === session.label
              ? 'bg-accent'
              : 'hover:bg-accent/30'}"
        >
          <div class="flex items-center justify-between">
            <span class="font-mono font-medium">#{session.label}</span>
            <span class="text-xs text-muted-foreground">{session.source.kind}</span>
          </div>
          <div class="text-xs text-muted-foreground mt-1">
            {session.turnCount} turns &middot; {session.budget.estimatedCostUsd.toFixed(2)}
          </div>
          {#if session.hasPendingEscalation}
            <span class="mt-1 inline-block px-1.5 py-0.5 text-xs bg-destructive/20 text-destructive rounded">
              escalation
            </span>
          {/if}
        </button>
      {/each}
      {#if appState.sessions.size === 0}
        <div class="p-4 text-sm text-muted-foreground text-center">
          No active sessions
        </div>
      {/if}
    </div>
  </div>

  <!-- Session detail / console -->
  <div class="flex-1 flex flex-col">
    {#if appState.selectedSession}
      <!-- Session header -->
      <div class="px-6 py-3 border-b border-border flex items-center justify-between bg-card/50">
        <div>
          <span class="font-mono font-semibold">#{appState.selectedSession.label}</span>
          <span class="ml-2 px-2 py-0.5 text-xs rounded-full
            {appState.selectedSession.status === 'processing' ? 'bg-yellow-500/20 text-yellow-400' :
             appState.selectedSession.status === 'ready' ? 'bg-green-500/20 text-green-400' :
             'bg-muted text-muted-foreground'}">
            {appState.selectedSession.status}
          </span>
        </div>
        <div class="flex items-center gap-4">
          <span class="text-xs text-muted-foreground">
            {appState.selectedSession.budget.estimatedCostUsd.toFixed(2)} &middot;
            {appState.selectedSession.budget.stepCount} steps &middot;
            {Math.round(appState.selectedSession.budget.elapsedSeconds)}s
          </span>
          <button
            onclick={() => endSession(appState.selectedSessionLabel!)}
            class="px-3 py-1 text-xs bg-destructive text-destructive-foreground rounded-md hover:opacity-90"
          >
            End
          </button>
        </div>
      </div>

      <!-- Output area -->
      <div class="flex-1 overflow-auto p-4 space-y-3 font-mono text-sm">
        {#each appState.getOutput(appState.selectedSessionLabel!) as line}
          <div class="{line.kind === 'user' ? 'text-blue-400' :
                       line.kind === 'assistant' ? 'text-foreground' :
                       line.kind === 'tool_call' ? 'text-muted-foreground italic' :
                       line.kind === 'thinking' ? 'text-yellow-400 animate-pulse' :
                       line.kind === 'error' ? 'text-destructive' :
                       'text-muted-foreground'}">
            {#if line.kind === 'user'}
              <span class="text-muted-foreground select-none">&gt; </span>{line.text}
            {:else if line.kind === 'tool_call'}
              <span class="select-none">  [tool] </span>{line.text}
            {:else if line.kind === 'thinking'}
              <span class="select-none">  </span>{line.text}
            {:else}
              <span class="whitespace-pre-wrap">{line.text}</span>
            {/if}
          </div>
        {/each}
        {#if appState.getOutput(appState.selectedSessionLabel!).length === 0 && sessionHistory.length > 0}
          {#each sessionHistory as turn}
            <div class="text-blue-400">
              <span class="text-muted-foreground select-none">&gt; </span>{turn.userMessage}
            </div>
            <div class="whitespace-pre-wrap">{turn.assistantResponse}</div>
          {/each}
        {/if}
      </div>

      <!-- Input area -->
      <form onsubmit={sendMessage} class="border-t border-border p-4 flex gap-2">
        <input
          type="text"
          bind:value={messageInput}
          placeholder="Send a message..."
          disabled={sending || appState.selectedSession.status !== 'ready'}
          class="flex-1 px-3 py-2 bg-background border border-border rounded-md text-sm
                 focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={sending || !messageInput.trim() || appState.selectedSession.status !== 'ready'}
          class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium
                 hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {sending ? 'Sending...' : 'Send'}
        </button>
      </form>
    {:else}
      <div class="flex-1 flex items-center justify-center text-muted-foreground">
        <div class="text-center">
          <p class="text-lg mb-2">No session selected</p>
          <p class="text-sm">Select a session from the list or create a new one.</p>
        </div>
      </div>
    {/if}
  </div>
</div>
