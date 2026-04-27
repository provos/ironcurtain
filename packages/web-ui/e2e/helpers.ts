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
  // Target the desktop sidebar by test id; the mobile drawer also
  // renders a <nav> in the DOM (offscreen) so a bare 'nav' selector
  // would hit a strict-mode violation.
  await expect(page.getByTestId('sidebar-nav')).toBeVisible({ timeout: 10_000 });
}

/**
 * Click a navigation item in the sidebar by its label text.
 */
export async function navigateTo(
  page: Page,
  view: 'Dashboard' | 'Sessions' | 'Escalations' | 'Jobs' | 'Workflows',
): Promise<void> {
  await page.getByTestId('sidebar-nav').getByRole('button', { name: view }).click();
}

/**
 * Navigate to the Workflows list view, dismissing any auto-opened detail view.
 *
 * The mock server seeds a workflow in `waiting_human` phase, and on connect
 * the store fetches its gate and populates `pendingGates`. The Workflows.svelte
 * auto-select effect then opens the detail view of that workflow. Tests that
 * need the list view must wait for the auto-select to settle, then dismiss the
 * detail view.
 */
export async function navigateToWorkflowsList(page: Page): Promise<void> {
  // Wait for the gate fetch to complete before navigating so the auto-select
  // effect has fired by the time we land on the Workflows view. The gate badge
  // on the sidebar's Workflows nav item is the visible signal that
  // pendingGates is populated.
  const workflowsNavBadge = page
    .getByTestId('sidebar-nav')
    .locator('button', { hasText: 'Workflows' })
    .locator('.font-mono');
  await expect(workflowsNavBadge).toBeVisible({ timeout: 10_000 });

  await navigateTo(page, 'Workflows');

  // Auto-select may now be opening the detail view; click Back if so.
  const heading = page.getByRole('heading', { name: 'Workflows', exact: true });
  const backButton = page.getByRole('button', { name: /Back/ });
  await expect(heading.or(backButton).first()).toBeVisible({ timeout: 10_000 });
  if (await backButton.isVisible().catch(() => false)) {
    await backButton.click();
  }
  await expect(heading).toBeVisible({ timeout: 5_000 });
}

/**
 * Clear the seeded code-review gate so subsequent actions (e.g., starting a
 * new workflow that raises a gate) won't trigger the auto-select effect
 * navigating away to the seeded workflow's detail view.
 *
 * Assumes we are on the Workflows list view with code-review present.
 */
export async function approveSeededGate(page: Page): Promise<void> {
  await page.locator('tr', { hasText: 'code-review' }).click();
  await expect(page.getByText('Review Required')).toBeVisible({ timeout: 5_000 });
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Review Required')).not.toBeVisible({ timeout: 5_000 });
  // Return to the list view; the gate badge should be gone.
  await page.getByRole('button', { name: /Back/ }).click();
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible({ timeout: 5_000 });
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
