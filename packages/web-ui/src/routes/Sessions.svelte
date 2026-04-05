<script lang="ts">
  import { appState, getWsClient } from '../lib/stores.svelte.js';
  import type { ConversationTurn, PersonaListItem, OutputLine } from '../lib/types.js';
  import { renderMarkdown } from '../lib/markdown.js';
  import { tick } from 'svelte';

  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { DropdownMenu, DropdownMenuItem } from '$lib/components/ui/dropdown-menu/index.js';

  import Plus from 'phosphor-svelte/lib/Plus';
  import CaretRight from 'phosphor-svelte/lib/CaretRight';

  let messageInput = $state('');
  let sending = $state(false);
  let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);
  let sessionHistory = $state<ConversationTurn[]>([]);

  // Session creation state
  let creatingSession = $state(false);
  let showPersonaPicker = $state(false);
  let personas = $state<PersonaListItem[]>([]);
  let loadingPersonas = $state(false);
  let createError = $state('');

  // Session end state
  let endingSession = $state<number | null>(null);

  // Auto-scroll reference
  let outputContainer: HTMLDivElement | undefined = $state(undefined);

  // Collapsible group expanded state (keyed by group index)
  let expandedGroups = $state<Set<number>>(new Set());

  // Types for grouped output
  type SingleEntry = { kind: 'single'; line: OutputLine };
  type CollapsibleGroup = { kind: 'group'; lines: OutputLine[]; summary: string };
  type OutputEntry = SingleEntry | CollapsibleGroup;

  /** Whether a line kind should be grouped into collapsible sections. */
  function isCollapsibleKind(kind: OutputLine['kind']): boolean {
    return kind === 'thinking' || kind === 'tool_call';
  }

  /** Build a summary label for a collapsible group of lines. */
  function buildGroupSummary(lines: OutputLine[]): string {
    const toolCalls = lines.filter((l) => l.kind === 'tool_call').length;
    const thinking = lines.filter((l) => l.kind === 'thinking').length;
    const parts: string[] = [];
    if (thinking > 0) parts.push(`${thinking} thinking`);
    if (toolCalls > 0) parts.push(`${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`);
    return parts.join(', ');
  }

  /** Group consecutive thinking/tool_call lines into collapsible sections. */
  function groupOutputLines(lines: OutputLine[]): OutputEntry[] {
    const entries: OutputEntry[] = [];
    let pendingGroup: OutputLine[] = [];

    function flushGroup(): void {
      if (pendingGroup.length > 0) {
        entries.push({
          kind: 'group',
          lines: pendingGroup,
          summary: buildGroupSummary(pendingGroup),
        });
        pendingGroup = [];
      }
    }

    for (const line of lines) {
      if (isCollapsibleKind(line.kind)) {
        pendingGroup.push(line);
      } else {
        flushGroup();
        entries.push({ kind: 'single', line });
      }
    }
    flushGroup();
    return entries;
  }

  function toggleGroup(index: number): void {
    const next = new Set(expandedGroups);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    expandedGroups = next;
  }

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
    if (textareaEl) textareaEl.style.height = 'auto';

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

  function autoResizeTextarea(): void {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = `${textareaEl.scrollHeight}px`;
  }

  function handleTextareaKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(e);
    }
  }

  async function loadHistory(label: number): Promise<void> {
    try {
      sessionHistory = await getWsClient().request<ConversationTurn[]>('sessions.history', { label });
    } catch {
      sessionHistory = [];
    }
  }

  // Load history when session is selected; reset expanded groups
  $effect(() => {
    if (appState.selectedSessionLabel !== null) {
      loadHistory(appState.selectedSessionLabel);
      expandedGroups = new Set();
    }
  });

  // Auto-scroll output container when new content arrives
  $effect(() => {
    const label = appState.selectedSessionLabel;
    if (label === null) return;
    // Access the output array to register as a reactive dependency
    const output = appState.getOutput(label);
    const _len = output.length;
    // Scroll after the DOM updates
    tick().then(() => {
      if (outputContainer) {
        outputContainer.scrollTop = outputContainer.scrollHeight;
      }
    });
  });
</script>

<div class="flex h-full min-h-0 animate-fade-in">
  <div class="w-64 border-r border-border bg-sidebar flex flex-col shrink-0 min-h-0">
    <div class="px-4 py-3 border-b border-border flex items-center justify-between">
      <h3 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Sessions</h3>
      <DropdownMenu bind:open={showPersonaPicker} align="bottom-right" contentClass="w-56">
        {#snippet trigger()}
          <Button
            variant="default"
            size="sm"
            loading={creatingSession}
            onclick={openPersonaPicker}
          >
            {#if !creatingSession}
              <Plus size={14} weight="bold" />
            {/if}
            {creatingSession ? 'Starting...' : 'New'}
          </Button>
        {/snippet}
        <DropdownMenuItem onclick={() => createSession()} class="border-b border-border">
          <div class="font-medium">Default</div>
          <div class="text-xs text-muted-foreground">No persona</div>
        </DropdownMenuItem>
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
            <DropdownMenuItem
              onclick={() => createSession(persona.name)}
              disabled={!persona.compiled}
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
            </DropdownMenuItem>
          {/each}
        {/if}
      </DropdownMenu>
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
            <span class="text-xs text-muted-foreground">
              {session.source.kind}{#if session.persona}&nbsp;&middot; {session.persona}{/if}
            </span>
          </div>
          <div class="text-xs text-muted-foreground mt-1">
            {session.turnCount} turns &middot; {session.budget.estimatedCostUsd.toFixed(2)}
          </div>
          {#if session.hasPendingEscalation}
            <Badge variant="destructive" class="mt-1">
              escalation
            </Badge>
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
  <div class="flex-1 flex flex-col min-h-0 overflow-hidden">
    {#if appState.selectedSession}
      <div class="px-6 py-3 border-b border-border flex items-center justify-between bg-card/50">
        <div>
          <span class="font-mono font-semibold">#{appState.selectedSession.label}</span>
          {#if appState.selectedSession.persona}
            <Badge variant="default" class="ml-2">
              {appState.selectedSession.persona}
            </Badge>
          {/if}
          <Badge
            variant={appState.selectedSession.status === 'processing' ? 'warning'
                   : appState.selectedSession.status === 'ready' ? 'success'
                   : 'secondary'}
            class="ml-2"
          >
            {#if appState.selectedSession.status === 'processing'}
              <span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse"></span>
            {:else if appState.selectedSession.status === 'ready'}
              <span class="w-1.5 h-1.5 rounded-full bg-success"></span>
            {/if}
            {appState.selectedSession.status}
          </Badge>
        </div>
        <div class="flex items-center gap-4">
          <span class="text-xs text-muted-foreground">
            {appState.selectedSession.budget.estimatedCostUsd.toFixed(2)} &middot;
            {appState.selectedSession.budget.stepCount} steps &middot;
            {Math.round(appState.selectedSession.budget.elapsedSeconds)}s
          </span>
          <Button
            variant="destructive"
            size="sm"
            loading={endingSession === appState.selectedSessionLabel}
            onclick={() => endSession(appState.selectedSessionLabel!)}
          >
            {endingSession === appState.selectedSessionLabel ? 'Ending' : 'End'}
          </Button>
        </div>
      </div>

      <div bind:this={outputContainer} class="flex-1 overflow-auto p-5 space-y-2 font-mono text-sm">
        {#each groupOutputLines(appState.getOutput(appState.selectedSessionLabel!)) as entry, groupIdx}
          {#if entry.kind === 'single'}
            {@const line = entry.line}
            <div class="{line.kind === 'user' ? 'text-blue-400' :
                         line.kind === 'assistant' ? 'text-foreground' :
                         line.kind === 'error' ? 'text-destructive' :
                         'text-muted-foreground'}">
              {#if line.kind === 'user'}
                <span class="text-muted-foreground select-none">&gt; </span>{line.text}
              {:else}
                <div class="prose-markdown">{@html renderMarkdown(line.text)}</div>
              {/if}
            </div>
          {:else}
            <!-- Collapsible group for thinking/tool_call lines -->
            <div class="border border-border/50 rounded-md overflow-hidden">
              <button
                onclick={() => toggleGroup(groupIdx)}
                class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground
                       hover:bg-accent/30 transition-colors select-none"
              >
                <CaretRight
                  size={12}
                  class="transition-transform {expandedGroups.has(groupIdx) ? 'rotate-90' : ''}"
                />
                <span class="italic">{entry.summary}</span>
              </button>
              {#if expandedGroups.has(groupIdx)}
                <div class="px-3 pb-2 space-y-1">
                  {#each entry.lines as line}
                    <div class="{line.kind === 'tool_call' ? 'text-muted-foreground italic' :
                                 line.kind === 'thinking' ? 'text-yellow-400 animate-pulse' :
                                 'text-muted-foreground'} text-xs">
                      {#if line.kind === 'tool_call'}
                        <span class="select-none">[tool] </span>{line.text}
                      {:else}
                        {line.text}
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        {/each}
        {#if appState.getOutput(appState.selectedSessionLabel!).length === 0 && sessionHistory.length > 0}
          {#each sessionHistory as turn}
            <div class="text-blue-400">
              <span class="text-muted-foreground select-none">&gt; </span>{turn.userMessage}
            </div>
            <div class="prose-markdown">{@html renderMarkdown(turn.assistantResponse)}</div>
          {/each}
        {/if}
      </div>

      <!-- Input area -->
      <form onsubmit={sendMessage} class="border-t border-border p-4 flex items-end gap-2">
        <textarea
          bind:this={textareaEl}
          bind:value={messageInput}
          oninput={autoResizeTextarea}
          onkeydown={handleTextareaKeydown}
          placeholder="Send a message..."
          disabled={sending || appState.selectedSession.status !== 'ready'}
          rows="1"
          class="flex-1 font-mono max-h-[150px] overflow-auto resize-none rounded-md border border-border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        ></textarea>
        <Button
          type="submit"
          loading={sending}
          disabled={!messageInput.trim() || appState.selectedSession.status !== 'ready'}
        >
          {sending ? 'Sending' : 'Send'}
        </Button>
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
