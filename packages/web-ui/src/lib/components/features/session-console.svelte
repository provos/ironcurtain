<script lang="ts">
  import type { SessionDto, OutputLine, ConversationTurn } from '../../types.js';
  import type { CollapsibleGroup } from '../../output-grouping.js';
  import { groupOutputLines } from '../../output-grouping.js';
  import { renderMarkdown } from '../../markdown.js';
  import { tick } from 'svelte';

  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';

  import CaretRight from 'phosphor-svelte/lib/CaretRight';
  import Warning from 'phosphor-svelte/lib/Warning';

  let {
    session,
    output,
    history,
    onsend,
    onend,
    onOpenEscalation,
    sending,
    ending,
  }: {
    session: SessionDto;
    output: OutputLine[];
    history: ConversationTurn[];
    onsend: (text: string) => void;
    onend: () => void;
    onOpenEscalation?: () => void;
    sending: boolean;
    ending: boolean;
  } = $props();

  let messageInput = $state('');
  let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);
  let outputContainer: HTMLDivElement | undefined = $state(undefined);

  // Collapsible group expanded state
  let expandedGroups = $state<Set<string>>(new Set());

  let groupedOutput = $derived(groupOutputLines(output));

  function groupKey(group: CollapsibleGroup): string {
    return `${group.lines[0].timestamp}:${group.lines[0].kind}`;
  }

  function toggleGroup(key: string): void {
    const next = new Set(expandedGroups);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    expandedGroups = next;
  }

  // Reset expanded groups when session changes
  $effect(() => {
    const _label = session.label;
    expandedGroups = new Set();
  });

  // Auto-scroll when new output arrives
  $effect(() => {
    const _len = output.length;
    tick().then(() => {
      if (outputContainer) {
        outputContainer.scrollTop = outputContainer.scrollHeight;
      }
    });
  });

  function handleSubmit(e: Event): void {
    e.preventDefault();
    if (!messageInput.trim() || sending) return;
    const text = messageInput.trim();
    messageInput = '';
    if (textareaEl) textareaEl.style.height = 'auto';
    onsend(text);
  }

  function autoResizeTextarea(): void {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = `${textareaEl.scrollHeight}px`;
  }

  function handleTextareaKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }
</script>

<div class="flex-1 flex flex-col min-h-0 overflow-hidden">
  <div class="px-6 py-3 border-b border-border flex items-center justify-between bg-card/50">
    <div>
      <span class="font-mono font-semibold">#{session.label}</span>
      {#if session.persona}
        <Badge variant="default" class="ml-2">
          {session.persona}
        </Badge>
      {/if}
      <Badge
        variant={session.status === 'processing' ? 'warning' : session.status === 'ready' ? 'success' : 'secondary'}
        class="ml-2"
      >
        {#if session.status === 'processing'}
          <span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse"></span>
        {:else if session.status === 'ready'}
          <span class="w-1.5 h-1.5 rounded-full bg-success"></span>
        {/if}
        {session.status}
      </Badge>
    </div>
    <div class="flex items-center gap-4">
      <span class="text-xs text-muted-foreground">
        {session.budget.estimatedCostUsd.toFixed(2)} &middot;
        {session.budget.stepCount} steps &middot;
        {Math.round(session.budget.elapsedSeconds)}s
      </span>
      <Button variant="destructive" size="sm" loading={ending} onclick={onend}>
        {ending ? 'Ending' : 'End'}
      </Button>
    </div>
  </div>

  <div
    bind:this={outputContainer}
    data-testid="session-output"
    class="flex-1 overflow-auto p-5 space-y-2 font-mono text-sm"
  >
    {#each groupedOutput as entry, i (i)}
      {#if entry.kind === 'single'}
        {@const line = entry.line}
        {#if line.kind === 'escalation'}
          <button
            onclick={() => onOpenEscalation?.()}
            class="w-full text-left px-3 py-2 rounded-md bg-warning/10 border border-warning/30
                   text-warning hover:bg-warning/20 transition-colors cursor-pointer flex items-center gap-2"
          >
            <Warning size={14} />
            <span>{line.text}</span>
            <span class="ml-auto text-xs opacity-70">Click to review</span>
          </button>
        {:else}
          <div
            class={line.kind === 'user'
              ? 'text-blue-400'
              : line.kind === 'assistant'
                ? 'text-foreground'
                : line.kind === 'error'
                  ? 'text-destructive'
                  : 'text-muted-foreground'}
          >
            {#if line.kind === 'user'}
              <span class="text-muted-foreground select-none">&gt; </span>{line.text}
            {:else}
              <div class="prose-markdown">{@html renderMarkdown(line.text)}</div>
            {/if}
          </div>
        {/if}
      {:else}
        <!-- Collapsible group for thinking/tool_call lines -->
        {@const gKey = groupKey(entry)}
        <div class="border border-border/50 rounded-md overflow-hidden">
          <button
            onclick={() => toggleGroup(gKey)}
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground
                   hover:bg-accent/30 transition-colors select-none"
          >
            <CaretRight size={12} class="transition-transform {expandedGroups.has(gKey) ? 'rotate-90' : ''}" />
            <span class="italic">{entry.summary}</span>
          </button>
          {#if expandedGroups.has(gKey)}
            <div class="px-3 pb-2 space-y-1">
              {#each entry.lines as line, j (j)}
                <div
                  class="{line.kind === 'tool_call'
                    ? 'text-muted-foreground italic'
                    : line.kind === 'thinking'
                      ? 'text-yellow-400 animate-pulse'
                      : 'text-muted-foreground'} text-xs"
                >
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
    {#if groupedOutput.length === 0 && history.length > 0}
      {#each history as turn (turn.turnNumber)}
        <div class="text-blue-400">
          <span class="text-muted-foreground select-none">&gt; </span>{turn.userMessage}
        </div>
        <div class="prose-markdown">{@html renderMarkdown(turn.assistantResponse)}</div>
      {/each}
    {/if}
  </div>

  <!-- Input area -->
  <form onsubmit={handleSubmit} class="border-t border-border p-4 flex items-end gap-2">
    <textarea
      bind:this={textareaEl}
      bind:value={messageInput}
      oninput={autoResizeTextarea}
      onkeydown={handleTextareaKeydown}
      placeholder="Send a message..."
      disabled={sending || session.status !== 'ready'}
      rows="1"
      class="flex-1 font-mono max-h-[150px] overflow-auto resize-none rounded-md border border-border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
    ></textarea>
    <Button type="submit" loading={sending} disabled={!messageInput.trim() || session.status !== 'ready'}>
      {sending ? 'Sending' : 'Send'}
    </Button>
  </form>
</div>
