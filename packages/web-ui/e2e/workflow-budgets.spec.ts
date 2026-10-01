import { test, expect } from '@playwright/test';
import { connectWithToken, navigateTo, navigateToWorkflowsList, resetMockServer, sendMockRpc } from './helpers.js';
import {
  DEFAULT_RESOURCE_BUDGET,
  type ResourceBudgetFixture,
  type WorkflowBudgetFixture,
} from '../scripts/workflow-budget-fixtures.js';

test.describe('Resource budget contracts', () => {
  test.beforeEach(async ({ request }) => {
    await resetMockServer(request);
  });

  test('saves only resource settings, preserves snapshots, and resets defaults', async ({ request }) => {
    const originalRun = await sendMockRpc<WorkflowBudgetFixture>('workflows.getBudget', { workflowId: 'wf-mock-001' });
    const providers = await sendMockRpc('config.getModelProviders');
    const updated = { ...DEFAULT_RESOURCE_BUDGET, maxEstimatedCostUsd: null, maxSteps: 500 };
    expect(await sendMockRpc('config.setResourceBudget', updated)).toEqual(updated);
    expect(await sendMockRpc('config.getResourceBudget')).toEqual(updated);
    expect(await sendMockRpc('config.getModelProviders')).toEqual(providers);
    expect(await sendMockRpc('workflows.getBudget', { workflowId: 'wf-mock-001' })).toEqual(originalRun);

    const inherited = await sendMockRpc<WorkflowBudgetFixture>('workflows.getBudgetPreview', {
      definitionPath: '/home/user/.ironcurtain/workflows/my-custom-flow/workflow.yaml',
    });
    expect(inherited.limits).toEqual(updated);
    expect(Object.values(inherited.sources)).toEqual(Array(5).fill('global'));
    const overridden = await sendMockRpc<WorkflowBudgetFixture>('workflows.getBudgetPreview', {
      definitionPath: '/opt/ironcurtain/workflows/design-and-code/workflow.yaml',
    });
    expect(overridden.limits.maxEstimatedCostUsd).toBe(20);
    expect(overridden.sources.maxEstimatedCostUsd).toBe('workflow');
    expect(overridden.sources.maxSteps).toBe('global');

    await resetMockServer(request);
    expect(await sendMockRpc('config.getResourceBudget')).toEqual(DEFAULT_RESOURCE_BUDGET);
    const defaults = await sendMockRpc<WorkflowBudgetFixture>('workflows.getBudgetPreview', {
      definitionPath: '/home/user/.ironcurtain/workflows/my-custom-flow/workflow.yaml',
    });
    expect(Object.values(defaults.sources)).toEqual(Array(5).fill('default'));
  });

  test('rejects invalid limits and enforces the mutation gate before validation', async ({ request }) => {
    for (const invalid of [
      { ...DEFAULT_RESOURCE_BUDGET, maxSteps: 1.5 },
      { ...DEFAULT_RESOURCE_BUDGET, maxSteps: Number.MAX_SAFE_INTEGER + 1 },
      { ...DEFAULT_RESOURCE_BUDGET, maxEstimatedCostUsd: 0 },
      { ...DEFAULT_RESOURCE_BUDGET, warnThresholdPercent: 100 },
      { ...DEFAULT_RESOURCE_BUDGET, extra: true },
      { maxEstimatedCostUsd: 10 },
    ]) {
      await expect(sendMockRpc('config.setResourceBudget', invalid)).rejects.toThrow('INVALID_PARAMS');
    }
    expect(await sendMockRpc('config.getResourceBudget')).toEqual(DEFAULT_RESOURCE_BUDGET);
    await resetMockServer(request, { allowPolicyMutation: false });
    await expect(sendMockRpc('config.setResourceBudget', {})).rejects.toThrow('POLICY_MUTATION_FORBIDDEN');
    expect(await sendMockRpc('config.getResourceBudget')).toEqual(DEFAULT_RESOURCE_BUDGET);
    await expect(sendMockRpc('workflows.getBudget', { workflowId: 'missing' })).rejects.toThrow('WORKFLOW_NOT_FOUND');
    await expect(sendMockRpc('workflows.getBudgetPreview', { definitionPath: '/tmp/unknown.yaml' })).rejects.toThrow(
      'WORKFLOW_NOT_FOUND',
    );
    await expect(sendMockRpc('config.getResourceBudget', { extra: true })).rejects.toThrow('INVALID_PARAMS');
    await expect(sendMockRpc('workflows.getBudget', { workflowId: 'wf-mock-001', extra: true })).rejects.toThrow(
      'INVALID_PARAMS',
    );
  });

  test('resumes with saved limits unless current settings are explicitly requested', async () => {
    const saved = await sendMockRpc('workflows.getBudget', { workflowId: 'wf-mock-001' });
    await sendMockRpc('workflows.abort', { workflowId: 'wf-mock-001' });
    await sendMockRpc('config.setResourceBudget', { ...DEFAULT_RESOURCE_BUDGET, maxSteps: 500 });
    await sendMockRpc('workflows.resume', { workflowId: 'wf-mock-001' });
    expect(await sendMockRpc('workflows.getBudget', { workflowId: 'wf-mock-001' })).toEqual(saved);
    await sendMockRpc('workflows.abort', { workflowId: 'wf-mock-001' });
    await sendMockRpc('workflows.resume', { workflowId: 'wf-mock-001', useCurrentBudget: true });
    const current = await sendMockRpc<WorkflowBudgetFixture>('workflows.getBudget', { workflowId: 'wf-mock-001' });
    expect(current.limits.maxSteps).toBe(500);
    expect(current.sources.maxSteps).toBe('global');
  });
});

test.describe('Workflow budget UI', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('previews effective limits with workflow provenance before starting', async ({ page }) => {
    await navigateToWorkflowsList(page);
    await page
      .getByLabel('Workflow definition')
      .selectOption('/opt/ironcurtain/workflows/design-and-code/workflow.yaml');
    const preview = page.getByTestId('workflow-budget-preview');
    await expect(preview).toBeVisible();
    await expect(preview.getByTestId('budget-maxEstimatedCostUsd')).toContainText('20');
    await expect(preview.getByTestId('budget-maxEstimatedCostUsd')).toContainText(/workflow/i);
    if (process.env.WORKFLOW_BUDGET_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.WORKFLOW_BUDGET_SCREENSHOT_DIR}/desktop-preview.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.getByLabel('Workflow definition').selectOption('/opt/ironcurtain/workflows/code-review/workflow.yaml');
    await expect(preview.getByTestId('budget-maxEstimatedCostUsd')).toContainText('Disabled');
  });

  test('shows cap warnings and distinguishes session usage from workflow totals', async ({ page }) => {
    await navigateToWorkflowsList(page);
    await page.locator('tr', { hasText: 'design-and-code' }).click();
    const panel = page.getByTestId('workflow-budget-detail');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('budget-maxEstimatedCostUsd')).toContainText('20');
    await expect(panel.getByTestId('budget-maxEstimatedCostUsd')).toContainText('17');
    await expect(panel).toContainText(/session/i);
    await expect(panel).toContainText('Near limit');
    if (process.env.WORKFLOW_BUDGET_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.WORKFLOW_BUDGET_SCREENSHOT_DIR}/desktop-detail.png`,
        fullPage: true,
        animations: 'disabled',
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(panel).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({
        path: `${process.env.WORKFLOW_BUDGET_SCREENSHOT_DIR}/mobile-detail.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
  });

  test('disabled limits do not invent usage while waiting at a gate', async ({ page }) => {
    await navigateToWorkflowsList(page);
    await page.locator('tr', { hasText: 'code-review' }).click();
    const panel = page.getByTestId('workflow-budget-detail');
    await expect(panel.getByTestId('budget-maxEstimatedCostUsd')).toContainText('Disabled');
    await expect(panel).toContainText(/unavailable|no .*usage|not .*available/i);
  });

  test('identifies legacy runs without recorded historical budgets', async ({ page, request }) => {
    await resetMockServer(request, { workflowBudgetScenario: 'legacy' });
    await page.reload();
    await connectWithToken(page);
    await navigateToWorkflowsList(page);
    await page.locator('tr', { hasText: 'design-and-code' }).click();
    await expect(page.getByTestId('workflow-budget-detail')).toContainText(/did not record|unknown|legacy/i);
  });

  test('saves settings, round-trips disabled cost, and keeps existing run limits', async ({ page }) => {
    await navigateTo(page, 'Settings');
    const settings = page.getByTestId('resource-limits-settings');
    await expect(settings).toBeVisible();
    await settings.getByTestId('budget-input-maxSteps').fill('500');
    await settings.getByTestId('budget-disable-maxEstimatedCostUsd').check();
    await settings.getByTestId('budget-save').click();
    await expect
      .poll(async () => (await sendMockRpc<ResourceBudgetFixture>('config.getResourceBudget')).maxSteps)
      .toBe(500);
    expect((await sendMockRpc<ResourceBudgetFixture>('config.getResourceBudget')).maxEstimatedCostUsd).toBeNull();
    await page.reload();
    await connectWithToken(page);
    await navigateTo(page, 'Settings');
    await expect(settings.getByTestId('budget-input-maxSteps')).toHaveValue('500');
    await expect(settings.getByTestId('budget-disable-maxEstimatedCostUsd')).toBeChecked();
    if (process.env.WORKFLOW_BUDGET_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.WORKFLOW_BUDGET_SCREENSHOT_DIR}/desktop-settings.png`,
        fullPage: true,
        animations: 'disabled',
      });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({
        path: `${process.env.WORKFLOW_BUDGET_SCREENSHOT_DIR}/mobile-settings.png`,
        fullPage: true,
        animations: 'disabled',
      });
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    await navigateToWorkflowsList(page);
    await page
      .getByLabel('Workflow definition')
      .selectOption('/home/user/.ironcurtain/workflows/my-custom-flow/workflow.yaml');
    await expect(page.getByTestId('workflow-budget-preview').getByTestId('budget-maxSteps')).toContainText('500');
    await page.locator('tr', { hasText: 'design-and-code' }).click();
    await expect(page.getByTestId('workflow-budget-detail').getByTestId('budget-maxSteps')).toContainText('200');
  });

  test('hides save/reset and disables editing on a read-only daemon', async ({ page, request }) => {
    await resetMockServer(request, { allowPolicyMutation: false });
    await page.reload();
    await connectWithToken(page);
    await navigateTo(page, 'Settings');
    const settings = page.getByTestId('resource-limits-settings');
    await expect(settings).toBeVisible();
    await expect(settings.getByTestId('budget-input-maxSteps')).toBeDisabled();
    await expect(settings.getByTestId('budget-save')).toHaveCount(0);
    await expect(settings.getByTestId('budget-reset')).toHaveCount(0);
  });

  test('resume control explicitly applies current limits to a saved run', async ({ page }) => {
    await sendMockRpc('workflows.abort', { workflowId: 'wf-mock-001' });
    await sendMockRpc('config.setResourceBudget', { ...DEFAULT_RESOURCE_BUDGET, maxSteps: 500 });
    await navigateToWorkflowsList(page);
    const currentSettings = page.getByTestId('resume-use-current-budget');
    await expect(currentSettings).not.toBeChecked();
    await currentSettings.check();
    await page.getByTestId('resume-wf-mock-001').click();
    await expect
      .poll(
        async () =>
          (await sendMockRpc<WorkflowBudgetFixture>('workflows.getBudget', { workflowId: 'wf-mock-001' })).limits
            .maxSteps,
      )
      .toBe(500);
  });
});
