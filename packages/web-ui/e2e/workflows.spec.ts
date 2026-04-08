import { test, expect } from '@playwright/test';
import { connectWithToken, navigateTo, resetMockServer } from './helpers.js';

test.describe('Workflow Dashboard', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
    await navigateTo(page, 'Workflows');
  });

  test('shows the workflow list with active workflows', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();

    // The mock server seeds two workflows: design-and-code (running) and code-review (waiting_human)
    // Use table cell locators to avoid matching dropdown options that also contain these names
    await expect(page.getByRole('cell', { name: 'design-and-code' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'code-review' })).toBeVisible();
  });

  test('displays phase badges for each workflow', async ({ page }) => {
    // "running" badge for design-and-code
    const runningRow = page.locator('tr', { hasText: 'design-and-code' });
    await expect(runningRow.getByText('running')).toBeVisible();

    // "waiting human" badge for code-review
    const waitingRow = page.locator('tr', { hasText: 'code-review' });
    await expect(waitingRow.getByText('waiting human')).toBeVisible();
  });

  test('shows current state for each workflow', async ({ page }) => {
    const runningRow = page.locator('tr', { hasText: 'design-and-code' });
    await expect(runningRow.getByText('implement')).toBeVisible();

    const waitingRow = page.locator('tr', { hasText: 'code-review' });
    await expect(waitingRow.getByText('plan_review')).toBeVisible();
  });
});

test.describe('Start Workflow', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
    await navigateTo(page, 'Workflows');
  });

  test('starts a new workflow via the form', async ({ page }) => {
    // Select the custom path option to reveal the definition file path input
    await page.getByLabel('Workflow definition').selectOption('__custom__');
    // Fill in the start form
    await page.getByLabel('Definition file path').fill('/path/to/design-and-code.json');
    await page.getByLabel('Task description').fill('Implement a feature');

    // Start button should be enabled
    const startButton = page.getByRole('button', { name: 'Start Workflow' });
    await expect(startButton).toBeEnabled();
    await startButton.click();

    // A new workflow should appear in the list (the mock derives the name from the file path)
    await expect(page.getByText('design-and-code').first()).toBeVisible({ timeout: 5_000 });
  });

  test('new workflow transitions to waiting_human after lifecycle simulation', async ({ page }) => {
    await page.getByLabel('Workflow definition').selectOption('__custom__');
    await page.getByLabel('Definition file path').fill('/path/to/my-workflow.json');
    await page.getByLabel('Task description').fill('Run the workflow');

    await page.getByRole('button', { name: 'Start Workflow' }).click();

    // The mock server simulates: plan -> plan_review (gate) after 4 seconds.
    // When the gate is raised, the auto-select $effect opens the detail view for
    // my-workflow, which shows the gate review panel. Wait for that panel to appear.
    await expect(page.getByText('Review Required')).toBeVisible({ timeout: 10_000 });
    // Verify we are looking at the correct workflow
    await expect(page.getByRole('heading', { name: 'my-workflow' })).toBeVisible();
  });

  test('start button is disabled when required fields are empty', async ({ page }) => {
    const startButton = page.getByRole('button', { name: 'Start Workflow' });
    await expect(startButton).toBeDisabled();

    // Select custom path and fill definition path -- still disabled (no task description)
    await page.getByLabel('Workflow definition').selectOption('__custom__');
    await page.getByLabel('Definition file path').fill('/some/path.json');
    await expect(startButton).toBeDisabled();

    // Fill task description -- now enabled
    await page.getByLabel('Task description').fill('A task');
    await expect(startButton).toBeEnabled();
  });
});

test.describe('Workflow Detail View', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
    await navigateTo(page, 'Workflows');
  });

  test('clicking a workflow row opens the detail view', async ({ page }) => {
    await page.locator('tr', { hasText: 'design-and-code' }).click();

    // Detail view should show the workflow name and a back button
    await expect(page.getByRole('button', { name: /Back/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'design-and-code' })).toBeVisible();
  });

  test('detail view renders the state machine graph SVG', async ({ page }) => {
    await page.locator('tr', { hasText: 'design-and-code' }).click();

    // The SVG should be rendered with the correct aria-label
    const svg = page.locator('svg[aria-label="Workflow state machine graph"]');
    await expect(svg).toBeVisible({ timeout: 5_000 });
    await expect(svg).toHaveAttribute('aria-label', 'Workflow state machine graph');

    // SVG should contain path elements (node shapes drawn via <path>)
    const paths = svg.locator('path');
    expect(await paths.count()).toBeGreaterThan(0);
  });

  test('state machine graph shows node labels', async ({ page }) => {
    await page.locator('tr', { hasText: 'design-and-code' }).click();

    const svg = page.locator('svg[aria-label="Workflow state machine graph"]');
    await expect(svg).toBeVisible({ timeout: 5_000 });

    // The design-and-code graph includes these states: Plan, Plan Review, Implement, etc.
    // Use exact match to avoid matching substrings (e.g., "Plan" in "Plan Review")
    await expect(svg.getByText('Plan', { exact: true })).toBeVisible();
    await expect(svg.getByText('Implement', { exact: true })).toBeVisible();
    await expect(svg.getByText('Review', { exact: true })).toBeVisible();
  });

  test('detail view shows context info cards', async ({ page }) => {
    await page.locator('tr', { hasText: 'design-and-code' }).click();

    // Wait for detail to load
    await expect(page.locator('svg[aria-label="Workflow state machine graph"]')).toBeVisible({ timeout: 5_000 });

    // Context cards: Round, Total Tokens, Workspace, Description
    await expect(page.getByText('Round')).toBeVisible();
    await expect(page.getByText('Total Tokens')).toBeVisible();
    // Use paragraph locator to avoid matching the collapsible "▸ Workspace" button
    await expect(page.getByRole('paragraph').filter({ hasText: 'Workspace' })).toBeVisible();
  });

  test('back button returns to the workflow list', async ({ page }) => {
    await page.locator('tr', { hasText: 'design-and-code' }).click();

    // Verify detail view is showing
    await expect(page.getByRole('button', { name: /Back/ })).toBeVisible();

    // Click back
    await page.getByRole('button', { name: /Back/ }).click();

    // Should see the workflow list heading again
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
  });
});

test.describe('Gate Review Panel', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
    await navigateTo(page, 'Workflows');
  });

  test('gate review panel appears for waiting workflow', async ({ page }) => {
    // code-review is in waiting_human phase at plan_review gate
    await page.locator('tr', { hasText: 'code-review' }).click();

    // Wait for detail to load and gate panel to appear
    await expect(page.getByText('Review Required')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Waiting for Review')).toBeVisible();

    // Summary text from mock gate
    await expect(page.getByText('Waiting for human review at plan_review')).toBeVisible();
  });

  test('gate panel shows action buttons', async ({ page }) => {
    await page.locator('tr', { hasText: 'code-review' }).click();

    await expect(page.getByText('Review Required')).toBeVisible({ timeout: 5_000 });

    // Check the available action buttons
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request Revision' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Abort Workflow' })).toBeVisible();
  });

  test('gate panel shows presented artifacts', async ({ page }) => {
    await page.locator('tr', { hasText: 'code-review' }).click();

    await expect(page.getByText('Review Required')).toBeVisible({ timeout: 5_000 });

    // The mock gate has presentedArtifacts: ['plan']
    // Use exact match to avoid the tab button "Artifacts (1)" that also contains the word
    await expect(page.getByText('Artifacts', { exact: true })).toBeVisible();
    // The artifact name is rendered as a Badge; use exact match to avoid matching
    // "plan_review", "Replan", etc.
    await expect(page.getByText('plan', { exact: true })).toBeVisible();
  });

  test('approving a gate dismisses the panel and resumes workflow', async ({ page }) => {
    await page.locator('tr', { hasText: 'code-review' }).click();

    await expect(page.getByText('Review Required')).toBeVisible({ timeout: 5_000 });

    // Click Approve
    await page.getByRole('button', { name: 'Approve' }).click();

    // Gate panel should disappear
    await expect(page.getByText('Review Required')).not.toBeVisible({ timeout: 5_000 });

    // Phase should change to running
    await expect(page.getByText('running')).toBeVisible({ timeout: 5_000 });
  });

  test('requesting revision shows feedback textarea', async ({ page }) => {
    await page.locator('tr', { hasText: 'code-review' }).click();

    await expect(page.getByText('Review Required')).toBeVisible({ timeout: 5_000 });

    // Click "Request Revision" -- first click shows the feedback form
    await page.getByRole('button', { name: 'Request Revision' }).click();

    // Feedback textarea and submit button should appear
    await expect(page.getByLabel('Revision feedback')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit Revision' })).toBeVisible();

    // Submit is disabled until feedback is provided
    await expect(page.getByRole('button', { name: 'Submit Revision' })).toBeDisabled();
  });

  test('submitting revision feedback resolves the gate', async ({ page }) => {
    await page.locator('tr', { hasText: 'code-review' }).click();

    await expect(page.getByText('Review Required')).toBeVisible({ timeout: 5_000 });

    // Open feedback form
    await page.getByRole('button', { name: 'Request Revision' }).click();

    // Type feedback
    await page.getByLabel('Revision feedback').fill('Please fix the error handling in step 3');

    // Submit
    await page.getByRole('button', { name: 'Submit Revision' }).click();

    // Gate panel should disappear
    await expect(page.getByText('Review Required')).not.toBeVisible({ timeout: 5_000 });

    // Phase should be running (revision sends FORCE_REVISION which resumes at plan)
    await expect(page.getByText('running')).toBeVisible({ timeout: 5_000 });
  });

  test('cancelling feedback hides the textarea', async ({ page }) => {
    await page.locator('tr', { hasText: 'code-review' }).click();

    await expect(page.getByText('Review Required')).toBeVisible({ timeout: 5_000 });

    // Open feedback form
    await page.getByRole('button', { name: 'Request Revision' }).click();
    await expect(page.getByLabel('Revision feedback')).toBeVisible();

    // Cancel
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Textarea should be hidden, action buttons visible again
    await expect(page.getByLabel('Revision feedback')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  });

  test('abort workflow from gate shows confirmation then aborts', async ({ page }) => {
    await page.locator('tr', { hasText: 'code-review' }).click();

    await expect(page.getByText('Review Required')).toBeVisible({ timeout: 5_000 });

    // First click shows confirmation
    await page.getByRole('button', { name: 'Abort Workflow' }).click();

    // Confirmation message and button should appear
    await expect(page.getByText('Are you sure you want to abort this workflow?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm Abort' })).toBeVisible();

    // Confirm the abort
    await page.getByRole('button', { name: 'Confirm Abort' }).click();

    // Gate panel should disappear and phase should change.
    // The mock server broadcasts workflow.failed which sets phase to "failed"
    // (the "aborted" distinction is only visible after a workflows.list refresh).
    await expect(page.getByText('Review Required')).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('failed')).toBeVisible({ timeout: 5_000 });
  });

  test('cancelling abort confirmation returns to action buttons', async ({ page }) => {
    await page.locator('tr', { hasText: 'code-review' }).click();

    await expect(page.getByText('Review Required')).toBeVisible({ timeout: 5_000 });

    // Open abort confirmation
    await page.getByRole('button', { name: 'Abort Workflow' }).click();
    await expect(page.getByText('Are you sure you want to abort this workflow?')).toBeVisible();

    // Cancel
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Confirmation should hide, action buttons should return
    await expect(page.getByText('Are you sure you want to abort this workflow?')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  });
});

test.describe('Gate Count Badge', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('workflows nav item shows gate count badge', async ({ page }) => {
    // The mock server initializes with one pending gate (code-review at plan_review),
    // but pendingGates only gets populated when a workflow detail is loaded (via
    // workflows.get) or a gate_raised event is broadcast. Navigate to Workflows and
    // open the code-review detail to seed the gate into appState.pendingGates.
    await navigateTo(page, 'Workflows');
    await page.locator('tr', { hasText: 'code-review' }).click();
    await expect(page.getByText('Review Required')).toBeVisible({ timeout: 5_000 });

    // Go back to the list then to Dashboard to verify the badge persists
    await page.getByRole('button', { name: /Back/ }).click();
    await navigateTo(page, 'Dashboard');

    // The Workflows nav button should show a badge with the gate count
    const workflowsNav = page.locator('nav').locator('button', { hasText: 'Workflows' });
    await expect(workflowsNav.locator('.font-mono')).toBeVisible({ timeout: 5_000 });
  });

  test('gate badge disappears after resolving all gates', async ({ page }) => {
    // Navigate to workflows and open the waiting workflow
    await navigateTo(page, 'Workflows');
    await page.locator('tr', { hasText: 'code-review' }).click();

    // Wait for gate panel
    await expect(page.getByText('Review Required')).toBeVisible({ timeout: 5_000 });

    // Approve the gate
    await page.getByRole('button', { name: 'Approve' }).click();

    // Gate panel should disappear
    await expect(page.getByText('Review Required')).not.toBeVisible({ timeout: 5_000 });

    // Go back to list and check the badge is gone
    await page.getByRole('button', { name: /Back/ }).click();

    // The badge should no longer be visible in the nav
    const workflowsNav = page.locator('nav').locator('button', { hasText: 'Workflows' });
    await expect(workflowsNav.locator('.font-mono')).not.toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Workflow List Actions', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
    await navigateTo(page, 'Workflows');
  });

  test('abort button in workflow list triggers confirmation and aborts', async ({ page }) => {
    // The running workflow row should have an Abort button
    const runningRow = page.locator('tr', { hasText: 'design-and-code' });
    const abortButton = runningRow.getByRole('button', { name: 'Abort' });
    await expect(abortButton).toBeVisible();

    // Clicking Abort triggers a browser confirm() dialog -- accept it
    page.on('dialog', (dialog) => dialog.accept());
    await abortButton.click();

    // After abort, the workflow should change phase.
    // Both the phase badge and currentState cell show "aborted"; use first() to avoid strict mode error.
    await expect(runningRow.getByText('aborted').first()).toBeVisible({ timeout: 5_000 });
  });
});
