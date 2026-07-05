import { test, expect } from '@playwright/test';
import {
  connectWithToken,
  navigateTo,
  createDefaultSession,
  resetMockServer,
  ptyRows,
  waitForPtyTerminal,
  sendTrustedPtyPrompt,
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

  test('creates a new session via New > Start session', async ({ page }) => {
    const label = await createDefaultSession(page);
    expect(label).toMatch(/#\d+/);
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
