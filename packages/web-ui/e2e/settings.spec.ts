import { test, expect } from '@playwright/test';
import { connectWithToken, navigateTo, resetMockServer } from './helpers.js';

/**
 * Settings (Model Providers) e2e against the mock WS server, which mirrors the
 * production M5/F7/F10 config contract. Drives the form round-trip through the
 * real WebSocket path (get → edit → set → get), so the whole-record send and
 * masked-key preservation behave like production.
 */

test.describe('Settings — Model Providers', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('lists native (non-editable) + the seeded openrouter profiles', async ({ page }) => {
    await navigateTo(page, 'Settings');
    await expect(page.getByRole('heading', { name: 'Model Providers', exact: true })).toBeVisible({ timeout: 10_000 });

    await expect(page.getByTestId('profile-row-native')).toBeVisible();
    await expect(page.getByTestId('profile-row-glm-5.2')).toBeVisible();
    // native is built-in: no edit/delete.
    await expect(page.getByTestId('edit-profile-native')).toHaveCount(0);
    await expect(page.getByTestId('delete-profile-native')).toHaveCount(0);
    // The seeded default profile carries the default badge.
    await expect(page.getByTestId('default-badge-glm-5.2')).toBeVisible();
  });

  test('edits a profile and saves; the masked key round-trips without clobbering', async ({ page }) => {
    await navigateTo(page, 'Settings');
    await expect(page.getByRole('heading', { name: 'Model Providers', exact: true })).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('edit-profile-glm-5.2').click();
    await expect(page.getByTestId('profile-editor')).toBeVisible();

    // The masked key is shown; leaving it untouched preserves the stored key.
    const apikey = page.getByTestId('profile-apikey');
    await expect(apikey).toHaveValue(/^sk-\.\.\./);

    // Toggle session affinity, then save.
    await page.getByTestId('session-affinity').click();
    await page.getByTestId('save-profile-button').click();

    // The editor closes and the profile persists (still listed, still masked).
    await expect(page.getByTestId('profile-editor')).toHaveCount(0);
    await expect(page.getByTestId('profile-row-glm-5.2')).toBeVisible();

    // Re-open: the key is still masked (never leaked / never cleared).
    await page.getByTestId('edit-profile-glm-5.2').click();
    await expect(page.getByTestId('profile-apikey')).toHaveValue(/^sk-\.\.\./);
  });

  test('adds a new openrouter profile', async ({ page }) => {
    await navigateTo(page, 'Settings');
    await expect(page.getByRole('heading', { name: 'Model Providers', exact: true })).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('add-profile-button').click();
    await page.getByTestId('profile-name').fill('deepseek');
    await page.getByTestId('profile-apikey').fill('sk-or-v1-DEEPSEEK');
    await page.getByTestId('save-profile-button').click();

    await expect(page.getByTestId('profile-editor')).toHaveCount(0);
    await expect(page.getByTestId('profile-row-deepseek')).toBeVisible({ timeout: 10_000 });
  });

  test('hides mutation controls on a read-only daemon', async ({ page, request }) => {
    await resetMockServer(request, { allowPolicyMutation: false });
    await page.reload();
    await connectWithToken(page);

    await navigateTo(page, 'Settings');
    await expect(page.getByRole('heading', { name: 'Model Providers', exact: true })).toBeVisible({ timeout: 10_000 });

    // The profile list still renders (read is ungated) but no mutation controls.
    await expect(page.getByTestId('profile-row-glm-5.2')).toBeVisible();
    await expect(page.getByTestId('add-profile-button')).toHaveCount(0);
    await expect(page.getByTestId('edit-profile-glm-5.2')).toHaveCount(0);
    await expect(page.getByTestId('delete-profile-glm-5.2')).toHaveCount(0);
  });
});
