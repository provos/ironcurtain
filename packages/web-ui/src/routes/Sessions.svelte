<script lang="ts">
  import { tick } from 'svelte';
  import {
    appState,
    createSession,
    endSession,
    listPersonas,
    attachPty,
    detachPty,
    sendPtyInput,
    sendPtyResize,
    sendPtyPrompt,
    registerPtySink,
    unregisterPtySink,
    connectPtyTerminal,
    disconnectPtyTerminal,
    getModelProviders,
  } from '../lib/stores.svelte.js';
  import type { CreateSessionOptions } from '../lib/types.js';

  import SessionSidebar from '$lib/components/features/session-sidebar.svelte';
  import TerminalConsole from '$lib/components/features/terminal-console.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  // Bound TerminalConsole instance for the selected web-pty session.
  let terminalRef = $state<TerminalConsole | undefined>(undefined);

  // Session creation state
  let creatingSession = $state(false);
  let createError = $state('');

  // Session end state
  let endingSession = $state<number | null>(null);

  // Trusted-message bar state (web-pty sessions). A prompt is PLAIN text sent
  // via `sessions.ptyPrompt`; the daemon records it as trusted user-context
  // (authorizing auto-approval) — distinct from raw keystrokes, which are never
  // trusted. This is the only browser path to auto-approval.
  let promptText = $state('');
  let promptError = $state('');
  let sendingPrompt = $state(false);

  async function handleSendPrompt(): Promise<void> {
    const label = selectedPtyLabel;
    if (label === null) return;
    const text = promptText.trim();
    if (!text) return;
    sendingPrompt = true;
    promptError = '';
    try {
      await sendPtyPrompt(label, text);
      promptText = '';
    } catch (err) {
      promptError = err instanceof Error ? err.message : String(err);
    } finally {
      sendingPrompt = false;
    }
  }

  async function loadProviderProfiles(): Promise<string[]> {
    const providers = await getModelProviders();
    // The reserved 'native' profile is default routing; the dropdown's empty
    // "Default" option already covers it (omitting providerProfileName), so it
    // is not listed as an explicit choice.
    return Object.keys(providers.profiles).filter((name) => name !== 'native');
  }

  async function handleCreate(opts: CreateSessionOptions): Promise<void> {
    if (creatingSession) return;

    if (!appState.daemonStatus) {
      createError = 'Daemon status is not available yet. Wait for the daemon connection to finish, then try again.';
      return;
    }

    if (appState.daemonStatus.sessionMode === undefined) {
      createError =
        'Web sessions require daemon session-mode support. Upgrade or restart the daemon, then refresh this page.';
      return;
    }

    if (appState.daemonStatus.sessionMode !== 'container') {
      createError = 'Web sessions require container mode. Restart the daemon with container mode enabled.';
      return;
    }
    creatingSession = true;
    createError = '';
    try {
      const result = await createSession(opts);
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

  // The selected session's label iff it is a web-pty terminal, else null.
  // A primitive derived: it flips null -> N when a freshly created pty session
  // first lands in the map, but does NOT change on unrelated session updates
  // (budget/status), so the attach effect never churns attach/detach.
  const selectedPtyLabel = $derived(
    appState.selectedSession?.source.kind === 'web-pty' ? appState.selectedSession.label : null,
  );

  // PTY attach lifecycle. Register the buffering sink BEFORE attaching (the
  // daemon sends a one-shot pty_replay on attach, which can beat the terminal's
  // mount): the sink buffers frames until the mounted TerminalConsole connects
  // its live handle via `onready`, so a replay is never dropped. Detach +
  // unregister on switch/unmount.
  $effect(() => {
    const label = selectedPtyLabel;
    if (label === null) return;

    registerPtySink(label);
    attachPty(label).catch((err) => console.error('Failed to attach PTY:', err));

    return () => {
      disconnectPtyTerminal(label);
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
    loadProviderProfilesFn={loadProviderProfiles}
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
            onready={(handle) => {
              connectPtyTerminal(ptySession.label, handle);
              terminalRef?.focus();
            }}
            oninput={(dataB64) => sendPtyInput(ptySession.label, dataB64)}
            onresize={(cols, rows) => sendPtyResize(ptySession.label, cols, rows)}
          />
        {/key}

        <!-- Trusted-message bar: docked below the terminal, subordinate to it.
             Plain text (NOT keystrokes) sent via `sessions.ptyPrompt` — the daemon
             records it as trusted user-context (authorizes auto-approval). -->
        <div class="px-4 py-3 border-t border-border bg-card/50 shrink-0">
          <form
            class="flex items-center gap-2"
            onsubmit={(e) => {
              e.preventDefault();
              handleSendPrompt();
            }}
          >
            <Input
              data-testid="pty-prompt-input"
              bind:value={promptText}
              placeholder="Send a trusted message..."
              class="flex-1 py-1.5"
              disabled={ptySession.status !== 'ready' || sendingPrompt}
            />
            <Button
              type="submit"
              data-testid="pty-prompt-send"
              size="sm"
              loading={sendingPrompt}
              disabled={!promptText.trim() || ptySession.status !== 'ready'}
            >
              Send
            </Button>
          </form>
          <div class="mt-1 text-xs text-muted-foreground">Trusted message — authorizes auto-approval</div>
          {#if promptError}
            <div class="mt-1 text-xs text-destructive" data-testid="pty-prompt-error">{promptError}</div>
          {/if}
        </div>
      </div>
    {:else}
      {@const session = appState.selectedSession}
      <div class="flex-1 flex items-center justify-center text-muted-foreground">
        <div class="max-w-sm text-center px-6">
          <div class="text-sm font-semibold text-foreground mb-1">Unsupported session type</div>
          <div class="text-sm">
            Session <span class="font-mono">#{session.label}</span> is
            <span class="font-mono">{session.source.kind}</span>. The web UI only supports container terminal sessions.
          </div>
          <Button
            variant="outline"
            size="sm"
            class="mt-4"
            loading={endingSession === session.label}
            onclick={handleEnd}
          >
            {endingSession === session.label ? 'Ending' : 'End session'}
          </Button>
        </div>
      </div>
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
