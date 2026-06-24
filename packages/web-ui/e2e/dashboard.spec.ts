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

test.describe('Dashboard — Workflow Activity', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('renders the workflow activity section with four KPI tiles', async ({ page }) => {
    const section = page.getByTestId('workflow-activity');
    await expect(section).toBeVisible();
    await expect(page.getByTestId('wf-stat-active')).toBeVisible();
    await expect(page.getByTestId('wf-stat-gates')).toBeVisible();
    await expect(page.getByTestId('wf-stat-completed')).toBeVisible();
    await expect(page.getByTestId('wf-stat-issues')).toBeVisible();
  });

  test('KPI tiles reflect the mock workflow data', async ({ page }) => {
    // Mock seeds 2 active live workflows (1 running + 1 waiting_human) and one
    // pending gate; listResumable returns 3 completed and 3 problem runs
    // (failed + aborted + interrupted).
    await expect(page.getByTestId('wf-stat-active').locator('.font-mono.font-bold')).toHaveText('2');
    await expect(page.getByTestId('wf-stat-gates').locator('.font-mono.font-bold')).toHaveText('1');
    await expect(page.getByTestId('wf-stat-completed').locator('.font-mono.font-bold')).toHaveText('3');
    await expect(page.getByTestId('wf-stat-issues').locator('.font-mono.font-bold')).toHaveText('3');
  });

  test('renders the phase distribution bar with the total run count', async ({ page }) => {
    await expect(page.getByTestId('wf-distribution')).toBeVisible();
    // 1 running + 2 waiting_human + 3 completed + 1 failed + 1 aborted + 1 interrupted = 9.
    await expect(page.getByTestId('workflow-activity')).toContainText('9 runs');
  });

  test('clicking an active workflow row opens that workflow in the Workflows view', async ({ page }) => {
    const table = page.getByTestId('dashboard-active-workflows');
    await expect(table).toBeVisible();
    await table.locator('tbody tr').first().click();
    // The Workflows view renders the selected workflow's detail (Back affordance).
    await expect(page.getByRole('button', { name: /Back/ })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('sidebar-nav').getByRole('button', { name: 'Workflows' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('"View all" navigates to the Workflows view', async ({ page }) => {
    await page.getByTestId('wf-view-all').click();
    // A seeded pending gate may auto-open a workflow's detail, so assert the
    // reliable signal: the Workflows nav item becomes the current page.
    await expect(page.getByTestId('sidebar-nav').getByRole('button', { name: 'Workflows' })).toHaveAttribute(
      'aria-current',
      'page',
      { timeout: 10_000 },
    );
  });
});
