import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type {
  LlmStatisticsMeasure,
  StatisticsCapabilitiesDto,
  StatisticsDistributionQuery,
  StatisticsMetricDistributionDto,
  StatisticsMetricSummaryDto,
  StatisticsSeriesQuery,
  StatisticsSummaryQuery,
  StatisticsTimeBucketDto,
} from '$lib/types.js';

const mockCapabilities = vi.fn<() => Promise<StatisticsCapabilitiesDto>>();
const mockSummary = vi.fn<(query: StatisticsSummaryQuery) => Promise<readonly StatisticsMetricSummaryDto[]>>();
const mockSeries = vi.fn<(query: StatisticsSeriesQuery) => Promise<readonly StatisticsTimeBucketDto[]>>();
const mockDistribution = vi.fn<(query: StatisticsDistributionQuery) => Promise<StatisticsMetricDistributionDto>>();
const appStateMock = { connected: true };
const connectionGenerationMock = { value: 0 };

vi.mock('$lib/stores.svelte.js', () => ({
  get appState() {
    return appStateMock;
  },
  get connectionGeneration() {
    return connectionGenerationMock;
  },
  getStatisticsCapabilities: () => mockCapabilities(),
  getStatisticsSummary: (query: StatisticsSummaryQuery) => mockSummary(query),
  getStatisticsSeries: (query: StatisticsSeriesQuery) => mockSeries(query),
  getStatisticsDistribution: (query: StatisticsDistributionQuery) => mockDistribution(query),
}));

import Statistics from './Statistics.svelte';

function metric(
  measure: LlmStatisticsMeasure,
  value: number | null,
  dimensions: Readonly<Record<string, string | boolean | null>> = {},
): StatisticsMetricSummaryDto {
  const speed = measure === 'effectiveOutputTokensPerSecond';
  return {
    dimensions,
    measure,
    value,
    sampleCount: value === null ? 0 : 8,
    sampleSessionCount: value === null ? 0 : 3,
    eligibleCount: 10,
    coverage: value === null ? 0 : 0.8,
    median: speed ? 42 : value,
    lowerQuartile: speed ? 34 : value,
    upperQuartile: speed ? 51 : value,
    formulaVersion: 2,
  };
}

const dimensions = {
  logicalProvider: 'openrouter',
  forwardedModel: 'anthropic/claude-sonnet-4',
  servedProvider: 'anthropic',
  servedModel: 'claude-sonnet-4-20260514',
};

function health(overrides: Partial<StatisticsCapabilitiesDto['health']> = {}): StatisticsCapabilitiesDto['health'] {
  return {
    state: 'ready',
    schemaVersion: 1,
    observed: 10,
    finalized: 10,
    enqueued: 10,
    persisted: 10,
    duplicates: 0,
    dropped: 0,
    queuedRecords: 0,
    queuedBytes: 0,
    lastError: null,
    readerState: 'ready',
    readerLastError: null,
    ...overrides,
  };
}

function capabilities(available = true): StatisticsCapabilitiesDto {
  return {
    available,
    dtoVersion: 2,
    formulaVersion: 2,
    schemaVersion: 1,
    maxPageSize: 100,
    maxScannedRows: 10_000,
    maxGroups: 100,
    allowedBucketSizesMs: [3_600_000, 86_400_000],
    allowedCalendarBucketUnits: ['day'],
    health: health(),
  };
}

function ungrouped(): StatisticsMetricSummaryDto[] {
  return [
    metric('requestCount', 10),
    metric('refusalCount', 1),
    metric('errorCount', 2),
    metric('inputTokens', 1_200),
    metric('outputTokens', 800),
    metric('thinkingTokens', 200),
    metric('nonThinkingOutputTokens', 500),
    metric('totalTokens', 2_000),
    metric('effectiveOutputTokensPerSecond', 43),
  ];
}

function grouped(): StatisticsMetricSummaryDto[] {
  return [
    metric('requestCount', 10, dimensions),
    metric('outputTokens', 800, dimensions),
    metric('effectiveOutputTokensPerSecond', 43, dimensions),
  ];
}

function buckets(): StatisticsTimeBucketDto[] {
  return [
    {
      fromMs: Date.UTC(2026, 7, 14),
      toMs: Date.UTC(2026, 7, 15) - 1,
      summaries: [
        metric('effectiveOutputTokensPerSecond', 43, dimensions),
        metric('refusalCount', 1, dimensions),
        metric('errorCount', 2, dimensions),
      ],
    },
  ];
}

function providerDimensions(index: number): Readonly<Record<string, string | boolean | null>> {
  return {
    logicalProvider: `provider-${index}`,
    forwardedModel: `model-${index}`,
    servedProvider: `served-provider-${index}`,
    servedModel: `served-model-${index}`,
  };
}

function manyGrouped(count = 5): StatisticsMetricSummaryDto[] {
  return Array.from({ length: count }, (_, index) => {
    const group = providerDimensions(index + 1);
    return [
      metric('requestCount', count - index, group),
      metric('outputTokens', 800 - index * 10, group),
      metric('effectiveOutputTokensPerSecond', 43 - index, group),
    ];
  }).flat();
}

function manyBuckets(count = 5): StatisticsTimeBucketDto[] {
  return [
    {
      fromMs: Date.UTC(2026, 7, 14),
      toMs: Date.UTC(2026, 7, 15) - 1,
      summaries: Array.from({ length: count }, (_, index) => {
        const group = providerDimensions(index + 1);
        return [
          metric('effectiveOutputTokensPerSecond', 43 - index, group),
          metric('refusalCount', index === count - 1 ? 2 : 0, group),
          metric('errorCount', 0, group),
        ];
      }).flat(),
    },
  ];
}

describe('Statistics route', () => {
  beforeEach(() => {
    mockCapabilities.mockReset();
    mockSummary.mockReset();
    mockSeries.mockReset();
    mockDistribution.mockReset();
    appStateMock.connected = true;
    connectionGenerationMock.value = 0;
    mockCapabilities.mockResolvedValue(capabilities());
    mockSummary.mockImplementation((query) => Promise.resolve(query.groupBy ? grouped() : ungrouped()));
    mockSeries.mockResolvedValue(buckets());
    mockDistribution.mockResolvedValue({
      measure: 'effectiveOutputTokensPerSecond',
      bins: [
        { lower: 20, upper: 40, count: 3 },
        { lower: 40, upper: 60, count: 5 },
      ],
      sampleCount: 8,
      eligibleCount: 10,
      coverage: 0.8,
      minimum: 20,
      maximum: 60,
      formulaVersion: 2,
    });
  });

  it('renders the honest dashboard and never exceeds two concurrent statistics requests', async () => {
    let active = 0;
    let maximum = 0;
    const delayed = async <Value>(value: Value): Promise<Value> => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return value;
    };
    mockCapabilities.mockImplementation(() => delayed(capabilities()));
    mockSummary.mockImplementation((query) => delayed(query.groupBy ? grouped() : ungrouped()));
    mockSeries.mockImplementation(() => delayed(buckets()));

    render(Statistics);

    expect(await screen.findByRole('heading', { name: 'LLM statistics' }, { timeout: 2_000 })).toBeTruthy();
    expect(screen.getByText('Median effective speed')).toBeTruthy();
    expect(screen.getByText('Weekly observed usage')).toBeTruthy();
    expect(screen.getAllByText('Canonical total')).toHaveLength(2);
    expect(screen.getByText('Provider and model rail')).toBeTruthy();
    expect(screen.getByText('Explicit API refusals')).toBeTruthy();
    expect(screen.getAllByText(/openrouter · anthropic\/claude-sonnet-4/i).length).toBeGreaterThan(0);
    expect(maximum).toBeLessThanOrEqual(2);
    expect(mockSeries).toHaveBeenCalledWith(
      expect.objectContaining({
        measures: ['refusalCount', 'errorCount'],
        calendarBucket: { unit: 'day', timeZone: expect.any(String) },
      }),
    );
    const signalQuery = mockSeries.mock.calls.map(([query]) => query).find((query) => query.groupBy === undefined);
    expect(signalQuery).toMatchObject({ measures: ['refusalCount', 'errorCount'] });
    expect(signalQuery).not.toHaveProperty('topGroups');
  });

  it('prioritizes observed chart groups over rail-only groups', async () => {
    const railOnly = providerDimensions(99);
    mockSummary.mockImplementation((query) =>
      Promise.resolve(
        query.groupBy
          ? [
              metric('requestCount', 100, railOnly),
              metric('effectiveOutputTokensPerSecond', 60, railOnly),
              ...manyGrouped(),
            ]
          : ungrouped(),
      ),
    );
    mockSeries.mockResolvedValue(manyBuckets());

    render(Statistics);
    await screen.findByRole('heading', { name: 'LLM statistics' }, { timeout: 2_000 });

    expect(screen.queryByRole('button', { name: /provider-99 · model-99/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Hide provider-/ })).toHaveLength(4);
  });

  it('shows at most four toggleable series while retaining hidden-series signals', async () => {
    mockSummary.mockImplementation((query) => Promise.resolve(query.groupBy ? manyGrouped() : ungrouped()));
    mockSeries.mockResolvedValue(manyBuckets());
    const { container } = render(Statistics);

    await screen.findByRole('heading', { name: 'LLM statistics' }, { timeout: 2_000 });
    const active = screen.getAllByRole('button', { name: /^Hide provider-/ });
    const hidden = screen.getByRole('button', { name: 'Show provider-5 · model-5' });
    expect(active).toHaveLength(4);
    expect(hidden.hasAttribute('disabled')).toBe(true);
    expect(container.querySelectorAll('.median')).toHaveLength(4);
    expect(screen.getAllByText('Hidden returned chart groups').length).toBeGreaterThan(0);

    const firstKey = active[0].getAttribute('data-series-key');
    const filterLine = active[0].querySelector('line');
    const chartLine = container.querySelector(`.median[data-series-key="${firstKey}"]`);
    expect(filterLine?.getAttribute('stroke')).toBe(chartLine?.getAttribute('stroke'));
    expect(filterLine?.getAttribute('stroke-dasharray')).toBe(chartLine?.getAttribute('stroke-dasharray'));

    await fireEvent.click(active[0]);
    expect(hidden.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(hidden);
    expect(hidden.getAttribute('aria-pressed')).toBe('true');
    expect(
      container.querySelector(`.median[data-series-key="${hidden.getAttribute('data-series-key')}"]`),
    ).toBeTruthy();
  });

  it('switches explicitly from routed to served model identity', async () => {
    render(Statistics);
    await screen.findByRole('heading', { name: 'LLM statistics' }, { timeout: 2_000 });

    await fireEvent.click(screen.getByRole('button', { name: 'Served model' }));

    await vi.waitFor(
      () => expect(screen.getAllByText(/anthropic · claude-sonnet-4-20260514/i).length).toBeGreaterThan(0),
      { timeout: 2_000 },
    );
  });

  it('does not reinterpret stale routed groups while served data is loading', async () => {
    const secondDimensions = {
      logicalProvider: 'openai',
      forwardedModel: 'gpt-5',
      servedProvider: null,
      servedModel: null,
    };
    const routedDimensions = { ...dimensions, servedProvider: null, servedModel: null };
    const routedGroups = [
      ...grouped().map((item) => ({ ...item, dimensions: routedDimensions })),
      ...grouped().map((item) => ({ ...item, dimensions: secondDimensions })),
    ];
    const routedBuckets = buckets().map((bucket) => ({
      ...bucket,
      summaries: [
        ...bucket.summaries.map((item) => ({ ...item, dimensions: routedDimensions })),
        ...bucket.summaries.map((item) => ({ ...item, dimensions: secondDimensions })),
      ],
    }));
    let resolveServedSummary!: (value: readonly StatisticsMetricSummaryDto[]) => void;
    let resolveServedSeries!: (value: readonly StatisticsTimeBucketDto[]) => void;
    const servedSummary = new Promise<readonly StatisticsMetricSummaryDto[]>((resolve) => {
      resolveServedSummary = resolve;
    });
    const servedSeries = new Promise<readonly StatisticsTimeBucketDto[]>((resolve) => {
      resolveServedSeries = resolve;
    });
    mockSummary.mockImplementation((query) => {
      if (query.groupBy?.[0] === 'servedProvider') return servedSummary;
      return Promise.resolve(query.groupBy ? routedGroups : ungrouped());
    });
    mockSeries.mockImplementation((query) =>
      query.groupBy?.[0] === 'servedProvider' ? servedSeries : Promise.resolve(routedBuckets),
    );

    render(Statistics);
    await screen.findByRole('heading', { name: 'LLM statistics' }, { timeout: 2_000 });
    await fireEvent.click(screen.getByRole('button', { name: 'Served model' }));
    expect(screen.getByRole('button', { name: 'Served model' }).getAttribute('aria-pressed')).toBe('true');

    await new Promise((resolve) => setTimeout(resolve, 120));
    const servedDimensions = { servedProvider: null, servedModel: null };
    resolveServedSummary(grouped().map((item) => ({ ...item, dimensions: servedDimensions })));
    resolveServedSeries(
      buckets().map((bucket) => ({
        ...bucket,
        summaries: bucket.summaries.map((item) => ({ ...item, dimensions: servedDimensions })),
      })),
    );

    expect(await screen.findByText('Provider not exposed', {}, { timeout: 2_000 })).toBeTruthy();
  });

  it('opens a selected calendar day with hourly and distribution detail', async () => {
    render(Statistics);
    await screen.findByRole('heading', { name: 'LLM statistics' }, { timeout: 2_000 });
    await fireEvent.click(screen.getByRole('button', { name: /Select Aug (13|14), 2026/i }));

    expect(await screen.findByRole('heading', { name: /August (13|14), 2026/i })).toBeTruthy();
    expect(await screen.findByText('Selected-day token volume')).toBeTruthy();
    expect(screen.getByText('Speed distribution')).toBeTruthy();
    expect(mockDistribution).toHaveBeenCalledWith(
      expect.objectContaining({ measure: 'effectiveOutputTokensPerSecond', maxBins: 16 }),
    );
  });

  it('uses an inclusive drilldown end for a half-open DST calendar bucket', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-08T18:00:00.000Z'));
    const fromMs = Date.parse('2026-03-08T08:00:00.000Z');
    const nextMidnightMs = Date.parse('2026-03-09T07:00:00.000Z');
    mockSeries.mockResolvedValue([
      {
        fromMs,
        toMs: nextMidnightMs,
        summaries: [
          metric('effectiveOutputTokensPerSecond', 43, dimensions),
          metric('refusalCount', 0, dimensions),
          metric('errorCount', 0, dimensions),
        ],
      },
    ]);

    try {
      render(Statistics);
      await screen.findByRole('heading', { name: 'LLM statistics' }, { timeout: 2_000 });
      await fireEvent.click(screen.getByRole('button', { name: /Select Today, Mar 8, 2026/i }));

      await vi.waitFor(() => {
        const detailQuery = mockSummary.mock.calls
          .map(([query]) => query)
          .find((query) => query.fromMs === fromMs && query.measures.includes('totalTokens'));
        expect(detailQuery).toMatchObject({ fromMs, toMs: nextMidnightMs - 1 });
      });
    } finally {
      now.mockRestore();
    }
  });

  it('distinguishes disabled collection from an empty or failed query', async () => {
    mockCapabilities.mockResolvedValue({ ...capabilities(false), health: health({ state: 'disabled' }) });
    render(Statistics);

    expect(await screen.findByRole('heading', { name: 'Statistics are disabled' }, { timeout: 2_000 })).toBeTruthy();
    expect(mockSummary).not.toHaveBeenCalled();
    expect(mockSeries).not.toHaveBeenCalled();
  });

  it('keeps writer health visible and retries a transient reader failure', async () => {
    mockCapabilities
      .mockResolvedValueOnce({
        ...capabilities(false),
        health: health({ readerState: 'unavailable', readerLastError: 'reader timed out', persisted: 17 }),
      })
      .mockResolvedValue(capabilities());
    render(Statistics);

    expect(
      await screen.findByRole('heading', { name: 'Statistics temporarily unavailable' }, { timeout: 2_000 }),
    ).toBeTruthy();
    expect(screen.getByLabelText('Statistics repository health').textContent).toMatch(
      /Reader\s*unavailable.*Writer\s*ready.*Persisted\s*17/s,
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'LLM statistics' }, { timeout: 2_000 })).toBeTruthy();
    expect(mockCapabilities).toHaveBeenCalledTimes(2);
  });

  it('ignores capability results that settle after the route unmounts', async () => {
    let resolveCapabilities!: (value: StatisticsCapabilitiesDto) => void;
    mockCapabilities.mockReturnValue(
      new Promise((resolve) => {
        resolveCapabilities = resolve;
      }),
    );
    const view = render(Statistics);
    await vi.waitFor(() => expect(mockCapabilities).toHaveBeenCalledTimes(1), { timeout: 2_000 });

    view.unmount();
    resolveCapabilities(capabilities());
    await Promise.resolve();

    expect(mockSummary).not.toHaveBeenCalled();
    expect(mockSeries).not.toHaveBeenCalled();
  });

  it('renders a distinct empty-range state', async () => {
    mockSummary.mockImplementation((query) =>
      Promise.resolve(query.groupBy ? [] : [metric('requestCount', 0), metric('effectiveOutputTokensPerSecond', null)]),
    );
    mockSeries.mockResolvedValue([]);
    render(Statistics);

    expect(await screen.findByRole('heading', { name: 'No observed exchanges' }, { timeout: 2_000 })).toBeTruthy();
  });

  it('surfaces degraded persistence without hiding partial results', async () => {
    mockCapabilities.mockResolvedValue({
      ...capabilities(),
      health: health({ state: 'degraded', dropped: 2, lastError: 'flush failed' }),
    });
    render(Statistics);

    expect(await screen.findByRole('heading', { name: 'LLM statistics' }, { timeout: 2_000 })).toBeTruthy();
    expect(screen.getByText('Partial')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/statistics may be missing/i);
  });
});
