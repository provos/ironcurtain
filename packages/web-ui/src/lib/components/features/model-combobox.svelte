<script lang="ts">
  import { cn } from '$lib/utils.js';
  import { tick } from 'svelte';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';

  // Presentational OpenRouter slug picker. Free-typing is ALWAYS allowed — the
  // dropdown only assists; the authoritative hard-block lives at save time in the
  // route. This component holds NO store/RPC dependency (features layer rule); the
  // route owns the fetch and feeds `models`/`source`/`loading`/`error` down.
  let {
    value = $bindable(''),
    models,
    source,
    loading,
    error,
    invalid = false,
    placeholder,
    testid,
  }: {
    value?: string;
    models: readonly string[];
    source: 'live' | 'cache' | 'bundled';
    loading: boolean;
    error: boolean;
    invalid?: boolean;
    placeholder?: string;
    testid: string;
  } = $props();

  // Cap rendered rows for DOM cost; the popover height caps visually (~8 rows) and
  // scrolls beyond that.
  const MAX_OPTIONS = 50;

  let inputEl = $state<HTMLInputElement>();
  let popoverEl = $state<HTMLDivElement>();
  let open = $state(false);
  let activeIndex = $state(-1);
  let pos = $state({ top: 0, left: 0, width: 0 });

  // ARIA ids are per-instance (derived from the unique testid) so multiple
  // comboboxes never share an id; the data-testids stay fixed per the contract.
  const listboxId = $derived(`${testid}-listbox`);
  const optionId = (i: number): string => `${testid}-option-${i}`;

  const filtered = $derived.by(() => {
    const q = value.trim().toLowerCase();
    const matches = q.length === 0 ? models : models.filter((m) => m.toLowerCase().includes(q));
    return matches.slice(0, MAX_OPTIONS);
  });

  const activeDescendant = $derived(open && activeIndex >= 0 ? optionId(activeIndex) : undefined);

  function updatePosition(): void {
    if (!inputEl) return;
    const r = inputEl.getBoundingClientRect();
    pos = { top: r.bottom + 4, left: r.left, width: r.width };
  }

  function openPopover(): void {
    open = true;
    updatePosition();
  }

  function closePopover(): void {
    open = false;
    activeIndex = -1;
  }

  function commit(slug: string): void {
    // Focus stays on the input throughout (Enter never blurs; option mousedown is
    // prevented), so we must NOT re-focus here — that would re-fire onfocus and
    // reopen the popover we just closed.
    value = slug;
    closePopover();
  }

  function scrollActiveIntoView(): void {
    void tick().then(() => {
      if (activeIndex < 0) return;
      // getElementById (no CSS.escape / no CSS global dependency) — the popover is
      // portaled to <body>, so a document-level lookup finds the active option.
      // scrollIntoView is absent under jsdom, so feature-detect before calling.
      const el = document.getElementById(optionId(activeIndex));
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    });
  }

  function moveActive(delta: number): void {
    const n = filtered.length;
    if (n === 0) {
      activeIndex = -1;
      return;
    }
    const base = activeIndex < 0 ? (delta > 0 ? -1 : 0) : activeIndex;
    activeIndex = (base + delta + n) % n;
    scrollActiveIntoView();
  }

  function onInput(): void {
    // `value` is already updated via bind:value; typing (re)opens and resets the
    // active option so a bare Enter commits the typed text, not a stale highlight.
    if (!open) open = true;
    activeIndex = -1;
    updatePosition();
  }

  function onKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) openPopover();
        else moveActive(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) openPopover();
        else moveActive(-1);
        return;
      case 'Enter':
        if (!open) return;
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < filtered.length) commit(filtered[activeIndex]);
        else closePopover(); // keep the typed value as-is
        return;
      case 'Escape':
        if (!open) return;
        // Swallow so the enclosing Modal does not also close on this Escape.
        e.stopPropagation();
        closePopover();
        return;
      case 'Tab':
        // Commit typed text and close; let focus move naturally.
        if (open) closePopover();
        return;
    }
  }

  // Teleport the popover to <body> so the max-h-[70vh] overflow-y-auto editor
  // modal cannot clip a bottom-row dropdown. Positioned fixed against the input
  // rect, kept in sync on scroll/resize; closed on outside pointer-down.
  function portal(node: HTMLElement): { destroy: () => void } {
    document.body.appendChild(node);
    return {
      destroy: () => node.remove(),
    };
  }

  $effect(() => {
    if (!open) return;
    updatePosition();
    const reposition = (): void => updatePosition();
    const onDocPointerDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (t && (inputEl?.contains(t) || popoverEl?.contains(t))) return;
      closePopover();
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    document.addEventListener('mousedown', onDocPointerDown, true);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('mousedown', onDocPointerDown, true);
    };
  });
</script>

<div class="relative">
  <input
    bind:this={inputEl}
    bind:value
    {placeholder}
    data-testid={testid}
    role="combobox"
    aria-expanded={open}
    aria-controls={open ? listboxId : undefined}
    aria-autocomplete="list"
    aria-activedescendant={activeDescendant}
    aria-invalid={invalid ? true : undefined}
    autocomplete="off"
    class={cn(
      'w-full px-3 py-2.5 bg-background border rounded-lg text-sm transition-all',
      'focus:outline-none focus:ring-2 placeholder:text-muted-foreground/50 disabled:opacity-50',
      invalid
        ? 'border-destructive ring-2 ring-destructive/40 focus:ring-destructive/40 focus:border-destructive'
        : 'border-border focus:ring-ring/40 focus:border-ring',
      loading ? 'pr-8' : '',
    )}
    oninput={onInput}
    onfocus={openPopover}
    onkeydown={onKeydown}
  />
  {#if loading}
    <span class="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
      <Spinner size="xs" />
    </span>
  {/if}
</div>

{#if error}
  <p class="mt-1 text-[11px] text-muted-foreground">Couldn't load model list — validation is best-effort.</p>
{:else if source === 'bundled' && !loading}
  <div class="mt-1">
    <Badge variant="warning" data-testid="model-combobox-source" title="unverified slugs allowed">
      Partial list (offline)
    </Badge>
  </div>
{/if}

{#if open}
  <div
    use:portal
    bind:this={popoverEl}
    class="fixed z-[60] rounded-lg border border-border bg-card shadow-xl overflow-hidden animate-fade-in"
    style="top: {pos.top}px; left: {pos.left}px; width: {pos.width}px;"
  >
    {#if loading}
      <div class="px-3 py-2 text-sm text-muted-foreground flex items-center gap-2">
        <Spinner size="xs" /> Loading models…
      </div>
    {:else if filtered.length === 0}
      <div class="px-3 py-2 text-sm text-muted-foreground">
        {#if value.trim().length > 0}
          No matching models — press Enter to use “{value.trim()}” as-is
        {:else}
          No models available
        {/if}
      </div>
    {:else}
      <ul id={listboxId} role="listbox" data-testid="model-combobox-listbox" class="max-h-64 overflow-y-auto py-1">
        {#each filtered as slug, i (slug)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id={optionId(i)}
            role="option"
            aria-selected={i === activeIndex}
            data-testid={`model-combobox-option-${i}`}
            class={cn(
              'px-3 py-1.5 text-sm cursor-pointer font-mono',
              i === activeIndex ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-muted',
            )}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => commit(slug)}
          >
            {slug}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
