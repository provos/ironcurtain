import { test, expect } from '@playwright/test';
import { connectWithToken, navigateTo, createDefaultSession, sendMessage, resetMockServer } from './helpers.js';

test.describe('Escalations', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('shows empty state when no escalations pending', async ({ page }) => {
    await navigateTo(page, 'Escalations');
    await expect(page.getByText('No pending escalations')).toBeVisible();
  });

  test('creates an escalation by sending "escalate" keyword', async ({ page }) => {
    await createDefaultSession(page);

    // Navigate to escalations view BEFORE sending escalation to avoid modal overlay
    await navigateTo(page, 'Escalations');

    // Select the session and send the escalation trigger
    await navigateTo(page, 'Sessions');
    await page.locator('[data-testid^="session-item-"]').first().click();
    await sendMessage(page, 'please escalate this');

    // Navigate to escalations view -- modal does not open because we're on escalations page
    await navigateTo(page, 'Escalations');

    // The mock server creates an escalation for filesystem/write_file
    await expect(page.getByText('Write to protected system path')).toBeVisible({ timeout: 10_000 });
  });

  test('escalation card shows server name and tool info', async ({ page }) => {
    await createDefaultSession(page);
    await navigateTo(page, 'Escalations');
    await navigateTo(page, 'Sessions');
    await page.locator('[data-testid^="session-item-"]').first().click();
    await sendMessage(page, 'escalate');
    await navigateTo(page, 'Escalations');

    // Wait for the escalation card to appear
    await expect(page.getByText('Write to protected system path')).toBeVisible({ timeout: 10_000 });

    // Should show the server and tool name
    await expect(page.getByText('filesystem/filesystem__write_file')).toBeVisible();

    // Should show Approve and Deny buttons
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
  });

  test('approving an escalation removes the card', async ({ page }) => {
    await createDefaultSession(page);
    await navigateTo(page, 'Escalations');
    await navigateTo(page, 'Sessions');
    await page.locator('[data-testid^="session-item-"]').first().click();
    await sendMessage(page, 'escalate');
    await navigateTo(page, 'Escalations');

    // Wait for escalation to appear
    await expect(page.getByText('Write to protected system path')).toBeVisible({ timeout: 10_000 });

    // Approve it
    await page.getByRole('button', { name: 'Approve' }).click();

    // The escalation card should disappear
    await expect(page.getByText('No pending escalations')).toBeVisible({ timeout: 5_000 });
  });

  test('denying an escalation removes the card', async ({ page }) => {
    await createDefaultSession(page);
    await navigateTo(page, 'Escalations');
    await navigateTo(page, 'Sessions');
    await page.locator('[data-testid^="session-item-"]').first().click();
    await sendMessage(page, 'escalate');
    await navigateTo(page, 'Escalations');

    // Wait for escalation to appear
    await expect(page.getByText('Write to protected system path')).toBeVisible({ timeout: 10_000 });

    // Deny it
    await page.getByRole('button', { name: 'Deny' }).click();

    // The escalation card should disappear
    await expect(page.getByText('No pending escalations')).toBeVisible({ timeout: 5_000 });
  });

  test('whitelist candidates are displayed and can be selected before approval', async ({ page }) => {
    await createDefaultSession(page);
    await navigateTo(page, 'Escalations');
    await navigateTo(page, 'Sessions');
    await page.locator('[data-testid^="session-item-"]').first().click();
    await sendMessage(page, 'escalate');
    await navigateTo(page, 'Escalations');

    // Wait for the escalation card to appear
    await expect(page.getByText('Write to protected system path')).toBeVisible({ timeout: 10_000 });

    // Verify whitelist candidates section is rendered
    await expect(page.getByText('Whitelist (optional)')).toBeVisible();

    // Verify both candidate descriptions are displayed
    const candidate1 = page.getByText('Allow filesystem.write_file within /etc/');
    const candidate2 = page.getByText('Allow filesystem.write_file for this exact path: /etc/hosts');
    await expect(candidate1).toBeVisible();
    await expect(candidate2).toBeVisible();

    // Click the second whitelist candidate to select it
    await candidate2.click();

    // Approve with the whitelist selection
    await page.getByRole('button', { name: 'Approve' }).click();

    // The escalation card should disappear
    await expect(page.getByText('No pending escalations')).toBeVisible({ timeout: 5_000 });
  });

  test('escalation badge appears in sidebar nav', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'escalate');

    // The nav item for Escalations should show a badge count
    // Wait for the escalation event to propagate
    await expect(
      page.getByTestId('sidebar-nav').locator('button', { hasText: 'Escalations' }).locator('.font-mono'),
    ).toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe('Escalation Modal', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('modal auto-opens when escalation fires during sessions view', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'escalate');

    // The modal should auto-open since we're on the Sessions view
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Modal should contain the escalation details
    await expect(modal.getByText('Write to protected system path')).toBeVisible();
    await expect(modal.getByText('Pending Escalations')).toBeVisible();
  });

  test('modal can be dismissed with Escape and sidebar badge still shows count', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'escalate');

    // Wait for the modal to auto-open
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Dismiss with Escape
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 3_000 });

    // Sidebar badge should still show the count
    await expect(
      page.getByTestId('sidebar-nav').locator('button', { hasText: 'Escalations' }).locator('.font-mono'),
    ).toBeVisible();
  });

  test('approving in modal removes the escalation', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'escalate');

    // Wait for the modal to auto-open
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal.getByText('Write to protected system path')).toBeVisible();

    // Approve the escalation via the modal
    await modal.getByRole('button', { name: 'Approve' }).click();

    // Modal should close since no more escalations
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
  });

  test('View Session link navigates to session view', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'escalate');

    // Wait for the modal to auto-open
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Click "View Session"
    await modal.getByText('View Session').click();

    // Modal should close
    await expect(modal).not.toBeVisible({ timeout: 3_000 });

    // Should be on sessions view with the session selected
    await expect(page.getByTestId('session-output')).toBeVisible();
  });

  test('pressing "a" key approves the active escalation', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'escalate');

    // Wait for the modal to auto-open
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal.getByText('Write to protected system path')).toBeVisible();

    // Press "a" to approve
    await page.keyboard.press('a');

    // Modal should close since no more escalations
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Sidebar badge should be gone
    await expect(
      page.getByTestId('sidebar-nav').locator('button', { hasText: 'Escalations' }).locator('.font-mono'),
    ).not.toBeVisible();
  });

  test('modal does NOT auto-open when already on Escalations page', async ({ page }) => {
    await createDefaultSession(page);

    // Navigate to Escalations page first
    await navigateTo(page, 'Escalations');

    // Go back to sessions to send the escalation trigger
    await navigateTo(page, 'Sessions');
    await page.locator('[data-testid^="session-item-"]').first().click();
    await sendMessage(page, 'escalate');

    // Immediately navigate to Escalations
    await navigateTo(page, 'Escalations');

    // Wait for escalation to appear on the page
    await expect(page.getByText('Write to protected system path')).toBeVisible({ timeout: 10_000 });

    // Modal should NOT be open since we're on the Escalations page
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });
});
