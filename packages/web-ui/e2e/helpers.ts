import { expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';
import { WebSocket } from 'ws';

export const PTY_BANNER_TEXT = 'Type to send keystrokes';
export const PTY_LIVE_FRAME_TEXT = '[mock] agent working';

/**
 * Reset the mock server's mutable state so tests are isolated. Pass
 * `allowPolicyMutation: false` to simulate a daemon launched WITHOUT
 * `--allow-policy-mutation` (persona-mutation controls hidden).
 */
export async function resetMockServer(
  request: APIRequestContext,
  opts?: { allowPolicyMutation?: boolean },
): Promise<void> {
  await request.post('http://localhost:7401/__reset', opts ? { data: opts } : undefined);
}

/**
 * Navigate to the app with the mock server's test token and wait
 * for the WebSocket connection to establish (sidebar becomes visible).
 */
export async function connectWithToken(page: Page): Promise<void> {
  await page.goto('/?token=mock-dev-token');
  // The sidebar nav appears only after the auth gate is passed and
  // the WS connection is established (appState.connected becomes true).
  // Target the desktop sidebar by test id; the mobile drawer also
  // renders a <nav> in the DOM (offscreen) so a bare 'nav' selector
  // would hit a strict-mode violation.
  await expect(page.getByTestId('sidebar-nav')).toBeVisible({ timeout: 10_000 });
}

/**
 * Click a navigation item in the sidebar by its label text.
 */
export async function navigateTo(
  page: Page,
  view: 'Dashboard' | 'Sessions' | 'Escalations' | 'Jobs' | 'Workflows' | 'Personas' | 'Settings',
): Promise<void> {
  await page.getByTestId('sidebar-nav').getByRole('button', { name: view }).click();
}

/**
 * Navigate to the Workflows list view, dismissing any auto-opened detail view.
 *
 * The mock server seeds a workflow in `waiting_human` phase, and on connect
 * the store fetches its gate and populates `pendingGates`. The Workflows.svelte
 * auto-select effect then opens the detail view of that workflow. Tests that
 * need the list view must wait for the auto-select to settle, then dismiss the
 * detail view.
 */
export async function navigateToWorkflowsList(page: Page): Promise<void> {
  // Wait for the gate fetch to complete before navigating so the auto-select
  // effect has fired by the time we land on the Workflows view. The gate badge
  // on the sidebar's Workflows nav item is the visible signal that
  // pendingGates is populated.
  const workflowsNavBadge = page
    .getByTestId('sidebar-nav')
    .locator('button', { hasText: 'Workflows' })
    .locator('.font-mono');
  await expect(workflowsNavBadge).toBeVisible({ timeout: 10_000 });

  await navigateTo(page, 'Workflows');

  // Auto-select may now be opening the detail view; click Back if so.
  const heading = page.getByRole('heading', { name: 'Workflows', exact: true });
  const backButton = page.getByRole('button', { name: /Back/ });
  await expect(heading.or(backButton).first()).toBeVisible({ timeout: 10_000 });
  if (await backButton.isVisible().catch(() => false)) {
    await backButton.click();
  }
  await expect(heading).toBeVisible({ timeout: 5_000 });
}

/**
 * Clear the seeded code-review gate so subsequent actions (e.g., starting a
 * new workflow that raises a gate) won't trigger the auto-select effect
 * navigating away to the seeded workflow's detail view.
 *
 * Assumes we are on the Workflows list view with code-review present.
 */
export async function approveSeededGate(page: Page): Promise<void> {
  await page.locator('tr', { hasText: 'code-review' }).click();
  await expect(page.getByText('Review Required')).toBeVisible({ timeout: 5_000 });
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Review Required')).not.toBeVisible({ timeout: 5_000 });
  // Return to the list view; the gate badge should be gone.
  await page.getByRole('button', { name: /Back/ }).click();
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible({ timeout: 5_000 });
}

/**
 * Create a new session using the visible launcher and explicit start button.
 * Returns the session label text (e.g., "#1").
 */
export async function createDefaultSession(page: Page): Promise<string> {
  await navigateTo(page, 'Sessions');

  await expect(page.getByTestId('launch-start')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('launch-workspace')).toBeVisible();
  await expect(page.getByTestId('launch-provider')).toBeVisible();
  await expect(page.getByTestId('launch-persona')).toBeVisible();
  await page.getByTestId('launch-start').click();

  // Wait for a session entry to appear in the sidebar list.
  // Session items have data-testid="session-item-{label}"
  const sessionItem = page.locator('[data-testid^="session-item-"]').first();
  await expect(sessionItem).toBeVisible({ timeout: 5_000 });

  // Extract the label text (e.g., "#1") from the session item
  const labelSpan = sessionItem.locator('.font-mono', { hasText: /^#\d+$/ });
  const label = (await labelSpan.textContent()) ?? '';

  // Click the session item to select it
  await sessionItem.click();
  return label;
}

export function sessionLabelNumber(labelText: string): number {
  const match = labelText.match(/#(\d+)/);
  if (!match) throw new Error(`Could not parse session label from "${labelText}"`);
  return Number(match[1]);
}

export function ptyRows(page: Page): Locator {
  return page.getByTestId('pty-terminal').locator('.xterm-rows');
}

export async function waitForPtyTerminal(page: Page): Promise<void> {
  await expect(page.getByTestId('pty-terminal')).toBeVisible({ timeout: 10_000 });
  await expect(ptyRows(page)).toContainText(PTY_BANNER_TEXT, { timeout: 15_000 });
}

export async function focusPtyTerminal(page: Page): Promise<void> {
  await page.locator('.xterm-screen').click();
}

/**
 * Deliver a full string to xterm as one input frame. Browser paste maps to a
 * single `sessions.ptyInput`, unlike keyboard typing which fires per key.
 */
export async function pasteIntoPtyTerminal(page: Page, text: string): Promise<void> {
  await focusPtyTerminal(page);
  await page.evaluate((value) => {
    const textarea = document.querySelector('.xterm-helper-textarea');
    if (!textarea) throw new Error('xterm helper textarea not found');
    const data = new DataTransfer();
    data.setData('text/plain', value);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);
  }, text);
}

export async function sendTrustedPtyPrompt(page: Page, text: string): Promise<void> {
  await page.getByTestId('pty-prompt-input').fill(text);
  await page.getByTestId('pty-prompt-send').click();
}

let rpcSeq = 0;

/**
 * Send a PTY trusted prompt through a separate JSON-RPC WebSocket. This lets a
 * test raise a terminal-backed escalation while the UI remains on another view.
 */
export async function sendPtyPromptRpc(label: number, text: string): Promise<void> {
  const ws = new WebSocket('ws://127.0.0.1:7400/ws?token=mock-dev-token');

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out opening mock WebSocket'));
      }, 5_000);

      function cleanup(): void {
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('error', onError);
      }

      function onOpen(): void {
        cleanup();
        resolve();
      }

      function onError(err: Error): void {
        cleanup();
        reject(err);
      }

      ws.once('open', onOpen);
      ws.once('error', onError);
    });

    const id = `e2e-pty-prompt-${Date.now()}-${++rpcSeq}`;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${id}`));
      }, 5_000);

      function cleanup(): void {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('error', onError);
        ws.off('close', onClose);
      }

      function onMessage(raw: WebSocket.RawData): void {
        let frame: { id?: string; ok?: boolean; error?: { message?: string } };
        try {
          frame = JSON.parse(raw.toString()) as { id?: string; ok?: boolean; error?: { message?: string } };
        } catch {
          return;
        }
        if (frame.id !== id) return;
        cleanup();
        if (frame.ok) {
          resolve();
        } else {
          reject(new Error(frame.error?.message ?? `Mock RPC ${id} failed`));
        }
      }

      function onError(err: Error): void {
        cleanup();
        reject(err);
      }

      function onClose(): void {
        cleanup();
        reject(new Error('Mock WebSocket closed before RPC response'));
      }

      ws.on('message', onMessage);
      ws.once('error', onError);
      ws.once('close', onClose);
      ws.send(JSON.stringify({ id, method: 'sessions.ptyPrompt', params: { label, text } }));
    });
  } finally {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
}
