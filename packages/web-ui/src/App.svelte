<script lang="ts" module>
  function formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import {
    appState,
    initConnection,
    connectWithToken,
    resolveEscalation,
    getTheme,
    setTheme,
    type ThemeId,
  } from './lib/stores.svelte.js';
  import Dashboard from './routes/Dashboard.svelte';
  import Sessions from './routes/Sessions.svelte';
  import Escalations from './routes/Escalations.svelte';
  import Jobs from './routes/Jobs.svelte';

  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { DropdownMenu, DropdownMenuItem } from '$lib/components/ui/dropdown-menu/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import EscalationModal from '$lib/components/escalation-modal.svelte';
  import { startFlashTitle } from '$lib/flash-title.js';

  import ShieldCheck from 'phosphor-svelte/lib/ShieldCheck';
  import House from 'phosphor-svelte/lib/House';
  import ChatCircle from 'phosphor-svelte/lib/ChatCircle';
  import Warning from 'phosphor-svelte/lib/Warning';
  import Clock from 'phosphor-svelte/lib/Clock';
  import Palette from 'phosphor-svelte/lib/Palette';
  import Check from 'phosphor-svelte/lib/Check';

  let tokenInput = $state('');
  let currentTheme = $state<ThemeId>('iron');
  let showThemePicker = $state(false);
  let escalationModalOpen = $state(false);
  let stopFlash: (() => void) | null = null;

  // Auto-open the escalation modal when new escalations arrive (unless on the Escalations page),
  // and auto-close when no escalations remain.
  $effect(() => {
    const hasNew = appState.escalationDisplayNumber > appState.escalationDismissedAt;
    const count = appState.pendingEscalations.size;
    const onEscalationsPage = appState.currentView === 'escalations';

    if (count === 0) {
      escalationModalOpen = false;
    } else if (hasNew && !onEscalationsPage) {
      escalationModalOpen = true;
      if (document.hidden) {
        stopFlash?.();
        stopFlash = startFlashTitle('Action Required - Escalation');
      }
    }
  });

  function recordDismissal(): void {
    appState.escalationDismissedAt = appState.escalationDisplayNumber;
    escalationModalOpen = false;
    stopFlash?.();
    stopFlash = null;
  }

  async function resolveEscalationFromModal(
    escalationId: string,
    decision: 'approved' | 'denied',
    whitelistSelection?: number,
  ): Promise<void> {
    try {
      await resolveEscalation(escalationId, decision, whitelistSelection);
    } catch (err) {
      console.error('Failed to resolve escalation from modal:', err);
      throw err;
    }
    // The escalation.resolved event may have already closed the modal via
    // the $effect, but if not (e.g., timing), force a check here.
    if (appState.pendingEscalations.size === 0) {
      escalationModalOpen = false;
    }
  }

  function viewSessionFromModal(label: number): void {
    recordDismissal();
    appState.currentView = 'sessions';
    appState.selectedSessionLabel = label;
  }

  onMount(() => {
    currentTheme = getTheme();
    document.documentElement.setAttribute('data-theme', currentTheme);
    initConnection();
  });

  function handleTokenSubmit(e: Event): void {
    e.preventDefault();
    if (tokenInput.trim()) {
      connectWithToken(tokenInput.trim());
    }
  }

  function switchTheme(theme: ThemeId): void {
    currentTheme = theme;
    setTheme(theme);
    showThemePicker = false;
  }

  const themes: { id: ThemeId; label: string; desc: string }[] = [
    { id: 'iron', label: 'Iron', desc: 'Dark charcoal + amber' },
    { id: 'daylight', label: 'Daylight', desc: 'Warm light + teal' },
    { id: 'midnight', label: 'Midnight', desc: 'Deep navy + blue' },
  ];

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: House },
    { id: 'sessions', label: 'Sessions', icon: ChatCircle },
    { id: 'escalations', label: 'Escalations', icon: Warning },
    { id: 'jobs', label: 'Jobs', icon: Clock },
  ] as const;
</script>

{#if !appState.connected && !appState.hasToken}
  <div class="flex items-center justify-center min-h-screen relative overflow-hidden">
    <div class="absolute inset-0 bg-gradient-to-br from-background via-background to-primary/5"></div>
    <div class="relative z-10 w-full max-w-sm mx-4 animate-fade-in">
      <div class="text-center mb-8">
        <div
          class="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-primary/10 border border-primary/20 mb-4"
        >
          <ShieldCheck size={28} class="text-primary" weight="duotone" />
        </div>
        <h1 class="text-2xl font-semibold tracking-tight">IronCurtain</h1>
        <p class="text-sm text-muted-foreground mt-1">Secure Agent Runtime</p>
      </div>

      <div class="bg-card border border-border rounded-xl p-6 shadow-lg shadow-black/5">
        <p class="text-sm text-muted-foreground mb-5">Paste the auth token from the daemon output to connect.</p>
        <form onsubmit={handleTokenSubmit}>
          <Input type="text" bind:value={tokenInput} placeholder="Auth token..." class="font-mono" />
          <Button type="submit" class="w-full mt-3">Connect</Button>
        </form>
      </div>

      <div class="flex justify-center gap-1 mt-6">
        {#each themes as t (t.id)}
          <Button
            variant="ghost"
            size="sm"
            onclick={() => switchTheme(t.id)}
            class={currentTheme === t.id ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground'}
          >
            {t.label}
          </Button>
        {/each}
      </div>
    </div>
  </div>
{:else}
  <div class="flex h-screen theme-transition overflow-hidden">
    <nav class="w-56 bg-sidebar border-r border-border flex flex-col shrink-0">
      <div class="px-4 py-4 border-b border-border">
        <div class="flex items-center gap-2.5">
          <div class="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
            <ShieldCheck size={16} class="text-primary" weight="duotone" />
          </div>
          <div>
            <span class="text-sm font-semibold tracking-tight">IronCurtain</span>
            <div data-testid="connection-status" class="flex items-center gap-1.5 mt-0.5">
              <span class="inline-flex rounded-full h-2 w-2 {appState.connected ? 'bg-success' : 'bg-destructive'}"
              ></span>
              <span class="text-[10px] text-muted-foreground uppercase tracking-wider">
                {appState.connected ? 'Live' : 'Offline'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="flex-1 py-2 px-2 space-y-0.5">
        {#each navItems as item}
          <button
            onclick={() => (appState.currentView = item.id)}
            aria-current={appState.currentView === item.id ? 'page' : undefined}
            class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all
              {appState.currentView === item.id
              ? 'bg-accent text-accent-foreground font-medium shadow-sm'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
          >
            <item.icon size={16} class="shrink-0" />
            {item.label}
            {#if item.id === 'escalations' && appState.escalationCount > 0}
              <Badge
                variant="destructive"
                class="ml-auto px-1.5 font-mono font-semibold min-w-[18px] text-center text-[10px] leading-none"
              >
                {appState.escalationCount}
              </Badge>
            {/if}
            {#if item.id === 'sessions' && appState.activeSessionCount > 0}
              <span class="ml-auto text-[10px] font-mono text-muted-foreground">
                {appState.activeSessionCount}
              </span>
            {/if}
          </button>
        {/each}
      </div>

      {#if appState.daemonStatus}
        <div class="px-4 py-3 border-t border-border text-[11px] text-muted-foreground space-y-1.5 font-mono">
          <div class="flex justify-between">
            <span>Uptime</span>
            <span class="text-foreground/70">{formatUptime(appState.daemonStatus.uptimeSeconds)}</span>
          </div>
          <div class="flex justify-between">
            <span>Jobs</span>
            <span class="text-foreground/70"
              >{appState.daemonStatus.jobs.enabled}/{appState.daemonStatus.jobs.total}</span
            >
          </div>
          {#if appState.daemonStatus.signalConnected}
            <div class="flex justify-between">
              <span>Signal</span>
              <span class="text-success">connected</span>
            </div>
          {/if}
        </div>
      {/if}

      <div class="px-2 py-2 border-t border-border">
        <DropdownMenu bind:open={showThemePicker} align="top-left" contentClass="w-48" class="w-full">
          {#snippet trigger()}
            <button
              onclick={() => (showThemePicker = !showThemePicker)}
              class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-all"
            >
              <Palette size={16} class="shrink-0" />
              Theme: {themes.find((t) => t.id === currentTheme)?.label}
            </button>
          {/snippet}
          {#each themes as t (t.id)}
            <DropdownMenuItem active={currentTheme === t.id} onclick={() => switchTheme(t.id)} class="py-2.5">
              <div class="flex items-center justify-between w-full">
                <div>
                  <div class="font-medium">{t.label}</div>
                  <div class="text-[11px] text-muted-foreground">{t.desc}</div>
                </div>
                {#if currentTheme === t.id}
                  <Check size={16} class="text-primary shrink-0" />
                {/if}
              </div>
            </DropdownMenuItem>
          {/each}
        </DropdownMenu>
      </div>
    </nav>

    <main class="flex-1 min-h-0 overflow-hidden">
      {#if appState.currentView === 'dashboard'}
        <Dashboard />
      {:else if appState.currentView === 'sessions'}
        <Sessions onOpenEscalation={() => (escalationModalOpen = true)} />
      {:else if appState.currentView === 'escalations'}
        <Escalations />
      {:else if appState.currentView === 'jobs'}
        <Jobs />
      {/if}
    </main>

    <EscalationModal
      open={escalationModalOpen}
      escalations={appState.pendingEscalations}
      onclose={recordDismissal}
      onresolve={resolveEscalationFromModal}
      onviewsession={viewSessionFromModal}
    />
  </div>
{/if}
