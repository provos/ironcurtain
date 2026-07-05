import { test, expect, type Page } from '@playwright/test';
import { connectWithToken, navigateTo, createDefaultSession, resetMockServer } from './helpers.js';

// A distinctive, box-drawing-free line from the mock's replay banner
// (PTY_BANNER in scripts/mock-ws-server.ts). Reading xterm's rendered text is
// more reliable on a plain line than one wrapped in ANSI box characters.
const BANNER_TEXT = 'Type to send keystrokes';

// The periodic status line only the live `session.pty_output` frames paint —
// the replay banner never contains it, so its presence proves live streaming.
const LIVE_FRAME_TEXT = '[mock] agent working';

/** The rendered-rows region of the single on-screen terminal. */
function ptyRows(page: Page) {
  return page.getByTestId('pty-terminal').locator('.xterm-rows');
}

/** Give the terminal keyboard focus by clicking its screen area. */
async function focusTerminal(page: Page): Promise<void> {
  await page.locator('.xterm-screen').click();
}

/** The current bottom-row frame counter, or null if no frame has rendered. */
async function currentFrameNumber(page: Page): Promise<number | null> {
  const text = (await ptyRows(page).textContent()) ?? '';
  const match = text.match(/frame (\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Deliver a full multi-character string to the PTY as ONE input frame.
 *
 * `page.keyboard.type()` sends each keystroke as a separate `sessions.ptyInput`
 * (xterm's `onData` fires per key), so the mock's word-level "escalate" detector
 * would never see the whole word. A browser paste is turned by xterm into a
 * single `onData(text)` call — exactly one input frame — which is also how a
 * real operator triggers this path (paste, not per-key typing). We dispatch a
 * synthetic paste on xterm's helper textarea rather than driving the OS
 * clipboard, which is unavailable in headless Chromium.
 */
async function pasteIntoTerminal(page: Page, text: string): Promise<void> {
  await focusTerminal(page);
  await page.evaluate((value) => {
    const textarea = document.querySelector('.xterm-helper-textarea');
    if (!textarea) throw new Error('xterm helper textarea not found');
    const data = new DataTransfer();
    data.setData('text/plain', value);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);
  }, text);
}

test.describe('PTY terminal (Docker Agent Mode)', () => {
  test.beforeEach(async ({ page, request }) => {
    // Flip the single mock instance into docker mode so `sessions.create`
    // yields a web-pty terminal. A bare reset in the other specs restores the
    // default chatbox mode, so this never leaks across files.
    await resetMockServer(request, { mode: 'docker' });
    await connectWithToken(page);
  });

  test('attaches and renders the replay banner', async ({ page }) => {
    await createDefaultSession(page);

    // The terminal element mounts for a web-pty session...
    await expect(page.getByTestId('pty-terminal')).toBeVisible();

    // ...and the one-shot replay snapshot repaints the canned banner into it.
    await expect(ptyRows(page)).toContainText(BANNER_TEXT, { timeout: 15_000 });
  });

  test('renders live output frames over time', async ({ page }) => {
    await createDefaultSession(page);
    await expect(page.getByTestId('pty-terminal')).toBeVisible();

    // The periodic frames (every 1s) paint a bottom status line the replay
    // banner lacks — its appearance proves the pty_output stream reaches xterm.
    await expect(ptyRows(page)).toContainText(LIVE_FRAME_TEXT, { timeout: 15_000 });

    // "Over time": the frame counter must advance, proving continued streaming
    // rather than a single stale paint.
    const first = (await currentFrameNumber(page)) ?? 0;
    await expect.poll(async () => (await currentFrameNumber(page)) ?? -1, { timeout: 15_000 }).toBeGreaterThan(first);
  });

  test('echoes typed input back into the terminal', async ({ page }) => {
    await createDefaultSession(page);
    await expect(ptyRows(page)).toContainText(BANNER_TEXT, { timeout: 15_000 });

    // The mock echoes each keystroke back as a pty_output frame; xterm does not
    // local-echo, so seeing the text at all proves the round-trip.
    await focusTerminal(page);
    const probe = 'echo-probe-42';
    await page.keyboard.type(probe);

    await expect(ptyRows(page)).toContainText(probe, { timeout: 15_000 });
  });

  test('escalation raised over the terminal can be approved', async ({ page }) => {
    await createDefaultSession(page);
    await expect(ptyRows(page)).toContainText(BANNER_TEXT, { timeout: 15_000 });

    // Paste "escalate" as one frame so the mock routes it to escalation.created.
    await pasteIntoTerminal(page, 'escalate');

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
    await expect(ptyRows(page)).toContainText(BANNER_TEXT, { timeout: 15_000 });

    await pasteIntoTerminal(page, 'escalate');

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal.getByText('Write to protected system path')).toBeVisible();

    await modal.getByRole('button', { name: 'Deny' }).click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('pty-terminal')).toBeVisible();
  });

  test('survives a viewport resize without crashing', async ({ page }) => {
    await createDefaultSession(page);
    await expect(ptyRows(page)).toContainText(BANNER_TEXT, { timeout: 15_000 });

    // Drive the ResizeObserver -> fit() -> sessions.ptyResize path a couple of
    // times. A light assertion: the terminal stays mounted and keeps its buffer.
    await page.setViewportSize({ width: 900, height: 600 });
    await page.setViewportSize({ width: 1400, height: 900 });

    await expect(page.getByTestId('pty-terminal')).toBeVisible();
    await expect(ptyRows(page)).toContainText(BANNER_TEXT, { timeout: 15_000 });
  });

  test('sends a trusted message from the docked bar and echoes it into the terminal', async ({ page }) => {
    await createDefaultSession(page);
    await expect(ptyRows(page)).toContainText(BANNER_TEXT, { timeout: 15_000 });

    // The trusted-message bar (below the terminal) sends PLAIN text via
    // sessions.ptyPrompt — distinct from raw keystrokes. The mock injects it back
    // as a pty_output frame, so seeing it in xterm proves the round-trip.
    const message = 'trusted-approve-99';
    await page.getByTestId('pty-prompt-input').fill(message);
    await page.getByTestId('pty-prompt-send').click();

    await expect(ptyRows(page)).toContainText(message, { timeout: 15_000 });
    // The input clears after a successful send.
    await expect(page.getByTestId('pty-prompt-input')).toHaveValue('');
  });

  test('creates a web-pty session with launch options set', async ({ page }) => {
    await navigateTo(page, 'Sessions');

    // Open the New-session dropdown; docker mode reveals the launch options.
    await page.getByRole('button', { name: 'New' }).click();

    await page.getByTestId('launch-workspace').fill('/tmp/demo-workspace');
    await page.getByTestId('launch-model').fill('anthropic/claude-sonnet-4.5');

    // The provider profile <select> is populated from config.getModelProviders.
    const providerSelect = page.getByTestId('launch-provider');
    await expect(providerSelect.locator('option', { hasText: 'glm-5.2' })).toHaveCount(1, { timeout: 10_000 });
    await providerSelect.selectOption('glm-5.2');

    // Start with the entered launch options (default persona).
    await page.getByTestId('launch-start').click();

    // The web-pty terminal renders for the newly created session.
    await expect(page.getByTestId('pty-terminal')).toBeVisible({ timeout: 10_000 });
    await expect(ptyRows(page)).toContainText(BANNER_TEXT, { timeout: 15_000 });
  });

  test('re-attaches and replays after a page reload', async ({ page }) => {
    await createDefaultSession(page);
    await expect(ptyRows(page)).toContainText(BANNER_TEXT, { timeout: 15_000 });

    // Reload drops the WS; the mock keeps the session (no reset). Re-selecting it
    // re-attaches and the daemon replays the snapshot, so the banner reappears.
    await page.reload();
    await expect(page.getByTestId('sidebar-nav')).toBeVisible({ timeout: 15_000 });
    await navigateTo(page, 'Sessions');
    await page.locator('[data-testid^="session-item-"]').first().click();

    await expect(page.getByTestId('pty-terminal')).toBeVisible();
    await expect(ptyRows(page)).toContainText(BANNER_TEXT, { timeout: 15_000 });
  });
});
