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
    // The mobile drawer also renders a ThemePicker bound to the same
    // showThemePicker state, so its menu items appear in the DOM too.
    // Scope to the desktop sidebar to avoid strict-mode violations.
    const sidebar = page.getByTestId('sidebar-nav');
    await sidebar.getByText('Theme:', { exact: false }).click();

    // Theme options should appear in the desktop sidebar's dropdown
    await expect(sidebar.getByText('Daylight')).toBeVisible();
    await expect(sidebar.getByText('Midnight')).toBeVisible();
  });

  test('switching to Daylight updates the dashboard card theme', async ({ page }) => {
    const sidebar = page.getByTestId('sidebar-nav');
    const sessionsCard = page.getByTestId('stat-sessions');
    await expect(sessionsCard).toHaveCSS('background-color', 'rgb(22, 24, 29)');
    await sidebar.getByText('Theme:', { exact: false }).click();
    await sidebar.getByText('Daylight').click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'daylight');
    await expect(sessionsCard).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  });

  test('switching to Midnight changes the data-theme attribute', async ({ page }) => {
    const sidebar = page.getByTestId('sidebar-nav');
    await sidebar.getByText('Theme:', { exact: false }).click();
    await sidebar.getByText('Midnight').click();

    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('midnight');
  });

  test('theme persists via localStorage', async ({ page }) => {
    const sidebar = page.getByTestId('sidebar-nav');
    await sidebar.getByText('Theme:', { exact: false }).click();
    await sidebar.getByText('Midnight').click();

    // Verify localStorage was updated
    const storedTheme = await page.evaluate(() => localStorage.getItem('ic-theme'));
    expect(storedTheme).toBe('midnight');
  });
});
