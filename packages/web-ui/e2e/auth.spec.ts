import { test, expect } from '@playwright/test';
import { resetMockServer } from './helpers.js';

// ---------------------------------------------------------------------------
// Auth gate — the HTTP preflight lets the UI distinguish a bad token
// from a down daemon. Before this fix, a wrong token flashed the
// dashboard and the client spun reconnects forever.
// ---------------------------------------------------------------------------

test.describe('Auth gate', () => {
  test.beforeEach(async ({ request }) => {
    await resetMockServer(request);
  });

  test('rejects a bad token without flashing the dashboard', async ({ page }) => {
    await page.goto('/?token=definitely-wrong-token');

    // The error banner should appear — this is the *only* way for the
    // user to learn their token was wrong, because browsers hide the
    // WS upgrade's 401 from JS.
    await expect(page.getByTestId('auth-error')).toBeVisible({ timeout: 5_000 });

    // The sidebar nav only renders once past the auth gate; it must
    // never appear for a rejected token.
    await expect(page.getByTestId('sidebar-nav')).not.toBeVisible();

    // And the bad token must be purged from sessionStorage so a
    // subsequent page load doesn't re-offer it.
    const stored = await page.evaluate(() => sessionStorage.getItem('ic-auth-token'));
    expect(stored).toBeNull();
  });

  test('accepts a valid token and hides the error banner on retry', async ({ page }) => {
    // First try a bad token — banner shows.
    await page.goto('/?token=wrong');
    await expect(page.getByTestId('auth-error')).toBeVisible({ timeout: 5_000 });

    // Then paste the real token into the form.
    const input = page.getByPlaceholder('Auth token...');
    await input.fill('mock-dev-token');
    await page.getByRole('button', { name: 'Connect' }).click();

    // Auth gate drops and we land in the app.
    await expect(page.getByTestId('sidebar-nav')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('auth-error')).not.toBeVisible();
  });
});
