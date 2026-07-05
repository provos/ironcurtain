import { test, expect } from '@playwright/test';
import { connectWithToken, navigateTo, createDefaultSession, resetMockServer, waitForPtyTerminal } from './helpers.js';

test.describe('Error handling', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('shows empty state after ending a session (terminal becomes unavailable)', async ({ page }) => {
    await createDefaultSession(page);
    await waitForPtyTerminal(page);

    // End the session
    await page.getByRole('button', { name: 'End', exact: true }).click();
    await expect(page.getByText('No active sessions')).toBeVisible({ timeout: 5_000 });

    // The session detail pane should show the empty state, not an input
    await expect(page.getByText('No session selected')).toBeVisible();
    // The terminal controls should no longer be present
    await expect(page.getByTestId('pty-terminal')).not.toBeVisible();
    await expect(page.getByTestId('pty-prompt-input')).not.toBeVisible();
  });

  test('removes the selected terminal after ending a live session', async ({ page }) => {
    await createDefaultSession(page);
    await waitForPtyTerminal(page);

    // End the session via the End button. The UI transitions to
    // "No session selected", confirming the terminal session is gone.
    await page.getByRole('button', { name: 'End', exact: true }).click();
    await expect(page.getByText('No session selected')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('pty-terminal')).not.toBeVisible();
  });

  test('session creation succeeds and produces a numbered session', async ({ page }) => {
    await navigateTo(page, 'Sessions');

    // Create a session and verify it appears with a numeric label
    await page.getByRole('button', { name: 'New' }).click();
    await page.getByTestId('launch-start').click();
    await expect(page.locator('[data-testid^="session-item-"]').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('pty-terminal')).toBeVisible({ timeout: 10_000 });
  });
});
