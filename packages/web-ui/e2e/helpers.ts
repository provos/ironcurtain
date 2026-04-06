import { expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * Reset the mock server's mutable state so tests are isolated.
 */
export async function resetMockServer(request: APIRequestContext): Promise<void> {
  await request.post('http://localhost:7401/__reset');
}

/**
 * Navigate to the app with the mock server's test token and wait
 * for the WebSocket connection to establish (sidebar becomes visible).
 */
export async function connectWithToken(page: Page): Promise<void> {
  await page.goto('/?token=mock-dev-token');
  // The sidebar nav appears only after the auth gate is passed and
  // the WS connection is established (appState.connected becomes true).
  await expect(page.locator('nav')).toBeVisible({ timeout: 10_000 });
}

/**
 * Click a navigation item in the sidebar by its label text.
 */
export async function navigateTo(page: Page, view: 'Dashboard' | 'Sessions' | 'Escalations' | 'Jobs'): Promise<void> {
  await page.locator('nav').getByRole('button', { name: view }).click();
}

/**
 * Create a new session using the "New" dropdown and selecting "Default".
 * Returns the session label text (e.g., "#1").
 */
export async function createDefaultSession(page: Page): Promise<string> {
  await navigateTo(page, 'Sessions');

  // Click "New" to open the persona picker dropdown
  await page.getByRole('button', { name: 'New' }).click();

  // Select "Default" from the dropdown via data-testid
  await page.getByTestId('persona-default').click();

  // Wait for a session entry to appear in the sidebar list.
  // Session items have data-testid="session-item-{label}"
  const sessionItem = page.locator('[data-testid^="session-item-"]').first();
  await expect(sessionItem).toBeVisible({ timeout: 5_000 });

  // Extract the label text (e.g., "#1") from the session item
  const labelSpan = sessionItem.locator('.font-mono', { hasText: /^#\d+$/ });
  const label = (await labelSpan.textContent()) ?? '';

  // Click the session item to select it
  await sessionItem.click();
  return label;
}

/**
 * Send a message in the currently selected session and wait for
 * the input to become enabled again (message accepted by server).
 */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const textarea = page.getByPlaceholder('Send a message...');
  await textarea.fill(text);
  await textarea.press('Enter');
}
