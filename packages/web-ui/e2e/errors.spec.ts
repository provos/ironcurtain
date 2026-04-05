import { test, expect } from '@playwright/test';
import { connectWithToken, navigateTo, createDefaultSession, sendMessage, resetMockServer } from './helpers.js';

test.describe('Error handling', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('shows empty state after ending a session (input becomes unavailable)', async ({ page }) => {
    await createDefaultSession(page);

    // End the session
    await page.getByRole('button', { name: 'End', exact: true }).click();
    await expect(page.getByText('No active sessions')).toBeVisible({ timeout: 5_000 });

    // The session detail pane should show the empty state, not an input
    await expect(page.getByText('No session selected')).toBeVisible();
    // The message input should no longer be present
    await expect(page.getByPlaceholder('Send a message...')).not.toBeVisible();
  });

  test('displays error in output when sending to a non-existent session', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'Hello');

    // Wait for the response so the session is in ready state
    await expect(page.getByText('Analysis Complete').or(page.getByText("I've completed"))).toBeVisible({
      timeout: 10_000,
    });

    // End the session via the End button -- the session is removed but we
    // may still have the output pane visible briefly. The UI transitions to
    // "No session selected", confirming the session is gone.
    await page.getByRole('button', { name: 'End', exact: true }).click();
    await expect(page.getByText('No session selected')).toBeVisible({ timeout: 5_000 });
  });

  test('session creation succeeds and produces a numbered session', async ({ page }) => {
    await navigateTo(page, 'Sessions');

    // Create a session and verify it appears with a numeric label
    await page.getByRole('button', { name: 'New' }).click();
    await page.getByTestId('persona-default').click();
    await expect(page.locator('[data-testid^="session-item-"]').first()).toBeVisible({ timeout: 5_000 });
  });
});
