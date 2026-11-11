<script lang="ts">
  import type { SessionDto } from '../../types.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import Plus from 'phosphor-svelte/lib/Plus';
  import CaretDoubleLeft from 'phosphor-svelte/lib/CaretDoubleLeft';
  import CaretDoubleRight from 'phosphor-svelte/lib/CaretDoubleRight';
  import ClockCounterClockwise from 'phosphor-svelte/lib/ClockCounterClockwise';

  let {
    sessions,
    selectedLabel,
    onselect,
    onnew,
    creating,
    collapsed = false,
    ontogglecollapse,
    onresumeopen,
    resumeDisabledReason,
  }: {
    sessions: Map<number, SessionDto>;
    selectedLabel: number | null;
    onselect: (label: number) => void;
    /** Opens the New session dialog. */
    onnew: () => void;
    creating: boolean;
    /** Collapsed to a narrow rail so the terminal gets the width. */
    collapsed?: boolean;
    ontogglecollapse?: () => void;
    onresumeopen?: () => void;
    resumeDisabledReason?: string;
  } = $props();

  const sessionList = $derived([...sessions.values()]);

  function statusDotClass(session: SessionDto): string {
    if (session.hasPendingEscalation) return 'bg-destructive';
    if (session.status === 'stopping') return 'bg-warning';
    return 'bg-success';
  }

  const iconButtonClass =
    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:opacity-50';
</script>

{#if collapsed}
  <div
    data-testid="session-rail"
    class="flex w-full shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-sidebar px-2 py-1.5 md:w-12 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-b-0 md:border-r md:px-0 md:py-2"
  >
    <button
      data-testid="sidebar-expand"
      type="button"
      class={iconButtonClass}
      aria-label="Expand session list"
      title="Expand session list"
      onclick={ontogglecollapse}
    >
      <CaretDoubleRight size={14} />
    </button>
    <button
      data-testid="session-new"
      type="button"
      class="{iconButtonClass} border border-border"
      aria-label="New session"
      title="New session"
      onclick={onnew}
    >
      <Plus size={14} />
    </button>
    {#each sessionList as session (session.label)}
      <button
        data-testid="session-rail-item-{session.label}"
        type="button"
        aria-label="Session #{session.label}"
        aria-current={selectedLabel === session.label ? 'true' : undefined}
        title="#{session.label}{session.persona ? ` · ${session.persona}` : ''}"
        class="relative inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md px-1 font-mono text-xs
          {selectedLabel === session.label
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'}"
        onclick={() => onselect(session.label)}
      >
        {session.label}
        <span class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full {statusDotClass(session)}"></span>
      </button>
    {/each}
    {#if onresumeopen}
      <button
        data-testid="resume-open"
        type="button"
        class="{iconButtonClass} md:mt-auto"
        aria-label="Resume previous session"
        title={resumeDisabledReason ?? 'Resume previous session'}
        disabled={creating || Boolean(resumeDisabledReason)}
        onclick={onresumeopen}
      >
        <ClockCounterClockwise size={14} />
      </button>
    {/if}
  </div>
{:else}
  <div
    data-testid="session-sidebar"
    class="flex max-h-[46dvh] min-h-0 w-full shrink-0 flex-col border-b border-border bg-sidebar md:max-h-none md:w-60 md:border-b-0 md:border-r"
  >
    <div class="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
      <h3 class="flex-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Sessions</h3>
      <button
        data-testid="session-new"
        type="button"
        class="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-accent/40"
        onclick={onnew}
      >
        <Plus size={12} />
        New
      </button>
      {#if ontogglecollapse}
        <button
          data-testid="sidebar-collapse"
          type="button"
          class={iconButtonClass}
          aria-label="Collapse session list"
          title="Collapse session list"
          onclick={ontogglecollapse}
        >
          <CaretDoubleLeft size={14} />
        </button>
      {/if}
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if creating}
        <div class="animate-pulse border-b border-border bg-accent/20 px-3 py-2 text-sm">
          <div class="flex items-center gap-2">
            <span
              class="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
            ></span>
            <span class="font-mono text-muted-foreground">Starting…</span>
          </div>
        </div>
      {/if}
      {#each sessionList as session (session.label)}
        <button
          data-testid="session-item-{session.label}"
          onclick={() => onselect(session.label)}
          class="w-full border-b border-border px-3 py-2 text-left text-sm transition-colors
            {selectedLabel === session.label ? 'bg-accent' : 'hover:bg-accent/30'}"
        >
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 shrink-0 rounded-full {statusDotClass(session)}" aria-hidden="true"></span>
            <span class="font-mono font-medium">#{session.label}</span>
            <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {session.persona ?? session.source.kind}
            </span>
            {#if session.hasPendingEscalation}
              <Badge variant="destructive" class="px-1.5 text-[10px]">escalation</Badge>
            {/if}
          </div>
          {#if session.status === 'stopping'}
            <div
              data-testid="session-stopping-status"
              class="ml-4 mt-0.5 inline-flex items-center gap-1.5 text-xs text-warning"
              aria-hidden={selectedLabel === session.label ? 'true' : undefined}
            >
              <span
                class="h-3 w-3 animate-spin rounded-full border-2 border-warning/30 border-t-warning"
                aria-hidden="true"
              ></span>
              Stopping…
            </div>
          {/if}
        </button>
      {/each}
      {#if sessions.size === 0 && !creating}
        <div class="p-4 text-center text-sm text-muted-foreground">No active sessions</div>
      {/if}
    </div>

    {#if onresumeopen}
      <div class="shrink-0 border-t border-border px-3 py-2">
        <button
          data-testid="resume-open"
          type="button"
          class="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={creating || Boolean(resumeDisabledReason)}
          title={resumeDisabledReason}
          aria-describedby={resumeDisabledReason ? 'resume-disabled-reason' : undefined}
          onclick={onresumeopen}
        >
          <ClockCounterClockwise size={14} />
          Resume previous…
        </button>
        {#if resumeDisabledReason}
          <p id="resume-disabled-reason" class="mt-1 text-xs text-muted-foreground">{resumeDisabledReason}</p>
        {/if}
      </div>
    {/if}
  </div>
{/if}
