import { test, expect, type Page } from '@playwright/test';
import { connectWithToken, navigateTo, resetMockServer } from './helpers.js';

/**
 * Open the Personas view and drill into a persona's detail by name.
 */
async function openPersonaDetail(page: Page, name: string): Promise<void> {
  await navigateTo(page, 'Personas');
  await expect(page.getByRole('heading', { name: 'Personas', exact: true })).toBeVisible({ timeout: 10_000 });
  await page.locator('tr', { hasText: name }).click();
  await expect(page.getByTestId('compile-button')).toBeVisible({ timeout: 10_000 });
}

test.describe('Persona streamed compile', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('compileStream renders live phases then a compiled success badge', async ({ page }) => {
    // `devops` starts uncompiled, so the button reads "Compile Policy".
    await openPersonaDetail(page, 'devops');
    await expect(page.getByRole('button', { name: 'Compile Policy' })).toBeVisible();

    await page.getByTestId('compile-button').click();

    // Live per-phase indicator renders as progress events arrive.
    await expect(page.getByTestId('compile-progress')).toBeVisible({ timeout: 10_000 });

    // Terminal: success message with the rule count appears.
    await expect(page.getByTestId('compile-success')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('compile-success')).toContainText('Compiled successfully');

    // After completion the detail refreshes: the persona now has a policy badge
    // and the compile button flips to "Recompile Policy".
    await expect(page.getByText('Policy compiled', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Recompile Policy' })).toBeVisible({ timeout: 10_000 });
  });

  test('reconnect rehydrates an in-flight compile card', async ({ page }) => {
    // `slow-compile` emits started + one progress event but never completes,
    // so it stays in the daemon's `active` map.
    await openPersonaDetail(page, 'slow-compile');
    await page.getByTestId('compile-button').click();

    // Wait for the live indicator to confirm the op is in-flight.
    await expect(page.getByTestId('compile-progress')).toBeVisible({ timeout: 10_000 });

    // Reload the page (drops the WS connection); on reconnect the store calls
    // listCompiles and the Personas view rehydrates the in-flight card.
    await page.reload();
    await connectWithToken(page);
    await openPersonaDetail(page, 'slow-compile');

    // The in-flight card is rehydrated: the button shows the loading/disabled
    // state and the live progress indicator is present again.
    await expect(page.getByTestId('compile-progress')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('compile-button')).toBeDisabled();
  });

  test('a post-start compile failure renders a typed error affordance', async ({ page }) => {
    await openPersonaDetail(page, 'fail-compile');
    await page.getByTestId('compile-button').click();

    await expect(page.getByTestId('compile-error')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('compile-error-code')).toHaveText('COMPILE_FAILED');
  });

  test('a credentials-missing preflight renders the typed credentials affordance', async ({ page }) => {
    // `no-creds` returns CREDENTIALS_MISSING synchronously from compileStream.
    await openPersonaDetail(page, 'no-creds');
    await page.getByTestId('compile-button').click();

    await expect(page.getByTestId('compile-error')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('compile-error-code')).toHaveText('CREDENTIALS_MISSING');
    await expect(page.getByTestId('compile-error')).toContainText('credentials are missing');
  });
});
