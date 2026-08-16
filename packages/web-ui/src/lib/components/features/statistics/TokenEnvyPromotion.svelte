<script lang="ts">
  import Check from 'phosphor-svelte/lib/Check';
  import Copy from 'phosphor-svelte/lib/Copy';
  import { Card } from '$lib/components/ui/card/index.js';

  const COMMAND = 'npx tokenenvy';
  const COPY_FEEDBACK_MS = 2_000;

  let copied = $state(false);
  let copyTimeout: ReturnType<typeof setTimeout> | undefined;

  async function copyCommand(): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(COMMAND);
      copied = true;
      if (copyTimeout) clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => {
        copied = false;
        copyTimeout = undefined;
      }, COPY_FEEDBACK_MS);
    } catch {
      // Clipboard access is optional. The command remains selectable.
    }
  }

  $effect(() => {
    return () => {
      if (copyTimeout) clearTimeout(copyTimeout);
    };
  });
</script>

<Card class="token-envy-promotion" role="region" aria-labelledby="token-envy-promotion-title">
  <div class="brand-mark" aria-hidden="true">T</div>
  <div class="promotion-copy">
    <p class="eyebrow">Companion analytics</p>
    <h2 id="token-envy-promotion-title">More detail for your regular Claude Code sessions</h2>
    <p>
      Token Envy analyzes local Claude Code transcripts for mix-adjusted trends, daily distributions, and richer refusal
      outcomes. Prompts stay on your computer.
    </p>
  </div>
  <div class="promotion-actions">
    <button type="button" class="command" aria-label="Copy npx tokenenvy" onclick={copyCommand}>
      <code>{COMMAND}</code>
      <span aria-live="polite">
        {#if copied}
          <Check size={14} weight="bold" aria-hidden="true" /> Copied
        {:else}
          <Copy size={14} aria-hidden="true" /> Copy
        {/if}
      </span>
    </button>
    <a href="https://github.com/provos/tokenenvy" target="_blank" rel="noreferrer"
      >Learn more <span aria-hidden="true">↗</span></a
    >
  </div>
</Card>

<style>
  :global(.token-envy-promotion) {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 1rem;
    min-width: 0;
    padding: 1rem 1.1rem;
    border-color: hsl(8 78% 60% / 0.35);
    background: radial-gradient(circle at 88% 20%, hsl(8 78% 60% / 0.09), transparent 25rem), hsl(var(--card));
  }
  .brand-mark {
    display: grid;
    width: 2.25rem;
    height: 2.25rem;
    place-items: center;
    border-radius: 0.65rem;
    background: hsl(8 86% 66%);
    color: hsl(15 30% 9%);
    font-size: 1rem;
    font-weight: 850;
    box-shadow: 0 0 0 4px hsl(8 78% 60% / 0.09);
  }
  .promotion-copy {
    min-width: 0;
  }
  .eyebrow {
    margin: 0 0 0.15rem;
    color: hsl(var(--muted-foreground));
    font-size: 0.61rem;
    font-weight: 750;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  h2 {
    margin: 0;
    font-size: 0.93rem;
    letter-spacing: -0.015em;
  }
  .promotion-copy > p:last-child {
    max-width: 51rem;
    margin: 0.3rem 0 0;
    color: hsl(var(--muted-foreground));
    font-size: 0.74rem;
    line-height: 1.5;
  }
  .promotion-actions {
    display: flex;
    align-items: center;
    gap: 0.7rem;
  }
  .command {
    display: inline-flex;
    align-items: center;
    gap: 0.8rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid hsl(var(--border));
    border-radius: 0.55rem;
    background: hsl(var(--background) / 0.7);
    color: hsl(var(--foreground));
    white-space: nowrap;
  }
  .command:hover {
    border-color: hsl(8 78% 60% / 0.65);
    background: hsl(8 78% 60% / 0.06);
  }
  .command:focus-visible,
  a:focus-visible {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 2px;
  }
  code {
    font-size: 0.76rem;
    font-weight: 650;
  }
  .command span {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: hsl(var(--muted-foreground));
    font-size: 0.65rem;
  }
  a {
    color: hsl(var(--foreground));
    font-size: 0.72rem;
    font-weight: 650;
    text-decoration: none;
    white-space: nowrap;
  }
  a:hover {
    color: hsl(8 86% 66%);
  }
  @media (max-width: 760px) {
    :global(.token-envy-promotion) {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .promotion-actions {
      grid-column: 1 / -1;
      justify-content: space-between;
    }
  }
  @media (max-width: 430px) {
    .promotion-actions {
      align-items: stretch;
      flex-direction: column;
    }
    .command {
      justify-content: space-between;
      width: 100%;
    }
    a {
      width: fit-content;
    }
  }
</style>
