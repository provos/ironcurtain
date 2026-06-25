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

test.describe('Persona CRUD (Phase 1c)', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('create a persona -> it appears in the list', async ({ page }) => {
    await navigateTo(page, 'Personas');
    await expect(page.getByRole('heading', { name: 'Personas', exact: true })).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('new-persona-button').click();
    await page.getByTestId('new-persona-name').fill('quality-eng');
    await page.getByTestId('new-persona-description').fill('Quality engineering persona');
    await page.getByTestId('create-persona-button').click();

    // The create flow drills into the new persona's detail view.
    await expect(page.getByRole('heading', { name: 'quality-eng', exact: true })).toBeVisible({ timeout: 10_000 });

    // Back to the list: the persona is present (driven by personas.changed refresh).
    await page.getByRole('button', { name: /Back/ }).click();
    await expect(page.locator('tr', { hasText: 'quality-eng' })).toBeVisible({ timeout: 10_000 });
  });

  test('duplicate name shows an inline PERSONA_EXISTS error', async ({ page }) => {
    await navigateTo(page, 'Personas');
    await expect(page.getByRole('heading', { name: 'Personas', exact: true })).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('new-persona-button').click();
    await page.getByTestId('new-persona-name').fill('default'); // already exists
    await page.getByTestId('new-persona-description').fill('dup');
    await page.getByTestId('create-persona-button').click();

    await expect(page.getByTestId('new-persona-name-error')).toBeVisible({ timeout: 10_000 });
  });

  test('edit constitution on a compiled persona shows the stale badge', async ({ page }) => {
    await openPersonaDetail(page, 'default'); // default has a compiled policy
    await expect(page.getByText('Policy compiled', { exact: true })).toBeVisible();

    const editor = page.getByTestId('constitution-editor');
    await editor.fill('# Default Persona (edited)\n\n- Allow read operations\n');
    await page.getByTestId('save-constitution-button').click();

    await expect(page.getByTestId('stale-badge')).toBeVisible({ timeout: 10_000 });
  });

  test('memory toggle persists via setMemory', async ({ page }) => {
    await openPersonaDetail(page, 'default');
    const toggle = page.getByTestId('memory-toggle');
    await expect(toggle).toBeChecked(); // default memory = true
    await toggle.click();
    await expect(toggle).not.toBeChecked();
  });

  test('broad-policy opt-in toggle persists', async ({ page }) => {
    await openPersonaDetail(page, 'default');
    const toggle = page.getByTestId('broad-policy-toggle');
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
  });

  test('soft-delete removes the persona from the list', async ({ page }) => {
    await openPersonaDetail(page, 'researcher');
    await page.getByTestId('delete-button').click();
    await expect(page.getByTestId('confirm-delete-button')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('confirm-delete-button').click();

    // Returns to the list; researcher is gone.
    await expect(page.getByRole('heading', { name: 'Personas', exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('tr', { hasText: 'researcher' })).toHaveCount(0, { timeout: 10_000 });
  });

  test('force-delete revokes (removes) the persona', async ({ page }) => {
    await openPersonaDetail(page, 'researcher');
    await page.getByTestId('delete-button').click();
    await page.getByTestId('delete-force').check();
    await page.getByTestId('confirm-delete-button').click();

    await expect(page.getByRole('heading', { name: 'Personas', exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('tr', { hasText: 'researcher' })).toHaveCount(0, { timeout: 10_000 });
  });

  test('ruleDelta is shown on the done card after a recompile', async ({ page }) => {
    // `default` already has a compiled policy, so a recompile emits a ruleDelta.
    await openPersonaDetail(page, 'default');
    await page.getByTestId('compile-button').click();

    await expect(page.getByTestId('compile-success')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('rule-delta')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('rule-delta')).toContainText('added');
  });
});

test.describe('Persona mutation gating (flag OFF)', () => {
  test.beforeEach(async ({ page, request }) => {
    // Simulate a daemon launched WITHOUT --allow-policy-mutation.
    await resetMockServer(request, { allowPolicyMutation: false });
    await connectWithToken(page);
  });

  test('mutation controls are hidden when policy mutation is disabled', async ({ page }) => {
    await navigateTo(page, 'Personas');
    await expect(page.getByRole('heading', { name: 'Personas', exact: true })).toBeVisible({ timeout: 10_000 });

    // No "New persona" button in the list view.
    await expect(page.getByTestId('new-persona-button')).toHaveCount(0);

    // Drill into a persona; detail-view mutation controls are absent.
    await page.locator('tr', { hasText: 'default' }).click();
    await expect(page.getByRole('heading', { name: 'default', exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('compile-button')).toHaveCount(0);
    // The whole compile card is dropped (not rendered as an empty box) when
    // mutation is off, since every child requires a compile.
    await expect(page.getByTestId('compile-card')).toHaveCount(0);
    await expect(page.getByTestId('delete-button')).toHaveCount(0);
    await expect(page.getByTestId('constitution-editor')).toHaveCount(0);
    await expect(page.getByTestId('memory-toggle')).toHaveCount(0);
    await expect(page.getByTestId('broad-policy-toggle')).toHaveCount(0);
  });
});
