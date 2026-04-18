import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { connectWithToken, navigateTo, resetMockServer } from './helpers.js';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Workflow visualization acceptance tests (Chunk 11 — §F.1 ACs).
//
// These tests exercise the cinematic workflow theater against the mock
// server's declarative scenario fixtures. Tests open the canned design-and-code
// workflow (wf-mock-001) and use `?scenario=` + `?speed=` URL params to drive
// the mock's per-client scenario runner (see `scripts/mock-ws-server.ts` →
// parseScenarioQueryParams).
//
// The `?scenario=` and `?speed=` params propagate to the WS URL via the patched
// `buildWsUrl()` in `stores.svelte.ts`. Scenarios that target `wf-mock-001`
// (e.g. `e2e-transitions`) can drive AgentEvent-keyed theater state because the
// theater's `subscribeWorkflowAgentEvents(workflowId, ...)` filter matches.
// ---------------------------------------------------------------------------

const MOCK_TOKEN = 'mock-dev-token';
const WS_URL = `ws://localhost:7400/ws?token=${MOCK_TOKEN}`;

/**
 * The mock server seeds `code-review` with a pending gate, and Workflows.svelte
 * auto-selects the gated workflow via an $effect. Hit Back to dismiss that
 * auto-selection so the workflow list becomes visible before the test clicks
 * into its target row. No-op when the list is already visible.
 */
async function dismissAutoSelectedGate(page: Page): Promise<void> {
  const backButton = page.getByRole('button', { name: /Back/ });
  if (await backButton.isVisible().catch(() => false)) {
    await backButton.click();
  }
}

/** Navigate into the design-and-code workflow detail view, toggle to theater
 *  mode, and wait for the theater frame + rain canvas to mount. */
async function openTheater(page: Page, opts: { scenario: string; speed?: number }): Promise<void> {
  // Navigate with scenario/speed in the browser URL; these are forwarded onto
  // the WS URL by buildWsUrl() so the mock's per-client scenario runner picks
  // them up on this client's subscribe.
  const params = new URLSearchParams({ token: MOCK_TOKEN, scenario: opts.scenario });
  if (opts.speed !== undefined) params.set('speed', String(opts.speed));
  await page.goto(`/?${params.toString()}`);
  await expect(page.locator('nav')).toBeVisible({ timeout: 10_000 });

  await navigateTo(page, 'Workflows');
  await dismissAutoSelectedGate(page);
  await page.locator('tr', { hasText: 'design-and-code' }).click();
  await expect(page.locator('svg[aria-label="Workflow state machine graph"]')).toBeVisible({ timeout: 5_000 });

  // Toggle from classic → theater. The toggle is a single button whose label
  // flips based on the current mode; data-testid keeps the selector stable.
  const toggle = page.getByTestId('viz-mode-toggle');
  const label = (await toggle.textContent())?.trim();
  if (label === 'Viz') {
    await toggle.click();
  }
  await expect(page.getByTestId('workflow-theater-frame')).toBeVisible();
  await expect(page.locator('canvas.theater-canvas')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Test A — Gating invariant (Chunk 6 follow-up):
//   A bare WS connection that never calls sessions.subscribeAllTokenStreams
//   must receive zero `session.token_stream` events. Subscribing then flips
//   the stream on.
//
// Exercised at the WS protocol layer directly — no app involved — because the
// invariant is about the server, not the UI.
// ---------------------------------------------------------------------------

test.describe('Workflow visualization — gating invariant', () => {
  test.beforeEach(async ({ request }: { request: APIRequestContext }) => {
    await resetMockServer(request);
  });

  test('AC-G: unsubscribed client receives zero session.token_stream events', async () => {
    const observed: string[] = [];
    const ws = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    ws.on('message', (raw) => {
      try {
        const frame = JSON.parse(String(raw)) as { event?: string };
        if (frame.event) observed.push(frame.event);
      } catch {
        // ignore non-JSON frames
      }
    });

    // Observe for one second with no subscribe.
    await new Promise((r) => setTimeout(r, 1000));
    const tokenFramesBefore = observed.filter((e) => e === 'session.token_stream').length;
    expect(tokenFramesBefore).toBe(0);

    // Now subscribe; the scenario runner should begin emitting.
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'sessions.subscribeAllTokenStreams',
        params: {},
      }),
    );

    // Wait for the runner to tick at least twice (TOKEN_BATCH_INTERVAL_MS = 50ms).
    await new Promise((r) => setTimeout(r, 1500));
    const tokenFramesAfter = observed.filter((e) => e === 'session.token_stream').length;
    expect(tokenFramesAfter).toBeGreaterThan(0);

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// Test B — AC1 (ambient-first forcing function):
//   With zero transitions, the view must still look actively alive.
//
// The design spec targets 3 minutes in-product; E2E uses ~10s at speed=10
// via the `no-transitions` scenario. That scenario emits a steady 40 tok/s
// stream and no agent events, matching the ambient-mode requirement.
// ---------------------------------------------------------------------------

test.describe('Workflow visualization — ambient mode', () => {
  test.beforeEach(async ({ page, request }: { page: Page; request: APIRequestContext }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('AC1: theater stays alive under zero-transition scenario', async ({ page }) => {
    await openTheater(page, { scenario: 'no-transitions', speed: 10 });

    const canvas = page.locator('canvas.theater-canvas');
    const dims = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      return { w: c.width, h: c.height };
    });
    expect(dims.w).toBeGreaterThan(0);
    expect(dims.h).toBeGreaterThan(0);

    const hudRight = page.getByTestId('ambient-hud-top-right');
    await expect(hudRight).toBeVisible();

    // Tokens/sec must climb above 0 within a few seconds — the EMA needs a
    // few batch windows to build up from its idle start.
    await expect
      .poll(
        async () => {
          const text = (await hudRight.textContent()) ?? '';
          const m = text.match(/(\d+)\s*tok\/s/);
          return m ? parseInt(m[1], 10) : 0;
        },
        { timeout: 5_000, intervals: [250, 500, 1000] },
      )
      .toBeGreaterThan(0);

    // Active-node affordance: the pulsing node (§E.2) is keyed off the
    // `smg-node--active` class in state-machine-graph.svelte. If no node
    // shows the class the theater has lost its active-state tracking and
    // AC1's "pulse is clearly breathing" requirement is broken.
    const activeNodeCount = await page.locator('.smg-node--active').count();
    expect(activeNodeCount).toBeGreaterThan(0);
  });

  test('AC3: no edge shows data-active=true during ambient operation', async ({ page }) => {
    await openTheater(page, { scenario: 'no-transitions', speed: 10 });
    // Give the scenario a chance to tick — 2s of ambient runtime is plenty to
    // catch any stray edge activation (the no-transitions scenario emits none).
    await page.waitForTimeout(2_000);

    const activeEdges = await page.locator('path.smg-edge[data-active="true"]').count();
    expect(activeEdges).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test C — AC2 (transition FX):
//   A transition fires → payload tile travels → edge activates → arrival
//   badge flashes on the incoming node.
//
// Uses the `e2e-transitions` scenario which targets `wf-mock-001` (the
// design-and-code canned workflow) with 2s agent cycles so the transition
// fires within the test timeout.
// ---------------------------------------------------------------------------

test.describe('Workflow visualization — transition FX', () => {
  test.beforeEach(async ({ page, request }: { page: Page; request: APIRequestContext }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('AC2: transition lights an edge and flashes the arrival node', async ({ page }) => {
    await openTheater(page, { scenario: 'e2e-transitions', speed: 5 });

    // The transition-FX overlay is only mounted while an FX cycle is active,
    // so its appearance is itself a signal the director fired. Wait up to 8s
    // for the first scenario transition (implement → review at 2000ms, sped
    // 5x ≈ 400ms) plus render latency.
    await expect(page.locator('canvas.transition-fx-canvas')).toBeVisible({ timeout: 8_000 });

    // During travel the target edge picks up data-active=true. Poll because
    // the attribute flip is on the rAF lerp, not the DOM mount, and clears
    // when the cycle ends.
    await expect
      .poll(async () => page.locator('path.smg-edge[data-active="true"]').count(), {
        timeout: 3_000,
        intervals: [50, 100, 200],
      })
      .toBeGreaterThan(0);

    // During absorb the incoming node picks up data-arrival=true. Same poll
    // approach because the absorb phase is brief.
    await expect
      .poll(async () => page.locator('foreignObject[data-arrival="true"]').count(), {
        timeout: 3_000,
        intervals: [50, 100, 200],
      })
      .toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test E — AC4 (tab-visibility pause/resume):
//   When the tab is hidden, the rAF loop halts; on resume, the canvas resumes
//   painting within one frame.
//
// Verified by hashing canvas pixels: while hidden, the hash must not change;
// after visibility returns, it changes again.
// ---------------------------------------------------------------------------

test.describe('Workflow visualization — visibility pause', () => {
  test.beforeEach(async ({ page, request }: { page: Page; request: APIRequestContext }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('AC4: rAF loop halts when tab hidden, resumes on visible', async ({ page }) => {
    await openTheater(page, { scenario: 'no-transitions', speed: 10 });
    // Let the loop run long enough for the canvas to paint at least once.
    await page.waitForTimeout(500);

    // Snapshot canvas pixels. `getImageData` requires willReadFrequently or
    // an extraction — we use toDataURL since it's read-only and stable.
    const snapshot = async (): Promise<string> =>
      page.locator('canvas.theater-canvas').evaluate((el) => (el as HTMLCanvasElement).toDataURL());

    // Prove the rain is actively painting by observing a change within ~500ms.
    const activeBefore = await snapshot();
    await page.waitForTimeout(500);
    const activeAfter = await snapshot();
    expect(activeAfter).not.toBe(activeBefore);

    // Emulate a hidden tab. Playwright doesn't ship a first-class "hidden"
    // emulator; dispatch visibilitychange with a stubbed visibilityState so
    // the theater's handler runs the stop-path.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Wait one rAF frame so the director has a chance to receive the stop
    // signal and halt. Then take a reference snapshot and confirm it no
    // longer drifts.
    await page.waitForTimeout(50);
    const frozen1 = await snapshot();
    await page.waitForTimeout(500);
    const frozen2 = await snapshot();
    expect(frozen2).toBe(frozen1);

    // Resume visibility; the loop should kick back on within a frame.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);
    const resumed = await snapshot();
    expect(resumed).not.toBe(frozen2);
  });
});

// ---------------------------------------------------------------------------
// Test F — viz-mode toggle persistence:
//   Toggle theater → reload → theater sticks (localStorage round-trip).
// ---------------------------------------------------------------------------

test.describe('Workflow visualization — viz-mode persistence', () => {
  test.beforeEach(async ({ page, request }: { page: Page; request: APIRequestContext }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('theater mode survives a full page reload', async ({ page }) => {
    await navigateTo(page, 'Workflows');
    await dismissAutoSelectedGate(page);
    await page.locator('tr', { hasText: 'design-and-code' }).click();
    await expect(page.locator('svg[aria-label="Workflow state machine graph"]')).toBeVisible({ timeout: 5_000 });

    // Flip to theater mode.
    const toggle = page.getByTestId('viz-mode-toggle');
    await toggle.click();
    await expect(page.getByTestId('workflow-theater-frame')).toBeVisible();

    // Confirm the preference is persisted under the documented key before
    // reloading — reload drops in-memory state, so this rules out false
    // positives from other state paths.
    const storedMode = await page.evaluate(() => localStorage.getItem('ic-workflow-viz-mode'));
    expect(storedMode).toBe('theater');

    // Reload: theater must still be active without re-clicking the toggle.
    await page.reload();
    await expect(page.locator('nav')).toBeVisible({ timeout: 10_000 });
    await navigateTo(page, 'Workflows');
    await dismissAutoSelectedGate(page);
    await page.locator('tr', { hasText: 'design-and-code' }).click();
    await expect(page.getByTestId('workflow-theater-frame')).toBeVisible({ timeout: 5_000 });
  });
});
