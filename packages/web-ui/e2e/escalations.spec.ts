import { test, expect } from '@playwright/test';
import { connectWithToken, navigateTo, createDefaultSession, sendMessage } from './helpers.js';

test.describe('Escalations', () => {
  test.beforeEach(async ({ page }) => {
    await connectWithToken(page);
  });

  test('shows empty state when no escalations pending', async ({ page }) => {
    await navigateTo(page, 'Escalations');
    await expect(page.getByText('No pending escalations')).toBeVisible();
  });

  test('creates an escalation by sending "escalate" keyword', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'please escalate this');

    // Navigate to escalations view
    await navigateTo(page, 'Escalations');

    // The mock server creates an escalation for filesystem/write_file
    await expect(page.getByText('filesystem')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('write_file')).toBeVisible();
  });

  test('escalation card shows server name and tool info', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'escalate');

    await navigateTo(page, 'Escalations');

    // Wait for the escalation card to appear
    await expect(page.getByText('filesystem')).toBeVisible({ timeout: 10_000 });

    // Should show the reason
    await expect(page.getByText('Write to protected system path')).toBeVisible();

    // Should show Approve and Deny buttons
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
  });

  test('approving an escalation removes the card', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'escalate');

    await navigateTo(page, 'Escalations');

    // Wait for escalation to appear
    await expect(page.getByText('filesystem')).toBeVisible({ timeout: 10_000 });

    // Approve it
    await page.getByRole('button', { name: 'Approve' }).click();

    // The escalation card should disappear
    await expect(page.getByText('No pending escalations')).toBeVisible({ timeout: 5_000 });
  });

  test('denying an escalation removes the card', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'escalate');

    await navigateTo(page, 'Escalations');

    // Wait for escalation to appear
    await expect(page.getByText('filesystem')).toBeVisible({ timeout: 10_000 });

    // Deny it
    await page.getByRole('button', { name: 'Deny' }).click();

    // The escalation card should disappear
    await expect(page.getByText('No pending escalations')).toBeVisible({ timeout: 5_000 });
  });

  test('escalation badge appears in sidebar nav', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'escalate');

    // The nav item for Escalations should show a badge count
    // Wait for the escalation event to propagate
    await expect(page.locator('nav').locator('button', { hasText: 'Escalations' }).locator('.font-mono')).toBeVisible({
      timeout: 10_000,
    });
  });
});
