<script lang="ts">
  import { onMount } from 'svelte';
  import { appState, initConnection, connectWithToken, getWsClient } from './lib/stores.svelte.js';
  import Dashboard from './routes/Dashboard.svelte';
  import Sessions from './routes/Sessions.svelte';
  import Escalations from './routes/Escalations.svelte';
  import Jobs from './routes/Jobs.svelte';

  let tokenInput = $state('');

  onMount(() => {
    initConnection();
  });

  function handleTokenSubmit(e: Event): void {
    e.preventDefault();
    if (tokenInput.trim()) {
      connectWithToken(tokenInput.trim());
    }
  }

  const navItems = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'escalations', label: 'Escalations' },
    { id: 'jobs', label: 'Jobs' },
  ] as const;
</script>

{#if !appState.connected && !appState.hasToken}
  <!-- Token prompt -->
  <div class="flex items-center justify-center min-h-screen">
    <div class="bg-card border border-border rounded-lg p-8 max-w-md w-full mx-4">
      <h1 class="text-xl font-semibold mb-2">IronCurtain Web UI</h1>
      <p class="text-muted-foreground text-sm mb-6">
        Paste the auth token from the daemon's stderr output to connect.
      </p>
      <form onsubmit={handleTokenSubmit}>
        <input
          type="text"
          bind:value={tokenInput}
          placeholder="Paste token here..."
          class="w-full px-3 py-2 bg-background border border-border rounded-md text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <button
          type="submit"
          class="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Connect
        </button>
      </form>
    </div>
  </div>
{:else}
  <div class="flex min-h-screen">
    <!-- Sidebar -->
    <nav class="w-56 border-r border-border bg-card flex flex-col">
      <div class="p-4 border-b border-border">
        <h1 class="text-lg font-semibold">IronCurtain</h1>
        <div class="flex items-center gap-2 mt-1">
          <span class="w-2 h-2 rounded-full {appState.connected ? 'bg-green-500' : 'bg-red-500'}"></span>
          <span class="text-xs text-muted-foreground">
            {appState.connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      <div class="flex-1 py-2">
        {#each navItems as item}
          <button
            onclick={() => appState.currentView = item.id}
            class="w-full text-left px-4 py-2 text-sm transition-colors
              {appState.currentView === item.id
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
          >
            {item.label}
            {#if item.id === 'escalations' && appState.escalationCount > 0}
              <span class="ml-2 px-1.5 py-0.5 text-xs bg-destructive text-destructive-foreground rounded-full">
                {appState.escalationCount}
              </span>
            {/if}
            {#if item.id === 'sessions'}
              <span class="ml-2 text-xs text-muted-foreground">
                ({appState.activeSessionCount})
              </span>
            {/if}
          </button>
        {/each}
      </div>

      {#if appState.daemonStatus}
        <div class="p-4 border-t border-border text-xs text-muted-foreground space-y-1">
          <div>Uptime: {formatUptime(appState.daemonStatus.uptimeSeconds)}</div>
          <div>Jobs: {appState.daemonStatus.jobs.enabled}/{appState.daemonStatus.jobs.total} enabled</div>
          {#if appState.daemonStatus.signalConnected}
            <div>Signal: connected</div>
          {/if}
        </div>
      {/if}
    </nav>

    <!-- Main content -->
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
