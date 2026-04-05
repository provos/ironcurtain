<script lang="ts">
  import { appState, getWsClient } from '../lib/stores.svelte.js';
  import type { ConversationTurn, PersonaListItem } from '../lib/types.js';

  let messageInput = $state('');
  let sending = $state(false);
  let sessionHistory = $state<ConversationTurn[]>([]);

  // Session creation state
  let creatingSession = $state(false);
  let showPersonaPicker = $state(false);
  let personas = $state<PersonaListItem[]>([]);
  let loadingPersonas = $state(false);
  let createError = $state('');

  // Session end state
  let endingSession = $state<number | null>(null);

  async function loadPersonas(): Promise<void> {
    loadingPersonas = true;
    try {
      personas = await getWsClient().request<PersonaListItem[]>('personas.list');
    } catch {
      personas = [];
    } finally {
      loadingPersonas = false;
    }
  }

  function openPersonaPicker(): void {
    createError = '';
    showPersonaPicker = true;
    loadPersonas();
  }

  async function createSession(persona?: string): Promise<void> {
    showPersonaPicker = false;
    creatingSession = true;
    createError = '';
    try {
      const params: Record<string, unknown> = {};
      if (persona) params.persona = persona;
      const result = await getWsClient().request<{ label: number }>('sessions.create', params);
      appState.selectedSessionLabel = result.label;
    } catch (err) {
      createError = err instanceof Error ? err.message : String(err);
    } finally {
      creatingSession = false;
    }
  }

  async function endSession(label: number): Promise<void> {
    endingSession = label;
    try {
      await getWsClient().request('sessions.end', { label });
    } catch (err) {
      console.error('Failed to end session:', err);
    } finally {
      endingSession = null;
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
      <div class="relative">
        <button
          onclick={openPersonaPicker}
          disabled={creatingSession}
          class="px-3 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90
                 transition-opacity disabled:opacity-50"
        >
          {#if creatingSession}
            <span class="inline-flex items-center gap-1">
              <span class="w-3 h-3 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin"></span>
              Starting...
            </span>
          {:else}
            New
          {/if}
        </button>

        <!-- Persona picker dropdown -->
        {#if showPersonaPicker}
          <!-- Backdrop -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="fixed inset-0 z-10" onclick={() => showPersonaPicker = false} onkeydown={() => {}}></div>
          <div class="absolute right-0 top-full mt-1 z-20 w-56 bg-card border border-border rounded-lg shadow-lg overflow-hidden">
            <button
              onclick={() => createSession()}
              class="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors border-b border-border"
            >
              <div class="font-medium">Default</div>
              <div class="text-xs text-muted-foreground">No persona</div>
            </button>
            {#if loadingPersonas}
              <div class="px-3 py-3 text-xs text-muted-foreground text-center">
                Loading personas...
              </div>
            {:else if personas.length === 0}
              <div class="px-3 py-3 text-xs text-muted-foreground text-center">
                No personas available
              </div>
            {:else}
              {#each personas as persona (persona.name)}
                <button
                  onclick={() => createSession(persona.name)}
                  disabled={!persona.compiled}
                  class="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <div class="font-medium flex items-center gap-1.5">
                    {persona.name}
                    {#if !persona.compiled}
                      <span class="text-xs text-yellow-400">(not compiled)</span>
                    {/if}
                  </div>
                  {#if persona.description}
                    <div class="text-xs text-muted-foreground truncate">{persona.description}</div>
                  {/if}
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>

    {#if createError}
      <div class="px-4 py-2 text-xs text-destructive bg-destructive/10 border-b border-border">
        {createError}
      </div>
    {/if}

    <div class="flex-1 overflow-auto">
      {#if creatingSession}
        <div class="w-full text-left px-4 py-3 border-b border-border text-sm bg-accent/20 animate-pulse">
          <div class="flex items-center justify-between">
            <span class="font-mono font-medium text-muted-foreground">Starting...</span>
            <span class="w-3 h-3 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin"></span>
          </div>
          <div class="text-xs text-muted-foreground mt-1">New session</div>
        </div>
      {/if}
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
      {#if appState.sessions.size === 0 && !creatingSession}
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
            disabled={endingSession === appState.selectedSessionLabel}
            class="px-3 py-1 text-xs bg-destructive text-destructive-foreground rounded-md
                   hover:opacity-90 disabled:opacity-50"
          >
            {#if endingSession === appState.selectedSessionLabel}
              <span class="inline-flex items-center gap-1">
                <span class="w-3 h-3 border-2 border-destructive-foreground/30 border-t-destructive-foreground rounded-full animate-spin"></span>
                Ending
              </span>
            {:else}
              End
            {/if}
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
          {#if sending}
            <span class="inline-flex items-center gap-1">
              <span class="w-3 h-3 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin"></span>
              Sending
            </span>
          {:else}
            Send
          {/if}
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
