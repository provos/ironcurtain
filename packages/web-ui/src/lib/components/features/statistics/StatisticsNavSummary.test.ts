import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import type { LlmStatisticsMeasure, StatisticsMetricSummaryDto } from '$lib/types.js';

import StatisticsNavSummary from './StatisticsNavSummary.svelte';

function summary(
  measure: LlmStatisticsMeasure,
  value: number | null,
  distribution?: { median: number; lowerQuartile: number; upperQuartile: number },
): StatisticsMetricSummaryDto {
  return {
    dimensions: {},
    measure,
    value,
    sampleCount: 14,
    sampleSessionCount: 2,
    eligibleCount: 14,
    coverage: 1,
    median: distribution?.median ?? null,
    lowerQuartile: distribution?.lowerQuartile ?? null,
    upperQuartile: distribution?.upperQuartile ?? null,
    formulaVersion: 1,
  };
}

describe('StatisticsNavSummary', () => {
  it('renders a compact, honest speed receipt and opens Statistics', () => {
    const onselect = vi.fn();
    render(StatisticsNavSummary, {
      available: true,
      summaries: [
        summary('effectiveOutputTokensPerSecond', 65.4, {
          median: 65.4,
          lowerQuartile: 52.1,
          upperQuartile: 78.2,
        }),
        summary('outputTokens', 871_400),
        summary('requestCount', 1_405),
      ],
      onselect,
    });

    const receipt = screen.getByTestId('statistics-nav-summary');
    expect(receipt.textContent).toMatch(/65\.4\s*tok\/s/);
    expect(receipt.textContent).toMatch(/Middle 50%\s*52\.1–78\.2/);
    expect(receipt.textContent).toMatch(/Output\s*871K tok/);
    expect(receipt.textContent).toMatch(/Measured\s*14/);
    expect(receipt.getAttribute('aria-label')).toMatch(
      /Today median effective output speed 65\.4 tokens per second based on 14 measured requests/,
    );

    fireEvent.click(receipt);
    expect(onselect).toHaveBeenCalledOnce();
  });

  it('distinguishes an observed day with missing speed from an empty day', () => {
    const onselect = vi.fn();
    const { rerender } = render(StatisticsNavSummary, {
      available: true,
      summaries: [
        summary('effectiveOutputTokensPerSecond', null),
        summary('outputTokens', 12_500),
        summary('requestCount', 7),
      ],
      onselect,
    });
    expect(screen.getByText('Speed unavailable')).toBeTruthy();

    rerender({ available: true, summaries: [], onselect });
    expect(screen.getByText('No observations today')).toBeTruthy();
  });

  it('stays out of the sidebar when statistics cannot be queried', () => {
    render(StatisticsNavSummary, { available: false, summaries: [], onselect: vi.fn() });
    expect(screen.queryByTestId('statistics-nav-summary')).toBeNull();
  });
});
