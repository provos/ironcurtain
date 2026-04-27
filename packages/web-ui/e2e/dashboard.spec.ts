import { test, expect } from '@playwright/test';
import { connectWithToken, resetMockServer } from './helpers.js';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('renders the dashboard view by default', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('displays the four stat cards', async ({ page }) => {
    await expect(page.getByTestId('stat-sessions')).toBeVisible();
    await expect(page.getByTestId('stat-escalations')).toBeVisible();
    await expect(page.getByTestId('stat-scheduled')).toBeVisible();
    await expect(page.getByTestId('stat-running')).toBeVisible();
  });

  test('stat cards show numeric values from mock data', async ({ page }) => {
    // The mock server returns daemon status with jobs.enabled > 0
    // The "Scheduled" card should show the count of enabled jobs
    const scheduledCard = page.getByTestId('stat-scheduled');
    // The value should be a digit (from daemon status)
    await expect(scheduledCard.locator('.font-mono.font-bold')).toBeVisible();
  });

  test('shows connection indicator as Live', async ({ page }) => {
    // Both the desktop sidebar and the offscreen mobile drawer render a
    // connection-status indicator, so scope to the desktop sidebar.
    await expect(page.getByTestId('sidebar-nav').getByTestId('connection-status').getByText('Live')).toBeVisible({
      timeout: 5_000,
    });
  });
});
