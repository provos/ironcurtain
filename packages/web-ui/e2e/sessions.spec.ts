import { test, expect } from '@playwright/test';
import { connectWithToken, navigateTo, createDefaultSession, sendMessage, resetMockServer } from './helpers.js';

test.describe('Sessions', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('shows empty state when no sessions exist', async ({ page }) => {
    await navigateTo(page, 'Sessions');
    await expect(page.getByText('No active sessions')).toBeVisible();
  });

  test('creates a new session via New > Default', async ({ page }) => {
    const label = await createDefaultSession(page);
    expect(label).toMatch(/#\d+/);
  });

  test('session appears in the sidebar after creation', async ({ page }) => {
    await createDefaultSession(page);
    // The session sidebar should list at least one session item
    const sidebar = page.getByTestId('session-sidebar');
    await expect(sidebar.locator('[data-testid^="session-item-"]').first()).toBeVisible();
  });

  test('sends a message and receives assistant output', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'Hello agent');

    // User message should appear in the output
    await expect(page.getByText('Hello agent')).toBeVisible();

    // The mock server emits tool_call events after ~800ms, then output after ~2.6s
    // Wait for the final assistant response (markdown rendered from CANNED_RESPONSES)
    await expect(page.getByText('Analysis Complete').or(page.getByText("I've completed"))).toBeVisible({
      timeout: 10_000,
    });
  });

  test('shows collapsible tool call group', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'Run analysis');

    // Wait for tool calls to arrive and be grouped
    // The collapsible group shows a summary like "2 tool calls"
    await expect(page.locator('button', { hasText: /tool call/ })).toBeVisible({ timeout: 10_000 });
  });

  test('auto-scrolls output container on new messages', async ({ page }) => {
    await createDefaultSession(page);
    await sendMessage(page, 'First message');

    // Wait for the response to fully render
    await expect(page.getByText('Analysis Complete').or(page.getByText("I've completed"))).toBeVisible({
      timeout: 10_000,
    });

    // Wait for auto-scroll to settle: scrollTop should be near scrollHeight
    await page.waitForFunction(
      () => {
        const container = document.querySelector('[data-testid="session-output"]');
        if (!container) return false;
        const { scrollTop, scrollHeight, clientHeight } = container;
        return scrollHeight - scrollTop - clientHeight < 50;
      },
      { timeout: 5_000 },
    );
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
