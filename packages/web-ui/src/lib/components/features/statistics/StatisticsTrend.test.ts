import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import StatisticsTrend from './StatisticsTrend.svelte';
import type { StatisticsTrendPoint } from './statistics-helpers.js';

const base: StatisticsTrendPoint = {
  key: 'one',
  fromMs: Date.UTC(2026, 0, 1),
  toMs: Date.UTC(2026, 0, 2) - 1,
  label: 'Jan 1, 2026',
  seriesKey: 'openai\0gpt-5',
  seriesLabel: 'openai · gpt-5',
  color: 'blue',
  dash: null,
  median: 40,
  lowerQuartile: 30,
  upperQuartile: 50,
  sampleCount: 8,
  sampleSessionCount: 3,
  eligibleCount: 10,
  coverage: 0.8,
  refusalCount: 1,
  refusalCoverage: 1,
  errorCount: 0,
};

describe('StatisticsTrend', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('provides chart semantics and an accessible table fallback', () => {
    const { container } = render(StatisticsTrend, { props: { points: [base] } });

    expect(screen.getByText('Effective output speed by model and provider')).toBeTruthy();
    expect(screen.getByText('View trend as accessible table')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Effective output speed table' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /1 measured provider\/model series/i })).toBeTruthy();
    expect(screen.getAllByText(/8 of 10 observed exchanges/i)).toHaveLength(2);
    expect(screen.getByText('Explicit API refusal or content filter')).toBeTruthy();
    expect(container.querySelector('circle title')?.textContent).toMatch(
      /openai · gpt-5: median 40\.0.*middle\s+50% 30\.0–50\.0.*8 of 10 observed exchanges · 3 sessions/s,
    );
  });

  it('uses Token Envy geometry, a nice scale, exact ticks, and explicit Today emphasis', () => {
    const points = Array.from({ length: 10 }, (_, index) => ({
      ...base,
      key: `day-${index}`,
      fromMs: Date.UTC(2026, 0, index + 1),
      toMs: Date.UTC(2026, 0, index + 2) - 1,
      label: `Jan ${index + 1}, 2026`,
      refusalCount: 0,
    }));
    const today = points.at(-1)!;
    const { container } = render(StatisticsTrend, {
      props: { points, todayFromMs: today.fromMs, selectedFromMs: today.fromMs },
    });

    expect(screen.getByTestId('statistics-trend').querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 890 380');
    expect(container.querySelectorAll('text.date')).toHaveLength(7);
    expect(screen.getByText('Today')).toBeTruthy();
    const todayTarget = screen.getByRole('button', { name: /Select Today, Jan 10, 2026/i });
    expect(todayTarget.classList.contains('today')).toBe(true);
    expect(todayTarget.classList.contains('selected')).toBe(true);
    expect(container.querySelector('.chart-point.today.selected')?.getAttribute('r')).toBe('5');
    expect(screen.getByText('50')).toBeTruthy();
  });

  it('keeps useful precision for low-rate axes', () => {
    const { container } = render(StatisticsTrend, {
      props: {
        points: [{ ...base, median: 0.3, lowerQuartile: 0.2, upperQuartile: 0.5 }],
      },
    });
    const labels = [...container.querySelectorAll('.axis-label:not(.date)')].map((label) => label.textContent?.trim());

    expect(labels).toEqual(['0', '0.13', '0.25', '0.38', '0.5']);
  });

  it('uses the fixed domain and keeps an empty Today endpoint visible but not selectable', () => {
    const day = 24 * 60 * 60 * 1_000;
    const domainBuckets = Array.from({ length: 7 }, (_, index) => ({
      fromMs: base.fromMs + index * day,
      toMs: base.fromMs + (index + 1) * day - 1,
      label: `Jan ${index + 1}, 2026`,
    }));
    const point = { ...base, fromMs: domainBuckets[2]!.fromMs, toMs: domainBuckets[2]!.toMs };
    const today = domainBuckets.at(-1)!;
    const { container } = render(StatisticsTrend, {
      props: { points: [point], domainBuckets, todayFromMs: today.fromMs },
    });

    expect(screen.getByText('Today')).toBeTruthy();
    expect(container.querySelector('.today-column.no-observation')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Select Today/i })).toBeNull();
    expect(container.querySelector('.chart-point')?.getAttribute('cx')).toBe(String((2 / 6) * 820));
  });

  it('uses authoritative ungrouped totals for day signals', () => {
    const { container } = render(StatisticsTrend, {
      props: {
        points: [{ ...base, refusalCount: 0, errorCount: 0 }],
        signalTotals: [
          {
            key: 'total',
            fromMs: base.fromMs,
            toMs: base.toMs,
            label: base.label,
            refusalCount: 7,
            refusalCoverage: 1,
            errorCount: 3,
          },
        ],
      },
    });

    expect(screen.getByRole('button', { name: /7 explicit API refusal signals; 3 errors/i })).toBeTruthy();
    expect(container.querySelector('.refusal')).toBeTruthy();
    expect(container.querySelector('.error-marker')).toBeTruthy();
  });

  it('paints all IQR ranges before lines and exposes stable encoded series hooks', () => {
    const secondSeries = {
      ...base,
      key: 'second-series',
      seriesKey: 'openrouter\0anthropic/claude',
      seriesLabel: 'openrouter · anthropic/claude',
      color: 'red',
      dash: '8 4',
      refusalCount: 0,
    };
    const { container } = render(StatisticsTrend, { props: { points: [base, secondSeries] } });
    const layers = [...container.querySelectorAll('.iqr, .median')];

    expect(layers.map((item) => item.classList.contains('iqr'))).toEqual([true, true, false, false]);
    expect(container.querySelector('.median[data-series-key="openai%00gpt-5"]')).toBeTruthy();
    expect(container.querySelector('.iqr[data-series-key="openrouter%00anthropic%2Fclaude"]')).toBeTruthy();
    expect(
      container
        .querySelector('.median[data-series-key="openrouter%00anthropic%2Fclaude"]')
        ?.getAttribute('stroke-dasharray'),
    ).toBe('8 4');
  });

  it('keeps missing calendar days discontinuous and makes singleton IQR ranges visible', () => {
    const later = {
      ...base,
      key: 'later',
      fromMs: Date.UTC(2026, 0, 4),
      toMs: Date.UTC(2026, 0, 5) - 1,
      label: 'Jan 4, 2026',
      refusalCount: 0,
    };
    const { container } = render(StatisticsTrend, { props: { points: [base, later] } });
    const path = container.querySelector('.median')?.getAttribute('d') ?? '';

    expect(path.match(/M /g)).toHaveLength(2);
    expect(container.querySelectorAll('.iqr-singleton')).toHaveLength(2);
  });

  it('renders errors separately from explicit refusals', () => {
    const { container } = render(StatisticsTrend, {
      props: { points: [{ ...base, refusalCount: 0, errorCount: 2 }] },
    });

    expect(screen.getByText('Transport/provider error')).toBeTruthy();
    expect(container.querySelector('.error-marker')).toBeTruthy();
    expect(screen.queryByText('Explicit API refusal or content filter')).toBeNull();
  });

  it('uses a roving keyboard target and activates the selected day', async () => {
    const onselect = vi.fn();
    const second = {
      ...base,
      key: 'two',
      fromMs: Date.UTC(2026, 0, 2),
      toMs: Date.UTC(2026, 0, 3) - 1,
      label: 'Jan 2, 2026',
      refusalCount: 0,
    };
    render(StatisticsTrend, { props: { points: [base, second], onselect } });
    const first = screen.getByRole('button', { name: /Select Jan 1, 2026/i });

    await fireEvent.keyDown(first, { key: 'ArrowRight' });
    const next = screen.getByRole('button', { name: /Select Jan 2, 2026/i });
    expect(next.getAttribute('tabindex')).toBe('0');
    await fireEvent.keyDown(next, { key: 'Enter' });

    expect(onselect).toHaveBeenCalledWith(second.fromMs, second.toMs);
  });

  it('keeps refusal-only buckets selectable without inventing a speed value', async () => {
    const onselect = vi.fn();
    const { container } = render(StatisticsTrend, {
      props: {
        points: [],
        signals: [
          {
            key: 'refusal-only',
            fromMs: base.fromMs,
            toMs: base.toMs,
            label: base.label,
            seriesKey: base.seriesKey,
            seriesLabel: base.seriesLabel,
            color: base.color,
            refusalCount: 1,
            refusalCoverage: 1,
            errorCount: 0,
          },
        ],
        onselect,
      },
    });

    expect(screen.getAllByText('No eligible speed sample')).toHaveLength(2);
    expect(container.querySelector('.axis-title')).toBeNull();
    expect(container.querySelector('.grid')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: /Select Jan 1, 2026/i }));
    expect(onselect).toHaveBeenCalledWith(base.fromMs, base.toMs);
  });
});
