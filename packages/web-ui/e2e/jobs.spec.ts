import { test, expect } from '@playwright/test';
import { connectWithToken, navigateTo, resetMockServer } from './helpers.js';

test.describe('Jobs', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
    await navigateTo(page, 'Jobs');
  });

  test('renders the job table with mock jobs', async ({ page }) => {
    await expect(page.getByText('Daily Security Scan')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Weekly Status Report')).toBeVisible();
    await expect(page.getByText('PR Review Helper')).toBeVisible();
  });

  test('shows enabled/disabled status for each job', async ({ page }) => {
    // "Daily Security Scan" and "Weekly Status Report" are enabled
    // "PR Review Helper" is disabled
    await expect(page.getByText('Daily Security Scan')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('disabled')).toBeVisible();
  });

  test('clicking Run triggers a job run', async ({ page }) => {
    await expect(page.getByText('Daily Security Scan')).toBeVisible({ timeout: 5_000 });

    // Find the row for the first enabled job and click Run
    const firstRow = page.locator('tr', { hasText: 'Daily Security Scan' });
    await firstRow.getByRole('button', { name: 'Run' }).click();

    // The mock server broadcasts job.started, which triggers a jobs.list refresh.
    // The refreshed list shows isRunning=true, rendering a "running" badge.
    await expect(firstRow.getByText('running')).toBeVisible({ timeout: 5_000 });
  });

  test('clicking Disable on an enabled job changes its status', async ({ page }) => {
    await expect(page.getByText('Daily Security Scan')).toBeVisible({ timeout: 5_000 });

    const row = page.locator('tr', { hasText: 'Daily Security Scan' });
    await row.getByRole('button', { name: 'Disable' }).click();

    // After disable, the mock server broadcasts job.list_changed,
    // which triggers a refresh. The row should now show "Enable" button
    // instead of "Disable"
    await expect(row.getByRole('button', { name: 'Enable' })).toBeVisible({ timeout: 5_000 });
  });

  test('shows schedule cron expression', async ({ page }) => {
    await expect(page.getByText('Daily Security Scan')).toBeVisible({ timeout: 5_000 });
    // The daily scan has cron "0 2 * * *"
    await expect(page.getByText('0 2 * * *')).toBeVisible();
  });

  test('shows last run outcome badge', async ({ page }) => {
    await expect(page.getByText('Daily Security Scan')).toBeVisible({ timeout: 5_000 });
    // The daily scan has a "success" last run
    await expect(page.getByText('success').first()).toBeVisible();
  });
});
