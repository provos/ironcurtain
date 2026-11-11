import { test, expect } from '@playwright/test';
import {
  connectWithToken,
  navigateTo,
  createDefaultSession,
  resetMockServer,
  ptyRows,
  waitForPtyTerminal,
  sendTrustedPtyPrompt,
  openNewSessionDialog,
} from './helpers.js';

test.describe('Sessions', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('shows empty state when no sessions exist', async ({ page }) => {
    await navigateTo(page, 'Sessions');
    await expect(page.getByText('No active sessions')).toBeVisible();
  });

  test('creates a new session via the explicit Start session action', async ({ page }) => {
    const label = await createDefaultSession(page);
    expect(label).toMatch(/#\d+/);
  });

  test('keeps launch options in the New session dialog until start', async ({ page }) => {
    await navigateTo(page, 'Sessions');
    await expect(page.getByTestId('session-launch-form')).toHaveCount(0);

    await openNewSessionDialog(page);
    await expect(page.getByTestId('launch-workspace')).toBeVisible();
    await expect(page.getByTestId('launch-provider')).toBeVisible();
    await expect(page.getByTestId('launch-persona')).toBeVisible();
    await expect(page.getByTestId('launch-readonly-input')).toBeVisible();
    await expect(page.getByTestId('launch-start')).toBeVisible();
    await expect(page.locator('[data-testid^="session-item-"]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog', { name: 'New session' })).toBeHidden();
  });

  test('starts a session with read-only folder chips', async ({ page }) => {
    await navigateTo(page, 'Sessions');
    await openNewSessionDialog(page);

    const input = page.getByTestId('launch-readonly-input');
    await input.fill('/mnt/d/Training');
    await input.press('Enter');
    await input.fill('D:\\Datasets\\imagenet');
    await input.press('Enter');
    await expect(page.getByTestId('launch-readonly-chip')).toHaveText(['Training', 'imagenet']);
    await expect(page.getByTestId('launch-readonly-warning')).toBeVisible();

    await page.getByTestId('launch-start').click();
    await expect(page.getByRole('dialog', { name: 'New session' })).toBeHidden();
    await expect(page.locator('[data-testid^="session-item-"]').first()).toBeVisible({ timeout: 5_000 });
  });

  test('keeps Start session reachable on a small screen with many folder chips', async ({ page }) => {
    // Navigate at desktop width (the nav moves into a drawer on phones), then shrink.
    await navigateTo(page, 'Sessions');
    await page.setViewportSize({ width: 375, height: 667 });
    await openNewSessionDialog(page);

    const input = page.getByTestId('launch-readonly-input');
    for (let i = 1; i <= 8; i++) {
      await input.fill(`/mnt/d/datasets/folder-with-a-long-name-${i}`);
      await input.press('Enter');
    }
    await expect(page.getByTestId('launch-readonly-chip')).toHaveCount(8);

    const start = page.getByTestId('launch-start');
    await expect(start).toBeInViewport();
    await start.click();
    await expect(page.getByRole('dialog', { name: 'New session' })).toBeHidden();
  });

  test('collapses the session list to a rail', async ({ page }) => {
    await createDefaultSession(page);
    await page.getByTestId('sidebar-collapse').click();

    await expect(page.getByTestId('session-sidebar')).toHaveCount(0);
    await expect(page.locator('[data-testid^="session-rail-item-"]')).toHaveCount(1);
    await page.getByTestId('sidebar-expand').click();
    await expect(page.getByTestId('session-sidebar')).toBeVisible();
  });

  test('session appears in the sidebar after creation', async ({ page }) => {
    await createDefaultSession(page);
    // The session sidebar should list at least one session item
    const sidebar = page.getByTestId('session-sidebar');
    await expect(sidebar.locator('[data-testid^="session-item-"]').first()).toBeVisible();
  });

  test('renders a PTY terminal after creation', async ({ page }) => {
    await createDefaultSession(page);
    await waitForPtyTerminal(page);
  });

  test('resumes a saved session into a selected PTY terminal', async ({ page }) => {
    await navigateTo(page, 'Sessions');
    await page.getByRole('button', { name: 'Resume previous…' }).click();

    const dialog = page.getByRole('dialog', { name: 'Resume a session' });
    await expect(dialog.getByText('Claude Code — ironcurtain')).toBeVisible();
    await dialog.getByRole('button', { name: 'Resume Claude Code — ironcurtain' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('session-sidebar').locator('[data-testid^="session-item-"]')).toHaveCount(1);
    await waitForPtyTerminal(page);
  });

  test('resumes a saved session with an added read-only folder', async ({ page }) => {
    await navigateTo(page, 'Sessions');
    await page.getByRole('button', { name: 'Resume previous…' }).click();

    const dialog = page.getByRole('dialog', { name: 'Resume a session' });
    await expect(dialog.getByTestId('resume-saved-folders')).toContainText('Read-only: Training');
    const input = dialog.getByTestId('resume-readonly-input');
    await input.fill('/mnt/d/Reference');
    await input.press('Enter');
    await expect(dialog.getByTestId('resume-readonly-chip')).toHaveText(['Reference']);
    await expect(dialog.getByTestId('resume-readonly-warning')).toBeVisible();

    await dialog.getByRole('button', { name: 'Resume Claude Code — ironcurtain' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('session-sidebar').locator('[data-testid^="session-item-"]')).toHaveCount(1);
  });

  test('sends a trusted prompt and echoes it into the terminal', async ({ page }) => {
    await createDefaultSession(page);
    await waitForPtyTerminal(page);

    const message = 'session-helper-prompt-17';
    await sendTrustedPtyPrompt(page, message);

    await expect(ptyRows(page)).toContainText(message, { timeout: 15_000 });
    await expect(page.getByTestId('pty-prompt-input')).toHaveValue('');
  });

  test('ends a session and removes it from sidebar', async ({ page }) => {
    await createDefaultSession(page);

    // The "End" button should be visible in the session header
    const endButton = page.getByRole('button', { name: 'End', exact: true });
    await expect(endButton).toBeVisible();
    await endButton.click();

    // Session should be removed from the sidebar
    await expect(page.getByText('No active sessions')).toBeVisible({ timeout: 5_000 });
  });
});
