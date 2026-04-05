<script lang="ts">
  import { onMount } from 'svelte';
  import {
    appState,
    initConnection,
    connectWithToken,
    getTheme,
    setTheme,
    type ThemeId,
  } from './lib/stores.svelte.js';
  import Dashboard from './routes/Dashboard.svelte';
  import Sessions from './routes/Sessions.svelte';
  import Escalations from './routes/Escalations.svelte';
  import Jobs from './routes/Jobs.svelte';

  let tokenInput = $state('');
  let currentTheme = $state<ThemeId>('iron');
  let showThemePicker = $state(false);

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
    { id: 'dashboard', label: 'Dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
    { id: 'sessions', label: 'Sessions', icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
    { id: 'escalations', label: 'Escalations', icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z' },
    { id: 'jobs', label: 'Jobs', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
  ] as const;
</script>

{#if !appState.connected && !appState.hasToken}
  <div class="flex items-center justify-center min-h-screen relative overflow-hidden">
    <div class="absolute inset-0 bg-gradient-to-br from-background via-background to-primary/5"></div>
    <div class="relative z-10 w-full max-w-sm mx-4 animate-fade-in">
      <div class="text-center mb-8">
        <div class="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-primary/10 border border-primary/20 mb-4">
          <svg viewBox="0 0 24 24" class="w-7 h-7 text-primary" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
        </div>
        <h1 class="text-2xl font-semibold tracking-tight">IronCurtain</h1>
        <p class="text-sm text-muted-foreground mt-1">Secure Agent Runtime</p>
      </div>

      <div class="bg-card border border-border rounded-xl p-6 shadow-lg shadow-black/5">
        <p class="text-sm text-muted-foreground mb-5">
          Paste the auth token from the daemon output to connect.
        </p>
        <form onsubmit={handleTokenSubmit}>
          <input
            type="text"
            bind:value={tokenInput}
            placeholder="Auth token..."
            class="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm font-mono
                   focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring
                   placeholder:text-muted-foreground/50 transition-all"
          />
          <button
            type="submit"
            class="w-full mt-3 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium
                   hover:brightness-110 active:scale-[0.98] transition-all"
          >
            Connect
          </button>
        </form>
      </div>

      <div class="flex justify-center gap-1 mt-6">
        {#each themes as t (t.id)}
          <button
            onclick={() => switchTheme(t.id)}
            class="px-2.5 py-1 text-xs rounded-md transition-all
              {currentTheme === t.id
                ? 'bg-primary/15 text-primary font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'}"
          >
            {t.label}
          </button>
        {/each}
      </div>
    </div>
  </div>
{:else}
  <div class="flex min-h-screen theme-transition">
    <nav class="w-56 bg-sidebar border-r border-border flex flex-col shrink-0">
      <div class="px-4 py-4 border-b border-border">
        <div class="flex items-center gap-2.5">
          <div class="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
            <svg viewBox="0 0 24 24" class="w-4 h-4 text-primary" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <div>
            <span class="text-sm font-semibold tracking-tight">IronCurtain</span>
            <div class="flex items-center gap-1.5 mt-0.5">
              <span class="relative flex h-2 w-2">
                {#if appState.connected}
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
                {:else}
                  <span class="relative inline-flex rounded-full h-2 w-2 bg-destructive"></span>
                {/if}
              </span>
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
            onclick={() => appState.currentView = item.id}
            class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all
              {appState.currentView === item.id
                ? 'bg-accent text-accent-foreground font-medium shadow-sm'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
          >
            <svg viewBox="0 0 24 24" class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d={item.icon} />
            </svg>
            {item.label}
            {#if item.id === 'escalations' && appState.escalationCount > 0}
              <span class="ml-auto px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-destructive text-destructive-foreground rounded-full min-w-[18px] text-center leading-none">
                {appState.escalationCount}
              </span>
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
            <span class="text-foreground/70">{appState.daemonStatus.jobs.enabled}/{appState.daemonStatus.jobs.total}</span>
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
        <div class="relative">
          <button
            onclick={() => showThemePicker = !showThemePicker}
            class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-all"
          >
            <svg viewBox="0 0 24 24" class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
            </svg>
            Theme: {themes.find(t => t.id === currentTheme)?.label}
          </button>
          {#if showThemePicker}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="fixed inset-0 z-10" onclick={() => showThemePicker = false} onkeydown={() => {}}></div>
            <div class="absolute bottom-full left-2 mb-1 z-20 w-48 bg-card border border-border rounded-lg shadow-xl overflow-hidden animate-fade-in">
              {#each themes as t (t.id)}
                <button
                  onclick={() => switchTheme(t.id)}
                  class="w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center justify-between
                    {currentTheme === t.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50 text-foreground'}"
                >
                  <div>
                    <div class="font-medium">{t.label}</div>
                    <div class="text-[11px] text-muted-foreground">{t.desc}</div>
                  </div>
                  {#if currentTheme === t.id}
                    <svg viewBox="0 0 24 24" class="w-4 h-4 text-primary shrink-0" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </nav>

    <main class="flex-1 overflow-auto">
      {#if appState.currentView === 'dashboard'}
        <Dashboard />
      {:else if appState.currentView === 'sessions'}
        <Sessions />
      {:else if appState.currentView === 'escalations'}
        <Escalations />
      {:else if appState.currentView === 'jobs'}
        <Jobs />
      {/if}
    </main>
  </div>
{/if}

<script lang="ts" module>
  function formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }
</script>
