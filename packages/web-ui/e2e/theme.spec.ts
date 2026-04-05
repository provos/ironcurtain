import { test, expect } from '@playwright/test';
import { connectWithToken, resetMockServer } from './helpers.js';

test.describe('Theme switching', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('default theme is "iron"', async ({ page }) => {
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('iron');
  });

  test('opens the theme picker from the sidebar', async ({ page }) => {
    // The theme picker trigger shows "Theme: Iron" in the sidebar
    await page.getByText('Theme:', { exact: false }).click();

    // Theme options should appear
    await expect(page.getByText('Daylight')).toBeVisible();
    await expect(page.getByText('Midnight')).toBeVisible();
  });

  test('switching to Daylight changes the data-theme attribute', async ({ page }) => {
    await page.getByText('Theme:', { exact: false }).click();
    await page.getByText('Daylight').click();

    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('daylight');
  });

  test('switching to Midnight changes the data-theme attribute', async ({ page }) => {
    await page.getByText('Theme:', { exact: false }).click();
    await page.getByText('Midnight').click();

    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('midnight');
  });

  test('theme persists via localStorage', async ({ page }) => {
    // Switch to midnight
    await page.getByText('Theme:', { exact: false }).click();
    await page.getByText('Midnight').click();

    // Verify localStorage was updated
    const storedTheme = await page.evaluate(() => localStorage.getItem('ic-theme'));
    expect(storedTheme).toBe('midnight');
  });
});
