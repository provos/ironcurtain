<script lang="ts">
  import { untrack } from 'svelte';
  import type { NetworkSettingsDto } from '$lib/types.js';
  import {
    getNetworkSettings,
    setNetworkSettings,
    appState,
    connectionGeneration,
    configChangedGeneration,
  } from '$lib/stores.svelte.js';
  import { Card, CardHeader, CardTitle, CardContent } from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';

  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let saved = $state(false);
  let baseline = $state<NetworkSettingsDto | null>(null);
  let allowPrivateNetworkAccess = $state(false);
  const mutationAllowed = $derived(appState.daemonStatus?.allowPolicyMutation === true);
  const dirty = $derived(baseline !== null && allowPrivateNetworkAccess !== baseline.allowPrivateNetworkAccess);

  function apply(dto: NetworkSettingsDto): void {
    baseline = dto;
    allowPrivateNetworkAccess = dto.allowPrivateNetworkAccess;
  }

  let requestVersion = 0;
  async function load(): Promise<void> {
    const version = ++requestVersion;
    loading = baseline === null;
    error = '';
    try {
      const dto = await getNetworkSettings();
      if (version === requestVersion && (!baseline || (!dirty && !saving))) apply(dto);
    } catch (err) {
      if (version === requestVersion) error = err instanceof Error ? err.message : String(err);
    } finally {
      if (version === requestVersion) loading = false;
    }
  }

  $effect(() => {
    void connectionGeneration.value;
    void configChangedGeneration.value;
    untrack(() => {
      if (!dirty && !saving) void load();
    });
    return () => {
      requestVersion++;
    };
  });

  async function save(): Promise<void> {
    if (!mutationAllowed || !dirty || saving) return;
    requestVersion++;
    saving = true;
    error = '';
    saved = false;
    try {
      apply(await setNetworkSettings({ allowPrivateNetworkAccess }));
      saved = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }
</script>

<Card data-testid="network-settings">
  <CardHeader><CardTitle>Network</CardTitle></CardHeader>
  <CardContent>
    {#if loading}
      <div class="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading network settings…</div>
    {:else}
      <div class="space-y-4">
        {#if error}<Alert variant="destructive">{error}</Alert>{/if}
        {#if baseline}
          <label class="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              class="mt-1 accent-primary"
              bind:checked={allowPrivateNetworkAccess}
              disabled={!mutationAllowed || saving}
              onchange={() => (saved = false)}
              data-testid="allow-private-network-access"
            />
            <span>
              Allow private network addresses
              <span class="block text-xs text-muted-foreground mt-1">
                Allow approved domains to resolve to private network addresses. Domain approval is still required.
                Metadata and link-local addresses stay blocked. Applies to new container sessions.
              </span>
            </span>
          </label>
          {#if mutationAllowed}
            <Button data-testid="save-network-settings" onclick={save} disabled={!dirty} loading={saving}>
              Save network settings
            </Button>
            {#if saved && !dirty}<p role="status" class="text-xs text-success">Network settings saved</p>{/if}
          {:else}
            <p class="text-xs text-muted-foreground">Configuration changes are disabled on this daemon.</p>
          {/if}
        {:else}
          <Button variant="outline" onclick={() => void load()}>Retry loading network settings</Button>
        {/if}
      </div>
    {/if}
  </CardContent>
</Card>
