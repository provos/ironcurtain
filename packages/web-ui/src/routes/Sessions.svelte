<script lang="ts">
  import { untrack, tick } from 'svelte';
  import {
    appState,
    createSession,
    sendSessionMessage,
    endSession,
    loadSessionHistory,
    listPersonas,
    attachPty,
    detachPty,
    sendPtyInput,
    sendPtyResize,
    registerPtySink,
    unregisterPtySink,
  } from '../lib/stores.svelte.js';
  import type { ConversationTurn } from '../lib/types.js';

  import SessionSidebar from '$lib/components/features/session-sidebar.svelte';
  import SessionConsole from '$lib/components/features/session-console.svelte';
  import TerminalConsole from '$lib/components/features/terminal-console.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';

  let { onOpenEscalation }: { onOpenEscalation?: () => void } = $props();

  let sending = $state(false);
  let sessionHistory = $state<ConversationTurn[]>([]);

  // Bound TerminalConsole instance for the selected web-pty session.
  let terminalRef = $state<TerminalConsole | undefined>(undefined);

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

  // Load history when a turn-based session is selected. D2 guard: a web-pty
  // session has no turn history/budget/diagnostics, so skip the fetch entirely
  // (selecting it must not fire those RPCs). The kind is read untracked so this
  // effect still depends only on the selected label, not on every session update.
  $effect(() => {
    const label = appState.selectedSessionLabel;
    if (label === null) return;
    const kind = untrack(() => appState.sessions.get(label)?.source.kind);
    if (kind === 'web-pty') return;
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
  });

  // The selected session's label iff it is a web-pty terminal, else null.
  // A primitive derived: it flips null -> N when a freshly created pty session
  // first lands in the map, but does NOT change on unrelated session updates
  // (budget/status), so the attach effect never churns attach/detach.
  const selectedPtyLabel = $derived(
    appState.selectedSession?.source.kind === 'web-pty' ? appState.selectedSession.label : null,
  );

  // PTY attach lifecycle. Install this component's sink BEFORE attaching (the
  // daemon sends a one-shot pty_replay on attach), then focus the terminal.
  // Detach + unregister on switch/unmount.
  $effect(() => {
    const label = selectedPtyLabel;
    if (label === null) return;

    registerPtySink(label, {
      write: (dataB64) => terminalRef?.write(dataB64),
      reset: (snapshotB64) => terminalRef?.reset(snapshotB64),
    });
    attachPty(label)
      .then(() => terminalRef?.focus())
      .catch((err) => console.error('Failed to attach PTY:', err));

    return () => {
      unregisterPtySink(label);
      detachPty(label).catch(() => {});
    };
  });

  // Return focus to the terminal after the escalation overlay is dismissed
  // (the modal, owned by App.svelte, steals focus). `escalationDismissedAt` is
  // bumped by App on dismiss.
  $effect(() => {
    void appState.escalationDismissedAt;
    if (selectedPtyLabel === null) return;
    tick().then(() => terminalRef?.focus());
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
    {#if appState.selectedSession.source.kind === 'web-pty'}
      {@const ptySession = appState.selectedSession}
      <div class="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div class="px-6 py-3 border-b border-border flex items-center justify-between bg-card/50">
          <div class="flex items-center gap-2">
            <span class="font-mono font-semibold">#{ptySession.label}</span>
            {#if ptySession.persona}
              <Badge variant="default">{ptySession.persona}</Badge>
            {/if}
            <Badge variant="secondary">terminal</Badge>
          </div>
          <div class="flex items-center gap-4">
            <span class="text-xs text-muted-foreground hidden sm:inline">Resizing affects all viewers</span>
            <Button variant="destructive" size="sm" loading={endingSession === ptySession.label} onclick={handleEnd}>
              {endingSession === ptySession.label ? 'Ending' : 'End'}
            </Button>
          </div>
        </div>

        <!-- Remount a fresh terminal per label so switching PTY sessions never
             leaks buffer state from the previous one. -->
        {#key ptySession.label}
          <TerminalConsole
            bind:this={terminalRef}
            oninput={(dataB64) => sendPtyInput(ptySession.label, dataB64)}
            onresize={(cols, rows) => sendPtyResize(ptySession.label, cols, rows)}
          />
        {/key}
      </div>
    {:else}
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
    {/if}
  {:else}
    <div class="flex-1 flex items-center justify-center text-muted-foreground">
      <div class="text-center">
        <p class="text-lg mb-2">No session selected</p>
        <p class="text-sm">Select a session from the list or create a new one.</p>
      </div>
    </div>
  {/if}
</div>
