<script lang="ts">
  import {
    appState,
    createSession,
    sendSessionMessage,
    endSession,
    loadSessionHistory,
    listPersonas,
  } from '../lib/stores.svelte.js';
  import type { ConversationTurn } from '../lib/types.js';

  import SessionSidebar from '$lib/components/features/session-sidebar.svelte';
  import SessionConsole from '$lib/components/features/session-console.svelte';

  let { onOpenEscalation }: { onOpenEscalation?: () => void } = $props();

  let sending = $state(false);
  let sessionHistory = $state<ConversationTurn[]>([]);

  // Session creation state
  let creatingSession = $state(false);
  let createError = $state('');

  // Session end state
  let endingSession = $state<number | null>(null);

  async function handleCreate(persona?: string): Promise<void> {
    creatingSession = true;
    createError = '';
    try {
      const result = await createSession(persona);
      appState.selectedSessionLabel = result.label;
    } catch (err) {
      createError = err instanceof Error ? err.message : String(err);
    } finally {
      creatingSession = false;
    }
  }

  async function handleEnd(): Promise<void> {
    const label = appState.selectedSessionLabel;
    if (label === null) return;
    endingSession = label;
    try {
      await endSession(label);
    } catch (err) {
      console.error('Failed to end session:', err);
    } finally {
      endingSession = null;
    }
  }

  async function handleSend(text: string): Promise<void> {
    if (!appState.selectedSessionLabel || sending) return;

    const label = appState.selectedSessionLabel;
    sending = true;

    // Add user message to output immediately
    appState.addOutput(label, {
      kind: 'user',
      text,
      timestamp: new Date().toISOString(),
    });

    try {
      await sendSessionMessage(label, text);
    } catch (err) {
      appState.addOutput(label, {
        kind: 'error',
        text: `Failed to send: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      });
    } finally {
      sending = false;
    }
  }

  // Guard against stale history responses when the user switches sessions quickly
  let historyVersion = 0;

  // Load history when session is selected
  $effect(() => {
    const label = appState.selectedSessionLabel;
    if (label !== null) {
      const version = ++historyVersion;
      loadSessionHistory(label)
        .then((history) => {
          if (version === historyVersion) {
            sessionHistory = history;
          }
        })
        .catch(() => {
          if (version === historyVersion) {
            sessionHistory = [];
          }
        });
    }
  });
</script>

<div class="flex h-full min-h-0 animate-fade-in">
  <SessionSidebar
    sessions={appState.sessions}
    selectedLabel={appState.selectedSessionLabel}
    onselect={(label) => (appState.selectedSessionLabel = label)}
    oncreate={handleCreate}
    creating={creatingSession}
    {createError}
    loadPersonasFn={listPersonas}
  />

  {#if appState.selectedSession}
    <SessionConsole
      session={appState.selectedSession}
      output={appState.getOutput(appState.selectedSessionLabel!)}
      history={sessionHistory}
      onsend={handleSend}
      onend={handleEnd}
      {onOpenEscalation}
      {sending}
      ending={endingSession === appState.selectedSessionLabel}
    />
  {:else}
    <div class="flex-1 flex items-center justify-center text-muted-foreground">
      <div class="text-center">
        <p class="text-lg mb-2">No session selected</p>
        <p class="text-sm">Select a session from the list or create a new one.</p>
      </div>
    </div>
  {/if}
</div>
