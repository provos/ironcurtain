import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import { connectWithToken, navigateTo, resetMockServer } from './helpers.js';
import { STATISTICS_FIXTURE_MIXED_ROW_COUNT } from '../scripts/statistics-fixtures.js';

const FIXED_NOW = new Date('2026-08-15T12:00:00.000Z');

async function openStatistics(page: Page): Promise<void> {
  await connectWithToken(page);
  await navigateTo(page, 'Statistics');
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const panel = page.getByRole('region', { name: 'Speed over time' });
  const chart = panel.getByTestId('statistics-trend');
  const target = (page.viewportSize()?.width ?? 1_280) <= 640 ? chart : panel;
  await target.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await expect(chart.locator('path.median')).not.toHaveCount(0);
  await expect(chart.locator('path.iqr')).not.toHaveCount(0);
  await testInfo.attach(name, {
    body: await target.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  });
}

const seriesSelector = (key: string): string => `[data-series-key="${encodeURIComponent(key)}"]`;

async function pathGeometry(path: Locator): Promise<{ d: string; width: number; height: number }> {
  await expect(path).toHaveCount(1);
  return path.evaluate((element) => {
    const bounds = (element as SVGGraphicsElement).getBBox();
    return { d: element.getAttribute('d') ?? '', width: bounds.width, height: bounds.height };
  });
}

async function expectDenseSeries(chart: Locator, key: string): Promise<void> {
  const encoded = seriesSelector(key);
  const median = await pathGeometry(chart.locator(`path.median${encoded}`));
  const ribbon = await pathGeometry(chart.locator(`path.iqr${encoded}`));
  expect(median.d.match(/\bL\b/g)?.length ?? 0).toBeGreaterThanOrEqual(27);
  expect(median.width).toBeGreaterThan(700);
  expect(median.height).toBeGreaterThan(0);
  expect(ribbon.d).not.toContain('NaN');
  expect(ribbon.width).toBeGreaterThan(0);
  expect(ribbon.height).toBeGreaterThan(0);
}

test.describe('LLM statistics', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(FIXED_NOW);
  });

  test('renders the mixed provider and model dataset on desktop', async ({ page, request }, testInfo) => {
    await resetMockServer(request, { statisticsScenario: 'mixed' });
    await connectWithToken(page);

    const navSummary = page.getByTestId('sidebar-nav').getByTestId('statistics-nav-summary');
    await expect(navSummary).toBeVisible();
    await expect(navSummary).toContainText('tok/s');
    await expect(navSummary).toContainText('Middle 50%');
    await expect(navSummary).toContainText('Output');
    await expect(navSummary).toContainText('Measured');
    await navSummary.click();

    await expect(page.getByRole('heading', { name: 'LLM statistics' })).toBeVisible();
    await expect(page.getByLabel('Effective output speed', { exact: true })).toContainText('output tokens/s');
    await expect(page.getByRole('heading', { name: 'Speed over time' })).toBeVisible();
    const tokenVolume = page.getByRole('region', { name: 'Observed token volume · 30 days' });
    await expect(tokenVolume).toBeVisible();
    await expect(tokenVolume.getByText('Thinking split', { exact: true })).toBeVisible();
    await expect(tokenVolume.getByText('Unavailable for a consistent observation population')).toBeVisible();

    const rail = page.getByRole('region', { name: 'Provider and model comparison' });
    await expect(rail).toContainText('openrouter');
    await expect(rail).toContainText('google/gemini-2.5-pro');
    await expect(rail).toContainText('acme-reasoner-v2-prod');
    await expect(page.getByText('Explicit API refusals', { exact: true })).toBeVisible();
    await expect(page.getByText('Transport/provider errors', { exact: true })).toBeVisible();
    const tokenEnvyPromotion = page.getByRole('region', {
      name: 'More detail for your regular Claude Code sessions',
    });
    await expect(tokenEnvyPromotion).toContainText('npx tokenenvy');
    await expect(tokenEnvyPromotion.getByRole('link', { name: /Learn more/ })).toHaveAttribute(
      'href',
      'https://github.com/provos/tokenenvy',
    );

    const chart = page.getByTestId('statistics-trend');
    const routedGoogleKey = 'openrouter\u0000google/gemini-2.5-pro';
    const routedAnthropicKey = 'anthropic\u0000claude-sonnet-4-6';
    const routedSparseKey = 'openrouter\u0000meta/llama-4-sparse';
    await expectDenseSeries(chart, routedGoogleKey);
    await expectDenseSeries(chart, routedAnthropicKey);

    const sparse = await pathGeometry(chart.locator(`path.median${seriesSelector(routedSparseKey)}`));
    expect(sparse.d.match(/\bM\b/g)?.length ?? 0).toBe(2);
    expect(sparse.d.match(/\bL\b/g)?.length ?? 0).toBe(2);
    await expect(chart.locator('.refusal')).not.toHaveCount(0);
    await expect(chart.locator('.error-marker')).not.toHaveCount(0);
    const today = chart.locator('.bucket-target.today');
    await expect(today).toHaveCount(1);
    await expect(today).toHaveAttribute('aria-label', /^Select Today, .+\./);
    await expect(chart.locator('.today-label')).toHaveText('Today');
    await expect(chart.locator(`[data-bucket="${Date.UTC(2026, 7, 14, 7)}"]`)).toHaveAttribute(
      'aria-label',
      /1 explicit API refusal signal/,
    );

    const googleMedian = chart.locator(`path.median${seriesSelector(routedGoogleKey)}`);
    const googleRibbon = chart.locator(`path.iqr${seriesSelector(routedGoogleKey)}`);
    const googleFilter = page.locator(`button${seriesSelector(routedGoogleKey)}`);
    const routedStroke = await googleMedian.getAttribute('stroke');
    expect(routedStroke).toBeTruthy();
    expect(await googleRibbon.getAttribute('fill')).toBe(routedStroke);
    expect(await googleFilter.locator('line').getAttribute('stroke')).toBe(routedStroke);

    const activeFilters = page.locator('.series-filters button[aria-pressed="true"]');
    await expect(activeFilters).toHaveCount(4);
    const activeStyles: string[] = [];
    for (let index = 0; index < (await activeFilters.count()); index++) {
      const filter = activeFilters.nth(index);
      const encodedKey = await filter.getAttribute('data-series-key');
      expect(encodedKey).not.toBeNull();
      const key = decodeURIComponent(encodedKey ?? '');
      const [provider, model] = key.split('\u0000');
      expect(provider).toBeTruthy();
      expect(model).toBeTruthy();
      const swatch = filter.locator('line');
      const median = chart.locator(`path.median${seriesSelector(key)}`);
      const color = await swatch.getAttribute('stroke');
      const dash = (await swatch.getAttribute('stroke-dasharray')) ?? '';
      expect(await median.getAttribute('stroke')).toBe(color);
      expect((await median.getAttribute('stroke-dasharray')) ?? '').toBe(dash);
      const railRow = rail
        .locator('tbody tr')
        .filter({ hasText: provider ?? '' })
        .filter({ hasText: model ?? '' });
      await expect(railRow).toHaveCount(1);
      const railColor = await railRow
        .locator('i')
        .evaluate((element) => getComputedStyle(element).getPropertyValue('--series-color').trim());
      expect(railColor).toBe(color);
      activeStyles.push(`${color}\u0000${dash}`);
    }
    expect(new Set(activeStyles).size).toBe(activeStyles.length);

    await attachScreenshot(page, testInfo, 'statistics-longitudinal-routed-desktop');
    await testInfo.attach('statistics-sidebar-receipt-desktop', {
      body: await page.getByTestId('sidebar-nav').screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });

    await page.getByRole('button', { name: 'Served model' }).click();
    await expect(page.getByRole('button', { name: 'Served model' })).toHaveAttribute('aria-pressed', 'true');
    await expect(rail).toContainText('Google AI Studio');
    await expect(rail).toContainText('Model not exposed');
    await expect(rail).toContainText('Provider not exposed');
    await expectDenseSeries(chart, 'Google AI Studio\u0000gemini-2.5-pro-001');
    await expect(page.locator(`button${seriesSelector('Provider not exposed\u0000Model not exposed')}`)).toBeVisible();

    await attachScreenshot(page, testInfo, 'statistics-longitudinal-served-desktop');

    await page.getByRole('button', { name: 'Routed model' }).click();
    await expect(googleMedian).toBeVisible();
    expect(await googleMedian.getAttribute('stroke')).toBe(routedStroke);
  });

  test('uses fixed 30 and 90 day domains and emphasizes an unobserved Today', async ({ page, request }) => {
    await page.clock.setFixedTime(new Date('2026-08-16T12:00:00.000Z'));
    await resetMockServer(request, { statisticsScenario: 'mixed' });
    await openStatistics(page);

    let chart = page.getByTestId('statistics-trend');
    const key = 'openrouter\u0000google/gemini-2.5-pro';
    const thirtyDay = await pathGeometry(chart.locator(`path.median${seriesSelector(key)}`));
    await expect(chart.locator('.today-column.no-observation')).toHaveCount(1);
    await expect(chart.locator('.bucket-target.today')).toHaveCount(0);

    await page.getByRole('button', { name: '90d' }).click();
    await expect(page.getByRole('button', { name: '90d' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/Last 90 local calendar days/)).toBeVisible();
    chart = page.getByTestId('statistics-trend');
    const ninetyDay = await pathGeometry(chart.locator(`path.median${seriesSelector(key)}`));

    expect(ninetyDay.width).toBeLessThan(thirtyDay.width * 0.5);
    await expect(chart.locator('.today-column.no-observation')).toHaveCount(1);
    await expect(chart.locator('.bucket-target.today')).toHaveCount(0);
  });

  test('keeps controls and visualizations usable at a mobile viewport', async ({ page, request }, testInfo) => {
    await resetMockServer(request, { statisticsScenario: 'mixed' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?token=mock-dev-token');

    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Open menu' }).click();
    const drawer = page.getByRole('dialog', { name: 'Main navigation' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'Statistics' }).click();

    await expect(page.getByRole('heading', { name: 'LLM statistics' })).toBeVisible();
    await expect(page.getByRole('button', { name: '30d' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Routed model' })).toBeVisible();
    await expect(page.getByTestId('statistics-trend')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Provider and model comparison' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const chart = page.getByTestId('statistics-trend');
    await expectDenseSeries(chart, 'openrouter\u0000google/gemini-2.5-pro');
    const today = chart.locator('.bucket-target.today');
    await expect(today).toHaveCount(1);
    await today.focus();
    await expect(today).toBeFocused();
    const scrolling = await chart.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
    }));
    expect(scrolling.scrollWidth).toBeGreaterThan(scrolling.clientWidth);
    expect(scrolling.scrollLeft).toBeGreaterThan(0);
    const todayVisible = await today.evaluate((element) => {
      const target = element.getBoundingClientRect();
      const shell = element.closest('[data-testid="statistics-trend"]')?.getBoundingClientRect();
      return shell !== undefined && target.left >= shell.left - 1 && target.right <= shell.right + 1;
    });
    expect(todayVisible).toBe(true);
    await today.evaluate((element) => (element as SVGElement).blur());
    await expect(today).not.toBeFocused();

    await attachScreenshot(page, testInfo, 'statistics-longitudinal-mobile-today');
  });

  for (const state of [
    { scenario: 'empty', heading: 'No observed exchanges' },
    { scenario: 'disabled', heading: 'Statistics are disabled' },
    { scenario: 'reader-unavailable', heading: 'Statistics temporarily unavailable' },
  ] as const) {
    test(`renders the ${state.scenario} state`, async ({ page, request }) => {
      await resetMockServer(request, { statisticsScenario: state.scenario });
      await openStatistics(page);

      await expect(page.getByRole('heading', { name: state.heading })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'LLM statistics' })).not.toBeVisible();
      if (state.scenario === 'reader-unavailable') {
        await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
      }
    });
  }

  test('surfaces degraded persistence without hiding captured statistics', async ({ page, request }, testInfo) => {
    await resetMockServer(request, { statisticsScenario: 'degraded' });
    await openStatistics(page);

    await expect(page.getByRole('heading', { name: 'LLM statistics' })).toBeVisible();
    await expect(page.getByText('Some statistics may be missing.')).toBeVisible();
    await expect(page.getByText(`${STATISTICS_FIXTURE_MIXED_ROW_COUNT} persisted · 4 dropped`)).toBeVisible();
    await attachScreenshot(page, testInfo, 'statistics-degraded');
  });
});
