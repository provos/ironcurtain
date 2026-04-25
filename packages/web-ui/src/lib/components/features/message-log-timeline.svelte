<script lang="ts">
  /**
   * Vertical timeline of {@link MessageLogEntry} records.
   *
   * Pure prop-driven (no store access — see `packages/web-ui/CLAUDE.md` layer
   * rules). The parent route is responsible for fetching pages via the
   * `workflows.messageLog` RPC and feeding them in.
   */
  import type { MessageLogEntry } from '$lib/types.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Card } from '$lib/components/ui/card/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import { renderMarkdown } from '$lib/markdown.js';

  let {
    entries,
    loading = false,
    hasMore,
    onLoadOlder,
    maxHeight = '60vh',
  }: {
    entries: readonly MessageLogEntry[];
    loading?: boolean;
    hasMore: boolean;
    onLoadOlder?: () => void;
    /**
     * Cap the timeline scroll viewport. Defaults to `60vh` so a long log does
     * not push the surrounding page off-screen. Pass an empty string or a
     * larger value (e.g. `'100vh'`) to opt out.
     */
    maxHeight?: string;
  } = $props();

  // ------------------------------------------------------------------
  // Variant metadata
  //
  // Maps entry `type` to (badge variant, human label). Re-uses existing
  // `BadgeVariant` tokens — no new ones introduced.
  // ------------------------------------------------------------------
  type VariantMeta = {
    label: string;
    badgeVariant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';
  };

  const VARIANT_META: Record<MessageLogEntry['type'], VariantMeta> = {
    agent_sent: { label: 'Agent sent', badgeVariant: 'default' },
    agent_received: { label: 'Agent received', badgeVariant: 'success' },
    state_transition: { label: 'State', badgeVariant: 'outline' },
    gate_raised: { label: 'Gate raised', badgeVariant: 'secondary' },
    gate_resolved: { label: 'Gate resolved', badgeVariant: 'secondary' },
    error: { label: 'Error', badgeVariant: 'destructive' },
    quota_exhausted: { label: 'Quota exhausted', badgeVariant: 'destructive' },
    agent_retry: { label: 'Retry', badgeVariant: 'warning' },
  };

  // `ts:type` alone is not unique enough: rapid `agent_retry` bursts can emit
  // multiple same-type entries within the same millisecond (orchestrator.ts:1531),
  // which would crash Svelte 5's keyed `{#each}` with `each_key_duplicate`.
  // We assign each entry object a monotonic id via WeakMap and include it in
  // the rendered key. Trade-off: this loses `expanded` state on a full
  // message-log refresh (re-fetched entries are new object references); a
  // backend `seq` field on `MessageLogEntry` would fix that, but a silent
  // expansion reset is far better than a fatal render crash.
  const entryIds = new WeakMap<MessageLogEntry, number>();
  let nextEntryId = 0;

  function entryKey(entry: MessageLogEntry): string {
    let id = entryIds.get(entry);
    if (id === undefined) {
      id = nextEntryId++;
      entryIds.set(entry, id);
    }
    return entry.ts + ':' + entry.type + ':' + String(id);
  }

  let expanded = $state<Set<string>>(new Set());

  function toggleExpanded(key: string): void {
    const next = new Set(expanded);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    expanded = next;
  }

  function isExpanded(key: string): boolean {
    return expanded.has(key);
  }

  // ------------------------------------------------------------------
  // Preview helper for collapsed agent messages.
  // ------------------------------------------------------------------
  const PREVIEW_LIMIT = 120;

  function previewOf(text: string): string {
    if (!text) return '';
    const firstLine = text.split('\n', 1)[0] ?? '';
    if (firstLine.length <= PREVIEW_LIMIT && !text.includes('\n')) {
      return firstLine;
    }
    const candidate = firstLine.length > PREVIEW_LIMIT ? firstLine.slice(0, PREVIEW_LIMIT) : firstLine;
    return candidate + '…';
  }

  // ------------------------------------------------------------------
  // Relative-time helper. No codebase utility exists for this; keep it
  // small and inline rather than introducing a new dependency.
  // ------------------------------------------------------------------
  function formatRelativeTime(iso: string, now: number = Date.now()): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    const deltaSec = Math.round((now - ts) / 1000);
    if (deltaSec < 5) return 'just now';
    if (deltaSec < 60) return `${deltaSec}s ago`;
    const min = Math.round(deltaSec / 60);
    if (min < 60) return `${min}m ago`;
    const hrs = Math.round(min / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function formatAbsoluteTime(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toLocaleString();
  }

  function isAgentMessage(
    entry: MessageLogEntry,
  ): entry is Extract<MessageLogEntry, { type: 'agent_sent' | 'agent_received' }> {
    return entry.type === 'agent_sent' || entry.type === 'agent_received';
  }

  function handleLoadOlder(): void {
    onLoadOlder?.();
  }
</script>

<div data-testid="message-log-timeline" class="space-y-2">
  <div
    data-testid="message-log-scroll"
    class={maxHeight ? 'overflow-y-auto space-y-2 pr-1' : 'space-y-2'}
    style={maxHeight ? `max-height: ${maxHeight}` : undefined}
  >
    {#if entries.length === 0 && !loading}
      <div data-testid="message-log-empty" class="text-sm text-muted-foreground italic px-2 py-6 text-center">
        No message-log entries yet.
      </div>
    {/if}

    {#each entries as entry (entryKey(entry))}
      {@const meta = VARIANT_META[entry.type]}
      {@const key = entryKey(entry)}
      <Card data-testid="message-log-entry" data-entry-type={entry.type} class="px-3 py-2">
        <div class="flex items-baseline gap-2 text-xs text-muted-foreground mb-1">
          <Badge variant={meta.badgeVariant} class="font-mono shrink-0">{meta.label}</Badge>
          <span class="font-mono text-foreground/70">{entry.state}</span>
          <span class="ml-auto" title={formatAbsoluteTime(entry.ts)}>{formatRelativeTime(entry.ts)}</span>
        </div>

        {#if isAgentMessage(entry)}
          {@const isOpen = isExpanded(key)}
          <button
            type="button"
            class="w-full text-left text-sm text-foreground/90 hover:text-foreground transition-colors"
            onclick={() => toggleExpanded(key)}
            data-testid="agent-toggle"
            aria-expanded={isOpen}
          >
            {#if isOpen}
              <div class="prose-markdown" data-testid="agent-full">{@html renderMarkdown(entry.message)}</div>
            {:else}
              <div class="truncate" data-testid="agent-preview">
                <span class="text-[10px] uppercase tracking-wider text-muted-foreground/70 mr-2">{entry.role}</span>
                {previewOf(entry.message)}
              </div>
            {/if}
          </button>
          {#if entry.type === 'agent_received' && entry.verdict}
            <div class="mt-1 text-xs text-muted-foreground">
              verdict: <span class="font-mono text-foreground/80">{entry.verdict}</span>
              {#if entry.confidence}
                · confidence: <span class="font-mono text-foreground/80">{entry.confidence}</span>
              {/if}
            </div>
          {/if}
        {:else if entry.type === 'state_transition'}
          <div class="text-sm font-mono text-foreground/90">
            <span class="text-muted-foreground">{entry.from}</span>
            <span class="mx-1.5 text-muted-foreground">→</span>
            <span>{entry.state}</span>
            <span class="mx-2 text-muted-foreground">/</span>
            <span class="text-foreground/70">{entry.event}</span>
          </div>
        {:else if entry.type === 'gate_raised'}
          <div class="text-sm text-foreground/90">
            <span class="text-muted-foreground">accepted events:</span>
            <span class="font-mono text-foreground/80">{entry.acceptedEvents.join(', ') || '—'}</span>
          </div>
        {:else if entry.type === 'gate_resolved'}
          <div class="text-sm text-foreground/90">
            <span class="text-muted-foreground">resolved with</span>
            <span class="font-mono text-foreground/80">{entry.event}</span>
            {#if entry.prompt}
              <div class="mt-1 text-xs text-muted-foreground italic">{entry.prompt}</div>
            {/if}
          </div>
        {:else if entry.type === 'error'}
          <div class="text-sm text-destructive whitespace-pre-wrap">{entry.error}</div>
          {#if entry.context}
            <div class="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{entry.context}</div>
          {/if}
        {:else if entry.type === 'quota_exhausted'}
          <div class="text-sm text-destructive">
            <span class="text-[10px] uppercase tracking-wider mr-2">{entry.role}</span>
            <span class="whitespace-pre-wrap">{entry.rawMessage}</span>
          </div>
          {#if entry.resetAt}
            <div class="mt-1 text-xs text-muted-foreground">resets at {formatAbsoluteTime(entry.resetAt)}</div>
          {/if}
        {:else if entry.type === 'agent_retry'}
          <div class="text-sm text-warning">
            <span class="text-[10px] uppercase tracking-wider mr-2">{entry.role}</span>
            <span class="font-mono">{entry.reason}</span>
          </div>
          <div class="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{entry.details}</div>
        {/if}
      </Card>
    {/each}
  </div>

  {#if loading}
    <div
      data-testid="message-log-loading"
      class="flex items-center justify-center gap-2 text-xs text-muted-foreground py-3"
    >
      <Spinner size="sm" />
      <span>Loading older entries…</span>
    </div>
  {/if}

  {#if hasMore && !loading}
    <div class="flex justify-center pt-2">
      <Button
        data-testid="message-log-load-older"
        variant="outline"
        size="sm"
        onclick={handleLoadOlder}
        disabled={onLoadOlder == null}
      >
        Load older
      </Button>
    </div>
  {/if}
</div>
