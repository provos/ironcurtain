import { test, expect, type Page } from '@playwright/test';
import {
  connectWithToken,
  navigateTo,
  createDefaultSession,
  resetMockServer,
  focusPtyTerminal,
  pasteIntoPtyTerminal,
  ptyRows,
  waitForPtyTerminal,
  sendTrustedPtyPrompt,
  PTY_BANNER_TEXT,
  PTY_LIVE_FRAME_TEXT,
} from './helpers.js';

/** The current bottom-row frame counter, or null if no frame has rendered. */
async function currentFrameNumber(page: Page): Promise<number | null> {
  const text = (await ptyRows(page).textContent()) ?? '';
  const match = text.match(/frame (\d+)/);
  return match ? Number(match[1]) : null;
}

test.describe('PTY terminal (Container Agent Mode)', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('attaches and renders the replay banner', async ({ page }) => {
    await createDefaultSession(page);

    // The terminal element mounts for a web-pty session...
    await waitForPtyTerminal(page);
  });

  test('renders live output frames over time', async ({ page }) => {
    await createDefaultSession(page);
    await expect(page.getByTestId('pty-terminal')).toBeVisible();

    // The periodic frames (every 1s) paint a bottom status line the replay
    // banner lacks — its appearance proves the pty_output stream reaches xterm.
    await expect(ptyRows(page)).toContainText(PTY_LIVE_FRAME_TEXT, { timeout: 15_000 });

    // "Over time": the frame counter must advance, proving continued streaming
    // rather than a single stale paint.
    const first = (await currentFrameNumber(page)) ?? 0;
    await expect.poll(async () => (await currentFrameNumber(page)) ?? -1, { timeout: 15_000 }).toBeGreaterThan(first);
  });

  test('echoes typed input back into the terminal', async ({ page }) => {
    await createDefaultSession(page);
    await waitForPtyTerminal(page);

    // The mock echoes each keystroke back as a pty_output frame; xterm does not
    // local-echo, so seeing the text at all proves the round-trip.
    await focusPtyTerminal(page);
    const probe = 'echo-probe-42';
    await page.keyboard.type(probe);

    await expect(ptyRows(page)).toContainText(probe, { timeout: 15_000 });
  });

  test('escalation raised over the terminal can be approved', async ({ page }) => {
    await createDefaultSession(page);
    await waitForPtyTerminal(page);

    // Paste "escalate" as one frame so the mock routes it to escalation.created.
    await pasteIntoPtyTerminal(page, 'escalate');

    // The escalation modal auto-opens on the Sessions view (App.svelte), layered
    // over the live terminal.
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal.getByText('Write to protected system path')).toBeVisible();

    // Approving resolves it (escalation.resolved) and clears the overlay.
    await modal.getByRole('button', { name: 'Approve' }).click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // The terminal is still live underneath the dismissed overlay.
    await expect(page.getByTestId('pty-terminal')).toBeVisible();
  });

  test('escalation raised over the terminal can be denied', async ({ page }) => {
    await createDefaultSession(page);
    await waitForPtyTerminal(page);

    await pasteIntoPtyTerminal(page, 'escalate');

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal.getByText('Write to protected system path')).toBeVisible();

    await modal.getByRole('button', { name: 'Deny' }).click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('pty-terminal')).toBeVisible();
  });

  test('survives a viewport resize without crashing', async ({ page }) => {
    await createDefaultSession(page);
    await waitForPtyTerminal(page);

    // Drive the ResizeObserver -> fit() -> sessions.ptyResize path a couple of
    // times. A light assertion: the terminal stays mounted and keeps its buffer.
    await page.setViewportSize({ width: 900, height: 600 });
    await page.setViewportSize({ width: 1400, height: 900 });

    await expect(page.getByTestId('pty-terminal')).toBeVisible();
    await expect(ptyRows(page)).toContainText(PTY_BANNER_TEXT, { timeout: 15_000 });
  });

  test('sends a trusted message from the docked bar and echoes it into the terminal', async ({ page }) => {
    await createDefaultSession(page);
    await waitForPtyTerminal(page);

    // The trusted-message bar (below the terminal) sends PLAIN text via
    // sessions.ptyPrompt — distinct from raw keystrokes. The mock injects it back
    // as a pty_output frame, so seeing it in xterm proves the round-trip.
    const message = 'trusted-approve-99';
    await sendTrustedPtyPrompt(page, message);

    await expect(ptyRows(page)).toContainText(message, { timeout: 15_000 });
    // The input clears after a successful send.
    await expect(page.getByTestId('pty-prompt-input')).toHaveValue('');
  });

  test('creates a web-pty session with launch options set', async ({ page }) => {
    await navigateTo(page, 'Sessions');

    const personaSelect = page.getByTestId('launch-persona');
    await expect(personaSelect).toBeVisible({ timeout: 10_000 });
    await personaSelect.selectOption('researcher');
    await expect(personaSelect).toHaveValue('researcher');

    await page.getByTestId('launch-workspace').fill('/tmp/demo-workspace');
    await page.getByTestId('launch-model').fill('anthropic/claude-sonnet-4.5');

    // The provider profile <select> is populated from config.getModelProviders.
    const providerSelect = page.getByTestId('launch-provider');
    await expect(providerSelect.locator('option', { hasText: 'glm-5.2' })).toHaveCount(1, { timeout: 10_000 });
    await providerSelect.selectOption('glm-5.2');

    await page.getByTestId('launch-start').click();

    const sessionItem = page.locator('[data-testid^="session-item-"]').first();
    await expect(sessionItem).toContainText('researcher', { timeout: 10_000 });

    // The web-pty terminal renders for the newly created session.
    await waitForPtyTerminal(page);
    await expect(page.getByTestId('pty-terminal').locator('xpath=preceding-sibling::*[1]')).toContainText('researcher');
  });

  test('re-attaches and replays after a page reload', async ({ page }) => {
    await createDefaultSession(page);
    await waitForPtyTerminal(page);

    // Reload drops the WS; the mock keeps the session (no reset). Re-selecting it
    // re-attaches and the daemon replays the snapshot, so the banner reappears.
    await page.reload();
    await expect(page.getByTestId('sidebar-nav')).toBeVisible({ timeout: 15_000 });
    await navigateTo(page, 'Sessions');
    await page.locator('[data-testid^="session-item-"]').first().click();

    await expect(page.getByTestId('pty-terminal')).toBeVisible();
    await expect(ptyRows(page)).toContainText(PTY_BANNER_TEXT, { timeout: 15_000 });
  });
});
