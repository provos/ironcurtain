<script lang="ts">
  /**
   * Ambient HUD — two-corner telemetry for the workflow theater (§E.3).
   *
   * Top-left: workflow name + round count + connection indicator glyph
   * Top-right: tokens/sec + active model name
   *
   * Bottom corners are v1.1 (§F.3). On narrow viewports the bottom panels
   * collided with the graph — deferred until the responsive story is
   * designed explicitly.
   *
   * Per the features/ layer rule, this component takes all its inputs as
   * props — it does not reach into stores.svelte.ts or the singleton
   * tokenStreamStore. The theater (its parent) reads the intensity EMA
   * and feeds tokens/sec down. Composition, not coupling.
   */

  interface Props {
    workflowName: string;
    currentRound?: number;
    totalRounds?: number;
    connectionStatus: 'connected' | 'reconnecting' | 'disconnected';
    /** Tokens/sec display — passed in, not read from the store. Route composes. */
    tokensPerSec: number;
    /** Current model name (short display form). */
    modelName: string | null;
  }

  const { workflowName, currentRound, totalRounds, connectionStatus, tokensPerSec, modelName }: Props = $props();

  // Connection indicator uses `●` for connected, `○` for disconnected. The
  // design spec ("amber if reconnecting") is satisfied by the CSS class; the
  // glyph itself stays filled while reconnecting so the panel doesn't get
  // flickery on brief drops.
  const connectionGlyph = $derived(connectionStatus === 'disconnected' ? '○' : '●');

  const connectionClass = $derived(
    connectionStatus === 'connected'
      ? 'hud-dot hud-dot--ok'
      : connectionStatus === 'reconnecting'
        ? 'hud-dot hud-dot--reconnect'
        : 'hud-dot hud-dot--down',
  );

  // Round-number formatting. We avoid showing a partial string like "3/" or
  // "/20" when only one half is available — the viewer should see either a
  // full fraction or nothing.
  const roundText = $derived(
    currentRound != null && totalRounds != null && totalRounds > 0 ? `${currentRound}/${totalRounds}` : null,
  );

  // Tokens/sec display. The EMA produces fractional values; HUD rounds to a
  // whole number so the digit doesn't thrash every frame. Negative/NaN are
  // clamped to 0 (the EMA should never produce these, but guard anyway).
  const tokensText = $derived(
    Number.isFinite(tokensPerSec) && tokensPerSec > 0 ? Math.round(tokensPerSec).toString() : '0',
  );
</script>

<div class="ambient-hud-top-left" aria-hidden="true" data-testid="ambient-hud-top-left">
  <span class={connectionClass} title="Connection: {connectionStatus}">{connectionGlyph}</span>
  <span class="hud-label">{workflowName}</span>
  {#if roundText}
    <span class="hud-sep">·</span>
    <span class="hud-value">{roundText}</span>
  {/if}
</div>

<div class="ambient-hud-top-right" aria-hidden="true" data-testid="ambient-hud-top-right">
  <span class="hud-value">{tokensText}</span>
  <span class="hud-label">tok/s</span>
  {#if modelName}
    <span class="hud-sep">·</span>
    <span class="hud-label">{modelName}</span>
  {/if}
</div>

<style>
  /* Shared panel chrome. 11px monospace at 70% opacity with a thin
     20%-primary border — reads as "readout" without drawing the eye. */
  .ambient-hud-top-left,
  .ambient-hud-top-right {
    position: absolute;
    top: 12px;
    z-index: 30;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    font-feature-settings: 'tnum' 1;
    line-height: 1;
    color: hsl(var(--foreground));
    background: transparent;
    border: 1px solid hsl(var(--primary) / 0.2);
    border-radius: 3px;
    opacity: 0.7;
    pointer-events: none;
    white-space: nowrap;
  }

  .ambient-hud-top-left {
    left: 12px;
  }
  .ambient-hud-top-right {
    right: 12px;
  }

  .hud-label {
    color: hsl(var(--muted-foreground));
  }
  .hud-value {
    color: hsl(var(--foreground));
    font-weight: 600;
  }
  .hud-sep {
    color: hsl(var(--muted-foreground) / 0.6);
  }

  /* Connection dot. Three states, same glyph choice at two of them — color
     carries the meaning. Amber pulse during reconnect so a stalled connection
     is visible without being alarming. */
  .hud-dot {
    display: inline-block;
    font-size: 10px;
    line-height: 1;
  }
  .hud-dot--ok {
    color: hsl(var(--primary));
  }
  .hud-dot--reconnect {
    color: hsl(38 92% 55%); /* amber — independent of theme primary */
    animation: hud-dot-blink 1s ease-in-out infinite;
  }
  .hud-dot--down {
    color: hsl(var(--muted-foreground));
  }

  @keyframes hud-dot-blink {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .hud-dot--reconnect {
      animation: none;
      opacity: 0.8;
    }
  }
</style>
