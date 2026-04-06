<script lang="ts">
  import type { EscalationDto } from '../types.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Card } from '$lib/components/ui/card/index.js';

  let {
    escalation,
    loading = false,
    onapprove,
    ondeny,
    onviewsession,
  }: {
    escalation: EscalationDto;
    loading?: boolean;
    onapprove: (whitelistSelection?: number) => void;
    ondeny: () => void;
    onviewsession?: (label: number) => void;
  } = $props();

  let selectedWhitelist = $state<number | undefined>(undefined);

  function toggleWhitelist(index: number): void {
    selectedWhitelist = selectedWhitelist === index ? undefined : index;
  }

  function handleApprove(): void {
    onapprove(selectedWhitelist);
  }
</script>

<Card
  class="overflow-hidden transition-all animate-fade-in
  {loading ? 'opacity-50 border-border' : 'border-destructive/20 shadow-sm shadow-destructive/5'}"
>
  <div class="px-5 py-4 flex items-start justify-between gap-4">
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <span class="font-mono font-semibold text-sm"
          >{escalation.serverName}<span class="text-muted-foreground">/</span>{escalation.toolName}</span
        >
      </div>
      <div class="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
        <Badge variant="secondary" class="font-mono">#{escalation.sessionLabel}</Badge>
        <span>{escalation.sessionSource.kind}</span>
        <span>&middot;</span>
        <span>{new Date(escalation.receivedAt).toLocaleTimeString()}</span>
        {#if onviewsession}
          <span>&middot;</span>
          <button class="text-primary hover:underline" onclick={() => onviewsession(escalation.sessionLabel)}>
            View Session
          </button>
        {/if}
      </div>
    </div>
    <div class="flex gap-2 shrink-0">
      <Button variant="success" size="sm" {loading} onclick={handleApprove}>
        {#if !loading}Approve{/if}
      </Button>
      <Button variant="destructive" size="sm" {loading} onclick={ondeny}>
        {#if !loading}Deny{/if}
      </Button>
    </div>
  </div>

  <div class="px-5 pb-4 space-y-3">
    <div>
      <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Reason</div>
      <div class="text-sm bg-muted/40 rounded-lg px-3 py-2.5 text-foreground/90">{escalation.reason}</div>
    </div>

    <div>
      <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Arguments</div>
      <pre
        class="text-xs font-mono bg-muted/40 rounded-lg px-3 py-2.5 overflow-auto max-h-48 text-foreground/80">{JSON.stringify(
          escalation.arguments,
          null,
          2,
        )}</pre>
    </div>

    {#if escalation.context && Object.keys(escalation.context).length > 0}
      <div>
        <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Context</div>
        <pre
          class="text-xs font-mono bg-muted/40 rounded-lg px-3 py-2.5 overflow-auto max-h-32 text-foreground/80">{JSON.stringify(
            escalation.context,
            null,
            2,
          )}</pre>
      </div>
    {/if}

    {#if escalation.whitelistCandidates && escalation.whitelistCandidates.length > 0}
      <div>
        <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
          Whitelist (optional)
        </div>
        <div class="space-y-1.5">
          {#each escalation.whitelistCandidates as candidate, idx}
            {@const isSelected = selectedWhitelist === idx}
            <button
              onclick={() => toggleWhitelist(idx)}
              disabled={loading}
              class="w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors
                {isSelected
                ? 'bg-primary/15 border border-primary/40 text-foreground'
                : 'bg-muted/40 border border-transparent hover:bg-muted/60 text-foreground/80'}
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span
                class="shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center
                {isSelected ? 'border-primary' : 'border-muted-foreground/40'}"
              >
                {#if isSelected}
                  <span class="w-2 h-2 rounded-full bg-primary"></span>
                {/if}
              </span>
              <span class="text-xs">{candidate.description}</span>
            </button>
          {/each}
        </div>
        <p class="text-[10px] text-muted-foreground/60 mt-1.5">
          Select a rule to auto-approve similar future requests.
        </p>
      </div>
    {/if}
  </div>
</Card>
