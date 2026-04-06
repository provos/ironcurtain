<script lang="ts">
  import type { PendingEscalation } from '../types.js';
  import { Modal } from '$lib/components/ui/modal/index.js';
  import EscalationCard from './escalation-card.svelte';

  let {
    open,
    escalations,
    onclose,
    onresolve,
    onviewsession,
  }: {
    open: boolean;
    escalations: Map<string, PendingEscalation>;
    onclose: () => void;
    onresolve: (id: string, decision: 'approved' | 'denied', whitelistSelection?: number) => Promise<void>;
    onviewsession: (label: number) => void;
  } = $props();

  let activeTabId = $state<string | null>(null);
  let resolvingIds = $state<Set<string>>(new Set());

  // Keep sorted by displayNumber so tabs are stable
  let sortedEscalations = $derived([...escalations.values()].sort((a, b) => a.displayNumber - b.displayNumber));

  // Auto-select first tab if active tab is gone
  $effect(() => {
    if (sortedEscalations.length === 0) {
      activeTabId = null;
    } else if (activeTabId === null || !escalations.has(activeTabId)) {
      activeTabId = sortedEscalations[0].escalationId;
    }
  });

  let activeEscalation = $derived(activeTabId ? (escalations.get(activeTabId) ?? null) : null);

  async function handleResolve(
    id: string,
    decision: 'approved' | 'denied',
    whitelistSelection?: number,
  ): Promise<void> {
    resolvingIds = new Set([...resolvingIds, id]);
    try {
      await onresolve(id, decision, whitelistSelection);
    } finally {
      const next = new Set(resolvingIds);
      next.delete(id);
      resolvingIds = next;
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (!open) return;

    // Skip keyboard shortcuts when focus is in an input or textarea
    const target = e.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      navigateTab(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      navigateTab(1);
    } else if (e.key === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (activeTabId && !resolvingIds.has(activeTabId)) {
        handleResolve(activeTabId, 'approved');
      }
    } else if (e.key === 'd' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (activeTabId && !resolvingIds.has(activeTabId)) {
        handleResolve(activeTabId, 'denied');
      }
    }
  }

  function navigateTab(direction: number): void {
    if (sortedEscalations.length <= 1) return;
    const currentIndex = sortedEscalations.findIndex((e) => e.escalationId === activeTabId);
    const nextIndex = (currentIndex + direction + sortedEscalations.length) % sortedEscalations.length;
    activeTabId = sortedEscalations[nextIndex].escalationId;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<Modal {open} {onclose} title="Pending Escalations">
  {#if sortedEscalations.length > 1}
    <div class="flex border-b border-border overflow-x-auto scroll-snap-x" role="tablist">
      {#each sortedEscalations as esc (esc.escalationId)}
        <button
          role="tab"
          aria-selected={esc.escalationId === activeTabId}
          onclick={() => (activeTabId = esc.escalationId)}
          class="shrink-0 scroll-snap-start px-4 py-2 text-xs font-mono border-b-2 transition-colors
            {esc.escalationId === activeTabId
            ? 'border-primary text-primary'
            : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'}"
        >
          {esc.serverName}/{esc.toolName}
        </button>
      {/each}
    </div>
  {/if}

  <div class="max-h-[60vh] overflow-y-auto">
    {#if activeEscalation}
      {#key activeEscalation.escalationId}
        <EscalationCard
          escalation={activeEscalation}
          loading={resolvingIds.has(activeEscalation.escalationId)}
          onapprove={(whitelistSelection) =>
            handleResolve(activeEscalation!.escalationId, 'approved', whitelistSelection)}
          ondeny={() => handleResolve(activeEscalation!.escalationId, 'denied')}
          onviewsession={(label) => {
            onclose();
            onviewsession(label);
          }}
        />
      {/key}
    {/if}
  </div>

  <div class="px-5 py-2 border-t border-border text-[10px] text-muted-foreground flex items-center gap-4">
    <span><kbd class="px-1 py-0.5 bg-muted rounded text-[10px]">a</kbd> approve</span>
    <span><kbd class="px-1 py-0.5 bg-muted rounded text-[10px]">d</kbd> deny</span>
    {#if sortedEscalations.length > 1}
      <span
        ><kbd class="px-1 py-0.5 bg-muted rounded text-[10px]">&larr;</kbd><kbd
          class="px-1 py-0.5 bg-muted rounded text-[10px]">&rarr;</kbd
        > switch</span
      >
    {/if}
    <span><kbd class="px-1 py-0.5 bg-muted rounded text-[10px]">Esc</kbd> dismiss</span>
  </div>
</Modal>
